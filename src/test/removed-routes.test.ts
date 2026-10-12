// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

describe('endpoints that acknowledged without acting', () => {
  let server: Server;
  let base: string;
  let firstProject: string;

  before(async () => {
    const { createApp } = await import('../app.js');
    const { config } = await import('../config.js');
    const { RateLimiter } = await import('../services/security.js');
    firstProject = Object.keys(config.projects)[0] ?? 'unknown-project';
    // These routes never reach the services, so stubs are enough.
    const app = createApp({
      qdrant: {} as never,
      ollama: {} as never,
      rateLimiter: new RateLimiter(1000, 1000),
      writeRateLimiter: new RateLimiter(1000, 1000),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('answers 404 on the removed webhook and indexing routes', async () => {
    const paths = [
      '/webhooks/file-changed',
      '/webhooks/commit',
      `/webhooks/git/${firstProject}`,
      '/api/index-repo',
      '/api/index-doc',
    ];
    for (const path of paths) {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: firstProject }),
      });
      assert.equal(res.status, 404, `${path} -> ${res.status}`);
    }
  });

  it('keeps /mcp and the project deletion route behind authentication', async () => {
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(mcp.status, 401);
    const del = await fetch(`${base}/api/project/x`, { method: 'DELETE' });
    assert.equal(del.status, 401);
  });
});
