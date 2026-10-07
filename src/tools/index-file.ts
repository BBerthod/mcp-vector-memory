import crypto from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QdrantService } from '../services/qdrant.js';
import type { OllamaService } from '../services/ollama.js';
import type { RateLimiter } from '../services/security.js';
import { containsSecrets } from '../services/security.js';
import type { AuthContext } from '../services/auth.js';
import { chunkByAst, isAstSupported, type AstChunk } from '../services/ast-chunker.js';
import { chunkByFormat } from '../services/text-chunker.js';
import { encodeSparse } from '../services/sparse-encoder.js';
import { config } from '../config.js';

const MAX_FILE_SIZE = 100 * 1024; // 100KB
const CHUNK_LINES = 50;
const CHUNK_OVERLAP = 10;

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.php': 'php',
  '.vue': 'vue',
  '.py': 'python',
  '.md': 'markdown',
  '.sql': 'sql',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
};

function detectLanguage(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf('.'));
  return LANGUAGE_MAP[ext] ?? 'text';
}

type Chunk = AstChunk;

function slidingWindowChunk(content: string, project: string, relativePath: string): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];

  for (let i = 0; i < lines.length; i += CHUNK_LINES - CHUNK_OVERLAP) {
    const chunkLines = lines.slice(i, i + CHUNK_LINES);
    if (chunkLines.length < 5 && i > 0) break;

    const startLine = i + 1;
    const endLine = i + chunkLines.length;
    const chunkContent = chunkLines.join('\n');

    const id = crypto.createHash('sha256')
      .update(`${project}:${relativePath}:${startLine}:${endLine}`)
      .digest('hex')
      .substring(0, 32);

    const uuid = [id.substring(0, 8), id.substring(8, 12), id.substring(12, 16), id.substring(16, 20), id.substring(20, 32)].join('-');

    chunks.push({
      id: uuid,
      content: chunkContent,
      embeddingContent: `// File: ${relativePath}\n${chunkContent}`,
      startLine,
      endLine,
      name: `chunk_${startLine}`,
    });
  }

  if (chunks.length === 0) {
    const id = crypto.createHash('sha256')
      .update(`${project}:${relativePath}`)
      .digest('hex')
      .substring(0, 32);
    const uuid = [id.substring(0, 8), id.substring(8, 12), id.substring(12, 16), id.substring(16, 20), id.substring(20, 32)].join('-');

    chunks.push({
      id: uuid,
      content,
      embeddingContent: `// File: ${relativePath}\n${content}`,
      startLine: 1,
      endLine: lines.length,
      name: 'full_file',
    });
  }

  return chunks;
}

function chunkContent(content: string, language: string, project: string, relativePath: string): Chunk[] {
  // Try AST-aware chunking first
  if (isAstSupported(language)) {
    const astChunks = chunkByAst(content, language, project, relativePath);
    if (astChunks && astChunks.length > 0) {
      return astChunks;
    }
  }

  // Try format-specific chunking for non-code files
  const formatChunks = chunkByFormat(content, language, project, relativePath);
  if (formatChunks && formatChunks.length > 0) {
    return formatChunks;
  }

  // Fallback to sliding window
  return slidingWindowChunk(content, project, relativePath);
}

export function registerIndexFileTool(
  server: McpServer,
  qdrant: QdrantService,
  ollama: OllamaService,
  rateLimiter: RateLimiter,
  authContext: AuthContext,
): void {
  server.tool(
    'index_file',
    'Indexer un fichier de code dans la base vectorielle. Le contenu est envoyé directement.',
    {
      project: z.string().describe('Nom du projet'),
      relative_path: z.string().describe('Chemin relatif (ex: app/Services/AuthService.php)'),
      content: z.string().describe('Contenu du fichier (max 100KB)'),
      language: z.string().optional().describe('Langage (auto-détecté si absent)'),
    },
    async (args) => {
      console.log('[index-file] project:', args.project, 'path:', args.relative_path);

      // ACL: verify project access
      if (!authContext.allowedProjects.includes(args.project)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Access denied to project '${args.project}'` }) }],
          isError: true,
        };
      }

      // Size check
      if (args.content.length > MAX_FILE_SIZE) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Fichier trop volumineux (${args.content.length} octets, max ${MAX_FILE_SIZE})` }) }],
          isError: true,
        };
      }

      // Security check
      if (containsSecrets(args.content)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Le fichier contient des secrets' }) }],
          isError: true,
        };
      }

      const language = args.language ?? detectLanguage(args.relative_path);
      const contentHash = crypto.createHash('sha256').update(args.content).digest('hex');
      const jobId = crypto.randomUUID();

      // Fire-and-forget async processing
      processIndexing(args.project, args.relative_path, args.content, language, contentHash, qdrant, ollama)
        .then(() => console.log('[index-file] Job completed:', jobId))
        .catch(err => console.error('[index-file] Job failed:', jobId, err));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ status: 'queued', job_id: jobId }) }],
      };
    },
  );
}

async function processIndexing(
  project: string,
  relativePath: string,
  content: string,
  language: string,
  contentHash: string,
  qdrant: QdrantService,
  ollama: OllamaService,
): Promise<void> {
  // Delete existing chunks for this file
  await qdrant.deleteByFilter('code', {
    must: [
      { key: 'project', match: { value: project } },
      { key: 'file_path', match: { value: relativePath } },
    ],
  });

  // Chunk the content (AST-aware with format-specific and sliding window fallback)
  const chunks = chunkContent(content, language, project, relativePath);

  // Batch embed using enriched content with optional doc instruction
  const docInstruction = config.embedDocInstructionCode;
  const texts = chunks.map(c =>
    docInstruction ? `Instruct: ${docInstruction}\nQuery: ${c.embeddingContent}` : c.embeddingContent
  );
  const vectors = await ollama.embedBatch(texts, 'code');

  // Generate sparse vectors for each chunk
  const sparseVectors = chunks.map(c => encodeSparse(c.content));

  // Upsert all chunks with hybrid vectors
  const points = chunks.map((chunk, idx) => ({
    id: chunk.id,
    denseVector: vectors[idx],
    sparseVector: sparseVectors[idx],
    payload: {
      project,
      file_path: relativePath,
      relative_path: relativePath,
      language,
      content: chunk.content,
      name: chunk.name,
      type: 'block' as const,
      line_start: chunk.startLine,
      line_end: chunk.endLine,
      content_hash: contentHash,
      last_indexed: new Date().toISOString(),
      embedding_model: config.embedModelCode,
      embedding_dims: config.embedDims,
    },
  }));

  await qdrant.upsertHybrid('code', points);
  console.log(`[index-file] Indexed ${points.length} chunks for ${relativePath}`);
}
