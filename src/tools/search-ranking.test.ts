// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startQdrant, type RunningQdrant } from '../test/qdrant.js';
import { FakeOllama } from '../test/fake-ollama.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('search ranking', () => {
  let qdrantContainer: RunningQdrant;

  before(async () => {
    qdrantContainer = await startQdrant();
  });

  after(async () => {
    await qdrantContainer?.stop();
  });

  it('keeps fusion order: an old, better ranked memory stays ahead of a recent, lower ranked one', async () => {
    const { QdrantService } = await import('../services/qdrant.js');
    const { connectTools } = await import('../test/mcp-harness.js');
    const service = new QdrantService(qdrantContainer.url);
    await service.initCollections();
    const ollama = new FakeOllama();

    // The query shares no term with the stored summaries: only the dense list ranks them.
    const query = 'zzqq';
    const q = [1, 0, 0, 0, 0, 0, 0, 0];
    ollama.setVector(query, q);
    const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
    const ids = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
    const rows: Array<[string, number[], string]> = [
      [ids[0], [1, 0, 0, 0, 0, 0, 0, 0], ago(180)],
      [ids[1], [0.9, 0.436, 0, 0, 0, 0, 0, 0], ago(180)],
      [ids[2], [0.8, 0.6, 0, 0, 0, 0, 0, 0], ago(1)],
      [ids[3], [0.6, 0.8, 0, 0, 0, 0, 0, 0], ago(1)],
    ];
    await service.upsertHybrid('memory', rows.map(([id, v, created]) => ({
      id,
      denseVector: v,
      payload: { project: 'p1', type: 'decision', summary: `entry ${id.slice(-1)}`, created_at: created, deleted_at: null },
    })));

    const tools = await connectTools({
      qdrant: service,
      ollama,
      authContext: { token: 't', name: 'tester', allowedProjects: ['p1'] },
    });
    try {
      const found = await tools.call('search', { query, project: 'p1', collections: ['memory'], limit: 4 });
      const order = (found as Array<{ id: string; score: number }>).map((r) => r.id);
      assert.deepEqual(order, ids);
    } finally {
      await tools.close();
    }
  });
});
