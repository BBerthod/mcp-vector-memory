// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startQdrant, type RunningQdrant } from '../test/qdrant.js';

describe('QdrantService.sparseSearch', () => {
  let qdrantContainer: RunningQdrant;

  before(async () => {
    qdrantContainer = await startQdrant();
  });

  after(async () => {
    await qdrantContainer?.stop();
  });

  it('ranks points by sparse similarity on Qdrant 1.13.2', async () => {
    const { QdrantService } = await import('../services/qdrant.js');
    const { encodeSparse, encodeSparseQuery } = await import('../services/sparse-encoder.js');
    const service = new QdrantService(qdrantContainer.url);
    await service.initCollections();
    const vec = [1, 0, 0, 0, 0, 0, 0, 0];
    const hit = '00000000-0000-4000-8000-0000000000c1';
    const miss = '00000000-0000-4000-8000-0000000000c2';
    await service.upsertHybrid('memory', [
      { id: hit, denseVector: vec, sparseVector: encodeSparse('invoice rounding rules'), payload: { project: 'p1', summary: 'hit' } },
      { id: miss, denseVector: vec, sparseVector: encodeSparse('weekend deployment freeze'), payload: { project: 'p1', summary: 'miss' } },
    ]);

    const results = await service.sparseSearch('memory', encodeSparseQuery('invoice'), { limit: 5 });
    assert.deepEqual(results.map((r) => r.id), [hit]);
  });
});
