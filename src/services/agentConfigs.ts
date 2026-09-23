import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OPENCODE_MCP_KEY, OPENCODE_SCHEMA } from '../constants';
import { BridgeError } from '../errors';

/** How an external agent should launch the MCP server (stdio). */
export interface McpLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Includes the bridge token — every file written from this is chmod 600. */
  readonly env: Readonly<Record<string, string>>;
}

export interface AgentEnv {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** Parent of every extension's globalStorage dir (for Kilo/Cline/Roo). */
  readonly globalStorageRoot?: string;
}

export interface AgentTarget {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  configPath(env: AgentEnv): string;
  /** Best guess whether the agent is installed (drives sort order + "detected"). */
  detect(env: AgentEnv): boolean;
  /** Merge the Figma entry into `existing` file text; returns the new file text. */
  render(existing: string | null, spec: McpLaunchSpec): string;
  /** Optional CLI to prefer over editing the file (e.g. `claude mcp add-json`). */
  cli?(spec: McpLaunchSpec): { readonly command: string; readonly args: string[] };
}

export const MCP_SERVER_KEY = OPENCODE_MCP_KEY;

// --- renderers -------------------------------------------------------------

type Json = Record<string, unknown>;

function parseJson(existing: string | null, file: string): Json {
  if (existing === null || existing.trim() === '') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(existing);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Json;
    }
  } catch (error) {
    throw new BridgeError('config_invalid', `${file} is not valid JSON (comments are not supported): ${String(error)}`);
  }
  throw new BridgeError('config_invalid', `${file} must contain a JSON object`);
}

/** `{ <rootKey>: { figma-mcp-free: entry } }`, preserving everything else. */
function jsonMcpServers(rootKey: string, file: string, entry: (spec: McpLaunchSpec) => Json) {
  return (existing: string | null, spec: McpLaunchSpec): string => {
    const doc = parseJson(existing, file);
    const servers = doc[rootKey] && typeof doc[rootKey] === 'object' ? (doc[rootKey] as Json) : {};
    doc[rootKey] = { ...servers, [MCP_SERVER_KEY]: entry(spec) };
    return `${JSON.stringify(doc, null, 2)}\n`;
  };
}

const stdioEntry = (spec: McpLaunchSpec): Json => ({
  command: spec.command,
  args: [...spec.args],
  env: { ...spec.env },
});

