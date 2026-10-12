// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startQdrant, type RunningQdrant } from '../test/qdrant.js';
import { FakeOllama } from '../test/fake-ollama.js';

const sha = (text: string) => crypto.createHash('sha256').update(text.toLowerCase().trim()).digest('hex');

describe('memory duplicate checks and content_hash', () => {
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

  it('recreating a forgotten entry is not blocked by the duplicate checks', async () => {
    const { tools } = await setup();
    try {
      const args = { project: 'p1', type: 'decision', summary: 'Deploy only on weekdays', tags: ['ops', 'deploy'] };
      const first = await tools.call('remember', args);
      assert.equal(first.status, 'created', JSON.stringify(first));
      const forgotten = await tools.call('forget', { id: first.id });
      assert.equal(forgotten.status, 'soft_deleted', JSON.stringify(forgotten));

      const again = await tools.call('remember', args);
      assert.equal(again.status, 'created', JSON.stringify(again));
      assert.notEqual(again.id, first.id);
    } finally {
      await tools.close();
    }
  });

  it('update_memory recomputes content_hash so the new summary is detected as duplicate', async () => {
    const { tools, service } = await setup();
    try {
      const saved = await tools.call('remember', {
        project: 'p1', type: 'pattern', summary: 'Use repository classes', tags: ['php', 'design'],
      });
      const newSummary = 'Use query objects for reads';
      const updated = await tools.call('update_memory', { id: saved.id, version: 1, summary: newSummary });
      assert.equal(updated.status, 'updated', JSON.stringify(updated));

      const point = await service.getById('memory', saved.id);
      assert.equal(point?.payload.content_hash, sha(newSummary));

      const dup = await tools.call('remember', { project: 'p1', type: 'pattern', summary: newSummary, tags: ['php', 'design'] });
      assert.equal(dup.status, 'duplicate_found', JSON.stringify(dup));
      assert.equal(dup.id, saved.id);
    } finally {
      await tools.close();
    }
  });

  it('update_memory rejects a type outside the remember enum', async () => {
    const { tools } = await setup();
    try {
      const saved = await tools.call('remember', {
        project: 'p1', type: 'issue', summary: 'Flaky login test', tags: ['tests', 'auth'],
      });
      const res = await tools.call('update_memory', { id: saved.id, version: 1, type: "n'importe quoi" });
      assert.equal(res.isError, true, JSON.stringify(res));
      const point = (await tools.call('search', { query: 'Flaky login test', project: 'p1', collections: ['memory'] }))[0];
      assert.equal(point.payload.type, 'issue');
    } finally {
      await tools.close();
    }
  });
});
