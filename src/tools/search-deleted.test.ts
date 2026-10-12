// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startQdrant, type RunningQdrant } from '../test/qdrant.js';
import { FakeOllama } from '../test/fake-ollama.js';

describe('search default filter on deleted_at', () => {
  let qdrantContainer: RunningQdrant;

  before(async () => {
    qdrantContainer = await startQdrant();
  });

  after(async () => {
    await qdrantContainer?.stop();
  });

  it('returns code points (no deleted_at field) and active memories, not forgotten ones', async () => {
    const { QdrantService } = await import('../services/qdrant.js');
    const { connectTools } = await import('../test/mcp-harness.js');
    const { encodeSparse } = await import('../services/sparse-encoder.js');
    const service = new QdrantService(qdrantContainer.url);
    await service.initCollections();
    const ollama = new FakeOllama();

    const tools = await connectTools({
      qdrant: service,
      ollama,
      authContext: { token: 't', name: 'tester', allowedProjects: ['p1'] },
    });
    try {
      const codeId = '11111111-1111-4111-8111-111111111111';
      const content = 'function computeInvoiceTotal() { return 42; }';
      await service.upsertHybrid('code', [{
        id: codeId,
        denseVector: await ollama.embed(content),
        sparseVector: encodeSparse(content),
        payload: { project: 'p1', file_path: 'a.ts', content, type: 'block' },
      }]);

      const active = await tools.call('remember', {
        project: 'p1', type: 'decision', summary: 'Keep invoice totals in cents', tags: ['billing', 'money'],
      });
      const gone = await tools.call('remember', {
        project: 'p1', type: 'decision', summary: 'Round invoice totals up always', tags: ['billing', 'money'],
      });
      const forgotten = await tools.call('forget', { id: gone.id, reason: 'obsolete' });
      assert.equal(forgotten.status, 'soft_deleted', JSON.stringify(forgotten));

      const found = await tools.call('search', { query: 'invoice totals', project: 'p1', limit: 10 });
      const ids = (found as Array<{ id: string }>).map((r) => r.id);
      assert.ok(ids.includes(codeId), `code point missing: ${JSON.stringify(ids)}`);
      assert.ok(ids.includes(active.id), `active memory missing: ${JSON.stringify(ids)}`);
      assert.ok(!ids.includes(gone.id), `forgotten memory returned: ${JSON.stringify(ids)}`);
    } finally {
      await tools.close();
    }
  });
});
