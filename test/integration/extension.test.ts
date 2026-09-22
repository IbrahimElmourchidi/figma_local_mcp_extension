import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'ibrahimelmourchidi.figma-mcp-bridge';

const CORE_COMMANDS = [
  'figmaMcpBridge.setBridgePassword',
  'figmaMcpBridge.regenerateBridgePassword',
  'figmaMcpBridge.setFigmaToken',
  'figmaMcpBridge.clearFigmaToken',
  'figmaMcpBridge.startBridge',
  'figmaMcpBridge.stopBridge',
  'figmaMcpBridge.restartBridge',
  'figmaMcpBridge.killOrphans',
  'figmaMcpBridge.testConnection',
  'figmaMcpBridge.copyUrl',
  'figmaMcpBridge.copyToken',
  'figmaMcpBridge.openBridgeLogs',
  'figmaMcpBridge.clearLogs',
  'figmaMcpBridge.showTree',
  'figmaMcpBridge.configureOpencode',
  'figmaMcpBridge.previewOpencodeConfig',
  'figmaMcpBridge.installPlugin',
  'figmaMcpBridge.uninstallPlugin',
  'figmaMcpBridge.openPluginFolder',
  'figmaMcpBridge.refreshPluginStatus',
  'figmaMcpBridge.buildFromSource',
  'figmaMcpBridge.checkRuntimeUpdate',
  'figmaMcpBridge.rollbackRuntime',
  'figmaMcpBridge.forceReinstallRuntime',
  'figmaMcpBridge.openBuildLogs',
  'figmaMcpBridge.runSystemCheck',
  'figmaMcpBridge.saveSettings',
];

suite('extension activation', () => {
  setup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension?.activate();
  });

  test('registers all commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of CORE_COMMANDS) {
      assert.ok(commands.includes(id), `expected command ${id} to be registered`);
    }
  });

  test('activates without error', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension is installed');
    assert.ok(extension.isActive, 'extension is active');
  });

  test('contributes the dashboard tree view', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    const contributes = extension?.packageJSON?.contributes as
      | { views?: Record<string, Array<{ id: string }>> }
      | undefined;
    const views = contributes?.views?.figmaMcpBridge ?? [];
    assert.ok(
      views.some((v) => v.id === 'figmaMcpBridge.view'),
      'expected figmaMcpBridge.view in contributes.views',
    );
  });

  test('contributes an MCP server definition provider', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    const contributes = extension?.packageJSON?.contributes as
      | { mcpServerDefinitionProviders?: Array<{ id: string }> }
      | undefined;
    const providers = contributes?.mcpServerDefinitionProviders ?? [];
    assert.ok(
      providers.some((p) => p.id === 'figmaMcpBridge.servers'),
      'expected figmaMcpBridge.servers provider id',
    );
  });
});
