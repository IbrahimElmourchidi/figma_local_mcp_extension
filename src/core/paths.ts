import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LOCKS_DIR_NAME,
  NODE_DIR_NAME,
  RUNTIME_DIR_NAME,
  RUNTIME_PREVIOUS_DIR_NAME,
  RUNTIME_STAGING_DIR_NAME,
  SEED_DIR_NAME,
} from '../constants';

export interface StorageLayout {
  readonly root: string;
  readonly runtime: string;
  readonly runtimePrevious: string;
  readonly runtimeStaging: string;
  readonly node: string;
  readonly build: string;
  readonly locks: string;
  /** Parent of the built Figma dev plugin (imported into Figma by manifest path). */
  readonly figmaPlugin: string;
}

export function createStorageLayout(root: string): StorageLayout {
  return {
    root,
    runtime: path.join(root, RUNTIME_DIR_NAME),
    runtimePrevious: path.join(root, RUNTIME_PREVIOUS_DIR_NAME),
    runtimeStaging: path.join(root, RUNTIME_STAGING_DIR_NAME),
    node: path.join(root, NODE_DIR_NAME),
    build: buildScratchDir(root),
    locks: path.join(root, LOCKS_DIR_NAME),
    figmaPlugin: path.join(root, 'figma-plugin'),
  };
}

/**
 * Source-build scratch (pnpm install + its `.pnpm` virtual store) lives outside
 * globalStorage, in the OS temp dir. globalStorage's own path is already long
 * (`.../globalStorage/<publisher>.<name>/build/source/...`); stacking pnpm's
 * nested `node_modules/.pnpm/<pkg>@<ver>_<hash>/node_modules/<pkg>/...` on top
 * of it regularly exceeds Windows' MAX_PATH. tmpdir is short and per-OS-managed.
 */
function buildScratchDir(root: string): string {
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `figma-mcp-bridge-build-${hash}`);
}

export function seedDir(extensionPath: string): string {
  return path.join(extensionPath, SEED_DIR_NAME);
}

export function managedNodeDir(layout: StorageLayout, version: string): string {
  return path.join(layout.node, version);
}

export function managedNodeExecutable(versionDir: string, isWindows: boolean): string {
  return isWindows
    ? path.join(versionDir, 'node.exe')
    : path.join(versionDir, 'bin', 'node');
}
