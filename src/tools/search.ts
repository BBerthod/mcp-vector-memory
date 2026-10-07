import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../services/auth.js';
import { buildAclFilter } from '../services/auth.js';
import type { QdrantService, SearchResult } from '../services/qdrant.js';
import type { OllamaService } from '../services/ollama.js';
import { redactSecrets } from '../services/security.js';
import { encodeSparseQuery } from '../services/sparse-encoder.js';
import { config, getDefaultThresholds } from '../config.js';

interface EnrichedResult extends SearchResult {
  collection: string;
}

function formatMarkdown(results: EnrichedResult[], maxTokens: number): string {
  const maxChars = maxTokens * 4; // rough estimate: 1 token ~= 4 chars
  let output = '';

  const codeResults = results.filter(r => r.collection === 'code');
  const docsResults = results.filter(r => r.collection === 'docs');
  const memoryResults = results.filter(r => r.collection === 'memory');

  const scores = results.map(r => r.score);
  const scoreRange = scores.length > 0
    ? `${Math.min(...scores).toFixed(2)}-${Math.max(...scores).toFixed(2)}`
    : '0';

  output += `## Contexte pertinent (${results.length} résultats, score ${scoreRange})\n\n`;

  if (codeResults.length > 0) {
    output += '### Code similaire\n';
    for (const r of codeResults) {
      const p = r.payload;
      const line = `- \`${p.file_path || p.relative_path}:${p.line_start}-${p.line_end}\` — ${p.name || 'snippet'} [${r.score.toFixed(2)}]\n`;
      if (output.length + line.length > maxChars) break;
      output += line;
    }
    output += '\n';
  }

  if (docsResults.length > 0) {
    output += '### Documentation\n';
    for (const r of docsResults) {
      const p = r.payload;
      const line = `- \`${p.file_path || p.relative_path || p.title || 'doc'}\` — ${p.name || 'snippet'} [${r.score.toFixed(2)}]\n`;
      if (output.length + line.length > maxChars) break;
      output += line;
    }
    output += '\n';
  }

  if (memoryResults.length > 0) {
    output += '### Mémoire\n';
    for (const r of memoryResults) {
      const p = r.payload;
      const line = `- ${p.type} : "${p.summary}" [${r.score.toFixed(2)}]\n`;
      if (output.length + line.length > maxChars) break;
      output += line;
    }
  }

  return output.trim();
}

