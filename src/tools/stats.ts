import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QdrantService } from '../services/qdrant.js';
import type { AuthContext } from '../services/auth.js';

export function registerStatsTool(
  server: McpServer,
  qdrant: QdrantService,
  authContext: AuthContext,
): void {
  server.tool(
    'stats',
    'Santé et métriques du système vectoriel.',
    {
      project: z.string().optional().describe('Filtrer par projet (si absent, tous les projets autorisés)'),
    },
    async (args) => {
      console.log('[stats] Fetching stats');

      const collections = ['code', 'docs', 'memory'] as const;
      const collectionStats: Record<string, { count: number; status: string }> = {};

      for (const col of collections) {
        try {
          const info = await qdrant.getCollectionInfo(col);
          collectionStats[col] = { count: info.count, status: 'ok' };
        } catch {
          collectionStats[col] = { count: 0, status: 'error' };
        }
      }

      const qdrantHealthy = await qdrant.healthCheck();

      const result = {
        collections: collectionStats,
        health: {
          qdrant: qdrantHealthy ? 'ok' : 'error',
        },
        uptime_seconds: Math.floor(process.uptime()),
        project_filter: args.project ?? authContext.allowedProjects.join(', '),
        authorized_projects: authContext.allowedProjects,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
