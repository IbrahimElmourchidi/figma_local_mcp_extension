import * as fs from 'node:fs';
import * as os from 'node:os';
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
import { RuntimeStore } from './runtimeStore';
import { StateStore } from './state';
import { BridgeConfig } from '../config/bridgeConfig';

interface Sidecar {
  runtimeSha: string;
  port: number;
  pluginId: string;
}

export function figmaDevelopmentDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) {return null;}
  if (process.platform === 'linux') {
    const p = path.join(home, '.config', 'figma', 'Development');
    return fs.existsSync(p) ? p : p; // return expected path even if missing (install creates it under Figma's dir only if parent exists)
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Figma', 'Development');
  }
  if (process.platform === 'win32') {
    const appData = env.APPDATA;
    if (!appData) {return null;}
    return path.join(appData, 'Figma', 'Development');
  }
  return null;
}

export function figmaDevelopmentDirCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? '';
  const appData = env.APPDATA;
  const candidates = [
    path.join(home, '.config', 'figma', 'Development'),
    path.join(home, 'Library', 'Application Support', 'Figma', 'Development'),
  ];
  if (appData) {
    candidates.push(path.join(appData, 'Figma', 'Development'));
  }
  return candidates;
}

export function findFigmaDevelopmentDir(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of figmaDevelopmentDirCandidates(env)) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  return null;
}

export class PluginManager {
  constructor(
    private readonly runtime: RuntimeStore,
    private readonly state: StateStore,
    private readonly getConfig: () => BridgeConfig,
  ) {}

  pluginInstallDir(devDir: string): string {
    return path.join(devDir, PLUGIN_INSTALL_DIR_NAME);
  }

  checkInstallation(): { installed: boolean; pluginPath?: string } {
    const devDir = findFigmaDevelopmentDir();
    if (!devDir) {
      this.state.updatePlugin({ installed: false, pluginPath: undefined });
      return { installed: false };
    }
    const pluginPath = this.pluginInstallDir(devDir);
    const manifest = path.join(pluginPath, PLUGIN_MANIFEST_FILE);
    const installed = fs.existsSync(manifest);
    this.state.updatePlugin({ installed, pluginPath: installed ? pluginPath : undefined });
    return { installed, pluginPath: installed ? pluginPath : undefined };
  }

  async install(port?: number, pluginIdOverride?: string): Promise<string> {
    const devDir = findFigmaDevelopmentDir();
    if (!devDir) {
      throw new BridgeError(
        'unexpected',
        'Figma development directory not found. Install Figma desktop and enable the Development plugin folder first.',
      );
    }
    if (!fs.existsSync(devDir)) {
      throw new BridgeError('unexpected', `Figma development directory does not exist: ${devDir}`);
    }

    const cfg = this.getConfig();
    const effectivePort = port ?? cfg.port;
    const pluginId = pluginIdOverride ?? cfg.figmaPluginId;
    const target = this.pluginInstallDir(devDir);
    fs.mkdirSync(target, { recursive: true });

    // Prefer runtime plugin files; fail loudly if missing.
    let codeSrc: string;
    let uiSrc: string;
    let templateSrc: string | null;
    try {
      const files = this.runtime.pluginFiles();
      codeSrc = files.codePath;
      uiSrc = files.uiPath;
      templateSrc = files.templatePath;
    } catch {
      throw new BridgeError('seed_missing', 'Plugin files missing from runtime. Run Force reinstall or Build from source.');
    }

    fs.copyFileSync(codeSrc, path.join(target, PLUGIN_CODE_FILE));

    // Manifest with port + optional id injection.
    let manifestObj: Record<string, unknown>;
    if (templateSrc) {
      manifestObj = JSON.parse(fs.readFileSync(templateSrc, 'utf8')) as Record<string, unknown>;
    } else {
      throw new BridgeError('seed_missing', 'manifest.template.json missing from runtime.');
    }
    if (pluginId && pluginId.length > 0) {
      manifestObj.id = pluginId;
    }
    const networkAccess = manifestObj.networkAccess;
    if (networkAccess && typeof networkAccess === 'object') {
      (networkAccess as Record<string, unknown>).devAllowedDomains = [
        `http://127.0.0.1:${effectivePort}`,
        `http://localhost:${effectivePort}`,
      ];
    }
    fs.writeFileSync(
      path.join(target, PLUGIN_MANIFEST_FILE),
      `${JSON.stringify(manifestObj, null, 4)}\n`,
      'utf8',
    );

    // Port injection into ui.html (same string surgery as Flutter).
    let uiHtml = fs.readFileSync(uiSrc, 'utf8');
    uiHtml = uiHtml.replace(/value="http:\/\/127\.0\.0\.1:\d+"/g, `value="http://127.0.0.1:${effectivePort}"`);
    uiHtml = uiHtml.split(':3845').join(`:${effectivePort}`);
    fs.writeFileSync(path.join(target, PLUGIN_UI_FILE), uiHtml, 'utf8');

    // Sidecar for staleness (replaces Flutter's broken bundle hash).
    const manifest = this.runtime.getInstalledManifest();
    const sidecar: Sidecar = {
      runtimeSha: manifest?.upstreamSha ?? '',
      port: effectivePort,
      pluginId: (manifestObj.id as string) ?? '',
    };
    fs.writeFileSync(path.join(target, '.installed.json'), `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');

    this.checkInstallation();
    return target;
  }

  async uninstall(): Promise<void> {
    const { pluginPath } = this.checkInstallation();
    if (!pluginPath) {
      return;
    }
    fs.rmSync(pluginPath, { recursive: true, force: true });
    this.checkInstallation();
  }

  async openFolder(): Promise<void> {
    const { pluginPath } = this.checkInstallation();
    if (!pluginPath) {
      throw new BridgeError('unexpected', 'Plugin is not installed.');
    }
    await vscode.env.openExternal(vscode.Uri.file(path.dirname(pluginPath)));
  }

  /** True when installed sidecar port/sha no longer matches current config/runtime. */
  isStale(): boolean {
    const { pluginPath } = this.checkInstallation();
    if (!pluginPath) {return false;}
    const sidecarPath = path.join(pluginPath, '.installed.json');
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
}

export function defaultHome(): string {
  return os.homedir();
}

// re-export for tree label
export { PLUGIN_DIR };
