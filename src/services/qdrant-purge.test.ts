// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startQdrant, type RunningQdrant } from '../test/qdrant.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('QdrantService.purgeDeleted', () => {
  let qdrantContainer: RunningQdrant;

  before(async () => {
    qdrantContainer = await startQdrant();
  });

  after(async () => {
    await qdrantContainer?.stop();
  });

  it('removes only entries soft-deleted before the retention window', async () => {
    const { QdrantService } = await import('../services/qdrant.js');
    const service = new QdrantService(qdrantContainer.url);
    await service.initCollections();
    const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();
    const vec = [1, 0, 0, 0, 0, 0, 0, 0];
    const old = '00000000-0000-4000-8000-0000000000a1';
    const recent = '00000000-0000-4000-8000-0000000000a2';
    const active = '00000000-0000-4000-8000-0000000000a3';
    const noField = '00000000-0000-4000-8000-0000000000a4';
    await service.upsertHybrid('memory', [
      { id: old, denseVector: vec, payload: { project: 'p1', summary: 'old', deleted_at: daysAgo(40) } },
      { id: recent, denseVector: vec, payload: { project: 'p1', summary: 'recent', deleted_at: daysAgo(5) } },
      { id: active, denseVector: vec, payload: { project: 'p1', summary: 'active', deleted_at: null } },
      { id: noField, denseVector: vec, payload: { project: 'p1', summary: 'no field' } },
    ]);

    await service.purgeDeleted('memory', 30);

    assert.equal(await service.getById('memory', old), null, 'entry deleted 40 days ago must be purged');
    assert.ok(await service.getById('memory', recent), 'entry deleted 5 days ago must stay');
    assert.ok(await service.getById('memory', active), 'active entry must stay');
    assert.ok(await service.getById('memory', noField), 'entry without deleted_at must stay');
  });
});
