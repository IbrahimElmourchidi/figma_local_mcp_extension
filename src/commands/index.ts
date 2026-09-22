import * as vscode from 'vscode';
import { SecretsStore } from '../config/secretsStore';
import { readBridgeConfig, BridgeConfig } from '../config/bridgeConfig';
import { BridgeService } from '../services/bridgeService';
import { RuntimeStore } from '../services/runtimeStore';
import { NodeResolver } from '../services/nodeResolver';
import { StateStore } from '../services/state';
import { OutputChannels } from '../ui/output';
import { PluginManager, pluginBridgeUrl } from '../services/pluginManager';
import { SystemChecker } from '../services/systemChecker';
import { SourceBuilder } from '../services/sourceBuilder';
import {
  generateOpenCodeConfig,
  openCodeConfigPath,
  previewOpenCodeConfig,
  saveOpenCodeConfig,
} from '../services/opencodeConfig';
import { probeHealth } from '../services/health';
import { runCommand, BridgeError } from '../errors';
import { registerSecretsCommands } from './secretsCommands';

export interface CommandDeps {
  readonly context: vscode.ExtensionContext;
  readonly secrets: SecretsStore;
  readonly runtime: RuntimeStore;
  readonly nodes: NodeResolver;
  readonly bridge: BridgeService;
  readonly state: StateStore;
  readonly output: OutputChannels;
  readonly plugin: PluginManager;
  readonly system: SystemChecker;
  readonly builder: SourceBuilder;
  readonly config: () => BridgeConfig;
  readonly treeRefresh: () => void;
}

