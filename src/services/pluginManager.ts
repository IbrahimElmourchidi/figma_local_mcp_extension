import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  PLUGIN_CODE_FILE,
  PLUGIN_DIR,
  PLUGIN_INSTALL_DIR_NAME,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_UI_FILE,
} from '../constants';
import { BridgeError } from '../errors';
import { patchPluginCode, patchPluginUi } from './pluginPatches';
import { RuntimeStore } from './runtimeStore';
import { StateStore } from './state';
import { BridgeConfig } from '../config/bridgeConfig';

/** Placeholder id shipped in upstream's manifest.template.json. */
export const PLACEHOLDER_PLUGIN_ID = 'REPLACE_WITH_FIGMA_GENERATED_PLUGIN_ID';

const SIDECAR_FILE = '.installed.json';
/** Everything build() writes — uninstall removes exactly these and nothing else. */
const OWNED_FILES = [PLUGIN_MANIFEST_FILE, PLUGIN_CODE_FILE, PLUGIN_UI_FILE, SIDECAR_FILE];

interface Sidecar {
  runtimeSha: string;
  port: number;
  pluginId: string;
}

export interface BuiltPlugin {
  readonly dir: string;
  readonly manifestPath: string;
  readonly pluginId: string;
  /** Build-time fixes applied to upstream's plugin files (see pluginPatches). */
  readonly patches: readonly string[];
}

/**
 * Builds the Figma development plugin (manifest.json + code.js + ui.html) into
 * a stable, extension-owned folder. Figma desktop does not scan any folder for
 * dev plugins — the user imports the manifest once via Plugins → Development →
 * Import plugin from manifest…, and Figma then re-reads these files from disk on
 * every run, so rebuilding in place keeps that import valid.
 */
export class PluginManager {
  constructor(
    private readonly runtime: RuntimeStore,
    private readonly state: StateStore,
    private readonly getConfig: () => BridgeConfig,
    /** Parent of the plugin folder, e.g. `<globalStorage>/figma-plugin`. */
    private readonly baseDir: string,
  ) {}

  pluginDir(): string {
    return path.join(this.baseDir, PLUGIN_INSTALL_DIR_NAME);
  }

  manifestPath(): string {
    return path.join(this.pluginDir(), PLUGIN_MANIFEST_FILE);
  }

  checkInstallation(): { installed: boolean; pluginPath?: string } {
    const pluginPath = this.pluginDir();
    const installed = fs.existsSync(this.manifestPath());
    this.state.updatePlugin({ installed, pluginPath: installed ? pluginPath : undefined });
    return { installed, pluginPath: installed ? pluginPath : undefined };
  }

  async install(port?: number, pluginIdOverride?: string): Promise<BuiltPlugin> {
    const cfg = this.getConfig();
    const effectivePort = port ?? cfg.port;
    const target = this.pluginDir();

    let files: ReturnType<RuntimeStore['pluginFiles']>;
    try {
      files = this.runtime.pluginFiles();
    } catch {
      throw new BridgeError('seed_missing', 'Plugin files missing from runtime. Run Force reinstall or Build from source.');
    }
    if (!files.templatePath) {
      throw new BridgeError('seed_missing', 'manifest.template.json missing from runtime.');
    }

    const manifestObj = JSON.parse(fs.readFileSync(files.templatePath, 'utf8')) as Record<string, unknown>;
    // id precedence: explicit override/setting > id already in the built
    // manifest (so a rebuild never changes the id Figma imported) > template.
    const pluginId =
      nonEmpty(pluginIdOverride) ?? nonEmpty(cfg.figmaPluginId) ?? this.existingPluginId() ?? manifestObj.id;
    if (typeof pluginId === 'string' && pluginId.length > 0) {
      manifestObj.id = pluginId;
    }
    const networkAccess = manifestObj.networkAccess;
    if (networkAccess && typeof networkAccess === 'object') {
      // Figma rejects IP literals here ("'http://127.0.0.1:3845' must be a valid
      // URL" → "Manifest issue", plugin won't run): its validator only accepts
      // `localhost` or a hostname with a letter TLD. The plugin iframe's CSP is
      // built from this list, so the UI must also talk to `localhost`.
      (networkAccess as Record<string, unknown>).devAllowedDomains = [pluginBridgeUrl(effectivePort)];
    }

    // Port injection into ui.html (same string surgery as Flutter), and point
    // the default bridge URL at `localhost` to match the CSP above.
    let uiHtml = fs.readFileSync(files.uiPath, 'utf8');
    uiHtml = uiHtml.replace(
      /value="http:\/\/(?:127\.0\.0\.1|localhost):\d+"/g,
      `value="${pluginBridgeUrl(effectivePort)}"`,
    );
    uiHtml = uiHtml.split(':3845').join(`:${effectivePort}`);
    const ui = patchPluginUi(uiHtml);
    const code = patchPluginCode(fs.readFileSync(files.codePath, 'utf8'));

    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, PLUGIN_CODE_FILE), code.text, 'utf8');
    fs.writeFileSync(path.join(target, PLUGIN_UI_FILE), ui.text, 'utf8');
    fs.writeFileSync(path.join(target, PLUGIN_MANIFEST_FILE), `${JSON.stringify(manifestObj, null, 4)}\n`, 'utf8');

    // Sidecar for staleness (replaces Flutter's broken bundle hash).
    const sidecar: Sidecar = {
      runtimeSha: this.runtime.getInstalledManifest()?.upstreamSha ?? '',
      port: effectivePort,
      pluginId: typeof manifestObj.id === 'string' ? manifestObj.id : '',
    };
    fs.writeFileSync(path.join(target, SIDECAR_FILE), `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');

    this.checkInstallation();
    return {
      dir: target,
      manifestPath: this.manifestPath(),
      pluginId: sidecar.pluginId,
      patches: [...code.applied, ...ui.applied],
    };
  }

  async uninstall(): Promise<void> {
    const dir = this.pluginDir();
    for (const name of OWNED_FILES) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
    try {
      fs.rmdirSync(dir); // only succeeds when nothing else is left in it
    } catch {
      // not empty or already gone
    }
    this.checkInstallation();
  }

  async openFolder(): Promise<void> {
    if (!this.checkInstallation().installed) {
      throw new BridgeError('unexpected', 'Plugin has not been built yet. Run "Build Figma Plugin" first.');
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(this.manifestPath()));
  }

  /** True when installed sidecar port/sha no longer matches current config/runtime. */
  isStale(): boolean {
    const { pluginPath } = this.checkInstallation();
    if (!pluginPath) {return false;}
    const sidecarPath = path.join(pluginPath, SIDECAR_FILE);
    if (!fs.existsSync(sidecarPath)) {return true;}
    try {
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Sidecar;
      const cfg = this.getConfig();
      const manifest = this.runtime.getInstalledManifest();
      if (sidecar.port !== cfg.port) {return true;}
      if (manifest?.upstreamSha && sidecar.runtimeSha !== manifest.upstreamSha) {return true;}
      return false;
    } catch {
      return true;
    }
  }

  private existingPluginId(): string | undefined {
    try {
      const existing = JSON.parse(fs.readFileSync(this.manifestPath(), 'utf8')) as { id?: unknown };
      return typeof existing.id === 'string' && existing.id !== PLACEHOLDER_PLUGIN_ID
        ? nonEmpty(existing.id)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

/** The bridge URL as the Figma plugin must use it (see devAllowedDomains above). */
export function pluginBridgeUrl(port: number): string {
  return `http://localhost:${port}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// re-export for tree label
export { PLUGIN_DIR };
