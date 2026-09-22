export const CONFIG_SECTION = 'figmaMcpBridge';

export const DEFAULT_PORT = 3845;
export const DEFAULT_HOST = '127.0.0.1';
export const VALID_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;

export const MIN_NODE_VERSION = 18;
export const RECOMMENDED_NODE_VERSION = '20 LTS';
export const PINNED_NODE_VERSION = 'v24.21.0';

// Upstream project the bridge/MCP bundles and Figma plugin are vendored from.
export const UPSTREAM_OWNER = 'superdoccimo';
export const UPSTREAM_REPO = 'figma-mcp-free';
export const UPSTREAM_REF = 'main';

// Pinned toolchain for on-device source builds (matches upstream packageManager + CI).
export const PINNED_PNPM_VERSION = '9.15.9';
export const ESBUILD_VERSION = '0.28.2';
export const NODE_BUILD_TARGET = 'node18';

export const SEED_DIR_NAME = 'runtime-seed';
export const RUNTIME_DIR_NAME = 'runtime';
export const RUNTIME_PREVIOUS_DIR_NAME = 'runtime.previous';
export const RUNTIME_STAGING_DIR_NAME = 'runtime-staging';
export const NODE_DIR_NAME = 'node';
export const BUILD_DIR_NAME = 'build';
export const LOCKS_DIR_NAME = 'locks';

export const MANIFEST_FILE = 'runtime.json';
export const VERSION_FILE = 'VERSION';
export const MCP_SERVER_FILE = 'mcp-server.cjs';
export const BRIDGE_CLI_FILE = 'bridge-cli.cjs';
export const PLUGIN_DIR = 'plugin';
export const PLUGIN_CODE_FILE = 'code.js';
export const PLUGIN_UI_FILE = 'ui.html';
export const PLUGIN_MANIFEST_TEMPLATE = 'manifest.template.json';
export const PLUGIN_MANIFEST_FILE = 'manifest.json';
export const PLUGIN_INSTALL_DIR_NAME = 'figma-mcp-free';

// Env contract shared with upstream bridge-cli / mcp-server (token never goes on argv).
export const ENV_BRIDGE_TOKEN = 'FIGMA_PLUGIN_BRIDGE_TOKEN';
export const ENV_BRIDGE_URL = 'FIGMA_PLUGIN_BRIDGE_URL';
export const ENV_FIGMA_TOKEN = 'FIGMA_TOKEN';

export const MIN_PASSWORD_LENGTH = 32;
export const MAX_PASSWORD_LENGTH = 512;

export const OPENCODE_SCHEMA = 'https://opencode.ai/config.json';
export const OPENCODE_MCP_KEY = 'figma-mcp-free';

export const BRIDGE_HEALTH_PATH = '/health';
export const HEALTH_TIMEOUT_MS = 5000;
export const OUTPUT_LOG_RING = 100;
export const STALE_LOCK_MS = 30 * 60 * 1000;

export const NODE_DIST_BASE = `https://nodejs.org/dist/${PINNED_NODE_VERSION}`;

export function codeloadTarballUrl(sha: string): string {
  return `https://codeload.github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/tar.gz/${sha}`;
}

export function githubApiRepoUrl(path: string): string {
  return `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/${path}`;
}

export function esbuildPackageUrl(os: string, arch: string): string {
  return `https://registry.npmjs.org/@esbuild/${os}-${arch}/-/${os}-${arch}-${ESBUILD_VERSION}.tgz`;
}

export function pnpmPackageUrl(version: string): string {
  return `https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`;
}
