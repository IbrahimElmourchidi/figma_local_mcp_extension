import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { MIN_NODE_VERSION, PINNED_NODE_VERSION } from '../constants';
import { BridgeError } from '../errors';
import { StorageLayout, managedNodeDir, managedNodeExecutable } from '../core/paths';

export interface ResolvedNode {
  readonly command: string;
  /** Extra env for spawning (ELECTRON_RUN_AS_NODE when using VS Code's binary). */
  readonly env: NodeJS.ProcessEnv;
  readonly via: 'electron' | 'override' | 'system' | 'managed';
  readonly version?: string;
  /**
   * Wrapper script to run in front of the target script (Electron only). See
   * resources/electron-node-launcher.cjs — without it, commander-based CLIs
   * misparse argv under ELECTRON_RUN_AS_NODE.
   */
  readonly launcher?: string;
}

export interface NodeResolverOptions {
  readonly overridePath?: string;
  readonly layout: StorageLayout;
  /** Absolute path to resources/electron-node-launcher.cjs. */
  readonly launcherPath?: string;
}

/** argv for running `script` with `node`, inserting the Electron launcher when needed. */
export function scriptArgs(node: Pick<ResolvedNode, 'launcher'>, script: string, args: readonly string[] = []): string[] {
  return node.launcher ? [node.launcher, script, ...args] : [script, ...args];
}

/**
 * Tier order for spawning bridge/MCP:
 *  0 — VS Code's own Node (ELECTRON_RUN_AS_NODE), documented pattern for stdio servers
 *  1 — figmaMcpBridge.nodePath override
 *  2 — system discovery
 *  3 — managed download (only used on demand for source builds / opencode)
 *
 * For source builds and opencode.json we need *real* Node, so `resolveRealNode`
 * skips tier 0.
 */
export class NodeResolver {
  private realNodeCache: ResolvedNode | null = null;

  constructor(private readonly options: NodeResolverOptions) {}

  /** Tier 0: editor's Node, for bridge/MCP child processes only. */
  resolveElectronNode(): ResolvedNode {
    return {
      command: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      via: 'electron',
      version: process.versions.node,
      launcher: this.options.launcherPath,
    };
  }

  /**
   * Node for spawning bridge/MCP. Prefers Electron-as-Node; falls back to
   * override/system when ELECTRON_RUN_AS_NODE probing fails (spike safety).
   */
  async resolveForServers(): Promise<ResolvedNode> {
    const electron = this.resolveElectronNode();
    if (await probeNode(electron.command, electron.env)) {
      return electron;
    }
    return this.resolveRealNode();
  }

  /** Real Node (tiers 1–2). Does not download. */
  async resolveRealNode(): Promise<ResolvedNode> {
    if (this.realNodeCache) {
      return this.realNodeCache;
    }

    const override = this.options.overridePath?.trim();
    if (override) {
      const probed = await probeNode(override, process.env);
      if (probed) {
        this.realNodeCache = { command: override, env: process.env, via: 'override', version: probed };
        return this.realNodeCache;
      }
    }

    const managed = this.managedNodePath();
    if (managed) {
      const probed = await probeNode(managed, process.env);
      if (probed) {
        this.realNodeCache = { command: managed, env: process.env, via: 'managed', version: probed };
        return this.realNodeCache;
      }
    }

    const system = await this.findSystemNode();
    if (system) {
      const probed = await probeNode(system, process.env);
      if (probed) {
        this.realNodeCache = { command: system, env: process.env, via: 'system', version: probed };
        return this.realNodeCache;
      }
    }

    throw new BridgeError(
      'node_not_available',
      'Node.js not found. Install Node.js >= 18, set figmaMcpBridge.nodePath, or run Build from source to download a managed copy.',
    );
  }

  managedNodePath(): string | null {
    const versionDir = managedNodeDir(this.options.layout, PINNED_NODE_VERSION);
    const exe = managedNodeExecutable(versionDir, process.platform === 'win32');
    return fs.existsSync(exe) ? exe : null;
  }

  async findSystemNode(): Promise<string | null> {
    const candidates = systemNodeCandidates();
    for (const candidate of candidates) {
      if (candidate.includes('*')) {
        const expanded = expandGlobCandidate(candidate);
        for (const full of expanded) {
          if (fs.existsSync(full)) {
            return full;
          }
        }
      } else if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return whichNode();
  }

  invalidate(): void {
    this.realNodeCache = null;
  }
}

export function systemNodeCandidates(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const appData = process.env.LOCALAPPDATA;
  const shared = [
    path.join(home, '.nvm/versions/node/*/bin/node'),
    path.join(home, '.local/share/fnm/node-versions/*/installation/bin/node'),
    path.join(home, '.volta/bin/node'),
    path.join(home, '.asdf/shims/node'),
  ];
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files\\nodejs\\node.exe',
      ...(appData ? [path.join(appData, 'fnm', 'multishells', '*', 'node.exe')] : []),
      ...shared.map((p) => p.replace(/\//g, '\\')),
    ];
  }
  if (process.platform === 'darwin') {
    return ['/opt/homebrew/bin/node', '/usr/local/bin/node', ...shared];
  }
  return ['/usr/local/bin/node', '/usr/bin/node', ...shared];
}

function expandGlobCandidate(pattern: string): string[] {
  const idx = pattern.indexOf('*');
  if (idx < 0) {
    return fs.existsSync(pattern) ? [pattern] : [];
  }
  const prefix = pattern.slice(0, idx);
  const suffix = pattern.slice(idx + 1);
  if (!fs.existsSync(prefix)) {
    return [];
  }
  try {
    return fs
      .readdirSync(prefix)
      .map((entry) => path.join(prefix, entry) + suffix)
      .filter((full) => fs.existsSync(full));
  } catch {
    return [];
  }
}

function whichNode(): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(cmd, ['node'], { timeout: 3000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const first = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
      resolve(first ?? null);
    });
  });
}

export function probeNode(command: string, env: NodeJS.ProcessEnv | undefined): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      ['--version'],
      { env, timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const raw = stdout.trim();
        if (!raw.startsWith('v')) {
          resolve(null);
          return;
        }
        const major = Number.parseInt(raw.slice(1).split('.')[0] ?? '', 10);
        if (!Number.isFinite(major) || major < MIN_NODE_VERSION) {
          resolve(null);
          return;
        }
        resolve(raw);
      },
    );
  });
}
