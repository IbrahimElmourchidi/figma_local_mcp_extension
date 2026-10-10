import { describe, expect, it } from 'vitest';
import { validateBridgeConfig, BridgeConfig } from '../../src/config/bridgeConfig';
import { BridgeError } from '../../src/errors';
import { DEFAULT_MAX_DEPTH, MAX_MAX_DEPTH } from '../../src/constants';

function cfg(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    port: 3845,
    host: '127.0.0.1',
    autoStart: false,
    mcpServerPath: '',
    opencodeNodePath: '',
    nodePath: '',
    figmaPluginId: '',
    autoCheckUpdates: true,
    maxDepth: 5,
    ...overrides,
  };
}

describe('validateBridgeConfig', () => {
  it('accepts defaults', () => {
    expect(() => validateBridgeConfig(cfg())).not.toThrow();
  });

  it('accepts all valid hosts', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(() => validateBridgeConfig(cfg({ host }))).not.toThrow();
    }
  });

  it('rejects out-of-range ports', () => {
    expect(() => validateBridgeConfig(cfg({ port: 0 }))).toThrow(BridgeError);
    expect(() => validateBridgeConfig(cfg({ port: 65536 }))).toThrow(BridgeError);
    expect(() => validateBridgeConfig(cfg({ port: 1.5 }))).toThrow(BridgeError);
  });

  it('rejects invalid hosts', () => {
    expect(() => validateBridgeConfig(cfg({ host: '0.0.0.0' }))).toThrow(BridgeError);
    expect(() => validateBridgeConfig(cfg({ host: 'example.com' }))).toThrow(BridgeError);
  });

  it('accepts empty optional paths (auto-detect)', () => {
    expect(() => validateBridgeConfig(cfg({ mcpServerPath: '', nodePath: '', opencodeNodePath: '' }))).not.toThrow();
  });

  it('rejects optional paths that do not exist', () => {
    expect(() => validateBridgeConfig(cfg({ mcpServerPath: '/no/such/mcp-server.cjs' }))).toThrow(BridgeError);
    expect(() => validateBridgeConfig(cfg({ nodePath: '/no/such/node' }))).toThrow(BridgeError);
    expect(() => validateBridgeConfig(cfg({ opencodeNodePath: '/no/such/node' }))).toThrow(BridgeError);
  });

  it('accepts optional paths that exist', () => {
    expect(() => validateBridgeConfig(cfg({ nodePath: process.execPath }))).not.toThrow();
  });

  describe('maxDepth', () => {
    it('accepts the default and the full valid range', () => {
      expect(() => validateBridgeConfig(cfg({ maxDepth: DEFAULT_MAX_DEPTH }))).not.toThrow();
      for (const depth of [1, DEFAULT_MAX_DEPTH, 12, MAX_MAX_DEPTH]) {
        expect(() => validateBridgeConfig(cfg({ maxDepth: depth }))).not.toThrow();
      }
    });

    it('rejects out-of-range and non-integer depths', () => {
      // 0 is a legal request to the patched bundle, but not a sensible user
      // setting (it returns no children at all), hence minimum: 1 in package.json.
      expect(() => validateBridgeConfig(cfg({ maxDepth: 0 }))).toThrow(BridgeError);
      expect(() => validateBridgeConfig(cfg({ maxDepth: -1 }))).toThrow(BridgeError);
      expect(() => validateBridgeConfig(cfg({ maxDepth: MAX_MAX_DEPTH + 1 }))).toThrow(BridgeError);
      expect(() => validateBridgeConfig(cfg({ maxDepth: 7.5 }))).toThrow(BridgeError);
      expect(() => validateBridgeConfig(cfg({ maxDepth: Number.NaN }))).toThrow(BridgeError);
    });

    it('reports the valid range in the error message', () => {
      expect(() => validateBridgeConfig(cfg({ maxDepth: 999 }))).toThrow(
        new RegExp(`must be an integer 1-${MAX_MAX_DEPTH}`),
      );
    });
  });
});
