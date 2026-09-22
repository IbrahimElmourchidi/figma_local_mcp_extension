import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { safeEntryPath, extractTar } from '../../src/core/archive';

describe('safeEntryPath', () => {
  it('accepts normal relative paths', () => {
    expect(safeEntryPath('a/b/c.txt')).toBe('a/b/c.txt');
    expect(safeEntryPath('./a/b.txt')).toBe('a/b.txt');
    expect(safeEntryPath('a\\b.txt')).toBe('a/b.txt');
  });

  it('rejects traversal', () => {
    expect(safeEntryPath('../evil')).toBeNull();
    expect(safeEntryPath('a/../../evil')).toBeNull();
    expect(safeEntryPath('a/..')).toBeNull();
  });

  it('rejects absolute paths and drive letters', () => {
    expect(safeEntryPath('/etc/passwd')).toBeNull();
    expect(safeEntryPath('C:\\Windows\\system32')).toBeNull();
    expect(safeEntryPath('c:/windows')).toBeNull();
  });

  it('rejects empty and directory-only entries', () => {
    expect(safeEntryPath('')).toBeNull();
    expect(safeEntryPath('dir/')).toBeNull();
  });
});

describe('extractTar', () => {
  it('writes safe file entries and skips traversal entries', () => {
    const tar = buildTar([
      { name: 'ok.txt', data: 'hello' },
      { name: '../escape.txt', data: 'nope' },
      { name: 'nested/dir/file.txt', data: 'nested' },
    ]);

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
    try {
      const count = extractTar(tar, dest);
      expect(count).toBe(2);
      expect(fs.readFileSync(path.join(dest, 'ok.txt'), 'utf8')).toBe('hello');
      expect(fs.readFileSync(path.join(dest, 'nested/dir/file.txt'), 'utf8')).toBe('nested');
      expect(fs.existsSync(path.join(path.dirname(dest), 'escape.txt'))).toBe(false);
      expect(fs.existsSync(path.join(dest, '../escape.txt'))).toBe(false);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});

interface TarEntry {
  name: string;
  data: string;
}

function buildTar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8');
    header.write('0000000\0', 108, 8, 'utf8');
    header.write('0000000\0', 116, 8, 'utf8');
    const size = Buffer.from(entry.data.length.toString(8).padStart(11, '0') + '\0');
    size.copy(header, 124);
    header.write('00000000000\0', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header[156] = '0'.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');
    // checksum: sum of header bytes with chksum field as spaces
    let sum = 0;
    for (let i = 0; i < 512; i += 1) {
      sum += header[i];
    }
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
    blocks.push(header);

    const data = Buffer.from(entry.data, 'utf8');
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