export function registerAllCommands(deps: CommandDeps): void {
  const { context } = deps;
  registerSecretsCommands(context, deps.secrets);

  const reg = (id: string, fn: () => unknown | Promise<unknown>, label = id) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => runCommand(label, async () => fn())),
    );
  };

  // --- Bridge ---
  reg('figmaMcpBridge.startBridge', async () => {
    const token = await deps.secrets.getOrCreateBridgePassword();
    await deps.bridge.start({ config: deps.config(), token });
    void vscode.window.showInformationMessage('Figma MCP bridge started.');
  }, 'Start bridge');

  reg('figmaMcpBridge.stopBridge', async () => {
    await deps.bridge.stop();
    void vscode.window.showInformationMessage('Figma MCP bridge stopped.');
  }, 'Stop bridge');

  reg('figmaMcpBridge.restartBridge', async () => {
    const token = await deps.secrets.getOrCreateBridgePassword();
    await deps.bridge.restart({ config: deps.config(), token });
    void vscode.window.showInformationMessage('Figma MCP bridge restarted.');
  }, 'Restart bridge');

  reg('figmaMcpBridge.killOrphans', async () => {
    const port = deps.config().port;
    const killed = await deps.bridge.killOrphans(port);
    void vscode.window.showInformationMessage(
      killed > 0 ? `Killed ${killed} orphan bridge process(es).` : 'No orphan bridge processes found.',
    );
  }, 'Kill orphans');

  reg('figmaMcpBridge.testConnection', async () => {
    const cfg = deps.config();
    const token = await deps.secrets.getOrCreateBridgePassword();
    const result = await probeHealth(cfg.host, cfg.port, token, 5000);
    if (result.ok) {
      void vscode.window.showInformationMessage(
        `Bridge healthy on ${cfg.host}:${cfg.port}${result.sessionId ? ` (session ${result.sessionId})` : ''}.`,
      );
    } else {
      throw new BridgeError('health_gate_failed', result.error ?? `HTTP ${result.status ?? 'no response'}`);
    }
  }, 'Test connection');

  reg('figmaMcpBridge.copyUrl', async () => {
    const cfg = deps.config();
    const { bridgeUrl } = await import('../util/bridgeUrl.js');
    await vscode.env.clipboard.writeText(bridgeUrl({ host: cfg.host, port: cfg.port }));
    void vscode.window.showInformationMessage('Bridge URL copied.');
  }, 'Copy URL');

  reg('figmaMcpBridge.copyToken', async () => {
    const token = await deps.secrets.getOrCreateBridgePassword();
    await vscode.env.clipboard.writeText(token);
    void vscode.window.showInformationMessage('Pairing token copied to clipboard.');
  }, 'Copy token');

  reg('figmaMcpBridge.openBridgeLogs', () => {
    deps.output.showBridge();
  }, 'Open bridge logs');

  reg('figmaMcpBridge.clearLogs', () => {
    deps.bridge.clearLogs();
    void vscode.window.showInformationMessage('Bridge logs cleared.');
  }, 'Clear logs');

  reg('figmaMcpBridge.showTree', () => {
    void vscode.commands.executeCommand('figmaMcpBridge.view.focus');
  }, 'Show tree');

  // --- MCP / opencode ---
  reg('figmaMcpBridge.configureOpencode', async () => {
    const cfg = deps.config();
    const token = await deps.secrets.getOrCreateBridgePassword();
    const figmaToken = await deps.secrets.getFigmaToken();
    const mcpPath = deps.runtime.getMcpServerPath(cfg.mcpServerPath || undefined);

    let nodePath = cfg.opencodeNodePath || cfg.nodePath || '';
    if (!nodePath) {
      try {
        const real = await deps.nodes.resolveRealNode();
        nodePath = real.command;
      } catch {
        nodePath = 'node';
      }
    }

    const target = openCodeConfigPath();
    const confirm = await vscode.window.showWarningMessage(
      `Write Figma MCP entry to ${target}? It contains your bridge token in plaintext.`,
      { modal: true },
      'Write',
    );
    if (confirm !== 'Write') {
      return;
    }

    const generated = generateOpenCodeConfig({
      mcpServerPath: mcpPath,
      bridgeToken: token,
      host: cfg.host,
      port: cfg.port,
      figmaToken,
      nodePath,
    });
    const written = saveOpenCodeConfig(generated);
    void vscode.window.showInformationMessage(`opencode config updated: ${written}`);
  }, 'Configure opencode');

  reg('figmaMcpBridge.previewOpencodeConfig', async () => {
    const cfg = deps.config();
    const token = await deps.secrets.getOrCreateBridgePassword();
    const figmaToken = await deps.secrets.getFigmaToken();
    const mcpPath = deps.runtime.getMcpServerPath(cfg.mcpServerPath || undefined);
    const nodePath = cfg.opencodeNodePath || cfg.nodePath || 'node';
    const generated = generateOpenCodeConfig({
      mcpServerPath: mcpPath,
      bridgeToken: token,
      host: cfg.host,
      port: cfg.port,
      figmaToken,
      nodePath,
    });
    const doc = await vscode.workspace.openTextDocument({
      content: previewOpenCodeConfig(generated),
      language: 'json',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }, 'Preview opencode config');

  // --- Plugin ---
  reg('figmaMcpBridge.installPlugin', async () => {
    const cfg = deps.config();
    const built = await deps.plugin.install(cfg.port);
    deps.output.appendBridge(`Figma plugin built: ${built.manifestPath}`);
    if (built.patches.length > 0) {
      deps.output.appendBridge(`Figma plugin fixes applied: ${built.patches.join(', ')}`);
    }
    const copy = 'Copy manifest path';
    const token = 'Copy pairing token';
    const reveal = 'Reveal in file manager';
    const pick = await vscode.window.showInformationMessage(
      `Figma plugin built at ${built.manifestPath}. First time only: in Figma desktop choose ` +
        'Plugins → Development → Import plugin from manifest… and select that file. ' +
        `Rebuilds update it in place. When you run it, keep the URL ${pluginBridgeUrl(cfg.port)} ` +
        'and paste the pairing token.',
      copy,
      token,
      reveal,
    );
    if (pick === copy) {
      await vscode.env.clipboard.writeText(built.manifestPath);
      void vscode.window.showInformationMessage(
        `Copied ${built.manifestPath} — in Figma's file dialog, press Ctrl+L (Cmd+Shift+G on macOS) and paste.`,
      );
    } else if (pick === token) {
      await vscode.commands.executeCommand('figmaMcpBridge.copyToken');
    } else if (pick === reveal) {
      await deps.plugin.openFolder();
    }
  }, 'Build Figma plugin');

  reg('figmaMcpBridge.copyPluginManifestPath', async () => {
    if (!deps.plugin.checkInstallation().installed) {
      throw new BridgeError('unexpected', 'Plugin has not been built yet. Run "Build Figma Plugin" first.');
    }
    await vscode.env.clipboard.writeText(deps.plugin.manifestPath());
    void vscode.window.showInformationMessage(`Copied ${deps.plugin.manifestPath()}`);
  }, 'Copy plugin manifest path');

  reg('figmaMcpBridge.uninstallPlugin', async () => {
    await deps.plugin.uninstall();
    void vscode.window.showInformationMessage('Plugin uninstalled.');
  }, 'Uninstall plugin');

  reg('figmaMcpBridge.openPluginFolder', async () => {
    await deps.plugin.openFolder();
  }, 'Open plugin folder');

  reg('figmaMcpBridge.refreshPluginStatus', () => {
    deps.plugin.checkInstallation();
  }, 'Refresh plugin status');

  // --- Runtime ---
  reg('figmaMcpBridge.buildFromSource', async () => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Building Figma MCP runtime from source…',
        cancellable: true,
      },
      async (progress, token) => {
        // Stop services before swap; remember what to restore afterward
        // (success or failure — the bridge shouldn't stay down just because a
        // rebuild attempt happened).
        const wasRunning = deps.state.get().bridge.status === 'running';
        const wasPluginInstalled = deps.state.get().plugin.installed;
        await deps.bridge.stop().catch(() => undefined);

        try {
          const result = await deps.builder.buildFromSource(token, (message, percent) => {
            progress.report({
              message,
              ...(percent !== undefined ? { increment: 0 } : {}),
            });
          });
          void vscode.window.showInformationMessage(
            `Runtime built from source @ ${result.upstreamSha.slice(0, 12)}.`,
          );
          if (wasPluginInstalled) {
            try {
              await deps.plugin.install(deps.config().port);
            } catch (error) {
              deps.output.appendBuild(`Plugin refresh after build failed: ${String(error)}`);
            }
          }
        } finally {
          if (wasRunning) {
            const restartToken = await deps.secrets.getOrCreateBridgePassword();
            await deps.bridge.start({ config: deps.config(), token: restartToken }).catch((error) => {
              deps.output.appendBridge(`Restart after build failed: ${String(error)}`);
            });
          }
        }
      },
    );
  }, 'Build from source');

  reg('figmaMcpBridge.checkRuntimeUpdate', async () => {
    const result = await deps.builder.checkForUpdate();
    if (result.updateAvailable) {
      const pick = await vscode.window.showInformationMessage(
        `Upstream moved to ${(result.latestSha ?? '').slice(0, 12)}. Build from source to update?`,
        'Build from source',
        'Later',
      );
      if (pick === 'Build from source') {
        await vscode.commands.executeCommand('figmaMcpBridge.buildFromSource');
      }
    } else {
      void vscode.window.showInformationMessage('Runtime is up to date with upstream main.');
    }
  }, 'Check runtime update');

  reg('figmaMcpBridge.rollbackRuntime', async () => {
    await deps.bridge.stop().catch(() => undefined);
    deps.runtime.rollback();
    deps.nodes.invalidate();
    refreshRuntimeState(deps);
    void vscode.window.showInformationMessage('Rolled back to previous runtime.');
  }, 'Rollback runtime');

  reg('figmaMcpBridge.forceReinstallRuntime', async () => {
    await deps.bridge.stop().catch(() => undefined);
    deps.runtime.forceReinstall();
    deps.nodes.invalidate();
    refreshRuntimeState(deps);
    void vscode.window.showInformationMessage('Runtime reinstalled from seed.');
  }, 'Force reinstall runtime');

  reg('figmaMcpBridge.openBuildLogs', () => {
    deps.output.showBuild();
  }, 'Open build logs');

  // --- System ---
  reg('figmaMcpBridge.runSystemCheck', async () => {
    const cfg = deps.config();
    await deps.system.checkAll({ port: cfg.port, host: cfg.host, nodes: deps.nodes });
  }, 'Run system check');

  // --- Settings helpers ---
  reg('figmaMcpBridge.saveSettings', () => {
    readBridgeConfig();
    void vscode.window.showInformationMessage('Settings validated.');
  }, 'Save settings');
}

export function refreshRuntimeState(deps: CommandDeps): void {
  try {
    deps.runtime.ensureInstalled();
    const manifest = deps.runtime.getInstalledManifest();
    deps.state.updateRuntime({
      installedSha: manifest?.upstreamSha,
      builtAt: manifest?.builtAt,
      builtBy: manifest?.builtBy,
      healthy: deps.runtime.isHealthy(),
      hasRollback: deps.runtime.hasRollbackAvailable(),
    });
  } catch (error) {
    deps.output.appendBridge(`Runtime refresh failed: ${String(error)}`);
  }
}
