import { spawn, ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import * as vscode from 'vscode';
import { ENV_BRIDGE_TOKEN, OUTPUT_LOG_RING, VALID_HOSTS } from '../constants';
import { BridgeError, runCommand } from '../errors';
import { StorageLayout } from '../core/paths';
import { RuntimeStore } from './runtimeStore';
import { NodeResolver } from './nodeResolver';
import { StateStore } from './state';
import { OutputChannels } from '../ui/output';
import { probeHealth, waitForHealth } from './health';
import { BridgeConfig } from '../config/bridgeConfig';

const HEALTH_GATE_MS = 8000;

export interface StartOptions {
  readonly config: BridgeConfig;
  readonly token: string;
  readonly killExisting?: boolean;
}

export class BridgeService implements vscode.Disposable {
  private child: ChildProcess | null = null;
  private intentionalStop = false;
  private uptimeTimer: NodeJS.Timeout | null = null;
  private logs: string[] = [];
  private disposed = false;
  private currentToken: string | undefined;

  constructor(
    private readonly layout: StorageLayout,
    private readonly runtime: RuntimeStore,
    private readonly nodes: NodeResolver,
    private readonly state: StateStore,
    private readonly output: OutputChannels,
  ) {}

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  async start(options: StartOptions): Promise<void> {
    await runCommand('Start bridge', async () => {
      if (this.isRunning()) {
        this.appendLog('Server already running');
        return;
      }

      const { config, token } = options;
      this.intentionalStop = false;
      this.currentToken = token;
      this.logs = [];
      this.state.updateBridge({
        status: 'starting',
        host: config.host,
        port: config.port,
        token,
        errorMessage: undefined,
        logs: [],
        startedAt: undefined,
        sessionId: undefined,
        pid: undefined,
      });

      if (options.killExisting !== false) {
        await this.killOrphans(config.port);
      }

      // Adopt-external: healthy bridge already on the port with our token.
      const existing = await probeHealth(config.host, config.port, token, 1500);
      if (existing.ok) {
        this.adoptExternal(config, token, existing.sessionId);
        return;
      }

      // Refuse if something else is bound (not our token).
      const foreign = await probeHealth(config.host, config.port, undefined, 500);
      if (foreign.ok || (foreign.status !== undefined && foreign.status !== 401)) {
        if (foreign.status === 401 || foreign.ok) {
          // 401 means a bridge is there but token mismatch / no token probe
          const withToken = await probeHealth(config.host, config.port, token, 500);
          if (withToken.ok) {
            this.adoptExternal(config, token, withToken.sessionId);
            return;
          }
          throw new BridgeError(
            'port_in_use',
            `Port ${config.port} is in use by another bridge (token mismatch). Stop it or change the port.`,
          );
        }
      }

      const serverPath = this.runtime.getBridgeCliPath();
      const node = await this.nodes.resolveForServers();
      const host = (VALID_HOSTS as readonly string[]).includes(config.host) ? config.host : '127.0.0.1';

      const args = [serverPath, 'serve', '--host', host, '--port', String(config.port)];
      const env: NodeJS.ProcessEnv = { ...node.env, [ENV_BRIDGE_TOKEN]: token };

      this.appendLog(`$ ${node.command} ${args.join(' ')}`);
      const child = spawn(node.command, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;

      if (child.pid) {
        this.state.updateBridge({ pid: child.pid });
      }

      const attach = (stream: NodeJS.ReadableStream, isError: boolean) => {
        const rl = readline.createInterface({ input: stream });
        rl.on('line', (line) => {
          this.appendLog(isError ? `[ERROR] ${line}` : line);
          if (!isError) {
            const match = /Session:\s*(\S+)/.exec(line);
            if (match) {
              this.state.updateBridge({ sessionId: match[1] });
            }
          }
        });
      };
      if (child.stdout) {attach(child.stdout, false);}
      if (child.stderr) {attach(child.stderr, true);}

      child.on('error', (error) => {
        this.appendLog(`[ERROR] ${error.message}`);
        this.state.updateBridge({
          status: 'error',
          errorMessage: error.message,
          startedAt: undefined,
        });
        this.stopUptime();
        this.child = null;
      });

      child.on('close', (code) => {
        const clean = this.intentionalStop || code === 0 || code === -15 || code === null;
        this.intentionalStop = false;
        this.child = null;
        this.stopUptime();
        if (this.disposed) {
          return;
        }
        this.state.updateBridge({
          status: clean ? 'stopped' : 'error',
          errorMessage: clean ? undefined : `Process exited with code ${code}`,
          startedAt: clean ? undefined : this.state.get().bridge.startedAt,
          pid: undefined,
        });
      });

      // Health gate — only report Running after /health 200.
      const health = await waitForHealth(config.host, config.port, token, HEALTH_GATE_MS);
      if (!health.ok) {
        // Process may have died already
        if (this.child && this.child.exitCode === null) {
          this.appendLog(`Health gate failed: ${health.error ?? 'no response'} — stopping process`);
          this.intentionalStop = true;
          this.child.kill('SIGTERM');
          setTimeout(() => this.child?.kill('SIGKILL'), 2000).unref();
        }
        const still = this.state.get().bridge;
        if (still.status !== 'error') {
          this.state.updateBridge({
            status: 'error',
            errorMessage: `Bridge did not become healthy: ${health.error ?? 'timeout'}`,
            startedAt: undefined,
          });
        }
        throw new BridgeError(
          'health_gate_failed',
          `Bridge did not become healthy within ${HEALTH_GATE_MS}ms: ${health.error ?? 'timeout'}`,
        );
      }

      this.state.updateBridge({
        status: 'running',
        host: config.host,
        port: config.port,
        token,
        sessionId: health.sessionId ?? this.state.get().bridge.sessionId,
        startedAt: Date.now(),
        errorMessage: undefined,
      });
      this.startUptime();
      this.appendLog(`Bridge healthy on ${config.host}:${config.port}`);
    });
  }

  private adoptExternal(config: BridgeConfig, token: string, sessionId?: string): void {
    this.appendLog(`Adopted existing bridge on ${config.host}:${config.port} (external)`);
    this.state.updateBridge({
      status: 'running-external',
      host: config.host,
      port: config.port,
      token,
      sessionId,
      startedAt: Date.now(),
      errorMessage: undefined,
    });
    this.startUptime();
  }

  async stop(): Promise<void> {
    await runCommand('Stop bridge', async () => {
      const snapshot = this.state.get().bridge;
      if (snapshot.status === 'running-external') {
        // Adopted servers are not ours to stop.
        return;
      }
      this.intentionalStop = true;
      if (snapshot.status !== 'stopped') {
        this.state.updateBridge({ status: 'stopping' });
      }
      const child = this.child;
      if (child && child.exitCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5000);
          timer.unref();
          child.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill('SIGTERM');
        });
      }
      this.child = null;
      this.stopUptime();
      const port = this.state.get().bridge.port ?? 0;
      if (port > 0) {
        await this.killOrphans(port);
      }
      this.intentionalStop = false;
      this.state.updateBridge({
        status: 'stopped',
        token: undefined,
        sessionId: undefined,
        startedAt: undefined,
        errorMessage: undefined,
        pid: undefined,
      });
    });
  }

  async restart(options: StartOptions): Promise<void> {
    await this.stop();
    await new Promise((r) => setTimeout(r, 300));
    await this.start(options);
  }

  /**
   * Kill processes whose command line contains `bridge-cli` and are listening
   * on `port`. Mirrors the Flutter app's orphan-kill (lsof/netstat + cmdline match).
   */
  async killOrphans(port: number): Promise<number> {
    try {
      const pids = await pidsListeningOn(port);
      let killed = 0;
      for (const pid of pids) {
        if (pid === process.pid) {continue;}
        const cmdline = await commandLineFor(pid);
        if (cmdline && cmdline.includes('bridge-cli')) {
          this.appendLog(`Killing orphan bridge pid ${pid}`);
          await killPid(pid);
          killed += 1;
        }
      }
      if (killed > 0) {
        await new Promise((r) => setTimeout(r, 250));
      }
      return killed;
    } catch (error) {
      this.appendLog(`[WARN] orphan kill failed: ${String(error)}`);
      return 0;
    }
  }

  getToken(): string | undefined {
    return this.currentToken;
  }

  clearLogs(): void {
    this.logs = [];
    this.output.clearBridge();
    this.state.updateBridge({ logs: [] });
  }

  private appendLog(line: string): void {
    this.logs = [...this.logs, line].slice(-OUTPUT_LOG_RING);
    this.output.appendBridge(line);
    this.state.updateBridge({ logs: this.logs });
  }

  private startUptime(): void {
    this.stopUptime();
    this.uptimeTimer = setInterval(() => {
      // Touch snapshot so tooltips recompute uptime.
      this.state.updateBridge({});
    }, 1000);
    this.uptimeTimer.unref?.();
  }

  private stopUptime(): void {
    if (this.uptimeTimer) {
      clearInterval(this.uptimeTimer);
      this.uptimeTimer = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.intentionalStop = true;
    this.stopUptime();
    const child = this.child;
    if (child && child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      // Synchronous best-effort; orphan-kill is the backstop on next start.
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 500).unref?.();
    }
    this.child = null;
  }
}

