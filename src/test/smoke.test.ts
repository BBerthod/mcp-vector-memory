// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startQdrant, type RunningQdrant } from './qdrant.js';
import { FakeOllama } from './fake-ollama.js';

describe('smoke', () => {
  let qdrantContainer: RunningQdrant;
  let url: string;

  before(async () => {
    qdrantContainer = await startQdrant();
    url = qdrantContainer.url;
  });

  after(async () => {
    await qdrantContainer?.stop();
  });

  it('creates the three collections with dense 8 + bm25 sparse', async () => {
    const { QdrantService } = await import('../services/qdrant.js');
    const { QdrantClient } = await import('@qdrant/js-client-rest');
    const service = new QdrantService(url);
    await service.initCollections();

    const raw = new QdrantClient({ url });
    for (const name of ['code', 'docs', 'memory']) {
      const info = await raw.getCollection(name);
      const vectors = info.config.params.vectors as Record<string, { size: number }>;
      const dense = Object.values(vectors).find((v) => typeof v?.size === 'number');
      assert.equal(dense?.size, 8, `${name} dense size`);
      assert.ok(info.config.params.sparse_vectors?.bm25, `${name} has bm25 sparse vector`);
    }
  });

  it('remember then search returns the entry', async () => {
    const { QdrantService } = await import('../services/qdrant.js');
    const { connectTools } = await import('./mcp-harness.js');
    const service = new QdrantService(url);
    await service.initCollections();

    const tools = await connectTools({
      qdrant: service,
      ollama: new FakeOllama(),
      authContext: { token: 't', name: 'tester', allowedProjects: ['p1'] },
    });
    try {
      const summary = 'Use pnpm workspaces for the monorepo';
      const saved = await tools.call('remember', {
        project: 'p1',
        type: 'decision',
        summary,
        tags: ['tooling', 'monorepo'],
      });
      assert.ok(!saved.error, JSON.stringify(saved));

      const found = await tools.call('search', { query: summary, project: 'p1', collections: ['memory'], threshold: 0 });
      assert.ok(JSON.stringify(found).includes(summary), JSON.stringify(found));
    } finally {
      await tools.close();
    }
  });
});