function renderOpencode(existing: string | null, spec: McpLaunchSpec): string {
  const doc = parseJson(existing, 'opencode.json');
  if (typeof doc.$schema !== 'string') {
    doc.$schema = OPENCODE_SCHEMA;
  }
  const mcp = doc.mcp && typeof doc.mcp === 'object' ? (doc.mcp as Json) : {};
  doc.mcp = {
    ...mcp,
    [MCP_SERVER_KEY]: {
      type: 'local',
      command: [spec.command, ...spec.args],
      environment: { ...spec.env },
      enabled: true,
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Codex uses TOML. Replace our `[mcp_servers.figma-mcp-free]` table (and its
 * `.env` sub-table) textually so the rest of the user's file is untouched.
 */
export function renderCodexToml(existing: string | null, spec: McpLaunchSpec): string {
  const prefix = `[mcp_servers.${MCP_SERVER_KEY}`;
  const kept: string[] = [];
  let skipping = false;
  for (const line of (existing ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      skipping = trimmed === `${prefix}]` || trimmed.startsWith(`${prefix}.`);
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') {
    kept.pop();
  }
  const block = [
    `${prefix}]`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(', ')}]`,
    '',
    `${prefix}.env]`,
    ...Object.entries(spec.env).map(([k, v]) => `${k} = ${tomlString(v)}`),
  ];
  return `${[...kept, ...(kept.length > 0 ? [''] : []), ...block].join('\n')}\n`;
}

function tomlString(value: string): string {
  return JSON.stringify(value); // TOML basic strings share JSON's escapes
}

// --- paths -----------------------------------------------------------------

function appData(e: AgentEnv): string {
  return e.env.APPDATA ?? path.join(e.home, 'AppData', 'Roaming');
}

function xdgConfig(e: AgentEnv): string {
  return e.env.XDG_CONFIG_HOME || path.join(e.home, '.config');
}

function opencodePath(e: AgentEnv): string {
  return e.platform === 'win32'
    ? path.join(appData(e), 'opencode', 'opencode.json')
    : path.join(xdgConfig(e), 'opencode', 'opencode.json');
}

function claudeDesktopPath(e: AgentEnv): string {
  if (e.platform === 'darwin') {
    return path.join(e.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (e.platform === 'win32') {
    return path.join(appData(e), 'Claude', 'claude_desktop_config.json');
  }
  return path.join(xdgConfig(e), 'Claude', 'claude_desktop_config.json');
}

/** Kilo Code / Cline / Roo Code keep MCP settings in their own globalStorage. */
function vscodeExtensionSettings(extensionId: string, file: string) {
  return (e: AgentEnv): string => {
    if (!e.globalStorageRoot) {
      throw new BridgeError('config_invalid', 'VS Code global storage location unknown');
    }
    return path.join(e.globalStorageRoot, extensionId, 'settings', file);
  };
}

const exists = (p: string): boolean => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

function vscodeExtensionTarget(id: string, label: string, extensionId: string, file: string): AgentTarget {
  const configPath = vscodeExtensionSettings(extensionId, file);
  return {
    id,
    label,
    detail: `VS Code extension (${extensionId})`,
    configPath,
    detect: (e) => !!e.globalStorageRoot && exists(path.join(e.globalStorageRoot, extensionId)),
    render: jsonMcpServers('mcpServers', file, (spec) => ({ ...stdioEntry(spec), disabled: false })),
  };
}

// --- targets ---------------------------------------------------------------

export const AGENT_TARGETS: readonly AgentTarget[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    detail: 'User scope (~/.claude.json), via `claude mcp add-json` when available',
    configPath: (e) => path.join(e.home, '.claude.json'),
    detect: (e) => exists(path.join(e.home, '.claude.json')) || exists(path.join(e.home, '.claude')),
    render: jsonMcpServers('mcpServers', '.claude.json', (spec) => ({ type: 'stdio', ...stdioEntry(spec) })),
    cli: (spec) => ({
      command: 'claude',
      args: [
        'mcp',
        'add-json',
        '--scope',
        'user',
        MCP_SERVER_KEY,
        JSON.stringify({ type: 'stdio', ...stdioEntry(spec) }),
      ],
    }),
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    detail: '~/.gemini/settings.json',
    configPath: (e) => path.join(e.home, '.gemini', 'settings.json'),
    detect: (e) => exists(path.join(e.home, '.gemini')),
    render: jsonMcpServers('mcpServers', 'settings.json', stdioEntry),
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    detail: '~/.codex/config.toml',
    configPath: (e) => path.join(e.env.CODEX_HOME || path.join(e.home, '.codex'), 'config.toml'),
    detect: (e) => exists(e.env.CODEX_HOME || path.join(e.home, '.codex')),
    render: renderCodexToml,
  },
  {
    id: 'opencode',
    label: 'opencode',
    detail: 'opencode.json',
    configPath: opencodePath,
    detect: (e) => exists(path.dirname(opencodePath(e))),
    render: renderOpencode,
  },
  vscodeExtensionTarget('kilo-code', 'Kilo Code', 'kilocode.kilo-code', 'mcp_settings.json'),
  vscodeExtensionTarget('cline', 'Cline', 'saoudrizwan.claude-dev', 'cline_mcp_settings.json'),
  vscodeExtensionTarget('roo-code', 'Roo Code', 'rooveterinaryinc.roo-cline', 'mcp_settings.json'),
  {
    id: 'cursor',
    label: 'Cursor',
    detail: '~/.cursor/mcp.json',
    configPath: (e) => path.join(e.home, '.cursor', 'mcp.json'),
    detect: (e) => exists(path.join(e.home, '.cursor')),
    render: jsonMcpServers('mcpServers', 'mcp.json', stdioEntry),
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    detail: '~/.codeium/windsurf/mcp_config.json',
    configPath: (e) => path.join(e.home, '.codeium', 'windsurf', 'mcp_config.json'),
    detect: (e) => exists(path.join(e.home, '.codeium', 'windsurf')),
    render: jsonMcpServers('mcpServers', 'mcp_config.json', stdioEntry),
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    detail: 'claude_desktop_config.json',
    configPath: claudeDesktopPath,
    detect: (e) => exists(path.dirname(claudeDesktopPath(e))),
    render: jsonMcpServers('mcpServers', 'claude_desktop_config.json', stdioEntry),
  },
];

export function findAgentTarget(id: string): AgentTarget | undefined {
  return AGENT_TARGETS.find((t) => t.id === id);
}

/** Generic `mcpServers` snippet most other MCP clients accept. */
export function genericSnippet(spec: McpLaunchSpec): string {
  return `${JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: stdioEntry(spec) } }, null, 2)}\n`;
}

export function defaultAgentEnv(globalStorageRoot?: string): AgentEnv {
  return { home: os.homedir(), platform: process.platform, env: process.env, globalStorageRoot };
}

// --- writing ---------------------------------------------------------------

/**
 * Atomic merge-write (temp + rename), chmod 600 on POSIX because the entry
 * carries the bridge token. Keeps a one-time `.bak` of a pre-existing file.
 */
export function writeAgentConfig(target: AgentTarget, spec: McpLaunchSpec, env: AgentEnv): string {
  const file = target.configPath(env);
  const existing = exists(file) ? fs.readFileSync(file, 'utf8') : null;
  const next = target.render(existing, spec);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (existing !== null && !exists(`${file}.bak`)) {
    fs.writeFileSync(`${file}.bak`, existing, { encoding: 'utf8', mode: 0o600 });
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, next, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  if (env.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // best-effort
    }
  }
  return file;
}
