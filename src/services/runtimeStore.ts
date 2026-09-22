import * as fs from 'node:fs';
import * as fspath from 'node:path';
import {
  BRIDGE_CLI_FILE,
  MANIFEST_FILE,
  MCP_SERVER_FILE,
  PLUGIN_CODE_FILE,
  PLUGIN_DIR,
  PLUGIN_MANIFEST_TEMPLATE,
  PLUGIN_UI_FILE,
  UPSTREAM_OWNER,
  UPSTREAM_REPO,
  VERSION_FILE,
} from '../constants';
import { BridgeError } from '../errors';
import { StorageLayout } from '../core/paths';
import { withLock } from '../core/lock';

export interface RuntimeManifest {
  readonly schema: number;
  readonly upstreamRepo: string;
  readonly upstreamSha: string;
  readonly upstreamCommittedAt?: string;
  readonly builtAt?: string;
  readonly builtBy?: string;
  readonly esbuildVersion?: string;
  readonly nodeTarget?: string;
  readonly files: Readonly<Record<string, string>>;
}

export function parseManifest(raw: string): RuntimeManifest {
  const data = JSON.parse(raw) as Partial<RuntimeManifest>;
  return {
    schema: data.schema ?? 1,
    upstreamRepo: data.upstreamRepo ?? '',
    upstreamSha: data.upstreamSha ?? '',
    upstreamCommittedAt: data.upstreamCommittedAt,
    builtAt: data.builtAt,
    builtBy: data.builtBy,
    esbuildVersion: data.esbuildVersion,
    nodeTarget: data.nodeTarget,
    files: data.files ?? {},
  };
}

function readManifestDir(dir: string): RuntimeManifest | null {
  const manifestPath = fspath.join(dir, MANIFEST_FILE);
  if (fs.existsSync(manifestPath)) {
    try {
      return parseManifest(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      // fall through to VERSION
    }
  }
  const versionPath = fspath.join(dir, VERSION_FILE);
  if (fs.existsSync(versionPath)) {
    const sha = fs.readFileSync(versionPath, 'utf8').trim();
    if (sha) {
      return {
        schema: 1,
        upstreamRepo: `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`,
        upstreamSha: sha,
        files: {},
      };
    }
  }
  return null;
}

function dirLooksInstalled(dir: string): boolean {
  return (
    fs.existsSync(fspath.join(dir, MCP_SERVER_FILE)) &&
    fs.existsSync(fspath.join(dir, BRIDGE_CLI_FILE)) &&
    (fs.existsSync(fspath.join(dir, MANIFEST_FILE)) ||
      fs.existsSync(fspath.join(dir, VERSION_FILE)))
  );
}

/** Hard-fail verification of every file listed in the manifest. */
export function verifyRuntimeFiles(dir: string, manifest: RuntimeManifest): void {
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const full = fspath.join(dir, ...rel.split('/'));
    if (!fs.existsSync(full)) {
      throw new BridgeError('staged_file_missing', `Runtime file missing: ${rel}`);
    }
    // sha256File is sync via readFileSync under the hood? No - async. Use sync for lock simplicity.
    const actual = sha256FileSync(full);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new BridgeError('checksum_mismatch', `SHA-256 mismatch for ${rel}`);
    }
  }
}

