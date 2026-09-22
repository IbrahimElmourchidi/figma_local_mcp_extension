import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { RuntimeStore, parseManifest, verifyRuntimeFiles } from '../../src/services/runtimeStore';
import { createStorageLayout, seedDir } from '../../src/core/paths';
import { BridgeError } from '../../src/errors';
import { BRIDGE_CLI_FILE, MANIFEST_FILE, MCP_SERVER_FILE, VERSION_FILE } from '../../src/constants';

function writeRuntime(dir: string, sha: string, withManifest = true): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MCP_SERVER_FILE), `// mcp ${sha}`);
  fs.writeFileSync(path.join(dir, BRIDGE_CLI_FILE), `// cli ${sha}`);
  fs.writeFileSync(path.join(dir, VERSION_FILE), `${sha}\n`);
  if (withManifest) {
    const mcpHash = createHash('sha256').update(fs.readFileSync(path.join(dir, MCP_SERVER_FILE))).digest('hex');
    const cliHash = createHash('sha256').update(fs.readFileSync(path.join(dir, BRIDGE_CLI_FILE))).digest('hex');
    fs.writeFileSync(
      path.join(dir, MANIFEST_FILE),
      JSON.stringify({
        schema: 1,
        upstreamRepo: 'superdoccimo/figma-mcp-free',
        upstreamSha: sha,
        files: { [MCP_SERVER_FILE]: mcpHash, [BRIDGE_CLI_FILE]: cliHash },
      }),
    );
  }
}

describe('parseManifest', () => {
  it('defaults missing fields', () => {
    const m = parseManifest('{}');
    expect(m.schema).toBe(1);
    expect(m.upstreamSha).toBe('');
    expect(m.files).toEqual({});
  });
});

