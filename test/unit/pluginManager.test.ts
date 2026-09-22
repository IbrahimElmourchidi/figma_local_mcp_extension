import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLACEHOLDER_PLUGIN_ID, PluginManager } from '../../src/services/pluginManager';
import { RuntimeStore } from '../../src/services/runtimeStore';
import { StateStore } from '../../src/services/state';
import { BridgeConfig } from '../../src/config/bridgeConfig';

const seedPlugin = path.resolve(__dirname, '../../runtime-seed/plugin');

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    port: 3845,
    host: '127.0.0.1',
    autoStart: false,
    mcpServerPath: '',
    opencodeNodePath: '',
    nodePath: '',
    figmaPluginId: '',
    autoCheckUpdates: false,
    ...overrides,
  };
}

describe('PluginManager (build + manual import)', () => {
  let root: string;
  let state: StateStore;
  let cfg: BridgeConfig;
  let manager: PluginManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mgr-'));
    state = new StateStore();
    cfg = config();
    const runtime = {
      pluginFiles: () => ({
        codePath: path.join(seedPlugin, 'code.js'),
        uiPath: path.join(seedPlugin, 'ui.html'),
        templatePath: path.join(seedPlugin, 'manifest.template.json'),
      }),
      getInstalledManifest: () => ({ schema: 1, upstreamRepo: 'r', upstreamSha: 'sha-1', files: {} }),
    } as unknown as RuntimeStore;
    manager = new PluginManager(runtime, state, () => cfg, path.join(root, 'figma-plugin'));
  });

  afterEach(() => {
    state.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('builds manifest/code/ui into its own folder without any Figma directory present', async () => {
    const built = await manager.install(4001);
    expect(built.manifestPath).toBe(path.join(root, 'figma-plugin', 'figma-mcp-free', 'manifest.json'));
    const manifest = JSON.parse(fs.readFileSync(built.manifestPath, 'utf8'));
    expect(manifest.main).toBe('code.js');
    expect(manifest.ui).toBe('ui.html');
    expect(manifest.networkAccess.devAllowedDomains).toEqual(['http://localhost:4001']);
    expect(fs.existsSync(path.join(built.dir, 'code.js'))).toBe(true);
    const ui = fs.readFileSync(path.join(built.dir, 'ui.html'), 'utf8');
    expect(ui).not.toContain(':3845');
    // The default URL must be the host the manifest (and so the iframe CSP) allows.
    expect(ui).toContain('value="http://localhost:4001"');
    expect(ui).not.toContain('value="http://127.0.0.1');
    expect(ui).not.toContain('event.source !== parent');
    expect(fs.readFileSync(path.join(built.dir, 'code.js'), 'utf8')).toContain('"ui-ready"');
    expect(built.patches).toEqual(['code-ui-ready', 'ui-message-source', 'ui-ready-handshake']);
    expect(state.get().plugin).toEqual({ installed: true, pluginPath: built.dir });
  });

  it('only emits devAllowedDomains that pass Figma desktop manifest validation', async () => {
    // Copied from Figma's frontend (networkAccess validator): the host must be
    // `localhost` or a hostname ending in a letter TLD — IP literals fail with
    // "Invalid value for devAllowedDomains. '…' must be a valid URL."
    const figmaDomain =
      /^(?:(https?:|wss?:)(?:[/][/]))?((?:[*][.])?(?:(?:(?:[-a-z\d])+)[.])+[a-z]{2,}|localhost)(?:[:](\d+))?((?:[/][-a-zA-Z\d%_.~+@]*)*$)/;
    expect(figmaDomain.test('http://127.0.0.1:3845')).toBe(false);

    const built = await manager.install();
    const { devAllowedDomains } = JSON.parse(fs.readFileSync(built.manifestPath, 'utf8')).networkAccess;
    expect(devAllowedDomains.length).toBeGreaterThan(0);
    for (const domain of devAllowedDomains) {
      expect(figmaDomain.test(domain), domain).toBe(true);
    }
  });

  it('keeps the id already in the built manifest across rebuilds (so the Figma import stays valid)', async () => {
    const first = await manager.install();
    expect(first.pluginId).toBe(PLACEHOLDER_PLUGIN_ID);
    const manifest = JSON.parse(fs.readFileSync(first.manifestPath, 'utf8'));
    manifest.id = '1679462793087496067';
    fs.writeFileSync(first.manifestPath, JSON.stringify(manifest));

    const rebuilt = await manager.install(3999);
    expect(rebuilt.pluginId).toBe('1679462793087496067');
  });

  it('lets figmaPluginId override the id', async () => {
    cfg = config({ figmaPluginId: '123456789' });
    expect((await manager.install()).pluginId).toBe('123456789');
  });

  it('uninstall removes only the files it wrote', async () => {
    const built = await manager.install();
    const foreign = path.join(built.dir, 'notes.txt');
    fs.writeFileSync(foreign, 'keep me');

    await manager.uninstall();
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(built.manifestPath)).toBe(false);
    expect(fs.existsSync(path.join(built.dir, 'code.js'))).toBe(false);
    expect(state.get().plugin.installed).toBe(false);

    fs.rmSync(foreign);
    await manager.install();
    await manager.uninstall();
    expect(fs.existsSync(built.dir)).toBe(false);
  });
});
