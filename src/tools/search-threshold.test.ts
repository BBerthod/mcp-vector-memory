// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startQdrant, type RunningQdrant } from '../test/qdrant.js';
import { FakeOllama } from '../test/fake-ollama.js';

describe('search threshold on the dense prefetch', () => {
  let qdrantContainer: RunningQdrant;

  before(async () => {
    qdrantContainer = await startQdrant();
  });

  after(async () => {
    await qdrantContainer?.stop();
  });

  async function setup() {
    const { QdrantService } = await import('../services/qdrant.js');
    const { connectTools } = await import('../test/mcp-harness.js');
    const service = new QdrantService(qdrantContainer.url);
    await service.initCollections();
    const ollama = new FakeOllama();
    // The query shares no term with the stored summaries: only the dense prefetch can return them.
    const query = 'zzqq';
    ollama.setVector(query, [1, 0, 0, 0, 0, 0, 0, 0]);
    const near = '00000000-0000-4000-8000-0000000000b1';
    const far = '00000000-0000-4000-8000-0000000000b2';
    await service.upsertHybrid('memory', [
      { id: near, denseVector: [0.95, 0.312, 0, 0, 0, 0, 0, 0], payload: { project: 'p1', type: 'decision', summary: 'alpha beta', deleted_at: null } },
      { id: far, denseVector: [0.2, 0.98, 0, 0, 0, 0, 0, 0], payload: { project: 'p1', type: 'decision', summary: 'gamma delta', deleted_at: null } },
    ]);
    const tools = await connectTools({
      qdrant: service,
      ollama,
      authContext: { token: 't', name: 'tester', allowedProjects: ['p1'] },
    });
    return { tools, query, near, far };
  }

  const idsOf = (found: unknown) => (found as Array<{ id: string }>).map((r) => r.id).sort();

  it('excludes weak dense candidates with threshold 0.9 and keeps them without a threshold', async () => {
    const { tools, query, near, far } = await setup();
    try {
      const all = await tools.call('search', { query, collections: ['memory'] });
      assert.deepEqual(idsOf(all), [near, far].sort());

      const strict = await tools.call('search', { query, collections: ['memory'], threshold: 0.9 });
      assert.deepEqual(idsOf(strict), [near]);
    } finally {
      await tools.close();
    }
  });

  it('falls back to the project threshold for the collection when a project is given', async () => {
    const { tools, query, near, far } = await setup();
    try {
      // 'p1' has no configured threshold: the memory default (0.50) applies; far scores about 0.2.
      const withProject = await tools.call('search', { query, collections: ['memory'], project: 'p1' });
      assert.deepEqual(idsOf(withProject), [near]);

      // An explicit threshold wins over the project threshold.
      const explicit = await tools.call('search', { query, collections: ['memory'], project: 'p1', threshold: 0 });
      assert.deepEqual(idsOf(explicit), [near, far].sort());
    } finally {
      await tools.close();
    }
  });
});
