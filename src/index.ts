import { config } from './config.js';
import { QdrantService, CollectionSchemaMismatchError } from './services/qdrant.js';
import { OllamaService } from './services/ollama.js';
import { RateLimiter } from './services/security.js';
import { initAstChunker } from './services/ast-chunker.js';
import { createApp } from './app.js';

const PORT = process.env.PORT || 3100;

// Initialize services
const qdrantService = new QdrantService(config.qdrantUrl, config.qdrantApiKey);
const ollamaService = new OllamaService(config.ollamaUrl, config.embedModelCode, config.embedModelText);
const rateLimiter = new RateLimiter(config.rateLimitPerHour, config.rateLimitBurst);

const writeRateLimiter = new RateLimiter(config.rateLimitWritePerHour, config.rateLimitWriteBurst);

const app = createApp({ qdrant: qdrantService, ollama: ollamaService, rateLimiter, writeRateLimiter });

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
      // A schema mismatch is not transient: fail immediately instead of retrying.
      if (error instanceof CollectionSchemaMismatchError) throw error;
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

    // Opt-in permanent purge of soft-deleted memories (disabled unless PURGE_DELETED_AFTER_DAYS is a positive integer)
    const purgeRaw = process.env.PURGE_DELETED_AFTER_DAYS;
    const purgeDays = purgeRaw && /^\d+$/.test(purgeRaw.trim()) ? parseInt(purgeRaw.trim(), 10) : 0;
    if (purgeDays > 0) {
      const runPurge = (): void => {
        qdrantService.purgeDeleted('memory', purgeDays)
          .then(() => console.info(`[server] Purged memory entries soft-deleted more than ${purgeDays} days ago`))
          .catch((err) => console.error('[server] Purge of deleted entries failed:', err));
      };
      runPurge();
      setInterval(runPurge, 24 * 60 * 60 * 1000);
    } else {
      console.info('[server] Purge of soft-deleted entries disabled (PURGE_DELETED_AFTER_DAYS unset or not a positive integer)');
    }

    // Periodic cleanup of rate limiter buckets
    setInterval(() => {
      rateLimiter.cleanup();
      writeRateLimiter.cleanup();
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
