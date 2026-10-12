// VECTOR_SIZE must be set before project modules are loaded (see TESTING.md).
process.env.VECTOR_SIZE = '8';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('readRawConfig', () => {
  it('never logs or rethrows the YAML snippet of a parse error', async () => {
    const { readRawConfig } = await import('../config.js');
    const sentinel = 'SENTINEL' + '_VALUE_' + 'f3a9c1';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-parse-'));
    const file = path.join(dir, 'projects.yml');
    // Unterminated flow sequence after a sentinel value: js-yaml quotes the faulty lines in its message.
    fs.writeFileSync(file, `auth:\n  tokens:\n    ${sentinel}: { name: [oops\nprojects: {\n`);

    const captured: string[] = [];
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const capture = (...args: unknown[]) => { captured.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' ')); };
    console.log = capture; console.info = capture; console.warn = capture; console.error = capture;

    let thrown: Error | undefined;
    try {
      readRawConfig(file);
    } catch (error) {
      thrown = error as Error;
    } finally {
      Object.assign(console, original);
      fs.rmSync(dir, { recursive: true, force: true });
    }

    assert.ok(thrown, 'a malformed config must throw');
    assert.ok(!thrown.message.includes(sentinel), `error message leaks the snippet: ${thrown.message}`);
    assert.ok(!String(thrown.stack).includes(sentinel), 'error stack leaks the snippet');
    assert.ok(captured.length > 0, 'the failure is logged');
    for (const line of captured) assert.ok(!line.includes(sentinel), `console output leaks the snippet: ${line}`);
    assert.match(thrown.message, /line \d+, column \d+/);
  });
});
