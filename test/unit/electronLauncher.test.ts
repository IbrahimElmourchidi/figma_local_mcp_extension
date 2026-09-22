import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptArgs } from '../../src/services/nodeResolver';

const repo = path.resolve(__dirname, '../..');
const launcher = path.join(repo, 'resources', 'electron-node-launcher.cjs');
const bridgeCli = path.join(repo, 'runtime-seed', 'bridge-cli.cjs');

describe('scriptArgs', () => {
  it('prepends the launcher when one is set', () => {
    expect(scriptArgs({ launcher: '/l.cjs' }, '/s.cjs', ['serve'])).toEqual(['/l.cjs', '/s.cjs', 'serve']);
  });

  it('passes the script straight through without a launcher', () => {
    expect(scriptArgs({}, '/s.cjs', ['serve'])).toEqual(['/s.cjs', 'serve']);
  });
});

describe('electron-node-launcher', () => {
  // Plain node with process.versions.electron defined reproduces what
  // commander sees under VS Code's ELECTRON_RUN_AS_NODE.
  let tmp: string;
  let fakeElectron: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-'));
    fakeElectron = path.join(tmp, 'fake-electron.cjs');
    fs.writeFileSync(
      fakeElectron,
      "Object.defineProperty(process.versions, 'electron', { value: '37.0.0', enumerable: true });\n",
    );
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run(args: string[]): string {
    try {
      return execFileSync(process.execPath, ['--require', fakeElectron, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      return `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
  }

  it('reproduces the bug: bridge-cli misparses argv under Electron without the launcher', () => {
    const out = run([bridgeCli, 'serve', '--help']);
    expect(out).not.toContain('Usage: figma-mcp-free-bridge serve');
  });

  it('bridge-cli sees the serve subcommand when run through the launcher', () => {
    const out = run([launcher, bridgeCli, 'serve', '--help']);
    expect(out).toContain('Usage: figma-mcp-free-bridge serve');
  });

  it('keeps require.main and argv intact for the target script', () => {
    const target = path.join(tmp, 'target.cjs');
    fs.writeFileSync(
      target,
      'console.log(JSON.stringify({ isMain: require.main === module, argv1: process.argv[1], rest: process.argv.slice(2) }));\n',
    );
    const result = JSON.parse(run([launcher, target, 'a', '--b']).trim()) as {
      isMain: boolean;
      argv1: string;
      rest: string[];
    };
    expect(result).toEqual({ isMain: true, argv1: target, rest: ['a', '--b'] });
  });

  it('resolves a relative script path like node does', () => {
    const target = path.join(tmp, 'rel-target.cjs');
    fs.writeFileSync(target, 'console.log(process.argv[1]);\n');
    const out = execFileSync(
      process.execPath,
      ['--require', fakeElectron, launcher, path.relative(tmp, target)],
      { cwd: tmp, encoding: 'utf8' },
    );
    expect(out.trim()).toBe(target);
  });
});
