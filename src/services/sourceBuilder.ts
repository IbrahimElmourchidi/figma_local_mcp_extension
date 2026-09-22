import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  BRIDGE_CLI_FILE,
  ESBUILD_VERSION,
  MANIFEST_FILE,
  MCP_SERVER_FILE,
  NODE_BUILD_TARGET,
  PINNED_PNPM_VERSION,
  PLUGIN_CODE_FILE,
  PLUGIN_DIR,
  PLUGIN_MANIFEST_TEMPLATE,
  PLUGIN_UI_FILE,
  UPSTREAM_OWNER,
  UPSTREAM_REPO,
  VERSION_FILE,
  esbuildPackageUrl,
  pnpmPackageUrl,
} from '../constants';
import { BridgeError, toBridgeError } from '../errors';
import { downloadToFile } from '../core/download';
import { extractTarGz } from '../core/archive';
import { StorageLayout } from '../core/paths';
import { resolveRef } from '../core/github';
import { execOrThrow } from '../core/exec';
import { RuntimeStore } from './runtimeStore';
import { NodeResolver } from './nodeResolver';
import { StateStore } from './state';
import { verifyRuntimeBundle } from './runtimeVerifier';
import { OutputChannels } from '../ui/output';

export interface SourceBuildDeps {
  readonly layout: StorageLayout;
  readonly runtime: RuntimeStore;
  readonly nodes: NodeResolver;
  readonly state: StateStore;
  readonly output: OutputChannels;
}

export interface BuildResult {
  readonly upstreamSha: string;
  readonly staged: boolean;
}

export class SourceBuilder {
  private building = false;

  constructor(private readonly deps: SourceBuildDeps) {}

  isBuilding(): boolean {
    return this.building;
  }

  async checkForUpdate(): Promise<{ latestSha?: string; updateAvailable: boolean }> {
    try {
      const { sha } = await resolveRef('main');
      const installed = this.deps.runtime.getInstalledManifest();
      const installedSha = installed?.upstreamSha;
      const updateAvailable = Boolean(sha && installedSha && sha !== installedSha && installedSha !== 'unknown');
      this.deps.state.updateRuntime({
        latestUpstreamSha: sha,
        updateAvailable,
      });
      return { latestSha: sha, updateAvailable };
    } catch (error) {
      this.deps.output.appendBuild(`Update check failed: ${String(error)}`);
      return { updateAvailable: false };
    }
  }

