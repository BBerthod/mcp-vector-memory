// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QdrantClient } from '@qdrant/js-client-rest';
import { startQdrant, type RunningQdrant } from '../test/qdrant.js';
import { FakeOllama } from '../test/fake-ollama.js';

describe('update_memory', () => {
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
    const tools = await connectTools({
      qdrant: service,
      ollama: new FakeOllama(),
      authContext: { token: 't', name: 'tester', allowedProjects: ['p1'] },
    });
    return { tools, service };
  }

  async function readPoint(id: string) {
    const raw = new QdrantClient({ url: qdrantContainer.url });
    const [point] = await raw.retrieve('memory', { ids: [id], with_payload: true, with_vector: true });
    return point as { vector: Record<string, any>; payload: Record<string, any> };
  }

  it('updates the changed fields, both vectors and keeps the other payload fields', async () => {
    const { tools } = await setup();
    try {
      const saved = await tools.call('remember', {
        project: 'p1', type: 'decision', summary: 'Use the old queue', tags: ['queue', 'infra'],
      });
      const before = await readPoint(saved.id);

      const res = await tools.call('update_memory', { id: saved.id, version: 1, summary: 'Use the new queue' });
      assert.equal(res.status, 'updated', JSON.stringify(res));

      const after = await readPoint(saved.id);
      assert.equal(after.payload.summary, 'Use the new queue');
      assert.equal(after.payload.version, 2);
      assert.deepEqual(after.payload.tags, ['queue', 'infra']);
      assert.equal(after.payload.project, 'p1');
      assert.equal(after.payload.created_at, before.payload.created_at);
      assert.notEqual(after.payload.content_hash, before.payload.content_hash);
      assert.notDeepEqual(after.vector.dense, before.vector.dense);
      assert.notDeepEqual(after.vector.bm25, before.vector.bm25);
      assert.ok(after.vector.bm25, 'bm25 present after update');
    } finally {
      await tools.close();
    }
  });

  it('does not undo a forget that happens between the read and the write', async () => {
    const { tools, service } = await setup();
    try {
      const saved = await tools.call('remember', {
        project: 'p1', type: 'decision', summary: 'Race condition subject', tags: ['race', 'forget'],
      });

      // Simulate a concurrent forget landing right after update_memory read the point.
      const realGetById = service.getById.bind(service);
      service.getById = async (collection, id) => {
        const point = await realGetById(collection, id);
        await service.setPayload(collection, id, { deleted_at: '2026-01-01T00:00:00.000Z', deletion_reason: 'concurrent' });
        return point;
      };

      const res = await tools.call('update_memory', { id: saved.id, version: 1, summary: 'Race condition subject, edited' });
      assert.equal(res.status, 'updated', JSON.stringify(res));

      const after = await readPoint(saved.id);
      assert.equal(after.payload.deleted_at, '2026-01-01T00:00:00.000Z', `forget was undone: ${JSON.stringify(after.payload)}`);
      assert.equal(after.payload.deletion_reason, 'concurrent');
      assert.equal(after.payload.summary, 'Race condition subject, edited');
    } finally {
      await tools.close();
    }
  });
});
