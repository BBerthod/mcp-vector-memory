// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QdrantClient } from '@qdrant/js-client-rest';
import { startQdrant, type RunningQdrant } from '../test/qdrant.js';

describe('ensureCollection schema mismatch', () => {
  let qdrantContainer: RunningQdrant;

  before(async () => {
    qdrantContainer = await startQdrant();
  });

  after(async () => {
    await qdrantContainer?.stop();
  });

  it('refuses a different dimension and keeps existing points', async () => {
    const mod = await import('../services/qdrant.js');
    const service = new mod.QdrantService(qdrantContainer.url);
    await service.initCollections();
    const id = '22222222-2222-4222-8222-222222222222';
    await service.upsertHybrid('memory', [{
      id,
      denseVector: [1, 0, 0, 0, 0, 0, 0, 0],
      payload: { project: 'p1', summary: 'keep me' },
    }]);

    const wider = new mod.QdrantService(qdrantContainer.url, undefined, { vectorSize: 16 });
    let error: unknown;
    await wider.initCollections().catch((e: unknown) => { error = e; });

    const point = await service.getById('memory', id);
    assert.ok(point, 'the existing point must survive a dimension mismatch');
    assert.ok(error instanceof mod.CollectionSchemaMismatchError, `expected CollectionSchemaMismatchError, got ${String(error)}`);
    assert.match(error.message, /'code'|'docs'|'memory'/);
    assert.match(error.message, /8/);
    assert.match(error.message, /16/);
    assert.match(error.message, /snapshot/i);
  });

  it('refuses an old anonymous-vector collection without deleting it', async () => {
    const mod = await import('../services/qdrant.js');
    const raw = new QdrantClient({ url: qdrantContainer.url });
    await raw.deleteCollection('docs');
    await raw.createCollection('docs', { vectors: { size: 8, distance: 'Cosine' } });
    await raw.upsert('docs', { wait: true, points: [{ id: 1, vector: [1, 0, 0, 0, 0, 0, 0, 0], payload: { a: 1 } }] });

    const service = new mod.QdrantService(qdrantContainer.url);
    let error: unknown;
    await service.initCollections().catch((e: unknown) => { error = e; });

    const info = await raw.getCollection('docs');
    assert.equal(info.points_count, 1, 'the anonymous-schema collection must not be deleted');
    assert.ok(error instanceof mod.CollectionSchemaMismatchError, `expected CollectionSchemaMismatchError, got ${String(error)}`);
  });
});
