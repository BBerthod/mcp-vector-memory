// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QdrantClient } from '@qdrant/js-client-rest';
import { startQdrant, type RunningQdrant } from '../test/qdrant.js';
import { FakeOllama } from '../test/fake-ollama.js';

describe('sparse encoding v2', () => {
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
    return { service, tools };
  }

  it('creates new collections with the IDF modifier on bm25', async () => {
    await setup();
    const raw = new QdrantClient({ url: qdrantContainer.url });
    for (const name of ['code', 'docs', 'memory']) {
      const info = await raw.getCollection(name);
      assert.equal(info.config.params.sparse_vectors?.bm25?.modifier, 'idf', `${name} modifier`);
    }
  });

  it('finds an accented memory with an unaccented query through sparse search alone', async () => {
    const { service, tools } = await setup();
    try {
      const saved = await tools.call('remember', {
        project: 'p1', type: 'decision', summary: 'Décision prise pour la facturation mensuelle', tags: ['billing', 'planning'],
      });
      const { encodeSparseQuery } = await import('../services/sparse-encoder.js');
      const hits = await service.sparseSearch('memory', encodeSparseQuery('decision'), { limit: 5 });
      assert.deepEqual(hits.map((h) => h.id), [saved.id]);
    } finally {
      await tools.close();
    }
  });

  it('tags every written point with sparse_version 2', async () => {
    const { service, tools } = await setup();
    try {
      const saved = await tools.call('remember', {
        project: 'p1', type: 'pattern', summary: 'Write sparse tagged entries', tags: ['sparse', 'version'],
      });
      assert.equal((await service.getById('memory', saved.id))?.payload.sparse_version, 2);

      await tools.call('update_memory', { id: saved.id, version: 1, summary: 'Write sparse tagged entries again' });
      assert.equal((await service.getById('memory', saved.id))?.payload.sparse_version, 2);

      await tools.call('index_file', {
        project: 'p1', relative_path: 'notes/readme.txt', content: 'alpha beta gamma\n', language: 'text',
      });
      let indexed: { payload: Record<string, unknown> } | undefined;
      for (let i = 0; i < 50 && !indexed; i++) {
        const page = await service.scroll('code', { limit: 1 });
        indexed = page.points[0];
        if (!indexed) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(indexed, 'index_file produced no point');
      assert.equal(indexed.payload.sparse_version, 2);
    } finally {
      await tools.close();
    }
  });
});
