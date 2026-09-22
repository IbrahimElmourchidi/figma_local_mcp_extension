import { describe, expect, it } from 'vitest';
import { mergeOpenCodeConfig, generateOpenCodeConfig, openCodeConfigDir } from '../../src/services/opencodeConfig';
import { BridgeError } from '../../src/errors';

describe('generateOpenCodeConfig', () => {
  it('builds the expected JSON shape', () => {
    const config = generateOpenCodeConfig({
      mcpServerPath: '/tmp/mcp-server.cjs',
      bridgeToken: 'tok',
      host: '127.0.0.1',
      port: 3845,
      figmaToken: 'figd_abc',
      nodePath: '/usr/bin/node',
    });
    expect(config.$schema).toBe('https://opencode.ai/config.json');
    const mcp = (config.mcp as Record<string, Record<string, unknown>>)['figma-mcp-free'];
    expect(mcp.type).toBe('local');
    expect(mcp.command).toEqual(['/usr/bin/node', '/tmp/mcp-server.cjs']);
    expect(mcp.environment).toEqual({
      FIGMA_PLUGIN_BRIDGE_TOKEN: 'tok',
      FIGMA_PLUGIN_BRIDGE_URL: 'http://127.0.0.1:3845',
      FIGMA_TOKEN: 'figd_abc',
    });
    expect(mcp.enabled).toBe(true);
  });

  it('omits FIGMA_TOKEN when not provided', () => {
    const config = generateOpenCodeConfig({
      mcpServerPath: '/m.cjs',
      bridgeToken: 'tok',
      host: '127.0.0.1',
      port: 1,
    });
    const mcp = (config.mcp as Record<string, Record<string, unknown>>)['figma-mcp-free'];
    expect(mcp.environment).toEqual({
      FIGMA_PLUGIN_BRIDGE_TOKEN: 'tok',
      FIGMA_PLUGIN_BRIDGE_URL: 'http://127.0.0.1:1',
    });
  });
});

describe('mergeOpenCodeConfig', () => {
  it('preserves other mcp entries and overwrites same key', () => {
    const existing = {
      $schema: 'https://opencode.ai/config.json',
      theme: 'dark',
      mcp: {
        other: { type: 'remote', url: 'https://example.com' },
        'figma-mcp-free': { type: 'local', command: ['old'], enabled: false },
      },
    };
    const incoming = generateOpenCodeConfig({
      mcpServerPath: '/new.cjs',
      bridgeToken: 't',
      host: '127.0.0.1',
      port: 3845,
    });
    const merged = mergeOpenCodeConfig(existing, incoming);
    expect(merged.theme).toBe('dark');
    const mcp = merged.mcp as Record<string, Record<string, unknown>>;
    expect(mcp.other).toEqual({ type: 'remote', url: 'https://example.com' });
    expect((mcp['figma-mcp-free'].command as string[])[1]).toBe('/new.cjs');
    expect(mcp['figma-mcp-free'].enabled).toBe(true);
  });

  it('sets $schema when missing', () => {
    const merged = mergeOpenCodeConfig({}, { mcp: {} });
    expect(merged.$schema).toBe('https://opencode.ai/config.json');
  });
});

describe('openCodeConfigDir', () => {
  it('uses XDG_CONFIG_HOME on non-windows when set', () => {
    if (process.platform === 'win32') {return;}
    expect(openCodeConfigDir({ XDG_CONFIG_HOME: '/custom/config', HOME: '/home/u' })).toBe(
      '/custom/config/opencode',
    );
  });

  it('falls back to HOME/.config', () => {
    if (process.platform === 'win32') {return;}
    expect(openCodeConfigDir({ HOME: '/home/u' })).toBe('/home/u/.config/opencode');
  });

  it('throws when HOME missing on posix', () => {
    if (process.platform === 'win32') {return;}
    expect(() => openCodeConfigDir({})).toThrow(BridgeError);
  });
});
