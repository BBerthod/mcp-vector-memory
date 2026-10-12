// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

describe('createTokenStore', () => {
  const valid = () => ({
    'tok-alpha-123': { name: 'alpha', projects: ['p1', 'p2'] },
    'tok-root-456': { name: 'root', projects: ['p1'], role: 'admin' },
    'tok-fake-789': { name: 'admin-x', projects: ['p1'] },
  });

  it('finds a valid token and returns its info', async () => {
    const { createTokenStore } = await import('../services/token-store.js');
    const store = createTokenStore(valid());
    assert.deepEqual(store.getTokenInfo('tok-alpha-123'), { name: 'alpha', projects: ['p1', 'p2'] });
    assert.deepEqual(store.getProjectsForToken('tok-alpha-123'), ['p1', 'p2']);
  });

  it('returns null / no projects for an unknown token', async () => {
    const { createTokenStore } = await import('../services/token-store.js');
    const store = createTokenStore(valid());
    assert.equal(store.getTokenInfo('nope'), null);
    assert.deepEqual(store.getProjectsForToken('nope'), []);
    assert.equal(store.getTokenInfo(''), null);
  });

  it('never matches keys inherited from the prototype', async () => {
    const { createTokenStore } = await import('../services/token-store.js');
    const store = createTokenStore(valid());
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(store.getTokenInfo(key), null, key);
      assert.deepEqual(store.getProjectsForToken(key), [], key);
    }
  });

  it('rejects malformed entries with a clear error that does not echo the token', async () => {
    const { createTokenStore } = await import('../services/token-store.js');
    const secret = 'super-secret-token-value';
    const bad: unknown[] = [
      { [secret]: 'not-an-object' },
      { [secret]: { name: 42, projects: ['p1'] } },
      { [secret]: { name: '', projects: ['p1'] } },
      { [secret]: { name: 'x', projects: 'p1' } },
      { [secret]: { name: 'x', projects: [1] } },
      { [secret]: { name: 'x', projects: ['p1'], role: 'root' } },
      { [secret]: null },
    ];
    for (const raw of bad) {
      assert.throws(
        () => createTokenStore(raw),
        (err: Error) => /auth\.tokens/.test(err.message) && !err.message.includes(secret),
        JSON.stringify(raw),
      );
    }
    assert.throws(() => createTokenStore([]), /auth\.tokens/);
  });

  it('is admin only through an explicit role', async () => {
    const { createTokenStore } = await import('../services/token-store.js');
    const store = createTokenStore(valid());
    assert.equal(store.getTokenInfo('tok-root-456')?.role, 'admin');
    assert.equal(store.getTokenInfo('tok-fake-789')?.role, undefined);
  });
});

describe('requireAdminToken', () => {
  it('rejects names containing admin and "*" projects, accepts role admin', async () => {
    const { createTokenStore } = await import('../services/token-store.js');
    const { requireAdminToken } = await import('../services/auth.js');
    const store = createTokenStore({
      'tok-root-456': { name: 'root', projects: ['p1'], role: 'admin' },
      'tok-name-111': { name: 'Admin-Person', projects: ['p1'] },
      'tok-star-222': { name: 'star', projects: ['*'] },
    });
    assert.doesNotThrow(() => requireAdminToken('tok-root-456', store));
    assert.throws(() => requireAdminToken('tok-name-111', store), /Admin privileges required/);
    assert.throws(() => requireAdminToken('tok-star-222', store), /Admin privileges required/);
    assert.throws(() => requireAdminToken('constructor', store), /Invalid token/);
  });
});

describe('HTTP authentication', () => {
  let server: Server;
  let base: string;

  before(async () => {
    const { createApp } = await import('../app.js');
    const { RateLimiter } = await import('../services/security.js');
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

  it('answers 401 to prototype keys used as bearer tokens', async () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.equal(res.status, 401, `Bearer ${key} -> ${res.status}`);
    }
  });
});