  /**
   * Download upstream → pnpm → build → esbuild → plugin → manifest → verify →
   * stage-and-swap. Cancellable via the progress token.
   */
  async buildFromSource(
    token: vscode.CancellationToken,
    onProgress: (message: string, percent?: number) => void,
  ): Promise<BuildResult> {
    if (this.building) {
      throw new BridgeError('unexpected', 'A build is already in progress.');
    }
    this.building = true;
    const log = (line: string) => {
      this.deps.output.appendBuild(line);
      onProgress(line);
    };

    const buildDir = this.deps.layout.build;
    const staging = this.deps.layout.runtimeStaging;

    try {
      this.deps.state.updateRuntime({ building: true, buildStatus: 'Resolving upstream…' });
      const { sha, committedAt } = await resolveRef('main');
      log(`Upstream ${sha}`);
      this.throwIfCancelled(token);

      // Real Node required
      let node: Awaited<ReturnType<NodeResolver['resolveRealNode']>>;
      try {
        node = await this.deps.nodes.resolveRealNode();
      } catch {
        const proceed = await vscode.window.showWarningMessage(
          'No system Node.js found. Download a managed Node.js (~50 MB) to build from source?',
          { modal: true },
          'Download',
        );
        if (proceed !== 'Download') {
          throw new BridgeError('node_not_available', 'Node.js is required for source builds.');
        }
        node = await this.downloadManagedNode(token, log);
      }
      this.throwIfCancelled(token);

      await fsp.rm(buildDir, { recursive: true, force: true });
      await fsp.mkdir(buildDir, { recursive: true });
      await fsp.rm(staging, { recursive: true, force: true });
      await fsp.mkdir(staging, { recursive: true });

      // Preflight: disk space is best-effort via free bytes when available
      await this.preflightDisk();

      // 1. Source
      this.deps.state.updateRuntime({ buildStatus: 'Downloading upstream source…' });
      log('Downloading source tarball…');
      const tarUrl = `https://codeload.github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/tar.gz/${sha}`;
      const tarPath = path.join(buildDir, 'source.tar.gz');
      await downloadToFile(tarUrl, tarPath, { signal: asAbort(token), onProgress: (r, t) => {
        if (t) {onProgress(`Downloading source… ${Math.round((r / t) * 100)}%`, 0.1);}
      }});
      const sourceRoot = path.join(buildDir, 'source');
      await fsp.mkdir(sourceRoot, { recursive: true });
      extractTarGz(await fsp.readFile(tarPath), sourceRoot);
      await fsp.rm(tarPath, { force: true });

      let src = sourceRoot;
      const entries = await fsp.readdir(sourceRoot, { withFileTypes: true });
      if (entries.length === 1 && entries[0].isDirectory()) {
        src = path.join(sourceRoot, entries[0].name);
      }
      this.throwIfCancelled(token);

      // 2. pnpm
      this.deps.state.updateRuntime({ buildStatus: 'Setting up pnpm…' });
      const pnpmVersion = await this.readPnpmVersion(src);
      log(`Using pnpm@${pnpmVersion}`);
      const pnpmDir = path.join(buildDir, 'pnpm');
      await downloadAndExtract(pnpmPackageUrl(pnpmVersion), pnpmDir, asAbort(token));
      const pnpmCjs = path.join(pnpmDir, 'package', 'dist', 'pnpm.cjs');
      if (!fs.existsSync(pnpmCjs)) {
        throw new BridgeError('extract_failed', `pnpm.cjs not found at ${pnpmCjs}`);
      }
      this.throwIfCancelled(token);

      // 3. install
      this.deps.state.updateRuntime({ buildStatus: 'Installing dependencies…' });
      this.deps.output.showBuild();
      const hasLock = fs.existsSync(path.join(src, 'pnpm-lock.yaml'));
      const installArgs = ['install', ...(hasLock ? ['--frozen-lockfile'] : [])];
      log(`pnpm ${installArgs.join(' ')}`);
      await execOrThrow(node.command, [pnpmCjs, ...installArgs], {
        cwd: src,
        env: node.env,
        signal: asAbort(token),
        onLine: (line) => this.deps.output.appendBuild(line),
        failCode: 'pnpm_install_failed',
        label: 'pnpm install',
      });
      this.throwIfCancelled(token);

      // 4. build
      this.deps.state.updateRuntime({ buildStatus: 'Building packages…' });
      log('pnpm -r run build');
      await execOrThrow(node.command, [pnpmCjs, '-r', 'run', 'build'], {
        cwd: src,
        env: node.env,
        signal: asAbort(token),
        onLine: (line) => this.deps.output.appendBuild(line),
        failCode: 'build_failed',
        label: 'pnpm build',
      });
      this.throwIfCancelled(token);

      // 5. esbuild
      this.deps.state.updateRuntime({ buildStatus: 'Bundling with esbuild…' });
      const esbuildDir = path.join(buildDir, 'esbuild');
      const osName = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : 'win32';
      const archName = os.arch() === 'arm64' ? 'arm64' : 'x64';
      await downloadAndExtract(esbuildPackageUrl(osName, archName), esbuildDir, asAbort(token));
      const esbuildBin =
        process.platform === 'win32'
          ? path.join(esbuildDir, 'package', 'esbuild.exe')
          : path.join(esbuildDir, 'package', 'bin', 'esbuild');
      if (!fs.existsSync(esbuildBin)) {
        throw new BridgeError('extract_failed', `esbuild binary not found at ${esbuildBin}`);
      }
      if (process.platform !== 'win32') {
        await fsp.chmod(esbuildBin, 0o755);
      }

      const mcpEntry = this.resolveEntry(src, [
        'packages/mcp-server/dist/index.js',
        'packages/mcp-server/dist/index.mjs',
      ]);
      const cliEntry = this.resolveEntry(src, [
        'packages/cli/dist/bridge-cli.js',
        'packages/cli/dist/bridge-cli.mjs',
      ]);

      const bundleFlags = ['--bundle', '--platform=node', '--format=cjs', `--target=${NODE_BUILD_TARGET}`];
      log('Bundling mcp-server.cjs');
      await execOrThrow(esbuildBin, [mcpEntry, ...bundleFlags, `--outfile=${path.join(staging, MCP_SERVER_FILE)}`], {
        env: node.env,
        signal: asAbort(token),
        onLine: (line) => this.deps.output.appendBuild(line),
        failCode: 'esbuild_mcp_failed',
        label: 'esbuild mcp-server',
      });
      log('Bundling bridge-cli.cjs');
      await execOrThrow(esbuildBin, [cliEntry, ...bundleFlags, `--outfile=${path.join(staging, BRIDGE_CLI_FILE)}`], {
        env: node.env,
        signal: asAbort(token),
        onLine: (line) => this.deps.output.appendBuild(line),
        failCode: 'esbuild_cli_failed',
        label: 'esbuild bridge-cli',
      });
      this.throwIfCancelled(token);

      // 6. plugin files — hard-fail
      this.deps.state.updateRuntime({ buildStatus: 'Copying plugin files…' });
      const pluginSrc = path.join(src, 'plugins/local-bridge');
      const pluginOut = path.join(staging, PLUGIN_DIR);
      await fsp.mkdir(pluginOut, { recursive: true });
      for (const name of [PLUGIN_CODE_FILE, PLUGIN_UI_FILE, PLUGIN_MANIFEST_TEMPLATE]) {
        const from = path.join(pluginSrc, name);
        if (!fs.existsSync(from)) {
          throw new BridgeError('upstream_layout_changed', `Missing upstream file: plugins/local-bridge/${name}`);
        }
        await fsp.copyFile(from, path.join(pluginOut, name));
      }

      // 7. VERSION + runtime.json
      this.deps.state.updateRuntime({ buildStatus: 'Generating manifest…' });
      await fsp.writeFile(path.join(staging, VERSION_FILE), `${sha}\n`, 'utf8');
      const files: Record<string, string> = {};
      for (const rel of [
        MCP_SERVER_FILE,
        BRIDGE_CLI_FILE,
        `${PLUGIN_DIR}/${PLUGIN_CODE_FILE}`,
        `${PLUGIN_DIR}/${PLUGIN_UI_FILE}`,
        `${PLUGIN_DIR}/${PLUGIN_MANIFEST_TEMPLATE}`,
      ]) {
        files[rel] = await sha256(path.join(staging, rel));
      }
      const manifest = {
        schema: 1,
        upstreamRepo: `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`,
        upstreamSha: sha,
        upstreamCommittedAt: committedAt,
        builtAt: new Date().toISOString(),
        builtBy: 'on-device',
        esbuildVersion: ESBUILD_VERSION,
        nodeTarget: NODE_BUILD_TARGET,
        files,
      };
      await fsp.writeFile(path.join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      // Normalize perms — these are data files, never executed directly, and
      // shouldn't inherit an overly-permissive umask into the runtime dir.
      if (process.platform !== 'win32') {
        for (const rel of [...Object.keys(files), VERSION_FILE, MANIFEST_FILE]) {
          await fsp.chmod(path.join(staging, rel), 0o644);
        }
      }

      // 8. Verify staged output BEFORE swap
      this.deps.state.updateRuntime({ buildStatus: 'Verifying staged runtime…' });
      // Smoke-test with the same Node + launcher the bridge/MCP will actually
      // run under (usually Electron-as-Node), not the real Node used to build.
      await verifyRuntimeBundle(staging, await this.deps.nodes.resolveForServers(), log);
      this.throwIfCancelled(token);

      // 9. Stage-and-swap (caller should have stopped bridge/MCP already)
      this.deps.state.updateRuntime({ buildStatus: 'Installing runtime…' });
      this.deps.runtime.stageAndSwap(staging);
      this.deps.nodes.invalidate();

      const installed = this.deps.runtime.getInstalledManifest();
      this.deps.state.updateRuntime({
        building: false,
        buildStatus: 'Build complete',
        installedSha: installed?.upstreamSha,
        builtAt: installed?.builtAt,
        builtBy: installed?.builtBy,
        healthy: this.deps.runtime.isHealthy(),
        hasRollback: this.deps.runtime.hasRollbackAvailable(),
        updateAvailable: false,
        latestUpstreamSha: sha,
      });
      log(`Installed runtime @ ${sha}`);
      return { upstreamSha: sha, staged: true };
    } catch (error) {
      const bridgeError = toBridgeError(error);
      this.deps.state.updateRuntime({
        building: false,
        buildStatus: `Failed: ${bridgeError.message}`,
      });
      this.deps.output.appendBuild(`Build failed: ${bridgeError.message}`);
      // Best-effort cleanup of staging so a partial stage never looks installed
      try {
        await fsp.rm(staging, { recursive: true, force: true });
      } catch {
        // ignore
      }
      throw bridgeError;
    } finally {
      this.building = false;
      try {
        await fsp.rm(buildDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  private resolveEntry(src: string, candidates: string[]): string {
    for (const rel of candidates) {
      const full = path.join(src, rel);
      if (fs.existsSync(full)) {return full;}
    }
    throw new BridgeError('upstream_layout_changed', `upstream layout changed — tried ${candidates.join(', ')}`);
  }

  private async readPnpmVersion(src: string): Promise<string> {
    try {
      const pkg = JSON.parse(await fsp.readFile(path.join(src, 'package.json'), 'utf8')) as {
        packageManager?: string;
      };
      const match = /^pnpm@(\d+\.\d+\.\d+)/.exec(pkg.packageManager ?? '');
      if (match) {return match[1];}
    } catch {
      // fall through
    }
    return PINNED_PNPM_VERSION;
  }

  private throwIfCancelled(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
      throw new BridgeError('cancelled', 'Build cancelled');
    }
  }

  private async preflightDisk(): Promise<void> {
    try {
      const stats = await fsp.statfs(this.deps.layout.root);
      const free = Number(stats.bavail) * Number(stats.bsize);
      const needed = 500 * 1024 * 1024;
      if (free < needed) {
        throw new BridgeError('unexpected', 'Insufficient disk space for source build (~500 MB required).');
      }
    } catch (error) {
      if (error instanceof BridgeError) {throw error;}
      // statfs unavailable — skip
    }
  }

  private async downloadManagedNode(
    token: vscode.CancellationToken,
    log: (line: string) => void,
  ): Promise<Awaited<ReturnType<NodeResolver['resolveRealNode']>>> {
    // Minimal managed download: reuse nodejs.org .tar.gz (not .xz) + extract bin/node.
    const version = 'v24.21.0';
    const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
    const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win' : 'linux';
    const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
    const archive = `node-${version}-${platform}-${arch}.${ext}`;
    const url = `https://nodejs.org/dist/${version}/${archive}`;
    log(`Downloading ${url}`);
    this.deps.state.updateRuntime({ buildStatus: `Downloading Node ${version}…` });

    const tmpDir = path.join(this.deps.layout.node, `.tmp-${Date.now()}`);
    await fsp.mkdir(tmpDir, { recursive: true });
    try {
      const archivePath = path.join(tmpDir, archive);
      await downloadToFile(url, archivePath, { signal: asAbort(token), retries: 3 });

      // Verify against SHASUMS256.txt (hard-fail if mismatch; skip only when unreachable)
      try {
        const shasumsUrl = `https://nodejs.org/dist/${version}/SHASUMS256.txt`;
        const res = await fetch(shasumsUrl, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          const text = await res.text();
          const line = text.split(/\r?\n/).find((l) => l.includes(archive));
          if (line) {
            const expected = line.trim().split(/\s+/)[0];
            const actual = await sha256(archivePath);
            if (expected && actual.toLowerCase() !== expected.toLowerCase()) {
              throw new BridgeError('checksum_mismatch', `Node ${archive} SHA-256 mismatch`);
            }
          }
        } else {
          log(`[WARN] SHASUMS256.txt HTTP ${res.status} — skipping checksum`);
        }
      } catch (error) {
        if (error instanceof BridgeError) {throw error;}
        log(`[WARN] checksum verification skipped: ${String(error)}`);
      }

      const versionDir = path.join(this.deps.layout.node, version);
      await fsp.mkdir(versionDir, { recursive: true });
      const buf = await fsp.readFile(archivePath);
      if (ext === 'zip') {
        const { extractZip } = await import('../core/archive.js');
        extractZip(buf, tmpDir);
        // find node.exe
        const exe = findFile(tmpDir, 'node.exe');
        if (!exe) {throw new BridgeError('node_not_found_in_archive', 'node.exe not found in archive');}
        const target = path.join(versionDir, 'node.exe');
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(exe, target);
      } else {
        extractTarGz(buf, tmpDir);
        const exe = findFile(tmpDir, path.join('bin', 'node'));
        if (!exe) {throw new BridgeError('node_not_found_in_archive', 'bin/node not found in archive');}
        const target = path.join(versionDir, 'bin', 'node');
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(exe, target);
        await fsp.chmod(target, 0o755);
      }

      this.deps.nodes.invalidate();
      return await this.deps.nodes.resolveRealNode();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }
}

function asAbort(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  }
  const sub = token.onCancellationRequested(() => controller.abort());
  // caller owns lifetime; sub disposed when token disposed by VS Code
  void sub;
  return controller.signal;
}

async function downloadAndExtract(url: string, destDir: string, signal?: AbortSignal): Promise<void> {
  const tmp = `${destDir}.tgz`;
  await downloadToFile(url, tmp, { signal, retries: 3 });
  const buf = await fsp.readFile(tmp);
  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(destDir, { recursive: true });
  extractTarGz(buf, destDir);
  await fsp.rm(tmp, { force: true });
}

async function sha256(filePath: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(await fsp.readFile(filePath)).digest('hex');
}

function findFile(root: string, relative: string): string | null {
  const direct = path.join(root, relative);
  if (fs.existsSync(direct)) {return direct;}
  // Walk one nested package/ dir (tarball layouts vary)
  try {
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          const candidate = path.join(full, relative);
          if (fs.existsSync(candidate)) {return candidate;}
          stack.push(full);
        } else if (path.basename(full) === path.basename(relative) && !relative.includes('/')) {
          return full;
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}
