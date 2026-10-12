// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { containsSecrets, redactSecrets } from './security.js';

const b64url = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('JWT pattern cost', () => {
  it('scans a long run of eyJ in under 200 ms', () => {
    const hostile = 'eyJ'.repeat(80000);
    const start = performance.now();
    containsSecrets(hostile);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 200, `took ${Math.round(elapsed)} ms`);
  });

  it('still detects and redacts a real JWT', () => {
    const jwt = [b64url({ alg: 'HS256', typ: 'JWT' }), b64url({ sub: '42', name: 'tester' }), 'c2lnbmF0dXJl'].join('.');
    for (const text of [jwt, `Authorization: ${jwt}`, `token="${jwt}"`]) {
      assert.equal(containsSecrets(text), true, text);
      assert.ok(!redactSecrets(text).includes(jwt), text);
    }
  });
});

describe('memory field size caps', () => {
  async function connect() {
    const { connectTools } = await import('../test/mcp-harness.js');
    const { FakeOllama } = await import('../test/fake-ollama.js');
    // The size checks are zod validation in the tool schema: the services are never reached.
    return connectTools({
      qdrant: {} as never,
      ollama: new FakeOllama(),
      authContext: { token: 't', name: 'tester', allowedProjects: ['p1'] },
    });
  }

  const base = { project: 'p1', type: 'decision', summary: 'ok', tags: ['aa', 'bb'] };

  it('refuses oversized remember fields', async () => {
    const tools = await connect();
    try {
      const attempts: Array<[string, object]> = [
        ['summary', { ...base, summary: 'a'.repeat(2001) }],
        ['context', { ...base, context: 'a'.repeat(20001) }],
        ['tag count', { ...base, tags: Array.from({ length: 21 }, (_, i) => `tag${i}`) }],
        ['tag length', { ...base, tags: ['aa', 'b'.repeat(65)] }],
      ];
      for (const [label, args] of attempts) {
        const result: any = await tools.client.callTool({ name: 'remember', arguments: args as Record<string, unknown> });
        assert.equal(result.isError, true, `${label}: ${JSON.stringify(result)}`);
        assert.match(JSON.stringify(result), /too_big|at most|exceed|Too big/i, label);
      }
    } finally {
      await tools.close();
    }
  });

  it('refuses oversized update_memory fields', async () => {
    const tools = await connect();
    try {
      const upd = { id: 'x', version: 1 };
      const attempts: Array<[string, object]> = [
        ['summary', { ...upd, summary: 'a'.repeat(2001) }],
        ['context', { ...upd, context: 'a'.repeat(20001) }],
        ['tag count', { ...upd, tags: Array.from({ length: 21 }, (_, i) => `tag${i}`) }],
        ['tag length', { ...upd, tags: ['b'.repeat(65)] }],
      ];
      for (const [label, args] of attempts) {
        const result: any = await tools.client.callTool({ name: 'update_memory', arguments: args as Record<string, unknown> });
        assert.equal(result.isError, true, `${label}: ${JSON.stringify(result)}`);
        assert.match(JSON.stringify(result), /too_big|at most|exceed|Too big/i, label);
      }
    } finally {
      await tools.close();
    }
  });
});
