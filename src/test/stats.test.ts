// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startQdrant, type RunningQdrant } from './qdrant.js';
import { FakeOllama } from './fake-ollama.js';

describe('stats tool', () => {
  let qdrantContainer: RunningQdrant;
  let url: string;

  before(async () => {
    qdrantContainer = await startQdrant();
    url = qdrantContainer.url;
  });

  after(async () => {
    await qdrantContainer?.stop();
  });

  async function connect(allowedProjects: string[]) {
    const { QdrantService } = await import('../services/qdrant.js');
    const { connectTools } = await import('./mcp-harness.js');
    const service = new QdrantService(url);
    await service.initCollections();
    return connectTools({
      qdrant: service,
      ollama: new FakeOllama(),
      authContext: { token: 't', name: 'tester', allowedProjects },
    });
  }

  it("scopes counts to the caller's projects and refuses other projects without a count", async () => {
    const writer = await connect(['p1', 'p2']);
    try {
      for (const summary of ['p1 first note', 'p1 second note']) {
        const saved = await writer.call('remember', { project: 'p1', type: 'decision', summary, tags: ['stats', 'scope'] });
        assert.equal(saved.status, 'created', JSON.stringify(saved));
      }
      for (const summary of ['p2 first note', 'p2 second note', 'p2 third note']) {
        const saved = await writer.call('remember', { project: 'p2', type: 'decision', summary, tags: ['stats', 'scope'] });
        assert.equal(saved.status, 'created', JSON.stringify(saved));
      }
    } finally {
      await writer.close();
    }

    const tools = await connect(['p1']);
    try {
      const own = await tools.call('stats', {});
      assert.equal(own.collections.memory.count, 2, JSON.stringify(own));

      const ownExplicit = await tools.call('stats', { project: 'p1' });
      assert.equal(ownExplicit.collections.memory.count, 2, JSON.stringify(ownExplicit));

      // tools.call() drops isError for JSON payloads, so use the raw client here.
      const denied: any = await tools.client.callTool({ name: 'stats', arguments: { project: 'p2' } });
      const deniedText = JSON.stringify(denied);
      assert.equal(denied.isError, true, deniedText);
      assert.ok(!deniedText.includes('count'), deniedText);
      assert.ok(!deniedText.includes('collections'), deniedText);
    } finally {
      await tools.close();
    }
  });
});
