// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startQdrant, type RunningQdrant } from '../test/qdrant.js';

describe('QdrantService.search uses the query API', () => {
  let qdrantContainer: RunningQdrant;

  before(async () => {
    qdrantContainer = await startQdrant();
  });

  after(async () => {
    await qdrantContainer?.stop();
  });

  it('works when the legacy search endpoint is gone (fake client)', async () => {
    const { QdrantService } = await import('../services/qdrant.js');
    const queryCalls: Array<[string, Record<string, unknown>]> = [];
    const fake = {
      search: async () => { throw new Error('404 endpoint removed'); },
      query: async (collection: string, params: Record<string, unknown>) => {
        queryCalls.push([collection, params]);
        return { points: [{ id: 'abc', score: 0.9, payload: { summary: 's' } }] };
      },
    };
    const service = new QdrantService('http://unused', undefined, { client: fake as never });

    const results = await service.search('memory', [1, 0, 0, 0, 0, 0, 0, 0], {
      filter: { must: [] }, limit: 3, threshold: 0.5,
    });

    assert.deepEqual(results, [{ id: 'abc', score: 0.9, payload: { summary: 's' } }]);
    assert.equal(queryCalls.length, 1);
    assert.equal(queryCalls[0][0], 'memory');
    assert.equal(queryCalls[0][1].using, 'dense');
    assert.equal(queryCalls[0][1].limit, 3);
    assert.equal(queryCalls[0][1].score_threshold, 0.5);
    assert.deepEqual(queryCalls[0][1].filter, { must: [] });
  });

  it('returns ranked results and respects the threshold on Qdrant 1.13.2', async () => {
    const { QdrantService } = await import('../services/qdrant.js');
    const service = new QdrantService(qdrantContainer.url);
    await service.initCollections();
    await service.upsertHybrid('memory', [
      { id: '00000000-0000-4000-8000-000000000001', denseVector: [1, 0, 0, 0, 0, 0, 0, 0], payload: { project: 'p1', summary: 'exact' } },
      { id: '00000000-0000-4000-8000-000000000002', denseVector: [0.6, 0.8, 0, 0, 0, 0, 0, 0], payload: { project: 'p1', summary: 'close' } },
      { id: '00000000-0000-4000-8000-000000000003', denseVector: [0, 1, 0, 0, 0, 0, 0, 0], payload: { project: 'p1', summary: 'far' } },
    ]);

    const all = await service.search('memory', [1, 0, 0, 0, 0, 0, 0, 0], { limit: 10 });
    assert.deepEqual(all.map((r) => r.payload.summary), ['exact', 'close', 'far']);
    assert.ok(Math.abs(all[0].score - 1) < 1e-3);

    const filtered = await service.search('memory', [1, 0, 0, 0, 0, 0, 0, 0], { limit: 10, threshold: 0.5 });
    assert.deepEqual(filtered.map((r) => r.payload.summary), ['exact', 'close']);

    const strict = await service.search('memory', [1, 0, 0, 0, 0, 0, 0, 0], { limit: 10, threshold: 0.9 });
    assert.deepEqual(strict.map((r) => r.payload.summary), ['exact']);
  });
});
