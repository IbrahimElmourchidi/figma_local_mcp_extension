import * as vscode from 'vscode';
import { readBridgeConfig } from './config/bridgeConfig';
import { SecretsStore } from './config/secretsStore';
import { createStorageLayout, seedDir } from './core/paths';
import { RuntimeStore } from './services/runtimeStore';
import { NodeResolver } from './services/nodeResolver';
import { StateStore } from './services/state';
import { BridgeService } from './services/bridgeService';
import { PluginManager } from './services/pluginManager';
import { SystemChecker } from './services/systemChecker';
import { SourceBuilder } from './services/sourceBuilder';
import { registerMcpProvider } from './services/mcpProvider';
import { OutputChannels } from './ui/output';
import { StatusBar } from './ui/statusBar';
import { TreeProvider } from './ui/treeView';
import { registerAllCommands } from './commands/index';
import { toBridgeError } from './errors';

let deactivateHooks: Array<() => void> = [];

export function activate(context: vscode.ExtensionContext): void {
  const output = new OutputChannels();
  const state = new StateStore();
  const layout = createStorageLayout(context.globalStorageUri.fsPath);
  const secrets = new SecretsStore(context.secrets, layout.locks);
  const runtime = new RuntimeStore(layout, seedDir(context.extensionPath));
  const nodes = new NodeResolver({
    layout,
    launcherPath: context.asAbsolutePath('resources/electron-node-launcher.cjs'),
  });
  const bridge = new BridgeService(layout, runtime, nodes, state, output);
  const plugin = new PluginManager(runtime, state, () => readBridgeConfig(), layout.figmaPlugin);
  const system = new SystemChecker(state, () => plugin.checkInstallation());
  const builder = new SourceBuilder({ layout, runtime, nodes, state, output });

  const config = () => readBridgeConfig();

  // Seed runtime on activation (offline-first).
  try {
    runtime.ensureInstalled();
    const manifest = runtime.getInstalledManifest();
    state.updateRuntime({
      installedSha: manifest?.upstreamSha,
      builtAt: manifest?.builtAt,
      builtBy: manifest?.builtBy,
      healthy: runtime.isHealthy(),
      hasRollback: runtime.hasRollbackAvailable(),
    });
  } catch (error) {
    const e = toBridgeError(error);
    output.appendBridge(`Runtime seed failed: ${e.message}`);
    void vscode.window.showErrorMessage(`Figma MCP Bridge: ${e.message}`);
  }

  // Native UI shell
  const tree = new TreeProvider(state);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('figmaMcpBridge.view', tree),
    output,
    state,
    { dispose: () => tree.dispose() },
  );
  const statusBar = new StatusBar(state);
  context.subscriptions.push(statusBar);

  registerAllCommands({
    context,
    secrets,
    runtime,
    nodes,
    bridge,
    state,
    output,
    plugin,
    system,
    builder,
    config,
    treeRefresh: () => tree.refresh(),
  });

  registerMcpProvider(context, {
    config,
    secrets,
    runtime,
    nodes,
    bridge,
    state,
    output,
  });

  plugin.checkInstallation();

  // Config change → revalidate
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('figmaMcpBridge')) {
        return;
      }
      try {
        const cfg = readBridgeConfig();
        if (bridge.isRunning() && e.affectsConfiguration('figmaMcpBridge.autoCheckUpdates')) {
          // no-op; other live fields require restart which the user triggers
        }
        void cfg;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Figma MCP Bridge settings: ${message}`);
      }
    }),
  );

  // autoStart
  const cfg = readBridgeConfig();
  if (cfg.autoStart) {
    void (async () => {
      try {
        const token = await secrets.getOrCreateBridgePassword();
        await bridge.start({ config: readBridgeConfig(), token });
      } catch (error) {
        output.appendBridge(`autoStart failed: ${String(error)}`);
      }
    })();
  }

  // Optional update check
  if (cfg.autoCheckUpdates) {
    void builder.checkForUpdate().then((result) => {
      if (!result.updateAvailable) {
        return;
      }
      void vscode.window
        .showInformationMessage(
          `Figma MCP runtime update available (${(result.latestSha ?? '').slice(0, 12)}).`,
          'Build from source',
        )
        .then((pick) => {
          if (pick === 'Build from source') {
            void vscode.commands.executeCommand('figmaMcpBridge.buildFromSource');
          }
        });
    });
  }

  deactivateHooks.push(() => bridge.dispose());
  output.appendBridge('Figma MCP Bridge activated.');
}

export function deactivate(): void {
  // Short async budget — kill children synchronously where possible.
  for (const hook of deactivateHooks) {
    try {
      hook();
    } catch {
      // ignore
    }
  }
  deactivateHooks = [];
}
