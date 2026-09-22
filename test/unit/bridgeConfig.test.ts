import { describe, expect, it } from 'vitest';
import { validateBridgeConfig, BridgeConfig } from '../../src/config/bridgeConfig';
import { BridgeError } from '../../src/errors';

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
});
