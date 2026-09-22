import * as path from 'node:path';
import {
  BUILD_DIR_NAME,
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
}

export function createStorageLayout(root: string): StorageLayout {
  return {
    root,
    runtime: path.join(root, RUNTIME_DIR_NAME),
    runtimePrevious: path.join(root, RUNTIME_PREVIOUS_DIR_NAME),
    runtimeStaging: path.join(root, RUNTIME_STAGING_DIR_NAME),
    node: path.join(root, NODE_DIR_NAME),
    build: path.join(root, BUILD_DIR_NAME),
    locks: path.join(root, LOCKS_DIR_NAME),
  };
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
