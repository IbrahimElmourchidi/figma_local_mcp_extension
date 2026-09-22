#!/usr/bin/env node
/**
 * Build runtime-seed/ from superdoccimo/figma-mcp-free.
 *
 * Port of ../figma_local_mcp_gui/tool/build_runtime_bundle.sh + the build/verify
 * steps of .github/workflows/runtime-sync.yml, in pure Node (no bash) so it runs
 * on Windows too.
 *
 * Usage:
 *   node tool/build-runtime.mjs [--ref <sha|branch|tag>] [--out runtime-seed] [--skip-verify]
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const UPSTREAM_OWNER = 'superdoccimo';
const UPSTREAM_REPO = 'figma-mcp-free';
const DEFAULT_REF = 'main';
const ESBUILD_VERSION = '0.28.2';
const DEFAULT_PNPM_VERSION = '9.15.9';
const NODE_TARGET = 'node18';

function parseArgs(argv) {
  const args = { ref: DEFAULT_REF, out: path.join(ROOT, 'runtime-seed'), skipVerify: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--ref') args.ref = argv[++i];
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--skip-verify') args.skipVerify = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node tool/build-runtime.mjs [--ref sha|branch|tag] [--out dir] [--skip-verify]');
      process.exit(0);
    }
  }
  return args;
}

function log(msg) {
  console.log(`[build-runtime] ${msg}`);
}

function fail(msg, code = 1) {
  console.error(`[build-runtime] ERROR: ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Minimal tar.gz extraction (safe paths only) — inlined so this script has no
// TS/bundler dependency.
// ---------------------------------------------------------------------------

function safeEntryPath(entryPath) {
  if (!entryPath) return null;
  let p = entryPath.replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const segments = p.split('/');
  if (segments.some((seg) => seg === '..')) return null;
  if (p.endsWith('/')) return null;
  return p;
}

function readTarString(header, start, length) {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end >= 0 ? end : slice.length).toString('utf8');
}

function parsePaxPath(raw) {
  // PAX extended-header record blob: "<len> <key>=<value>\n" repeated.
  let offset = 0;
  while (offset < raw.length) {
    const spaceIdx = raw.indexOf(' ', offset);
    if (spaceIdx === -1) break;
    const len = parseInt(raw.slice(offset, spaceIdx), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = raw.slice(offset, offset + len);
    const eqIdx = record.indexOf('=');
    if (eqIdx !== -1) {
      const key = record.slice(spaceIdx - offset + 1, eqIdx);
      if (key === 'path') return record.slice(eqIdx + 1).replace(/\n$/, '');
    }
    offset += len;
  }
  return null;
}

function extractTarGz(buffer, destDir) {
  const tarBuffer = gunzipSync(buffer);
  fs.mkdirSync(destDir, { recursive: true });
  let offset = 0;
  let count = 0;
  // GNU long name ('L') / PAX extended header ('x') describe the *next*
  // header — needed for paths over ustar's 100+155-byte name+prefix fields.
  // 'g' (PAX global, e.g. codeload's leading pax_global_header) and 'K'
  // (GNU long link) are consumed and discarded; links are never followed.
  let pendingLongName = null;
  let pendingPaxPath = null;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    const name = readTarString(header, 0, 100);
    const typeFlag = String.fromCharCode(header[156]);
    if (name.length === 0 && typeFlag === '\0') break;

    const prefix = readTarString(header, 345, 155);
    const sizeOctal = readTarString(header, 124, 12).trim();
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const nextOffset = dataStart + Math.ceil(size / 512) * 512;

    if (typeFlag === 'L') {
      pendingLongName = tarBuffer.subarray(dataStart, dataEnd).toString('utf8').replace(/\0+$/, '');
      offset = nextOffset;
      continue;
    }
    if (typeFlag === 'K') {
      offset = nextOffset;
      continue;
    }
    if (typeFlag === 'x' || typeFlag === 'g') {
      if (typeFlag === 'x') {
        const paxPath = parsePaxPath(tarBuffer.subarray(dataStart, dataEnd).toString('utf8'));
        if (paxPath) pendingPaxPath = paxPath;
      }
      offset = nextOffset;
      continue;
    }

    let fullEntry;
    if (pendingLongName !== null) {
      fullEntry = pendingLongName;
      pendingLongName = null;
    } else if (pendingPaxPath !== null) {
      fullEntry = pendingPaxPath;
      pendingPaxPath = null;
    } else {
      fullEntry = prefix ? `${prefix}/${name}` : name;
    }

    if (typeFlag === '0' || typeFlag === '\0') {
      const safe = safeEntryPath(fullEntry);
      if (safe) {
        const full = path.join(destDir, ...safe.split('/'));
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, tarBuffer.subarray(dataStart, dataEnd));
        count += 1;
      }
    } else if (typeFlag === '5') {
      const raw = fullEntry.endsWith('/') ? fullEntry.slice(0, -1) : fullEntry;
      const safe = safeEntryPath(raw);
      if (safe) fs.mkdirSync(path.join(destDir, ...safe.split('/')), { recursive: true });
    }
    // symlink/hardlink ('1'/'2') skipped

    offset = nextOffset;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

async function downloadToFile(url, destPath, retries = 3) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5 * 60 * 1000),
        redirect: 'follow',
        headers: { 'User-Agent': 'figma-mcp-bridge-build' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fsp.writeFile(destPath, buf);
      return;
    } catch (e) {
      lastError = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function downloadAndExtractTgz(url, destDir) {
  const tmp = `${destDir}.tgz`;
  await downloadToFile(url, tmp);
  const buf = await fsp.readFile(tmp);
  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(destDir, { recursive: true });
  extractTarGz(buf, destDir);
  await fsp.rm(tmp, { force: true });
}

// ---------------------------------------------------------------------------
// Build pipeline
// ---------------------------------------------------------------------------

async function resolveRef(ref) {
  const url = `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/commits/${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'figma-mcp-bridge-build' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) fail(`Could not resolve ref "${ref}": HTTP ${res.status}`);
  const data = await res.json();
  if (!data.sha) fail(`Ref "${ref}" did not resolve to a commit sha`);
  return { sha: data.sha, committedAt: data.commit?.committer?.date ?? new Date().toISOString() };
}

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${file} ${args.join(' ')} exited with code ${code}\n${stderr}`));
    });
  });
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function esbuildOs() {
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return fail(`Unsupported platform: ${process.platform}`);
}

function esbuildArch() {
  return os.arch() === 'arm64' ? 'arm64' : 'x64';
}

async function fetchPnpmVersion(sourceDir) {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(sourceDir, 'package.json'), 'utf8'));
    const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
    const match = /^pnpm@(\d+\.\d+\.\d+)/.exec(pm);
    if (match) return match[1];
  } catch {
    // fall through
  }
  return DEFAULT_PNPM_VERSION;
}

function requireFile(p, what) {
  if (!fs.existsSync(p)) {
    fail(`${what} not found: ${p} — upstream layout changed?`);
  }
}

async function verifyRuntime(outDir) {
  log('Verifying mcp-server initialize…');
  const initMsg = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'seed-smoke', version: '1.0' },
    },
  });
  const mcpOut = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(outDir, 'mcp-server.cjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FIGMA_PLUGIN_BRIDGE_TOKEN: 'seed-smoke-token-0123456789abcdef0123456789',
      },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('mcp-server initialize timed out'));
    }, 10_000);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('"result"')) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve(out);
      }
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out || err);
    });
    child.stdin.write(`${initMsg}\n`);
    child.stdin.end();
  });
  if (!String(mcpOut).includes('"result"')) {
    fail(`mcp-server did not return a result for initialize:\n${mcpOut}`);
  }
  log('  MCP initialize → result ✓');

  log('Verifying bridge-cli /health 401/200…');
  const port = 18845 + Math.floor(Math.random() * 1000);
  const token = 'seed-smoke-token-0123456789abcdef0123456789';
  const bridge = spawn(
    process.execPath,
    [path.join(outDir, 'bridge-cli.cjs'), 'serve', '--port', String(port)],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FIGMA_PLUGIN_BRIDGE_TOKEN: token }, windowsHide: true },
  );
  let bridgeStderr = '';
  bridge.stderr.on('data', (d) => {
    bridgeStderr += d;
  });
  try {
    let ready = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!ready) fail(`bridge-cli did not start listening on :${port}\n${bridgeStderr}`);

    const unauth = await fetch(`http://127.0.0.1:${port}/health`);
    if (unauth.status !== 401) fail(`expected 401 for unauthenticated /health, got ${unauth.status}`);
    log('  unauthenticated /health → 401 ✓');

    const auth = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (auth.status !== 200) fail(`expected 200 for authenticated /health, got ${auth.status}`);
    log('  authenticated /health → 200 ✓');
  } finally {
    bridge.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    bridge.kill('SIGKILL');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'figma-mcp-runtime-'));
  const sourceDir = path.join(tmpRoot, 'source');

  try {
    const { sha, committedAt } = await resolveRef(args.ref);
    log(`Resolved ${args.ref} → ${sha}`);

    const tarballUrl = `https://codeload.github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/tar.gz/${sha}`;
    log(`Downloading ${tarballUrl}`);
    const tarPath = path.join(tmpRoot, 'source.tar.gz');
    await downloadToFile(tarballUrl, tarPath);
    const tarBuf = await fsp.readFile(tarPath);
    await fsp.mkdir(sourceDir, { recursive: true });
    extractTarGz(tarBuf, sourceDir);

    let src = sourceDir;
    const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    if (entries.length === 1 && dirs.length === 1) {
      src = path.join(sourceDir, dirs[0].name);
    }
    log(`Source at ${src}`);

    const pnpmVersion = await fetchPnpmVersion(src);
    log(`Using pnpm@${pnpmVersion}`);
    const pnpmDir = path.join(tmpRoot, 'pnpm');
    await downloadAndExtractTgz(`https://registry.npmjs.org/pnpm/-/pnpm-${pnpmVersion}.tgz`, pnpmDir);
    const pnpmCjs = path.join(pnpmDir, 'package', 'dist', 'pnpm.cjs');
    requireFile(pnpmCjs, 'pnpm.cjs');

    const hasLock = fs.existsSync(path.join(src, 'pnpm-lock.yaml'));
    const installArgs = ['install', ...(hasLock ? ['--frozen-lockfile'] : [])];
    log(`pnpm ${installArgs.join(' ')}`);
    await run(process.execPath, [pnpmCjs, ...installArgs], { cwd: src });

    log('pnpm -r run build');
    await run(process.execPath, [pnpmCjs, '-r', 'run', 'build'], { cwd: src });

    const esbuildDir = path.join(tmpRoot, 'esbuild');
    const osName = esbuildOs();
    const archName = esbuildArch();
    const esbuildUrl = `https://registry.npmjs.org/@esbuild/${osName}-${archName}/-/${osName}-${archName}-${ESBUILD_VERSION}.tgz`;
    log(`Downloading esbuild ${ESBUILD_VERSION} (${osName}-${archName})`);
    await downloadAndExtractTgz(esbuildUrl, esbuildDir);
    const esbuildBin =
      process.platform === 'win32'
        ? path.join(esbuildDir, 'package', 'esbuild.exe')
        : path.join(esbuildDir, 'package', 'bin', 'esbuild');
    requireFile(esbuildBin, 'esbuild binary');
    if (process.platform !== 'win32') {
      await fsp.chmod(esbuildBin, 0o755);
    }

    const mcpEntryCandidates = [
      path.join(src, 'packages/mcp-server/dist/index.js'),
      path.join(src, 'packages/mcp-server/dist/index.mjs'),
    ];
    const cliEntryCandidates = [
      path.join(src, 'packages/cli/dist/bridge-cli.js'),
      path.join(src, 'packages/cli/dist/bridge-cli.mjs'),
      path.join(src, 'packages/cli/dist/index.js'),
    ];
    const mcpEntry = mcpEntryCandidates.find((p) => fs.existsSync(p));
    const cliEntry = cliEntryCandidates.find((p) => fs.existsSync(p));
    if (!mcpEntry || !cliEntry) {
      fail(
        `upstream layout changed — expected packages/mcp-server/dist/index.js and packages/cli/dist/bridge-cli.js under ${src}`,
      );
    }

    const outDir = args.out;
    await fsp.rm(outDir, { recursive: true, force: true });
    await fsp.mkdir(outDir, { recursive: true });

    const bundleFlags = ['--bundle', '--platform=node', '--format=cjs', `--target=${NODE_TARGET}`];
    log('Bundling mcp-server.cjs');
    await run(esbuildBin, [mcpEntry, ...bundleFlags, `--outfile=${path.join(outDir, 'mcp-server.cjs')}`]);
    log('Bundling bridge-cli.cjs');
    await run(esbuildBin, [cliEntry, ...bundleFlags, `--outfile=${path.join(outDir, 'bridge-cli.cjs')}`]);

    const pluginSrc = path.join(src, 'plugins/local-bridge');
    const pluginOut = path.join(outDir, 'plugin');
    await fsp.mkdir(pluginOut, { recursive: true });
    for (const name of ['code.js', 'ui.html', 'manifest.template.json']) {
      const from = path.join(pluginSrc, name);
      requireFile(from, `plugin file ${name}`);
      await fsp.copyFile(from, path.join(pluginOut, name));
    }

    const builtAt = new Date().toISOString();
    await fsp.writeFile(path.join(outDir, 'VERSION'), `${sha}\n`, 'utf8');

    const files = {};
    for (const rel of [
      'mcp-server.cjs',
      'bridge-cli.cjs',
      'plugin/code.js',
      'plugin/ui.html',
      'plugin/manifest.template.json',
    ]) {
      files[rel] = sha256File(path.join(outDir, rel));
    }

    const manifest = {
      schema: 1,
      upstreamRepo: `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`,
      upstreamSha: sha,
      upstreamCommittedAt: committedAt,
      builtAt,
      builtBy: process.env.GITHUB_ACTIONS ? 'ci' : 'local',
      esbuildVersion: ESBUILD_VERSION,
      nodeTarget: NODE_TARGET,
      files,
    };
    await fsp.writeFile(path.join(outDir, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    // Normalize perms regardless of the umask this script ran under — these
    // are data files (always invoked as `node <path>` / read as text, never
    // executed directly), and a VSIX-bundled asset shouldn't ship world-writable.
    if (process.platform !== 'win32') {
      for (const rel of [...Object.keys(files), 'VERSION', 'runtime.json']) {
        await fsp.chmod(path.join(outDir, rel), 0o644);
      }
    }

    if (!args.skipVerify) {
      await verifyRuntime(outDir);
    } else {
      log('Skipping verification (--skip-verify)');
    }

    log(`Wrote ${outDir}`);
    for (const rel of ['mcp-server.cjs', 'bridge-cli.cjs', 'runtime.json']) {
      const st = await fsp.stat(path.join(outDir, rel));
      log(`  ${rel} (${st.size} bytes)`);
    }
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  fail(error?.stack ?? String(error));
});
