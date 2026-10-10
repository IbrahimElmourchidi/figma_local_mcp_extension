import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_INSPECT_DEPTH,
  PATCH_LEVEL,
  patchBridgeCli,
  patchMcpServer,
} from '../../tool/runtimePatches.mjs';

const seedDir = path.resolve(__dirname, '../../runtime-seed');
const readSeed = (file: string): string => fs.readFileSync(path.join(seedDir, file), 'utf8');

/**
 * Minimal fixtures reproducing upstream's compiled output shape. Behaviour
 * tests run against these rather than the committed seed, because the seed is
 * patched by `npm run sync-runtime` and is therefore expected to already carry
 * the output — asserting "applied" against it would break the moment the seed is
 * legitimately rebuilt.
 */
const PRISTINE_MCP = [
  'var DEFAULT_DEPTH = 2;',
  'var MAX_DEPTH = 5;',
  'var DEFAULT_MAX_CHILDREN = 20;',
  'var MAX_CHILDREN = 100;',
  'var inspectSelectionInputSchema = {',
  '  depth: external_exports.number().int().min(0).max(5).optional(),',
  '  maxChildren: external_exports.number().int().min(0).max(100).optional()',
  '};',
  'var inspectCurrentSelectionInputSchema = {',
  '  depth: external_exports.number().int().min(0).max(5).optional(),',
  '};',
  // get_file / get_nodes / list_frames are unbounded upstream and must stay so.
  'var otherSchema = {',
  '  depth: external_exports.number().int().nonnegative().optional(),',
  '};',
].join('\n');

const PRISTINE_CLI = [
  'var DEFAULT_DEPTH = 2;',
  'var MAX_DEPTH = 5;',
  '.option("--depth <n>", "child depth to include (0-5)", parseInteger)',
  '.action(async (options) => {',
  '  if (options.depth !== void 0 && options.depth > 5)',
  '    throw new InvalidArgumentError("depth must be between 0 and 5.");',
].join('\n');

describe('runtimePatches (upstream fixtures)', () => {
  it('lifts the clamp and both inspect schemas in mcp-server', () => {
    const result = patchMcpServer(PRISTINE_MCP);
    expect(result.skipped).toEqual([]);
    expect(result.applied.map((p) => p.name)).toEqual(['max-depth-decl', 'inspect-depth-schema']);

    expect(result.text).not.toContain('var MAX_DEPTH = 5;');
    expect(result.text).toContain('process.env.FIGMA_MCP_MAX_DEPTH');
    // Both schemas, or a client still rejects the higher depth for one tool.
    expect(result.text).not.toContain('min(0).max(5).optional()');
    expect(
      result.text.match(new RegExp(`min\\(0\\)\\.max\\(${MAX_INSPECT_DEPTH}\\)\\.optional\\(\\)`, 'g')),
    ).toHaveLength(2);
  });

  it('leaves the unbounded depth tools alone', () => {
    // A sloppy patch could clamp get_file / get_nodes / list_frames too and
    // shrink their responses for no reason.
    const result = patchMcpServer(PRISTINE_MCP);
    expect(result.text).toContain('depth: external_exports.number().int().nonnegative().optional()');
  });

  it('lifts the clamp, guard and strings in bridge-cli', () => {
    const result = patchBridgeCli(PRISTINE_CLI);
    expect(result.skipped).toEqual([]);
    expect(result.applied.map((p) => p.name)).toEqual([
      'max-depth-decl',
      'inspect-cli-guard',
      'inspect-cli-help',
      'inspect-cli-error',
    ]);
    expect(result.text).not.toContain('var MAX_DEPTH = 5;');
    expect(result.text).toContain('process.env.FIGMA_MCP_MAX_DEPTH');
    expect(result.text).toContain(`options.depth > ${MAX_INSPECT_DEPTH}`);
    expect(result.text).toContain(`between 0 and ${MAX_INSPECT_DEPTH}`);
    expect(result.text).toContain(`child depth to include (0-${MAX_INSPECT_DEPTH})`);
  });

  it('is idempotent', () => {
    for (const [src, fn] of [
      [PRISTINE_MCP, patchMcpServer],
      [PRISTINE_CLI, patchBridgeCli],
    ] as const) {
      const once = fn(src);
      const twice = fn(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.applied).toEqual([]);
      expect(twice.skipped.every((s) => s.detail === 'already patched')).toBe(true);
    }
  });

  it('skips safely instead of corrupting when an anchor disappears', () => {
    // Simulates upstream renaming the constant: the clamp cannot be patched,
    // but the rest still lands and the text is never half-edited.
    const drifted = PRISTINE_MCP.replace('var MAX_DEPTH = 5;', 'const DEPTH_CAP = 5;');
    const result = patchMcpServer(drifted);
    expect(result.skipped.map((s) => s.name)).toEqual(['max-depth-decl']);
    expect(result.applied.map((p) => p.name)).toEqual(['inspect-depth-schema']);
    expect(result.text).toContain('const DEPTH_CAP = 5;');
    expect(result.text).toContain(`min(0).max(${MAX_INSPECT_DEPTH}).optional()`);
  });

  it('declares a patch level for install migration', () => {
    // manifestNeedsUpgrade short-circuits on an identical upstreamSha, so this
    // counter is what pushes a patched seed to already-installed extensions.
    expect(PATCH_LEVEL).toBeGreaterThan(0);
  });
});