export function registerSearchTool(
  server: McpServer,
  qdrant: QdrantService,
  ollama: OllamaService,
  authContext: AuthContext,
): void {
  server.tool(
    'search',
    'Recherche sémantique unifiée dans le code, la documentation et la mémoire collective. Dual embedding automatique.',
    {
      query: z.string().describe('Requête de recherche'),
      collections: z.array(z.enum(['code', 'docs', 'memory'])).optional().describe('Collections à chercher. Défaut: toutes'),
      project: z.string().optional().describe('Filtrer par projet'),
      language: z.string().optional().describe('Filtrer par langage (collection code)'),
      type: z.string().optional().describe("Filtrer par type d'entrée"),
      tags: z.array(z.string()).optional().describe('Filtrer par tags (OR)'),
      limit: z.number().optional().describe('Nombre max de résultats. Défaut: 10'),
      threshold: z.number().optional().describe('Score minimum de pertinence'),
      format: z.enum(['json', 'markdown']).optional().describe('Format de sortie. Défaut: json'),
      max_tokens: z.number().optional().describe('Borne max si format=markdown. Défaut: 4000'),
      exclude_expired: z.boolean().optional().describe('Exclure les entrées supprimées. Défaut: true'),
    },
    async (args) => {
      const collections = args.collections ?? ['code', 'docs', 'memory'];
      const limit = args.limit ?? 10;
      const format = args.format ?? 'json';
      const maxTokens = args.max_tokens ?? 4000;
      const excludeExpired = args.exclude_expired ?? true;

      console.log('[search] query:', args.query, 'collections:', collections);

      // ACL: restrict to caller's allowed projects
      const baseFilter = buildAclFilter(authContext, args.project);
      if (!baseFilter.must) (baseFilter as Record<string, unknown>).must = [];
      const must = baseFilter.must as unknown[];

      if (args.language) {
        must.push({ key: 'language', match: { value: args.language } });
      }
      if (args.type) {
        must.push({ key: 'type', match: { value: args.type } });
      }
      if (args.tags && args.tags.length > 0) {
        must.push({ key: 'tags', match: { any: args.tags } });
      }

      // Exclude soft-deleted entries (deleted_at must be null/absent)
      if (excludeExpired) {
        must.push({ is_null: { key: 'deleted_at' } });
      }

      const allResults: EnrichedResult[] = [];

      // Generate sparse query vector (always available — no external dependency)
      const sparseQuery = encodeSparseQuery(args.query);

      // Try hybrid search (dense + sparse), fall back to sparse-only if Ollama is down
      let ollamaAvailable = true;
      try {
        // Dual embedding: code model for code, text model for docs/memory
        const codeCols = collections.filter(c => c === 'code');
        const textCols = collections.filter(c => c !== 'code');

        if (codeCols.length > 0) {
          const codeQuery = config.embedQueryInstructionCode
            ? `Instruct: ${config.embedQueryInstructionCode}\nQuery: ${args.query}`
            : args.query;
          const vector = await ollama.embed(codeQuery, 'code');
          for (const col of codeCols) {
            const results = await qdrant.hybridSearch(col, vector, sparseQuery, { filter: baseFilter, limit });
            allResults.push(...results.map(r => ({ ...r, collection: col })));
          }
        }

        if (textCols.length > 0) {
          const textQuery = config.embedQueryInstructionText
            ? `Instruct: ${config.embedQueryInstructionText}\nQuery: ${args.query}`
            : args.query;
          const vector = await ollama.embed(textQuery, 'text');
          for (const col of textCols) {
            const results = await qdrant.hybridSearch(col, vector, sparseQuery, { filter: baseFilter, limit });
            allResults.push(...results.map(r => ({ ...r, collection: col })));
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        if (msg.includes('connect') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
          // Ollama is down — fall back to sparse-only (BM25) search
          ollamaAvailable = false;
          console.warn(`[search] Ollama unavailable (${msg}), falling back to BM25 sparse search`);
          for (const col of collections) {
            const results = await qdrant.sparseSearch(col, sparseQuery, { filter: baseFilter, limit });
            allResults.push(...results.map(r => ({ ...r, collection: col })));
          }
        } else {
          throw error;
        }
      }

      // Apply composite scoring: 80% similarity + 20% recency
      const now = Date.now();
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      for (const r of allResults) {
        const createdAt = r.payload.created_at || r.payload.last_indexed;
        if (typeof createdAt === 'string') {
          const ageMs = now - new Date(createdAt).getTime();
          const recencyScore = Math.max(0, 1 - ageMs / THIRTY_DAYS_MS);
          r.score = 0.80 * r.score + 0.20 * recencyScore;
        }
      }

      // Sort by composite score descending, take top N
      allResults.sort((a, b) => b.score - a.score);
      const topResults = allResults.slice(0, limit);

      if (format === 'markdown') {
        let md = formatMarkdown(topResults, maxTokens);
        if (!ollamaAvailable) {
          md = '> Ollama indisponible — résultats BM25 uniquement (moins précis)\n\n' + md;
        }
        return { content: [{ type: 'text' as const, text: md }] };
      }

      // JSON format — redact any secrets in payloads
      const safeResults = topResults.map(r => ({
        id: r.id,
        score: r.score,
        collection: r.collection,
        payload: {
          ...r.payload,
          content: typeof r.payload.content === 'string' ? redactSecrets(r.payload.content) : r.payload.content,
        },
      }));

      return { content: [{ type: 'text' as const, text: JSON.stringify(safeResults, null, 2) }] };
    },
  );
}
