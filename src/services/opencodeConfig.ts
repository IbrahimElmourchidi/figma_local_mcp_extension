import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ENV_BRIDGE_TOKEN,
  ENV_BRIDGE_URL,
  ENV_FIGMA_TOKEN,
  OPENCODE_MCP_KEY,
  OPENCODE_SCHEMA,
} from '../constants';
import { BridgeError } from '../errors';
import { bridgeUrl } from '../util/bridgeUrl';

export interface OpenCodeGenerateOptions {
  readonly mcpServerPath: string;
  readonly bridgeToken: string;
  readonly host: string;
  readonly port: number;
  readonly figmaToken?: string;
  readonly nodePath?: string;
}

export type OpenCodeConfig = Record<string, unknown>;

export function generateOpenCodeConfig(options: OpenCodeGenerateOptions): OpenCodeConfig {
  const environment: Record<string, string> = {
    [ENV_BRIDGE_TOKEN]: options.bridgeToken,
    [ENV_BRIDGE_URL]: bridgeUrl({ host: options.host, port: options.port }),
  };
  if (options.figmaToken && options.figmaToken.length > 0) {
    environment[ENV_FIGMA_TOKEN] = options.figmaToken;
  }
  return {
    $schema: OPENCODE_SCHEMA,
    mcp: {
      [OPENCODE_MCP_KEY]: {
        type: 'local',
        command: [options.nodePath ?? 'node', options.mcpServerPath],
        environment,
        enabled: true,
      },
    },
  };
}

export function openCodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    const appData = env.APPDATA;
    if (!appData) {
      throw new BridgeError('appdata_not_set', 'APPDATA environment variable not set');
    }
    return path.join(appData, 'opencode');
  }
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) {
    return path.join(xdg, 'opencode');
  }
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) {
    throw new BridgeError('home_not_set', 'HOME environment variable not set');
  }
  return path.join(home, '.config', 'opencode');
}

export function openCodeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(openCodeConfigDir(env), 'opencode.json');
}

/**
 * Atomic merge-write: temp file + rename. Preserves other `mcp` entries and
 * any unrelated top-level keys. On POSIX, chmod 600 (file contains a plaintext token).
 */
export function mergeOpenCodeConfig(existing: OpenCodeConfig, incoming: OpenCodeConfig): OpenCodeConfig {
  const merged: OpenCodeConfig = { ...existing };
  if (typeof merged.$schema !== 'string') {
    merged.$schema = OPENCODE_SCHEMA;
  }
  const existingMcp = (merged.mcp && typeof merged.mcp === 'object' ? merged.mcp : {}) as Record<string, unknown>;
  const incomingMcp = (incoming.mcp && typeof incoming.mcp === 'object' ? incoming.mcp : {}) as Record<string, unknown>;
  const resultMcp: Record<string, unknown> = { ...existingMcp };
  for (const [key, value] of Object.entries(incomingMcp)) {
    resultMcp[key] = value;
  }
  merged.mcp = resultMcp;
  return merged;
}

export function saveOpenCodeConfig(config: OpenCodeConfig, env: NodeJS.ProcessEnv = process.env): string {
  const dir = openCodeConfigDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'opencode.json');

  let existing: OpenCodeConfig = {};
  if (fs.existsSync(target)) {
    try {
      existing = JSON.parse(fs.readFileSync(target, 'utf8')) as OpenCodeConfig;
    } catch (error) {
      throw new BridgeError('config_invalid', `Existing opencode.json is not valid JSON: ${String(error)}`);
    }
  }

  const merged = mergeOpenCodeConfig(existing, config);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // best-effort
    }
  }
  fs.renameSync(tmp, target);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // best-effort
    }
  }
  return target;
}

export function previewOpenCodeConfig(config: OpenCodeConfig): string {
  return JSON.stringify(config, null, 2);
}

export function homeDir(): string {
  return os.homedir();
}
