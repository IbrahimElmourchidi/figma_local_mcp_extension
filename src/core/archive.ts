import * as fflate from 'fflate';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BridgeError } from '../errors';

/**
 * Reject absolute paths, `..` traversal, drive letters, and symlink-ish entries.
 * Returns the normalized posix-style relative path, or null when unsafe.
 */
export function safeEntryPath(entryPath: string): string | null {
  if (!entryPath || entryPath.length === 0) {
    return null;
  }
  let p = entryPath.replace(/\\/g, '/');
  // Strip a single leading "./"
  if (p.startsWith('./')) {
    p = p.slice(2);
  }
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) {
    return null;
  }
  const segments = p.split('/');
  if (segments.some((seg) => seg === '..')) {
    return null;
  }
  if (p.endsWith('/')) {
    return null;
  }
  return p;
}

function writeFileGuarded(destDir: string, entryPath: string, data: Uint8Array): void {
  const safe = safeEntryPath(entryPath);
  if (safe === null) {
    return;
  }
  const full = path.join(destDir, ...safe.split('/'));
  const resolvedRoot = path.resolve(destDir);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    return;
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
}

export function extractZip(buffer: Buffer, destDir: string): number {
  fs.mkdirSync(destDir, { recursive: true });
  let files: Record<string, Uint8Array>;
  try {
    files = fflate.unzipSync(new Uint8Array(buffer)) as Record<string, Uint8Array>;
  } catch (error) {
    throw new BridgeError('extract_failed', `Failed to unzip archive: ${String(error)}`);
  }
  let count = 0;
  for (const [name, data] of Object.entries(files)) {
    const safe = safeEntryPath(name);
    if (safe === null) {
      continue;
    }
    // fflate returns directories as empty entries ending in /
    if (name.endsWith('/')) {
      fs.mkdirSync(path.join(destDir, ...safe.split('/')), { recursive: true });
      continue;
    }
    writeFileGuarded(destDir, name, data);
    count += 1;
  }
  return count;
}

export function extractTarGz(buffer: Buffer, destDir: string): number {
  let tarBuffer: Buffer;
  try {
    tarBuffer = gunzipSync(buffer);
  } catch (error) {
    throw new BridgeError('extract_failed', `Failed to gunzip archive: ${String(error)}`);
  }
  return extractTar(tarBuffer, destDir);
}

export function extractTar(buffer: Buffer, destDir: string): number {
  fs.mkdirSync(destDir, { recursive: true });
  let offset = 0;
  let count = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    const name = readTarString(header, 0, 100);
    if (name.length === 0) {
      // Possible end-of-archive (two zero blocks) or ustar long name handling.
      const typeFlag = String.fromCharCode(header[156]);
      if (typeFlag === '\0') {
        break;
      }
    }
    const prefix = readTarString(header, 345, 155);
    const fullEntry = prefix ? `${prefix}/${name}` : name;
    const sizeOctal = readTarString(header, 124, 12).trim();
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const typeFlag = String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    if (typeFlag === '0' || typeFlag === '\0') {
      const safe = safeEntryPath(fullEntry);
      if (safe !== null) {
        const data = buffer.subarray(dataStart, dataEnd);
        writeFileGuarded(destDir, fullEntry, data);
        count += 1;
      }
    } else if (typeFlag === '5') {
      const safe = safeEntryPath(fullEntry.endsWith('/') ? fullEntry.slice(0, -1) : fullEntry);
      if (safe !== null) {
        fs.mkdirSync(path.join(destDir, ...safe.split('/')), { recursive: true });
      }
    }
    // '1'/'2' hard/sym links skipped (plan: reject symlink entries)

    offset = dataStart + Math.ceil(size / 512) * 512;
    if (size === 0 && fullEntry.length === 0 && typeFlag === '\0') {
      break;
    }
  }
  return count;
}

function readTarString(header: Buffer, start: number, length: number): string {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end >= 0 ? end : slice.length).toString('utf8');
}
