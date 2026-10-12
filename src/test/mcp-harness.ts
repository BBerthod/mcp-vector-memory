/**
 * In-memory MCP client wired to the production tool registration.
 *
 * Reminder: `src/app.ts` pulls in `src/services/qdrant.ts`, which reads
 * VECTOR_SIZE at module load. Set `process.env.VECTOR_SIZE` BEFORE importing
 * this file (use `await import(...)` in tests). Imports of project code here
 * are therefore dynamic.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { QdrantService } from '../services/qdrant.js';
import type { OllamaService } from '../services/ollama.js';
import type { RateLimiter } from '../services/security.js';
import type { AuthContext } from '../services/auth.js';
import type { FakeOllama } from './fake-ollama.js';

export interface ToolsHandle {
  client: Client;
  call(name: string, args: object): Promise<any>;
  close(): Promise<void>;
}

export async function connectTools(opts: {
  qdrant: QdrantService;
  ollama: OllamaService | FakeOllama;
  rateLimiter?: RateLimiter;
  authContext: AuthContext;
}): Promise<ToolsHandle> {
  const { createMcpServer } = await import('../app.js');
  const { RateLimiter: RateLimiterImpl } = await import('../services/security.js');

  const rateLimiter = opts.rateLimiter ?? new RateLimiterImpl(1000, 1000);
  const server = createMcpServer(opts.authContext, {
    qdrant: opts.qdrant,
    ollama: opts.ollama as OllamaService,
    rateLimiter,
    writeRateLimiter: new RateLimiterImpl(1000, 1000),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    async call(name, args) {
      const result: any = await client.callTool({ name, arguments: args as Record<string, unknown> });
      const block = Array.isArray(result.content) ? result.content.find((c: any) => c.type === 'text') : undefined;
      const text: string | undefined = block?.text;
      let parsed: unknown = text;
      if (text !== undefined) {
        try {
          parsed = JSON.parse(text);
        } catch {
          return { text, isError: result.isError === true };
        }
      } else {
        return { isError: result.isError === true, content: result.content };
      }
      return parsed;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