function sha256FileSync(filePath: string): string {
  // Local require-free sync hash to keep verifyRuntimeFiles synchronous under locks.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = fspath.join(src, entry.name);
    const to = fspath.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function renameOrCopy(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch {
    copyTree(src, dest);
    removeDir(src);
  }
}

/** Cheap fingerprint of the seed dir (sizes + mtimes) — changes whenever a file is edited. */
function seedSignature(dir: string, manifest: RuntimeManifest | null): string {
  const rels = [MANIFEST_FILE, VERSION_FILE, ...Object.keys(manifest?.files ?? {})];
  return rels
    .map((rel) => {
      try {
        const st = fs.statSync(fspath.join(dir, ...rel.split('/')));
        return `${rel}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${rel}:missing`;
      }
    })
    .join('|');
}

export class RuntimeStore {
  /**
   * Last failed seed attempt, keyed by seed fingerprint. ensureInstalled() is
   * called on hot paths (every MCP provider query), so a corrupt seed must not
   * be re-copied and re-hashed each time — it fails fast until the seed changes.
   */
  private seedFailure: { signature: string; error: BridgeError } | null = null;

  constructor(
    private readonly layout: StorageLayout,
    private readonly seedPath: string,
  ) {}

  private lock<T>(action: () => T): T {
    return withLock(this.layout.locks, 'runtime', action);
  }

  /**
   * Seed from the VSIX-bundled runtime-seed/ on first run or when the seed's
   * upstreamSha is newer than the installed runtime (fixes presence-only installs).
   */
  ensureInstalled(): string {
    return this.lock(() => {
      fs.mkdirSync(this.layout.runtime, { recursive: true });
      if (!fs.existsSync(this.seedPath)) {
        if (dirLooksInstalled(this.layout.runtime)) {
          return this.layout.runtime;
        }
        throw new BridgeError(
          'seed_missing',
          'Bundled runtime-seed is missing and no runtime is installed. Reinstall the extension or build from source.',
        );
      }

      const seedManifest = readManifestDir(this.seedPath);
      const installedManifest = readManifestDir(this.layout.runtime);
      const needsInstall =
        !dirLooksInstalled(this.layout.runtime) ||
        !installedManifest ||
        !seedManifest ||
        manifestNeedsUpgrade(installedManifest, seedManifest);

      if (needsInstall) {
        const signature = seedSignature(this.seedPath, seedManifest);
        if (this.seedFailure?.signature === signature) {
          throw this.seedFailure.error;
        }
        try {
          this.seedIntoRuntime();
          this.seedFailure = null;
        } catch (error) {
          const bridgeError =
            error instanceof BridgeError ? error : new BridgeError('unexpected', String(error));
          this.seedFailure = { signature, error: bridgeError };
          throw bridgeError;
        }
      }
      return this.layout.runtime;
    });
  }

  private seedIntoRuntime(): void {
    const staging = this.layout.runtimeStaging;
    removeDir(staging);
    fs.mkdirSync(staging, { recursive: true });
    copyTree(this.seedPath, staging);

    const stagedManifest = readManifestDir(staging);
    if (stagedManifest && Object.keys(stagedManifest.files).length > 0) {
      try {
        verifyRuntimeFiles(staging, stagedManifest);
      } catch (error) {
        removeDir(staging);
        const detail = error instanceof Error ? error.message : String(error);
        throw new BridgeError(
          'checksum_mismatch',
          `Bundled runtime seed failed its integrity check (${detail}). ` +
            'Reinstall the extension or run "Build from source".',
        );
      }
    }

    this.swapStaging(staging);
  }

  getRuntimePath(): string {
    return this.ensureInstalled();
  }

  getBridgeCliPath(): string {
    const runtime = this.ensureInstalled();
    const full = fspath.join(runtime, BRIDGE_CLI_FILE);
    if (!fs.existsSync(full)) {
      throw new BridgeError('bridge_cli_not_found', 'Bridge CLI (bridge-cli.cjs) not found in runtime.');
    }
    return full;
  }

  getMcpServerPath(override?: string): string {
    if (override && override.trim().length > 0 && fs.existsSync(override)) {
      return override;
    }
    const runtime = this.ensureInstalled();
    const full = fspath.join(runtime, MCP_SERVER_FILE);
    if (!fs.existsSync(full)) {
      throw new BridgeError('mcp_server_not_found', 'MCP server (mcp-server.cjs) not found in runtime.');
    }
    return full;
  }

  getPluginDirPath(): string {
    const runtime = this.ensureInstalled();
    return fspath.join(runtime, PLUGIN_DIR);
  }

  getInstalledManifest(): RuntimeManifest | null {
    if (!fs.existsSync(this.layout.runtime)) {
      return null;
    }
    return readManifestDir(this.layout.runtime);
  }

  /** Verify staged output, then rotate runtime → runtime.previous and staging → runtime. */
  stageAndSwap(stagedDir: string): void {
    this.lock(() => {
      if (!fs.existsSync(stagedDir)) {
        throw new BridgeError('staged_file_missing', `Staging directory missing: ${stagedDir}`);
      }
      const stagedManifest = readManifestDir(stagedDir);
      if (stagedManifest) {
        verifyRuntimeFiles(stagedDir, stagedManifest);
      } else {
        // Without a manifest at least require the two entry points.
        if (
          !fs.existsSync(fspath.join(stagedDir, MCP_SERVER_FILE)) ||
          !fs.existsSync(fspath.join(stagedDir, BRIDGE_CLI_FILE))
        ) {
          throw new BridgeError('staged_file_missing', 'Staged runtime is missing entry points.');
        }
      }
      this.swapStaging(stagedDir);
    });
  }

  private swapStaging(stagedDir: string): void {
    if (fs.existsSync(this.layout.runtime)) {
      removeDir(this.layout.runtimePrevious);
      renameOrCopy(this.layout.runtime, this.layout.runtimePrevious);
    }
    renameOrCopy(stagedDir, this.layout.runtime);
  }

  rollback(): void {
    this.lock(() => {
      if (!fs.existsSync(this.layout.runtimePrevious)) {
        throw new BridgeError('no_previous_runtime', 'No previous runtime available for rollback.');
      }
      if (fs.existsSync(this.layout.runtime)) {
        removeDir(this.layout.runtime);
      }
      renameOrCopy(this.layout.runtimePrevious, this.layout.runtime);
    });
  }

  hasRollbackAvailable(): boolean {
    return fs.existsSync(this.layout.runtimePrevious);
  }

  forceReinstall(): void {
    this.lock(() => {
      removeDir(this.layout.runtime);
      removeDir(this.layout.runtimePrevious);
      removeDir(this.layout.runtimeStaging);
      fs.mkdirSync(this.layout.runtime, { recursive: true });
      this.seedIntoRuntime();
    });
  }

  isHealthy(): boolean {
    try {
      const runtime = this.layout.runtime;
      return (
        fs.existsSync(fspath.join(runtime, MCP_SERVER_FILE)) &&
        fs.existsSync(fspath.join(runtime, BRIDGE_CLI_FILE))
      );
    } catch {
      return false;
    }
  }

  pluginFiles(): { codePath: string; uiPath: string; templatePath: string | null } {
    const pluginDir = this.getPluginDirPath();
    const codePath = fspath.join(pluginDir, PLUGIN_CODE_FILE);
    const uiPath = fspath.join(pluginDir, PLUGIN_UI_FILE);
    const templatePath = fspath.join(pluginDir, PLUGIN_MANIFEST_TEMPLATE);
    if (!fs.existsSync(codePath) || !fs.existsSync(uiPath)) {
      throw new BridgeError('seed_missing', 'Plugin files missing from runtime.');
    }
    return { codePath, uiPath, templatePath: fs.existsSync(templatePath) ? templatePath : null };
  }
}

function manifestNeedsUpgrade(installed: RuntimeManifest, seed: RuntimeManifest): boolean {
  const a = installed.upstreamSha;
  const b = seed.upstreamSha;
  if (!b) {
    return false;
  }
  if (!a || a === 'unknown') {
    return true;
  }
  if (a === b) {
    return false;
  }
  // Shas differ. Without this check an on-device "Build from source" (newer
  // upstream commit) would be clobbered by the older VSIX seed on every
  // activation. Only a seed with a strictly newer upstream commit wins.
  const installedAt = Date.parse(installed.upstreamCommittedAt ?? '');
  const seedAt = Date.parse(seed.upstreamCommittedAt ?? '');
  if (Number.isFinite(installedAt) && Number.isFinite(seedAt)) {
    return seedAt > installedAt;
  }
  if (installed.builtBy === 'on-device') {
    return false;
  }
  // No dates to compare (legacy VERSION-only install): prefer the VSIX seed.
  return true;
}
