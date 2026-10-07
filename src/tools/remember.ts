import crypto from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QdrantService } from '../services/qdrant.js';
import type { OllamaService } from '../services/ollama.js';
import type { RateLimiter } from '../services/security.js';
import { containsSecrets } from '../services/security.js';
import type { AuthContext } from '../services/auth.js';
import { encodeSparse } from '../services/sparse-encoder.js';
import { config } from '../config.js';

const VALID_TYPES = ['decision', 'pattern', 'solution', 'convention', 'issue', 'session_summary'] as const;

export function registerRememberTool(
  server: McpServer,
  qdrant: QdrantService,
  ollama: OllamaService,
  rateLimiter: RateLimiter,
  authContext: AuthContext,
): void {
  server.tool(
    'remember',
    'Stocker une information dans la mémoire collective. Détecte les doublons automatiquement.',
    {
      project: z.string().describe('Nom du projet ou "global"'),
      type: z.enum(VALID_TYPES).describe('Type: decision, pattern, solution, convention, issue, session_summary'),
      summary: z.string().describe('Description claire, commence par un verbe'),
      context: z.string().optional().describe('Détails supplémentaires, raisonnement'),
      tags: z.array(z.string()).min(2).describe('Minimum 2 tags'),
    },
    async (args) => {
      console.log('[remember] project:', args.project, 'type:', args.type);

      // ACL: verify project access
      if (!authContext.allowedProjects.includes(args.project)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Access denied to project '${args.project}'` }) }],
          isError: true,
        };
      }

      // Security: reject if content contains secrets
      if (containsSecrets(args.summary) || (args.context && containsSecrets(args.context))) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Le contenu contient des secrets. Veuillez les supprimer avant de mémoriser.' }) }],
          isError: true,
        };
      }

      // Duplicate detection
      const normalizedSummary = args.summary.toLowerCase().trim();
      const contentHash = crypto.createHash('sha256').update(normalizedSummary).digest('hex');

      // Check for hash-based exact duplicate within 3 months
      const hashFilter = {
        must: [
          { key: 'project', match: { value: args.project } },
          { key: 'content_hash', match: { value: contentHash } },
        ],
      };

      // Search for hash match first (cheap)
      const hashResults = await qdrant.scroll('memory', { filter: hashFilter, limit: 1 });
      if (hashResults.points.length > 0) {
        const existing = hashResults.points[0];
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              id: existing.id,
              status: 'duplicate_found',
              duplicate: { summary: existing.payload.summary, created_at: existing.payload.created_at },
            }),
          }],
        };
      }

      // Semantic duplicate check (embed + search with 0.9 threshold)
      const docInstruction = config.embedDocInstructionText;
      const textForEmbedding = docInstruction
        ? `Instruct: ${docInstruction}\nQuery: ${args.summary}`
        : args.summary;
      const vector = await ollama.embed(textForEmbedding, 'text');
      const semanticFilter = {
        must: [
          { key: 'project', match: { value: args.project } },
          { key: 'type', match: { value: args.type } },
        ],
      };

      const semanticResults = await qdrant.search('memory', vector, {
        filter: semanticFilter,
        limit: 1,
        threshold: 0.9,
      });

      if (semanticResults.length > 0) {
        const existing = semanticResults[0];
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              id: existing.id,
              status: 'duplicate_found',
              duplicate: { summary: existing.payload.summary, score: existing.score },
            }),
          }],
        };
      }

      // Create new memory entry
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const sparseVector = encodeSparse(args.summary);

      await qdrant.upsertHybrid('memory', [{
        id,
        denseVector: vector,
        sparseVector,
        payload: {
          project: args.project,
          type: args.type,
          summary: args.summary,
          context: args.context ?? '',
          tags: args.tags,
          content_hash: contentHash,
          author: authContext.name,
          created_at: now,
          updated_at: now,
          version: 1,
          relevance_score: 1.0,
          last_accessed: now,
          access_count: 0,
          deleted_at: null,
          embedding_model: config.embedModelText,
          embedding_dims: config.embedDims,
        },
      }]);

      console.log('[remember] Created memory:', id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ id, status: 'created' }) }],
      };
    },
  );
}
