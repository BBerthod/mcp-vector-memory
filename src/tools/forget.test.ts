// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QdrantClient } from '@qdrant/js-client-rest';
import { startQdrant, type RunningQdrant } from '../test/qdrant.js';
import { FakeOllama } from '../test/fake-ollama.js';

describe('forget soft delete', () => {
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
    const tools = await connectTools({
      qdrant: service,
      ollama,
      authContext: { token: 't', name: 'tester', allowedProjects: ['p1'] },
    });
    return { tools, ollama };
  }

  async function readVectors(id: string) {
    const raw = new QdrantClient({ url: qdrantContainer.url });
    const [point] = await raw.retrieve('memory', { ids: [id], with_payload: true, with_vector: true });
    return point as { vector: Record<string, unknown>; payload: Record<string, unknown> };
  }

  it('by id keeps dense and bm25 vectors and does not re-embed', async () => {
    const { tools, ollama } = await setup();
    try {
      const summary = 'Adopt strict null checks everywhere';
      const saved = await tools.call('remember', { project: 'p1', type: 'decision', summary, tags: ['ts', 'config'] });
      const before = await readVectors(saved.id);
      assert.ok(before.vector.bm25, 'bm25 present before forget');

      ollama.calls.length = 0;
      const res = await tools.call('forget', { id: saved.id, reason: 'obsolete' });
      assert.equal(res.status, 'soft_deleted', JSON.stringify(res));

      const after = await readVectors(saved.id);
      assert.ok(after.vector.bm25, 'bm25 must survive the soft delete');
      assert.deepEqual(after.vector.dense, before.vector.dense);
      assert.deepEqual(after.vector.bm25, before.vector.bm25);
      assert.ok(typeof after.payload.deleted_at === 'string');
      assert.equal(after.payload.deletion_reason, 'obsolete');
      assert.equal(after.payload.summary, summary);
      assert.ok(!ollama.calls.includes(summary), `summary was re-embedded: ${JSON.stringify(ollama.calls)}`);
    } finally {
      await tools.close();
    }
  });

  it('by query keeps dense and bm25 vectors and does not re-embed the summary', async () => {
    const { tools, ollama } = await setup();
    try {
      const summary = 'Prefer composition over inheritance in services';
      const saved = await tools.call('remember', { project: 'p1', type: 'pattern', summary, tags: ['oop', 'design'] });
      const before = await readVectors(saved.id);
      ollama.setVector('which one to drop', before.vector.dense as number[]);

      ollama.calls.length = 0;
      const res = await tools.call('forget', { query: 'which one to drop', project: 'p1' });
      assert.equal(res.status, 'soft_deleted', JSON.stringify(res));

      const after = await readVectors(saved.id);
      assert.ok(after.vector.bm25, 'bm25 must survive the soft delete');
      assert.deepEqual(after.vector.dense, before.vector.dense);
      assert.ok(typeof after.payload.deleted_at === 'string');
      assert.ok(!ollama.calls.includes(summary), `summary was re-embedded: ${JSON.stringify(ollama.calls)}`);
    } finally {
      await tools.close();
    }
  });
});
