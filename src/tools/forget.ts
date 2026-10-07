import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QdrantService } from '../services/qdrant.js';
import type { OllamaService } from '../services/ollama.js';
import type { RateLimiter } from '../services/security.js';
import type { AuthContext } from '../services/auth.js';

export function registerForgetTool(
  server: McpServer,
  qdrant: QdrantService,
  ollama: OllamaService,
  rateLimiter: RateLimiter,
  authContext: AuthContext,
): void {
  server.tool(
    'forget',
    'Supprimer une entrée mémoire (soft delete, rétention 30 jours). Par ID direct ou par recherche.',
    {
      id: z.string().optional().describe('ID direct de la mémoire à supprimer'),
      query: z.string().optional().describe('Recherche sémantique (retourne les candidats si >1)'),
      project: z.string().optional().describe('Filtrer par projet'),
      reason: z.string().optional().describe('Raison de la suppression'),
    },
    async (args) => {
      if (!args.id && !args.query) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'id ou query requis' }) }],
          isError: true,
        };
      }

      // Case 1: Direct ID
      if (args.id) {
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
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Déjà supprimée' }) }],
            isError: true,
          };
        }

        // Soft delete: re-embed to preserve vector, update payload
        const vector = await ollama.embed(point.payload.summary as string, 'text');
        await qdrant.upsert('memory', [{
          id: args.id,
          vector,
          payload: {
            ...point.payload,
            deleted_at: new Date().toISOString(),
            deletion_reason: args.reason ?? null,
          },
        }]);

        console.log('[forget] Soft deleted:', args.id);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ id: args.id, status: 'soft_deleted' }) }],
        };
      }

      // Case 2: Query-based
      const filter: Record<string, unknown> = {
        must: [] as unknown[],
      };
      const must = filter.must as unknown[];

      // ACL: restrict to caller's allowed projects
      const allowedProjects = args.project
        ? (authContext.allowedProjects.includes(args.project) ? [args.project] : [])
        : authContext.allowedProjects;

      if (allowedProjects.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Access denied to project '${args.project}'` }) }],
          isError: true,
        };
      }

      must.push({ key: 'project', match: { any: allowedProjects } });

      const vector = await ollama.embed(args.query!, 'text');
      const results = await qdrant.search('memory', vector, {
        filter,
        limit: 5,
        threshold: 0.7,
      });

      const active = results.filter(r => !r.payload.deleted_at);

      if (active.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'not_found' }) }],
        };
      }

      if (active.length > 1) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'multiple_matches',
              candidates: active.map(r => ({
                id: r.id,
                summary: r.payload.summary,
                score: r.score,
              })),
            }),
          }],
        };
      }

      // Exactly 1 match — soft delete
      const target = active[0];
      const targetVector = await ollama.embed(target.payload.summary as string, 'text');
      await qdrant.upsert('memory', [{
        id: target.id,
        vector: targetVector,
        payload: {
          ...target.payload,
          deleted_at: new Date().toISOString(),
          deletion_reason: args.reason ?? null,
        },
      }]);

      console.log('[forget] Soft deleted via query:', target.id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ id: target.id, status: 'soft_deleted' }) }],
      };
    },
  );
}