/**
 * The committed seed ships patched. These assertions guard the shipped artifact
 * itself — a silent upstream refactor would show up here as a skipped patch.
 */
describe('runtimePatches (committed seed)', () => {
  it('mcp-server.cjs is patched and needs no further edits', () => {
    const result = patchMcpServer(readSeed('mcp-server.cjs'));
    expect(result.applied).toEqual([]);
    expect(result.skipped.every((s) => s.detail === 'already patched')).toBe(true);
    expect(result.text).not.toContain('var MAX_DEPTH = 5;');
    expect(result.text).not.toContain('min(0).max(5).optional()');
  });

  it('bridge-cli.cjs is patched and needs no further edits', () => {
    const result = patchBridgeCli(readSeed('bridge-cli.cjs'));
    expect(result.applied).toEqual([]);
    expect(result.skipped.every((s) => s.detail === 'already patched')).toBe(true);
    expect(result.text).not.toContain('var MAX_DEPTH = 5;');
  });

  it('produces syntactically valid output', () => {
    for (const [file, fn] of [
      ['mcp-server.cjs', patchMcpServer],
      ['bridge-cli.cjs', patchBridgeCli],
    ] as const) {
      // Strip the shebang: `new Function` rejects it, and it is pre-existing.
      const body = fn(readSeed(file)).text.replace(/^#![^\n]*\n/, '');
      expect(() => new Function('process', 'require', 'module', 'exports', body)).not.toThrow();
    }
  });
});

describe('runtimePatches (patched MAX_DEPTH behaviour)', () => {
  /** Extracts and evaluates just the patched declaration from a fixture. */
  function clamp(bundle: string, env: string | undefined): number {
    const decl = bundle.match(/var MAX_DEPTH = \/\* figma-mcp-bridge[\s\S]*?\}\)\(\);/);
    expect(decl).not.toBeNull();
    const run = new Function(
      'process',
      (decl as RegExpMatchArray)[0].replace('var MAX_DEPTH =', 'return'),
    );
    if (env === undefined) {
      delete process.env.FIGMA_MCP_MAX_DEPTH;
    } else {
      process.env.FIGMA_MCP_MAX_DEPTH = env;
    }
    try {
      return run({ env: process.env }) as number;
    } finally {
      delete process.env.FIGMA_MCP_MAX_DEPTH;
    }
  }

  const bundle = patchMcpServer(PRISTINE_MCP).text;

  it('falls back to upstream default when unset or unusable', () => {
    expect(clamp(bundle, undefined)).toBe(5);
    expect(clamp(bundle, '')).toBe(5);
    expect(clamp(bundle, '   ')).toBe(5);
    expect(clamp(bundle, 'abc')).toBe(5);
  });

  it('honours a user value, including 0', () => {
    // 0 is a legal request (returns no children); `|| fallback` would eat it.
    expect(clamp(bundle, '0')).toBe(0);
    expect(clamp(bundle, '12')).toBe(12);
    expect(clamp(bundle, ' 12 ')).toBe(12);
    expect(clamp(bundle, '7.9')).toBe(7);
  });

  it('clamps to the supported range', () => {
    expect(clamp(bundle, String(MAX_INSPECT_DEPTH))).toBe(MAX_INSPECT_DEPTH);
    expect(clamp(bundle, '9999')).toBe(MAX_INSPECT_DEPTH);
    expect(clamp(bundle, '-3')).toBe(0);
  });
});