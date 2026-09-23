import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentEnv,
  McpLaunchSpec,
  findAgentTarget,
  genericSnippet,
  renderCodexToml,
  writeAgentConfig,
} from '../../src/services/agentConfigs';
import { BridgeError } from '../../src/errors';

const spec: McpLaunchSpec = {
  command: '/usr/bin/node',
  args: ['/rt/mcp-server.cjs'],
  env: { FIGMA_PLUGIN_BRIDGE_TOKEN: 'tok', FIGMA_PLUGIN_BRIDGE_URL: 'http://127.0.0.1:3845' },
};

const target = (id: string) => {
  const t = findAgentTarget(id);
  if (!t) {
    throw new Error(`missing target ${id}`);
  }
  return t;
};

describe('opencode', () => {
  it('builds the expected shape and preserves other entries', () => {
    const existing = JSON.stringify({
      theme: 'dark',
      mcp: { other: { type: 'remote', url: 'https://example.com' } },
    });
    const out = JSON.parse(target('opencode').render(existing, spec));
    expect(out.$schema).toBe('https://opencode.ai/config.json');
    expect(out.theme).toBe('dark');
    expect(out.mcp.other).toEqual({ type: 'remote', url: 'https://example.com' });
    expect(out.mcp['figma-mcp-free']).toEqual({
      type: 'local',
      command: ['/usr/bin/node', '/rt/mcp-server.cjs'],
      environment: spec.env,
      enabled: true,
    });
  });

  it('honours XDG_CONFIG_HOME and APPDATA', () => {
    const t = target('opencode');
    expect(t.configPath({ home: '/home/u', platform: 'linux', env: { XDG_CONFIG_HOME: '/x' } })).toBe(
      path.join('/x', 'opencode', 'opencode.json'),
    );
    expect(t.configPath({ home: '/home/u', platform: 'linux', env: {} })).toBe(
      path.join('/home/u', '.config', 'opencode', 'opencode.json'),
    );
    expect(t.configPath({ home: 'C:/Users/u', platform: 'win32', env: { APPDATA: 'C:/AD' } })).toBe(
      path.join('C:/AD', 'opencode', 'opencode.json'),
    );
  });
});

describe('mcpServers-style agents', () => {
  it.each(['gemini-cli', 'cursor', 'windsurf', 'claude-desktop'])('%s merges into mcpServers', (id) => {
    const existing = JSON.stringify({ theme: 'x', mcpServers: { keep: { command: 'a' } } });
    const out = JSON.parse(target(id).render(existing, spec));
    expect(out.theme).toBe('x');
    expect(out.mcpServers.keep).toEqual({ command: 'a' });
    expect(out.mcpServers['figma-mcp-free']).toEqual({
      command: '/usr/bin/node',
      args: ['/rt/mcp-server.cjs'],
      env: spec.env,
    });
  });

  it('claude-code marks the entry as stdio and offers a CLI', () => {
    const t = target('claude-code');
    expect(JSON.parse(t.render(null, spec)).mcpServers['figma-mcp-free'].type).toBe('stdio');
    const cli = t.cli?.(spec);
    expect(cli?.command).toBe('claude');
    expect(cli?.args.slice(0, 5)).toEqual(['mcp', 'add-json', '--scope', 'user', 'figma-mcp-free']);
  });

  it('kilo code lives in its own VS Code globalStorage', () => {
    const t = target('kilo-code');
    const env: AgentEnv = { home: '/h', platform: 'linux', env: {}, globalStorageRoot: '/gs' };
    expect(t.configPath(env)).toBe(path.join('/gs', 'kilocode.kilo-code', 'settings', 'mcp_settings.json'));
    expect(JSON.parse(t.render(null, spec)).mcpServers['figma-mcp-free'].disabled).toBe(false);
  });

  it('rejects invalid JSON instead of clobbering it', () => {
    expect(() => target('gemini-cli').render('{ // comment\n}', spec)).toThrow(BridgeError);
  });

  it('generic snippet uses mcpServers', () => {
    expect(JSON.parse(genericSnippet(spec)).mcpServers['figma-mcp-free'].command).toBe('/usr/bin/node');
  });
});

describe('codex toml', () => {
  it('appends a table and replaces it on re-run, keeping other content', () => {
    const base = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n';
    const once = renderCodexToml(base, spec);
    expect(once).toContain('model = "o3"');
    expect(once).toContain('[mcp_servers.other]');
    expect(once).toContain('[mcp_servers.figma-mcp-free]\ncommand = "/usr/bin/node"');
    expect(once).toContain('args = ["/rt/mcp-server.cjs"]');
    expect(once).toContain('FIGMA_PLUGIN_BRIDGE_TOKEN = "tok"');

    const twice = renderCodexToml(once, { ...spec, command: 'C:\\node.exe' });
    expect(twice.match(/\[mcp_servers\.figma-mcp-free\]/g)).toHaveLength(1);
    expect(twice.match(/\[mcp_servers\.figma-mcp-free\.env\]/g)).toHaveLength(1);
    expect(twice).toContain('command = "C:\\\\node.exe"');
    expect(twice).toContain('[mcp_servers.other]');
  });
});

describe('writeAgentConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcfg-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes atomically, backs up once and chmods 600', () => {
    const env: AgentEnv = { home: dir, platform: process.platform, env: {} };
    const t = target('gemini-cli');
    const file = t.configPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"theme":"x"}');

    expect(writeAgentConfig(t, spec, env)).toBe(file);
    writeAgentConfig(t, spec, env);
    expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe('{"theme":"x"}');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).theme).toBe('x');
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});
