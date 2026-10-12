import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QdrantService } from '../services/qdrant.js';
import type { OllamaService } from '../services/ollama.js';
import type { RateLimiter } from '../services/security.js';
import { containsSecrets } from '../services/security.js';
import type { AuthContext } from '../services/auth.js';
import { encodeSparse, SPARSE_VERSION } from '../services/sparse-encoder.js';
import { config } from '../config.js';
import { VALID_TYPES, computeContentHash } from './remember.js';

export function registerUpdateMemoryTool(
  server: McpServer,
  qdrant: QdrantService,
  ollama: OllamaService,
  rateLimiter: RateLimiter,
  authContext: AuthContext,
): void {
  server.tool(
    'update_memory',
    "Modifier une entrée mémoire existante. Verrouillage optimiste via le champ version.",
    {
      id: z.string().describe("ID de l'entrée à modifier"),
      version: z.number().describe('Version lue — rejeté si changée entre-temps'),
      summary: z.string().max(2000).optional().describe('Nouveau résumé'),
      context: z.string().max(20000).optional().describe('Nouveau contexte'),
      tags: z.array(z.string().max(64)).max(20).optional().describe('Nouveaux tags'),
      type: z.enum(VALID_TYPES).optional().describe('Nouveau type'),
    },
    async (args) => {
      console.log('[update-memory] Updating:', args.id, 'version:', args.version);

      const point = await qdrant.getById('memory', args.id);
      if (!point) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Mémoire non trouvée' }) }],
          isError: true,
        };
      }

      // ACL: verify project ownership
      if (!authContext.allowedProjects.includes(point.payload.project as string)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Access denied to this memory' }) }],
          isError: true,
        };
      }

      if (point.payload.deleted_at) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Cette mémoire a été supprimée' }) }],
          isError: true,
        };
      }

      // Optimistic locking
      const currentVersion = point.payload.version as number;
      if (currentVersion !== args.version) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ status: 'conflict', current_version: currentVersion }),
          }],
        };
      }

      // Security check on new content
      if (args.summary && containsSecrets(args.summary)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Le résumé contient des secrets' }) }],
          isError: true,
        };
      }
      if (args.context && containsSecrets(args.context)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Le contexte contient des secrets' }) }],
          isError: true,
        };
      }

      const newSummary = args.summary ?? point.payload.summary as string;
      const newVersion = currentVersion + 1;

      // Re-embed with doc instruction
      const docInstruction = config.embedDocInstructionText;
      const textForEmbedding = docInstruction
        ? `Instruct: ${docInstruction}\nQuery: ${newSummary}`
        : newSummary;
      const vector = await ollama.embed(textForEmbedding, 'text');

      // Write only what changed: rewriting the whole payload read above would
      // undo a forget (deleted_at) that landed since the read.
      const changes: Record<string, unknown> = {
        content_hash: computeContentHash(newSummary),
        sparse_version: SPARSE_VERSION,
        version: newVersion,
        updated_at: new Date().toISOString(),
      };
      if (args.summary !== undefined) changes.summary = newSummary;
      if (args.context !== undefined) changes.context = args.context;
      if (args.tags !== undefined) changes.tags = args.tags;
      if (args.type !== undefined) changes.type = args.type;

      const sparseVector = encodeSparse(newSummary);
      await qdrant.updateVectors('memory', args.id, { denseVector: vector, sparseVector });
      await qdrant.setPayload('memory', args.id, changes);

      console.log('[update-memory] Updated:', args.id, 'version:', newVersion);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ id: args.id, status: 'updated', version: newVersion }),
        }],
      };
    },
  );
}