async function pidsListeningOn(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const child = spawn('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
      });
      child.on('close', () => {
        const pids: number[] = [];
        for (const line of out.split(/\r?\n/)) {
          if (line.includes(`:${port}`) && line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/);
            const pid = Number.parseInt(parts[parts.length - 1] ?? '', 10);
            if (Number.isFinite(pid)) {pids.push(pid);}
          }
        }
        resolve([...new Set(pids)]);
      });
      child.on('error', () => resolve([]));
    });
  }

  return new Promise((resolve) => {
    const child = spawn('lsof', ['-i', `:${port}`, '-t'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('close', () => {
      const pids = out
        .split(/\r?\n/)
        .map((l) => Number.parseInt(l.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      resolve([...new Set(pids)]);
    });
    child.on('error', () => resolve([]));
  });
}

async function commandLineFor(pid: number): Promise<string | null> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const child = spawn(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { windowsHide: true },
      );
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
      });
      child.on('close', () => resolve(out.trim() || null));
      child.on('error', () => resolve(null));
    });
  }
  if (process.platform === 'linux') {
    try {
      const fs = await import('node:fs/promises');
      return await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    const child = spawn('ps', ['-p', String(pid), '-o', 'command='], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('close', () => resolve(out.trim() || null));
    child.on('error', () => resolve(null));
  });
}

async function killPid(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const child = spawn('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  } catch {
    // already gone
  }
}
