import * as vscode from 'vscode';

export type BridgeErrorCode =
  | 'bridge_not_found'
  | 'mcp_server_not_found'
  | 'bridge_cli_not_found'
  | 'seed_missing'
  | 'staged_file_missing'
  | 'checksum_mismatch'
  | 'no_previous_runtime'
  | 'lock_contended'
  | 'node_not_available'
  | 'node_not_found_in_archive'
  | 'unsupported_archive'
  | 'extracted_file_missing'
  | 'extract_failed'
  | 'download_failed'
  | 'pnpm_install_failed'
  | 'build_failed'
  | 'esbuild_mcp_failed'
  | 'esbuild_cli_failed'
  | 'upstream_layout_changed'
  | 'verification_failed'
  | 'port_in_use'
  | 'health_gate_failed'
  | 'appdata_not_set'
  | 'home_not_set'
  | 'config_invalid'
  | 'cancelled'
  | 'unexpected';

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export function isBridgeError(error: unknown): error is BridgeError {
  return error instanceof BridgeError;
}

export function toBridgeError(error: unknown): BridgeError {
  if (isBridgeError(error)) {
    return error;
  }
  if (error instanceof Error) {
    return new BridgeError('unexpected', error.message);
  }
  return new BridgeError('unexpected', String(error));
}

/**
 * Command-boundary wrapper: runs `action`, surfaces failures to the user, and
 * rethrows so callers/tests can still observe the error.
 */
export async function runCommand<T>(label: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const bridgeError = toBridgeError(error);
    if (bridgeError.code !== 'cancelled') {
      void vscode.window.showErrorMessage(`${label}: ${bridgeError.message}`);
    }
    throw bridgeError;
  }
}
