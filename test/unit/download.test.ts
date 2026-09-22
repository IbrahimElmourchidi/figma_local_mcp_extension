import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256File, sha256Of } from '../../src/core/download';

describe('sha256Of', () => {
  it('hashes strings and buffers consistently', () => {
    const a = sha256Of('hello');
    const b = sha256Of(Buffer.from('hello'));
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
});

describe('sha256File', () => {
  it('hashes a file on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sha-'));
    try {
      const p = path.join(dir, 'f.txt');
      fs.writeFileSync(p, 'hello');
      const expected = createHash('sha256').update('hello').digest('hex');
      await expect(sha256File(p)).resolves.toBe(expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

