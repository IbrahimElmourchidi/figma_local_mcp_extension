import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { BridgeError } from '../errors';

export interface DownloadOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly retries?: number;
  readonly retryDelayMs?: number;
  readonly onProgress?: (received: number, total: number | undefined) => void;
  readonly expectedSha256?: string;
  readonly headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function downloadToFile(
  url: string,
  destPath: string,
  options: DownloadOptions = {},
): Promise<void> {
  const retries = options.retries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await downloadOnce(url, destPath, options);
      if (options.expectedSha256) {
        const actual = await sha256File(destPath);
        if (actual.toLowerCase() !== options.expectedSha256.toLowerCase()) {
          throw new BridgeError(
            'checksum_mismatch',
            `SHA-256 mismatch for ${path.basename(destPath)}: expected ${options.expectedSha256}, got ${actual}`,
          );
        }
      }
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof BridgeError && error.code === 'cancelled') {
        throw error;
      }
      if (error instanceof BridgeError && error.code === 'checksum_mismatch') {
        throw error;
      }
      if (attempt < retries) {
        await sleep(retryDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastError instanceof BridgeError
    ? lastError
    : new BridgeError('download_failed', `Failed to download ${url}: ${String(lastError)}`);
}

async function downloadOnce(
  url: string,
  destPath: string,
  options: DownloadOptions,
): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tempPath = `${destPath}.download`;

  const response = await fetch(url, {
    headers: options.headers,
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new BridgeError('download_failed', `HTTP ${response.status} for ${url}`);
  }
  if (!response.body) {
    throw new BridgeError('download_failed', `Empty response body for ${url}`);
  }

  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : undefined;
  let received = 0;

  const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length;
    options.onProgress?.(received, total);
  });

  await pipeline(nodeStream, createWriteStream(tempPath));
  await fs.rename(tempPath, destPath);
}

export async function fetchBuffer(
  url: string,
  options: DownloadOptions = {},
): Promise<Buffer> {
  const retries = options.retries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: options.headers,
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        redirect: 'follow',
      });
      if (!response.ok) {
        throw new BridgeError('download_failed', `HTTP ${response.status} for ${url}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (options.expectedSha256) {
        const actual = createHash('sha256').update(buffer).digest('hex');
        if (actual.toLowerCase() !== options.expectedSha256.toLowerCase()) {
          throw new BridgeError('checksum_mismatch', `SHA-256 mismatch for ${url}`);
        }
      }
      return buffer;
    } catch (error) {
      lastError = error;
      if (error instanceof BridgeError && (error.code === 'cancelled' || error.code === 'checksum_mismatch')) {
        throw error;
      }
      if (attempt < retries) {
        await sleep(retryDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastError instanceof BridgeError
    ? lastError
    : new BridgeError('download_failed', `Failed to download ${url}: ${String(lastError)}`);
}

export async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

export function sha256Of(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
