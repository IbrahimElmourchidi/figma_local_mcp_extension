import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, withLock } from '../../src/core/lock';
import { BridgeError } from '../../src/errors';

describe('lock', () => {
  let locksDir: string;

  beforeEach(() => {
    locksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
  });

  afterEach(() => {
    fs.rmSync(locksDir, { recursive: true, force: true });
  });

  it('acquires and releases', () => {
    const handle = acquireLock(locksDir, 'runtime', 1000);
    expect(fs.existsSync(handle.dir)).toBe(true);
    handle.release();
    expect(fs.existsSync(handle.dir)).toBe(false);
  });

  it('is exclusive across sequential acquisitions after release', () => {
    withLock(locksDir, 'runtime', () => {
      // hold
    });
    withLock(locksDir, 'runtime', () => {
      // second acquisition succeeds after first released
    });
  });

  it('times out when held with a short wait', () => {
    const handle = acquireLock(locksDir, 'runtime', 5000);
    try {
      expect(() => acquireLock(locksDir, 'runtime', 100)).toThrow(BridgeError);
    } finally {
      handle.release();
    }
  });

  it('breaks stale locks older than the timeout', () => {
    const dir = path.join(locksDir, 'runtime');
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(dir, old, old);
    const handle = acquireLock(locksDir, 'runtime', 1000);
    expect(fs.existsSync(handle.dir)).toBe(true);
    handle.release();
  });
});
