/**
 * Disposable Qdrant for tests (Docker).
 *
 * Reminder: `src/services/qdrant.ts` reads VECTOR_SIZE when the module is
 * loaded. Set `process.env.VECTOR_SIZE` BEFORE any (dynamic) import of it.
 * This helper itself does not import project code.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const run = promisify(execFile);

export interface RunningQdrant {
  url: string;
  stop(): Promise<void>;
}

export async function startQdrant(opts: { image?: string } = {}): Promise<RunningQdrant> {
  const image = opts.image ?? 'qdrant/qdrant:v1.13.2';
  const name = `vr-test-${crypto.randomBytes(4).toString('hex')}`;

  try {
    await run('docker', ['run', '-d', '--rm', '-p', '127.0.0.1::6333', '--name', name, image]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Docker is required to run the tests but could not start Qdrant (${image}): ${message}`);
  }

  const stop = async (): Promise<void> => {
    await run('docker', ['rm', '-f', name]).catch(() => undefined);
  };

  try {
    const { stdout } = await run('docker', ['port', name, '6333/tcp']);
    const match = stdout.match(/127\.0\.0\.1:(\d+)/);
    if (!match) throw new Error(`Cannot parse published port from: ${stdout.trim()}`);
    const url = `http://127.0.0.1:${match[1]}`;

    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const res = await fetch(`${url}/readyz`);
        if (res.ok) return { url, stop };
      } catch {
        // not ready yet
      }
      if (Date.now() > deadline) throw new Error('Qdrant did not become ready within 60s');
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (error) {
    await stop();
    throw error;
  }
}
