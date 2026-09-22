import { spawn } from 'node:child_process';
import { BridgeError } from '../errors';

export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Spawn with streamed line-oriented output. Not `exec` — pnpm install output
 * exceeds Node's default maxBuffer.
 */
export function exec(
  file: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    timer.unref();

    const onAbort = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const attach = (stream: 'stdout' | 'stderr') => {
      const target = stream === 'stdout' ? child.stdout : child.stderr;
      let buffer = '';
      target.setEncoding('utf8');
      target.on('data', (chunk: string) => {
        if (stream === 'stdout') {
          stdout += chunk;
        } else {
          stderr += chunk;
        }
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          options.onLine?.(line, stream);
          index = buffer.indexOf('\n');
        }
      });
      target.on('end', () => {
        const rest = buffer.replace(/\r$/, '');
        if (rest.length > 0) {
          options.onLine?.(rest, stream);
        }
      });
    };
    attach('stdout');
    attach('stderr');

    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.on('error', (error) => {
      settle(() => reject(new BridgeError('unexpected', `Failed to spawn ${file}: ${error.message}`)));
    });

    child.on('close', (code) => {
      settle(() => {
        if (options.signal?.aborted) {
          reject(new BridgeError('cancelled', `${pathOf(file)} was cancelled`));
          return;
        }
        if (timedOut) {
          reject(new BridgeError('unexpected', `${pathOf(file)} timed out after ${timeoutMs}ms`));
          return;
        }
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  });
}

function pathOf(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] || file;
}

export async function execOrThrow(
  file: string,
  args: readonly string[],
  options: ExecOptions & {
    readonly failCode?: import('../errors').BridgeErrorCode;
    readonly label?: string;
  } = {},
): Promise<ExecResult> {
  const result = await exec(file, args, options);
  if (result.code !== 0) {
    const label = options.label ?? pathOf(file);
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-8).join('\n');
    throw new BridgeError(
      options.failCode ?? 'unexpected',
      `${label} exited with code ${result.code}${detail ? `:\n${detail}` : ''}`,
    );
  }
  return result;
}
