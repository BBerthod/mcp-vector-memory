import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import type { QdrantService } from './services/qdrant.js';
import type { OllamaService } from './services/ollama.js';
import { authMiddleware, requireAuthContext, buildAclFilter, requireAdminToken, type AuthContext } from './services/auth.js';
import type { RateLimiter } from './services/security.js';
import { registerSearchTool } from './tools/search.js';
import { registerRememberTool } from './tools/remember.js';
import { registerForgetTool } from './tools/forget.js';
import { registerUpdateMemoryTool } from './tools/update-memory.js';
import { registerIndexFileTool } from './tools/index-file.js';
import { registerStatsTool } from './tools/stats.js';

export interface AppDeps {
  qdrant: QdrantService;
  ollama: OllamaService;
  rateLimiter: RateLimiter;
  /** Separate, tighter budget consumed by write tools (see WRITE_TOOLS). */
  writeRateLimiter: RateLimiter;
}

const WRITE_TOOLS = new Set(['remember', 'update_memory', 'forget', 'index_file']);
const RATE_LIMIT_ERROR_CODE = -32029;

interface RateLimitRejection {
  id: unknown;
  resetAt: Date;
}

// Consumes one general token per tools/call and one write token per write tool.
// Other JSON-RPC methods (initialize, tools/list...) are never limited.
function consumeToolCallBudget(body: unknown, token: string, deps: AppDeps): RateLimitRejection | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    const { method, params, id } = message as { method?: unknown; params?: { name?: unknown }; id?: unknown };
    if (method !== 'tools/call') continue;

    if (!deps.rateLimiter.tryConsume(token)) {
      return { id: id ?? null, resetAt: deps.rateLimiter.getRemainingQuota(token).resetAt };
    }
    if (typeof params?.name === 'string' && WRITE_TOOLS.has(params.name) && !deps.writeRateLimiter.tryConsume(token)) {
      return { id: id ?? null, resetAt: deps.writeRateLimiter.getRemainingQuota(token).resetAt };
    }
  }
  return null;
}

export interface AppOptions {
  /**
   * Authentication middleware for POST /mcp. Defaults to the bearer-token
   * `authMiddleware`; tests inject one that sets `req.authContext` directly.
   */
  authenticate?: RequestHandler;
}


// MCP Server factory — stateless pattern: new server + transport per request
export function createMcpServer(authContext: AuthContext, deps: AppDeps): McpServer {
  const { qdrant: qdrantService, ollama: ollamaService, rateLimiter } = deps;

  const server = new McpServer({
    name: 'vector-memory-server',
    version: '0.1.0',
  });

  registerSearchTool(server, qdrantService, ollamaService, authContext);
  registerRememberTool(server, qdrantService, ollamaService, rateLimiter, authContext);
  registerForgetTool(server, qdrantService, ollamaService, rateLimiter, authContext);
  registerUpdateMemoryTool(server, qdrantService, ollamaService, rateLimiter, authContext);
  registerIndexFileTool(server, qdrantService, ollamaService, rateLimiter, authContext);
  registerStatsTool(server, qdrantService, authContext);

  return server;
}

export function createApp(deps: AppDeps, options: AppOptions = {}): express.Express {
  const { qdrant: qdrantService, ollama: ollamaService } = deps;
  const authenticate = options.authenticate ?? authMiddleware;

  // Express app
  const app = express();

  // Middleware
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Request logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    console.info(`[express] ${req.method} ${req.path}`);
    next();
  });

  // Health check endpoint (no auth required)
  app.get('/health', async (req: Request, res: Response) => {
    try {
      const qdrantHealthy = await qdrantService.healthCheck();
      const ollamaHealthy = await ollamaService.healthCheck();

      const status = qdrantHealthy && ollamaHealthy ? 'healthy' : 'degraded';

      res.json({
        status,
        timestamp: new Date().toISOString(),
        services: {
          qdrant: qdrantHealthy ? 'ok' : 'unhealthy',
          ollama: ollamaHealthy ? 'ok' : 'unhealthy',
        },
        config: {
          projectsCount: Object.keys(config.projects).length,
          logLevel: config.logLevel,
        },
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        message: 'Health check failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Project deletion (admin only)
  app.delete('/api/project/:name', authMiddleware, async (req: Request, res: Response) => {
    try {
      const auth = requireAuthContext(req);
      const projectName = req.params.name as string;

      // Require admin token for project deletion
      requireAdminToken(auth.token);

      const aclFilter = buildAclFilter(auth, projectName);

      // Delete all data for this project from all collections
      const collections = ['code', 'docs', 'memory'];
      const results: Record<string, number> = {};

      for (const collection of collections) {
        try {
          const infoBefore = await qdrantService.getCollectionInfo(collection);
          await qdrantService.deleteByFilter(collection, aclFilter);
          const infoAfter = await qdrantService.getCollectionInfo(collection);
          results[collection] = infoBefore.count - infoAfter.count;
        } catch (error) {
          console.error(`[api] Error deleting from ${collection}:`, error);
          results[collection] = -1;
        }
      }

      res.json({ 
        message: 'Project data deleted',
        project: projectName,
        deletedCounts: results
      });
    } catch (error) {
      console.error('[api] project delete error:', error);
      res.status(error instanceof Error && error.message.includes('Admin') ? 403 : 500).json({ 
        error: 'Failed to delete project data',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // MCP Streamable HTTP endpoint — stateless (no session tracking)
  app.post('/mcp', authenticate, async (req: Request, res: Response) => {
    try {
      const authContext = requireAuthContext(req);

      const rejection = consumeToolCallBudget(req.body, authContext.token, deps);
      if (rejection) {
        res.status(429).json({
          jsonrpc: '2.0',
          error: {
            code: RATE_LIMIT_ERROR_CODE,
            message: 'Rate limit exceeded',
            data: { resetAt: rejection.resetAt },
          },
          id: rejection.id,
        });
        return;
      }

      const server = createMcpServer(authContext, deps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error('[mcp] Error handling request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // MCP GET/DELETE — not used in stateless mode
  app.get('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless mode)' },
      id: null,
    });
  });

  app.delete('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless mode)' },
      id: null,
    });
  });

  // Error handling middleware
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error('[express] Unhandled error:', err);
    res.status(500).json({
      error: 'Internal server error',
      message: config.logLevel === 'debug' ? err.message : 'An unexpected error occurred'
    });
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}
