import express, { Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config, isProjectAllowed } from './config.js';
import { QdrantService } from './services/qdrant.js';
import { OllamaService } from './services/ollama.js';
import { authMiddleware, requireAuthContext, buildAclFilter, requireAdminToken, type AuthContext } from './services/auth.js';
import { RateLimiter, containsSecrets, redactSecrets, validateContent } from './services/security.js';
import { registerSearchTool } from './tools/search.js';
import { registerRememberTool } from './tools/remember.js';
import { registerForgetTool } from './tools/forget.js';
import { registerUpdateMemoryTool } from './tools/update-memory.js';
import { registerIndexFileTool } from './tools/index-file.js';
import { registerStatsTool } from './tools/stats.js';
import { initAstChunker } from './services/ast-chunker.js';

const PORT = process.env.PORT || 3100;

// Initialize services
const qdrantService = new QdrantService(config.qdrantUrl, config.qdrantApiKey);
const ollamaService = new OllamaService(config.ollamaUrl, config.embedModelCode, config.embedModelText);
const rateLimiter = new RateLimiter(config.rateLimitPerHour, config.rateLimitBurst);

// Express app
const app = express();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`[express] ${req.method} ${req.path}`);
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

// Webhook secret validation middleware for git webhooks
function webhookSecretMiddleware(req: Request, res: Response, next: NextFunction): void {
  const project = req.body?.project || req.params?.project;
  
  if (!project) {
    res.status(400).json({ error: 'Project name required' });
    return;
  }

  const projectConfig = config.projects[project];
  if (!projectConfig) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const providedSecret = req.headers['x-webhook-secret'] as string || 
                         req.body?.secret;
  
  if (!projectConfig.webhook_secret) {
    res.status(400).json({ error: 'Webhook not configured for this project' });
    return;
  }

  if (providedSecret !== projectConfig.webhook_secret) {
    res.status(401).json({ error: 'Invalid webhook secret' });
    return;
  }

  next();
}

