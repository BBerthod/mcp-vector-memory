import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QdrantService } from '../services/qdrant.js';
import type { OllamaService } from '../services/ollama.js';
import type { RateLimiter } from '../services/security.js';
import { containsSecrets } from '../services/security.js';
import type { AuthContext } from '../services/auth.js';
import { encodeSparse } from '../services/sparse-encoder.js';
import { config } from '../config.js';

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
      summary: z.string().optional().describe('Nouveau résumé'),
      context: z.string().optional().describe('Nouveau contexte'),
      tags: z.array(z.string()).optional().describe('Nouveaux tags'),
      type: z.string().optional().describe('Nouveau type'),
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

      const updatedPayload = {
        ...point.payload,
        summary: newSummary,
        context: args.context ?? point.payload.context,
        tags: args.tags ?? point.payload.tags,
        type: args.type ?? point.payload.type,
        version: newVersion,
        updated_at: new Date().toISOString(),
      };

      const sparseVector = encodeSparse(newSummary);
      await qdrant.upsertHybrid('memory', [{ id: args.id, denseVector: vector, sparseVector, payload: updatedPayload }]);

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
