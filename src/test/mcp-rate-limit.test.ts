// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { startQdrant, type RunningQdrant } from './qdrant.js';
import { FakeOllama } from './fake-ollama.js';

describe('rate limiting of MCP tool calls', () => {
  let qdrantContainer: RunningQdrant;
  let qdrant: InstanceType<typeof import('../services/qdrant.js').QdrantService>;
  const servers: Server[] = [];

  before(async () => {
    qdrantContainer = await startQdrant();
    const { QdrantService } = await import('../services/qdrant.js');
    qdrant = new QdrantService(qdrantContainer.url);
    await qdrant.initCollections();
  });

  after(async () => {
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    await qdrantContainer?.stop();
  });

  // Starts the real app with a test authenticator and the given limiters.
  async function start(general: [number, number], write: [number, number]) {
    const { createApp } = await import('../app.js');
    const { RateLimiter } = await import('../services/security.js');
    const app = createApp(
      {
        qdrant,
        ollama: new FakeOllama() as never,
        rateLimiter: new RateLimiter(...general),
        writeRateLimiter: new RateLimiter(...write),
      },
      {
        authenticate: (req: Request, _res: Response, next: NextFunction) => {
          req.authContext = { token: 'test-token', name: 'tester', allowedProjects: ['p1'] };
          next();
        },
      },
    );
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let nextId = 1;
    const post = (body: unknown) =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body),
      });
    const call = (name: string, args: object) =>
      post({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
    return { post, call };
  }

  const remember = (n: number) => ({
    project: 'p1', type: 'decision', summary: `rate limit note ${n}`, tags: ['rate', 'limit'],
  });

  it('refuses writes beyond the write budget while reads still pass', async () => {
    const { call, post } = await start([1000, 1000], [1, 2]);
    assert.equal((await call('remember', remember(1))).status, 200);
    assert.equal((await call('remember', remember(2))).status, 200);

    const third = await call('remember', remember(3));
    assert.equal(third.status, 429);
    const body: any = await third.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.error.code, -32029);
    assert.equal(body.error.message, 'Rate limit exceeded');
    assert.ok(body.error.data.resetAt, JSON.stringify(body));
    assert.ok(typeof body.id === 'number', JSON.stringify(body));

    assert.equal((await call('search', { query: 'note', project: 'p1' })).status, 200);
    const list = await post({ jsonrpc: '2.0', id: 99, method: 'tools/list' });
    assert.equal(list.status, 200);
  });

  it('applies the general budget to every tool call but not to other methods', async () => {
    const { call, post } = await start([1, 2], [1000, 1000]);
    for (let i = 0; i < 5; i++) {
      assert.equal((await post({ jsonrpc: '2.0', id: 100 + i, method: 'tools/list' })).status, 200);
    }
    assert.equal((await call('search', { query: 'a', project: 'p1' })).status, 200);
    assert.equal((await call('search', { query: 'b', project: 'p1' })).status, 200);
    assert.equal((await call('search', { query: 'c', project: 'p1' })).status, 429);
  });

  it('counts every tools/call of a JSON-RPC batch', async () => {
    const { post } = await start([1000, 1000], [1, 2]);
    const batch = [1, 2, 3].map((n) => ({
      jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'remember', arguments: remember(n + 10) },
    }));
    assert.equal((await post(batch)).status, 429);
  });
});
