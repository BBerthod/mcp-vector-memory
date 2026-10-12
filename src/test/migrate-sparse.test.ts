// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QdrantClient } from '@qdrant/js-client-rest';
import { startQdrant, type RunningQdrant } from './qdrant.js';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('scripts/migrate-sparse.ts', () => {
  let qdrantContainer: RunningQdrant;
  let raw: QdrantClient;
  const dense = [1, 0, 0, 0, 0, 0, 0, 0];
  const memoryId = '00000000-0000-4000-8000-0000000000d1';
  const codeId = '00000000-0000-4000-8000-0000000000d2';

  // Old encoding: accents kept, no stopword removal, unit weights.
  async function oldSparse(text: string) {
    const { tokenToIndex } = await import('../services/sparse-encoder.js');
    const tokens = [...new Set(text.toLowerCase().split(/\s+/))];
    return { indices: tokens.map(tokenToIndex), values: tokens.map(() => 1) };
  }

  async function script(args: string[]): Promise<{ code: number; out: string }> {
    try {
      const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', 'scripts/migrate-sparse.ts', ...args], {
        cwd: root,
        env: { ...process.env, QDRANT_URL: qdrantContainer.url },
      });
      return { code: 0, out: stdout + stderr };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  async function readPoint(collection: string, id: string) {
    const [point] = await raw.retrieve(collection, { ids: [id], with_payload: true, with_vector: true });
    return point as { vector: Record<string, any>; payload: Record<string, unknown> };
  }

  before(async () => {
    qdrantContainer = await startQdrant();
    raw = new QdrantClient({ url: qdrantContainer.url });
    for (const name of ['code', 'memory']) {
      await raw.createCollection(name, {
        vectors: { dense: { size: 8, distance: 'Cosine' } },
        sparse_vectors: { bm25: {} },
      });
    }
    const summary = 'Décision prise pour la facturation';
    const content = 'function calculerTotal() { return 1; }';
    await raw.upsert('memory', { wait: true, points: [{
      id: memoryId, vector: { dense, bm25: await oldSparse(summary) }, payload: { project: 'p1', summary },
    }] });
    await raw.upsert('code', { wait: true, points: [{
      id: codeId, vector: { dense, bm25: await oldSparse(content) }, payload: { project: 'p1', content },
    }] });
  });

  after(async () => {
    await qdrantContainer?.stop();
  });

  it('refuses without a snapshot, and with an unknown snapshot', async () => {
    const none = await script(['--apply']);
    assert.notEqual(none.code, 0);
    assert.match(none.out, /--snapshot/);

    const unknown = await script(['--snapshot', 'does-not-exist', '--apply']);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.out, /aucun instantané/i);

    const point = await readPoint('memory', memoryId);
    assert.equal(point.payload.sparse_version, undefined);
  });

  it('dry-run changes nothing, then apply re-encodes, keeps dense and is idempotent', async () => {
    const memorySnapshot = await raw.createSnapshot('memory');
    await raw.createSnapshot('code');
    assert.ok(memorySnapshot, 'snapshot created');
    // Qdrant names snapshots <collection>-<peer id>-<timestamp>.snapshot: the peer id is shared.
    const shared = memorySnapshot.name.split('-')[1];

    const beforePoint = await readPoint('memory', memoryId);

    const dry = await script(['--snapshot', shared]);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /'memory' : 1 points, 1 à ré-encoder/);
    assert.match(dry.out, /'code' : 1 points, 1 à ré-encoder/);
    const afterDry = await readPoint('memory', memoryId);
    assert.deepEqual(afterDry.vector, beforePoint.vector);
    assert.equal(afterDry.payload.sparse_version, undefined);
    assert.equal((await raw.getCollection('memory')).config.params.sparse_vectors?.bm25?.modifier ?? 'none', 'none');

    const { QdrantService } = await import('../services/qdrant.js');
    const { encodeSparseQuery } = await import('../services/sparse-encoder.js');
    const service = new QdrantService(qdrantContainer.url);
    assert.deepEqual(await service.sparseSearch('memory', encodeSparseQuery('decision'), { limit: 3 }), []);

    const applied = await script(['--snapshot', shared, '--apply']);
    assert.equal(applied.code, 0, applied.out);

    for (const name of ['code', 'memory']) {
      assert.equal((await raw.getCollection(name)).config.params.sparse_vectors?.bm25?.modifier, 'idf');
    }
    const afterApply = await readPoint('memory', memoryId);
    assert.deepEqual(afterApply.vector.dense, beforePoint.vector.dense);
    assert.equal(afterApply.payload.sparse_version, 2);
    const hits = await service.sparseSearch('memory', encodeSparseQuery('decision'), { limit: 3 });
    assert.deepEqual(hits.map((h) => h.id), [memoryId]);
    const codeHits = await service.sparseSearch('code', encodeSparseQuery('calculer'), { limit: 3 });
    assert.deepEqual(codeHits.map((h) => h.id), [codeId]);

    const again = await script(['--snapshot', shared, '--apply']);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /0 points ré-encodés/);
    assert.equal((await raw.getCollection('memory')).points_count, 1);
  });

  it('requires a long enough snapshot fragment and a recent snapshot', async () => {
    const snapshots = await raw.listSnapshots('memory');
    assert.ok(snapshots.length > 0, 'a snapshot exists');
    const shared = snapshots[0].name.split('-')[1];
    assert.ok(shared.length >= 8, `peer id fragment is long enough: ${shared}`);

    const tooShort = await script(['--snapshot', shared.slice(0, 4)]);
    assert.notEqual(tooShort.code, 0, tooShort.out);
    assert.match(tooShort.out, /au moins 8 caractères/);

    const tooOld = await script(['--snapshot', shared, '--max-snapshot-age-hours', '0']);
    assert.notEqual(tooOld.code, 0, tooOld.out);
    assert.match(tooOld.out, /trop ancien/i);

    const nominal = await script(['--snapshot', shared, '--max-snapshot-age-hours', '24']);
    assert.equal(nominal.code, 0, nominal.out);
  });
});