describe('verifyRuntimeFiles', () => {
  it('hard-fails on missing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
    try {
      expect(() =>
        verifyRuntimeFiles(dir, {
          schema: 1,
          upstreamRepo: 'r',
          upstreamSha: 's',
          files: { 'missing.cjs': 'abc' },
        }),
      ).toThrow(BridgeError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hard-fails on hash mismatch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.cjs'), 'data');
      expect(() =>
        verifyRuntimeFiles(dir, {
          schema: 1,
          upstreamRepo: 'r',
          upstreamSha: 's',
          files: { 'a.cjs': 'deadbeef' },
        }),
      ).toThrow(/SHA-256 mismatch/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('RuntimeStore', () => {
  let root: string;
  let seed: string;
  let store: RuntimeStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-store-'));
    seed = path.join(root, 'seed');
    writeRuntime(seed, 'sha-new');
    const layout = createStorageLayout(path.join(root, 'data'));
    store = new RuntimeStore(layout, seed);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('seeds on first ensureInstalled', () => {
    const runtime = store.ensureInstalled();
    expect(fs.existsSync(path.join(runtime, MCP_SERVER_FILE))).toBe(true);
    expect(store.getInstalledManifest()?.upstreamSha).toBe('sha-new');
    expect(store.isHealthy()).toBe(true);
  });

  it('upgrades when seed sha differs from installed', () => {
    store.ensureInstalled();
    // Simulate older install
    writeRuntime(path.join(root, 'data', 'runtime'), 'sha-old');
    store.ensureInstalled();
    expect(store.getInstalledManifest()?.upstreamSha).toBe('sha-new');
  });

  it('no-ops when shas match', () => {
    store.ensureInstalled();
    const mtimeBefore = fs.statSync(path.join(root, 'data', 'runtime', MCP_SERVER_FILE)).mtimeMs;
    store.ensureInstalled();
    const mtimeAfter = fs.statSync(path.join(root, 'data', 'runtime', MCP_SERVER_FILE)).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it('stageAndSwap rotates previous and supports rollback', () => {
    store.ensureInstalled();
    const staged = path.join(root, 'staged');
    writeRuntime(staged, 'sha-staged');
    store.stageAndSwap(staged);
    expect(store.getInstalledManifest()?.upstreamSha).toBe('sha-staged');
    expect(store.hasRollbackAvailable()).toBe(true);
    store.rollback();
    expect(store.getInstalledManifest()?.upstreamSha).toBe('sha-new');
  });

  it('forceReinstall restores seed', () => {
    store.ensureInstalled();
    writeRuntime(path.join(root, 'data', 'runtime'), 'tampered');
    store.forceReinstall();
    expect(store.getInstalledManifest()?.upstreamSha).toBe('sha-new');
  });

  it('keeps a newer on-device build instead of reseeding an older seed', () => {
    store.ensureInstalled();
    const runtimeDir = path.join(root, 'data', 'runtime');
    const staged = path.join(root, 'staged');
    writeRuntime(staged, 'sha-built');
    const builtManifest = JSON.parse(fs.readFileSync(path.join(staged, MANIFEST_FILE), 'utf8'));
    builtManifest.upstreamCommittedAt = '2026-09-20T00:00:00Z';
    builtManifest.builtBy = 'on-device';
    fs.writeFileSync(path.join(staged, MANIFEST_FILE), JSON.stringify(builtManifest));
    store.stageAndSwap(staged);

    const seedManifest = JSON.parse(fs.readFileSync(path.join(seed, MANIFEST_FILE), 'utf8'));
    seedManifest.upstreamCommittedAt = '2026-09-01T00:00:00Z';
    fs.writeFileSync(path.join(seed, MANIFEST_FILE), JSON.stringify(seedManifest));

    store.ensureInstalled();
    expect(store.getInstalledManifest()?.upstreamSha).toBe('sha-built');
    expect(fs.existsSync(path.join(runtimeDir, MCP_SERVER_FILE))).toBe(true);
  });

  it('reseeds when the seed has a strictly newer upstream commit', () => {
    const runtimeDir = path.join(root, 'data', 'runtime');
    writeRuntime(runtimeDir, 'sha-old');
    const installed = JSON.parse(fs.readFileSync(path.join(runtimeDir, MANIFEST_FILE), 'utf8'));
    installed.upstreamCommittedAt = '2026-09-01T00:00:00Z';
    installed.builtBy = 'on-device';
    fs.writeFileSync(path.join(runtimeDir, MANIFEST_FILE), JSON.stringify(installed));
    const seedManifest = JSON.parse(fs.readFileSync(path.join(seed, MANIFEST_FILE), 'utf8'));
    seedManifest.upstreamCommittedAt = '2026-09-20T00:00:00Z';
    fs.writeFileSync(path.join(seed, MANIFEST_FILE), JSON.stringify(seedManifest));

    store.ensureInstalled();
    expect(store.getInstalledManifest()?.upstreamSha).toBe('sha-new');
  });

  it('fails fast on a corrupt seed, cleans staging, and retries once the seed changes', () => {
    const cli = path.join(seed, BRIDGE_CLI_FILE);
    const original = fs.readFileSync(cli, 'utf8');
    fs.writeFileSync(cli, `\n${original}`);

    expect(() => store.ensureInstalled()).toThrow(/integrity check.*bridge-cli\.cjs/);
    expect(fs.existsSync(path.join(root, 'data', 'runtime-staging'))).toBe(false);

    // Same corrupt seed → cached failure, no re-copy into staging.
    expect(() => store.ensureInstalled()).toThrow(/integrity check/);
    expect(fs.existsSync(path.join(root, 'data', 'runtime-staging'))).toBe(false);

    fs.writeFileSync(cli, original);
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(cli, future, future);
    store.ensureInstalled();
    expect(store.isHealthy()).toBe(true);
  });

  it('throws when seed missing and nothing installed', () => {
    const layout = createStorageLayout(path.join(root, 'empty'));
    const emptyStore = new RuntimeStore(layout, path.join(root, 'no-seed'));
    expect(() => emptyStore.ensureInstalled()).toThrow(/seed/i);
  });
});

describe('committed runtime-seed', () => {
  // Guards against an accidental editor save (e.g. a stray blank line before
  // the shebang) shipping a seed that fails verification on every activation.
  it('matches the hashes in its own runtime.json', () => {
    const dir = path.resolve(__dirname, '../../runtime-seed');
    const manifest = parseManifest(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
    expect(Object.keys(manifest.files).length).toBeGreaterThan(0);
    expect(() => verifyRuntimeFiles(dir, manifest)).not.toThrow();
  });
});

describe('seedDir helper', () => {
  it('joins extension path with runtime-seed', () => {
    expect(seedDir('/ext')).toBe(path.join('/ext', 'runtime-seed'));
  });
});
