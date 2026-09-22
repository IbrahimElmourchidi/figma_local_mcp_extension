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

  it('honors a GNU long-name ("L") header for a path over 100+155 bytes', () => {
    // ustar's name(100)+prefix(155) fields cap plain paths well under this.
    const longPath = `${'deep/'.repeat(60)}file.txt`;
    expect(longPath.length).toBeGreaterThan(255);
    const tar = buildTar([
      { name: './@LongLink', data: `${longPath}\0`, typeFlag: 'L' },
      { name: longPath.slice(0, 99), data: 'gnu-longname-payload', typeFlag: '0' },
    ]);

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
    try {
      const count = extractTar(tar, dest);
      expect(count).toBe(1);
      expect(fs.readFileSync(path.join(dest, longPath), 'utf8')).toBe('gnu-longname-payload');
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('honors a PAX extended header ("path" record) for the next entry', () => {
    const longPath = `${'nested/'.repeat(40)}deep.txt`;
    expect(longPath.length).toBeGreaterThan(255);
    const tar = buildTar([
      { name: 'PaxHeaders/placeholder', data: paxRecord('path', longPath), typeFlag: 'x' },
      { name: longPath.slice(0, 99), data: 'pax-path-payload', typeFlag: '0' },
    ]);

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
    try {
      const count = extractTar(tar, dest);
      expect(count).toBe(1);
      expect(fs.readFileSync(path.join(dest, longPath), 'utf8')).toBe('pax-path-payload');
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('skips a PAX global header ("g", e.g. codeload\'s pax_global_header) without corrupting later entries', () => {
    const tar = buildTar([
      { name: 'pax_global_header', data: paxRecord('comment', 'abc123deadbeef'), typeFlag: 'g' },
      { name: 'ok.txt', data: 'still fine', typeFlag: '0' },
    ]);

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
    try {
      const count = extractTar(tar, dest);
      expect(count).toBe(1);
      expect(fs.readFileSync(path.join(dest, 'ok.txt'), 'utf8')).toBe('still fine');
      expect(fs.existsSync(path.join(dest, 'pax_global_header'))).toBe(false);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});

interface TarEntry {
  name: string;
  data: string;
  typeFlag?: string;
}

/** Builds a self-referential-length PAX record: "<len> <key>=<value>\n". */
function paxRecord(key: string, value: string): string {
  const suffix = ` ${key}=${value}\n`;
  let len = suffix.length + 1;
  for (;;) {
    const candidate = `${len}${suffix}`;
    if (candidate.length === len) {
      return candidate;
    }
    len = candidate.length;
  }
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
    header[156] = (entry.typeFlag ?? '0').charCodeAt(0);
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