// Webhook endpoints
app.post('/webhooks/file-changed', authMiddleware, async (req: Request, res: Response) => {
  try {
    const auth = requireAuthContext(req);
    const { project, filePath, content, changeType } = req.body;

    if (!project || !filePath) {
      res.status(400).json({ error: 'project and filePath are required' });
      return;
    }

    if (!isProjectAllowed(auth.token, project)) {
      res.status(403).json({ error: 'Access denied to project' });
      return;
    }

    // Check rate limit
    if (!rateLimiter.tryConsume(auth.token)) {
      const quota = rateLimiter.getRemainingQuota(auth.token);
      res.status(429).json({ 
        error: 'Rate limit exceeded', 
        resetAt: quota.resetAt 
      });
      return;
    }

    // Check for secrets in content
    if (content && containsSecrets(content)) {
      res.status(400).json({ 
        error: 'Content contains potential secrets. Please redact before indexing.' 
      });
      return;
    }

    // Delegate to index-file handler
    // This would normally call the index-file logic
    res.json({ 
      message: 'File change received',
      project,
      filePath,
      changeType 
    });
  } catch (error) {
    console.error('[webhooks] file-changed error:', error);
    res.status(500).json({ 
      error: 'Failed to process file change',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.post('/webhooks/commit', authMiddleware, async (req: Request, res: Response) => {
  try {
    const auth = requireAuthContext(req);
    const { project, commitSha, files } = req.body;

    if (!project || !commitSha) {
      res.status(400).json({ error: 'project and commitSha are required' });
      return;
    }

    if (!isProjectAllowed(auth.token, project)) {
      res.status(403).json({ error: 'Access denied to project' });
      return;
    }

    res.json({ 
      message: 'Commit webhook received',
      project,
      commitSha,
      filesCount: files?.length || 0
    });
  } catch (error) {
    console.error('[webhooks] commit error:', error);
    res.status(500).json({ 
      error: 'Failed to process commit webhook',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.post('/webhooks/git/:project', webhookSecretMiddleware, async (req: Request, res: Response) => {
  try {
    const project = req.params.project;
    const { ref, commits, repository } = req.body;

    console.log(`[webhooks] Git webhook for project '${project}': ${commits?.length || 0} commits`);

    res.json({ 
      message: 'Git webhook received',
      project,
      ref,
      commitsCount: commits?.length || 0
    });
  } catch (error) {
    console.error('[webhooks] git error:', error);
    res.status(500).json({ 
      error: 'Failed to process git webhook',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// API endpoints
app.post('/api/index-repo', authMiddleware, async (req: Request, res: Response) => {
  try {
    const auth = requireAuthContext(req);
    const { project, force } = req.body;

    if (!project) {
      res.status(400).json({ error: 'project is required' });
      return;
    }

    if (!isProjectAllowed(auth.token, project)) {
      res.status(403).json({ error: 'Access denied to project' });
      return;
    }

    if (!rateLimiter.tryConsume(auth.token)) {
      const quota = rateLimiter.getRemainingQuota(auth.token);
      res.status(429).json({ 
        error: 'Rate limit exceeded', 
        resetAt: quota.resetAt 
      });
      return;
    }

    const projectConfig = config.projects[project];
    if (!projectConfig) {
      res.status(404).json({ error: 'Project configuration not found' });
      return;
    }

    // Index repository logic would go here
    res.json({ 
      message: 'Repository indexing started',
      project,
      path: projectConfig.server_repo_path
    });
  } catch (error) {
    console.error('[api] index-repo error:', error);
    res.status(500).json({ 
      error: 'Failed to start repository indexing',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.post('/api/index-doc', authMiddleware, async (req: Request, res: Response) => {
  try {
    const auth = requireAuthContext(req);
    const { project, docType, content, metadata } = req.body;

    if (!project || !content) {
      res.status(400).json({ error: 'project and content are required' });
      return;
    }

    if (!isProjectAllowed(auth.token, project)) {
      res.status(403).json({ error: 'Access denied to project' });
      return;
    }

    if (!rateLimiter.tryConsume(auth.token)) {
      const quota = rateLimiter.getRemainingQuota(auth.token);
      res.status(429).json({ 
        error: 'Rate limit exceeded', 
        resetAt: quota.resetAt 
      });
      return;
    }

    // Check for secrets
    if (containsSecrets(content)) {
      res.status(400).json({ 
        error: 'Content contains potential secrets. Please redact before indexing.' 
      });
      return;
    }

    res.json({ 
      message: 'Document indexing started',
      project,
      docType
    });
  } catch (error) {
    console.error('[api] index-doc error:', error);
    res.status(500).json({ 
      error: 'Failed to index document',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

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

// MCP Server factory — stateless pattern: new server + transport per request
function createMcpServer(authContext: AuthContext): McpServer {
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

// MCP Streamable HTTP endpoint — stateless (no session tracking)
app.post('/mcp', authMiddleware, async (req: Request, res: Response) => {
  try {
    const authContext = requireAuthContext(req);
    const server = createMcpServer(authContext);
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

/**
 * Run `fn` with exponential backoff until it succeeds or the deadline elapses.
 * Used to tolerate transient startup races (DNS, slow dependency boot) where
 * Qdrant/Ollama may not yet be reachable when this container starts.
 */
async function retryWithBackoff<T>(
  label: string,
  fn: () => Promise<T>,
  options: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 30;
  const baseDelayMs = options.baseDelayMs ?? 2000;
  const maxDelayMs = options.maxDelayMs ?? 15000;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(1.5, attempt - 1));
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[server] ${label} attempt ${attempt}/${maxAttempts} failed: ${message}. Retrying in ${Math.round(delay)}ms...`,
      );
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// Initialize and start server
async function startServer(): Promise<void> {
  try {
    console.log('[server] Initializing services...');

    // Initialize Qdrant collections — retry to absorb startup races (DNS, slow boot).
    // depends_on:service_started does not guarantee Qdrant is accepting connections yet.
    await retryWithBackoff('Qdrant initCollections', () => qdrantService.initCollections());
    console.log('[server] Qdrant collections initialized');

    // Initialize AST chunker (tree-sitter WASM grammars)
    const astReady = await initAstChunker();
    if (astReady) {
      console.log('[server] AST chunker initialized');
    } else {
      console.warn('[server] AST chunker unavailable — using sliding window fallback');
    }

    // Check Ollama health
    const ollamaHealthy = await ollamaService.healthCheck();
    if (!ollamaHealthy) {
      console.warn('[server] Ollama health check failed - embedding service may not work');
    } else {
      console.log('[server] Ollama service healthy');
    }

    // Start Express server
    app.listen(PORT, () => {
      console.log(`[server] MCP Vector Memory Server running on port ${PORT}`);
      console.log(`[server] Health endpoint: http://localhost:${PORT}/health`);
      console.log(`[server] MCP endpoint: http://localhost:${PORT}/mcp`);
    });

    // Periodic cleanup of rate limiter buckets
    setInterval(() => {
      rateLimiter.cleanup();
    }, 60 * 60 * 1000); // Every hour

  } catch (error) {
    console.error('[server] Failed to start:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('[server] Received SIGTERM, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[server] Received SIGINT, shutting down...');
  process.exit(0);
});

startServer();
