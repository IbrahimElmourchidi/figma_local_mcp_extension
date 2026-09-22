import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { CONFIG_SECTION, DEFAULT_HOST, DEFAULT_PORT, VALID_HOSTS } from '../constants';
import { BridgeError } from '../errors';

export interface BridgeConfig {
  readonly port: number;
  readonly host: string;
  readonly autoStart: boolean;
  readonly mcpServerPath: string;
  readonly opencodeNodePath: string;
  readonly nodePath: string;
  readonly figmaPluginId: string;
  readonly autoCheckUpdates: boolean;
}

export function readBridgeConfig(): BridgeConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const config: BridgeConfig = {
    port: cfg.get<number>('port', DEFAULT_PORT),
    host: cfg.get<string>('host', DEFAULT_HOST),
    autoStart: cfg.get<boolean>('autoStart', false),
    mcpServerPath: cfg.get<string>('mcpServerPath', ''),
    opencodeNodePath: cfg.get<string>('opencodeNodePath', ''),
    nodePath: cfg.get<string>('nodePath', ''),
    figmaPluginId: cfg.get<string>('figmaPluginId', ''),
    autoCheckUpdates: cfg.get<boolean>('autoCheckUpdates', true),
  };
  validateBridgeConfig(config);
  return config;
}

export function validateBridgeConfig(config: BridgeConfig): void {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new BridgeError('config_invalid', `Invalid port ${config.port}: must be an integer 1-65535`);
  }
  if (!(VALID_HOSTS as readonly string[]).includes(config.host)) {
    throw new BridgeError(
      'config_invalid',
      `Invalid host "${config.host}": must be one of ${VALID_HOSTS.join(', ')}`,
    );
  }
  validateOptionalPath('mcpServerPath', config.mcpServerPath);
  validateOptionalPath('nodePath', config.nodePath);
  validateOptionalPath('opencodeNodePath', config.opencodeNodePath);
}

function validateOptionalPath(key: string, value: string): void {
  if (!value) {
    return;
  }
  if (!fs.existsSync(value)) {
    throw new BridgeError('config_invalid', `Invalid ${key} "${value}": path does not exist`);
  }
}
