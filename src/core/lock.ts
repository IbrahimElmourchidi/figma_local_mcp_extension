import * as fs from 'node:fs';
import * as path from 'node:path';
import { STALE_LOCK_MS } from '../constants';
import { BridgeError } from '../errors';

export interface LockHandle {
  readonly dir: string;
  release(): void;
}

/**
 * Cross-process lock via `fs.mkdir` (atomic on all platforms). Carries pid +
 * timestamp; stale locks older than STALE_LOCK_MS are broken.
 */
export function acquireLock(locksDir: string, name: string, waitMs = 30_000): LockHandle {
  const dir = path.join(locksDir, name);
  const deadline = Date.now() + waitMs;
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });

  // Ensure the parent exists (recursive), then mkdir the lock dir itself so
  // an already-held lock surfaces as EEXIST (recursive mkdir would not throw).
  fs.mkdirSync(locksDir, { recursive: true });

  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner'), payload, { encoding: 'utf8' });
      return {
        dir,
        release() {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            // best-effort; stale timeout will reclaim
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        if (code === 'ENOENT') {
          fs.mkdirSync(locksDir, { recursive: true });
          continue;
        }
        throw new BridgeError('unexpected', `Failed to acquire lock ${name}: ${String(error)}`);
      }

      // Lock exists — check staleness.
      try {
        const stat = fs.statSync(dir);
        const age = Date.now() - stat.mtimeMs;
        if (age > STALE_LOCK_MS) {
          fs.rmSync(dir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new BridgeError('lock_contended', `Timed out waiting for lock "${name}"`);
      }
      sleepSync(50);
    }
  }
}

export function withLock<T>(locksDir: string, name: string, action: () => T, waitMs = 30_000): T {
  const handle = acquireLock(locksDir, name, waitMs);
  try {
    return action();
  } finally {
    handle.release();
  }
}

export async function withLockAsync<T>(
  locksDir: string,
  name: string,
  action: () => Promise<T>,
  waitMs = 30_000,
): Promise<T> {
  const handle = acquireLock(locksDir, name, waitMs);
  try {
    return await action();
  } finally {
    handle.release();
  }
}

function sleepSync(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, ms);
}
