import * as vscode from 'vscode';
import * as path from 'node:path';
import { AppSnapshot, StateStore } from '../services/state';
import { formatDuration } from './statusBar';

type SectionId = 'bridge' | 'mcp' | 'plugin' | 'runtime' | 'system';

type NodeKind = 'root' | 'section' | 'item';

export interface TreeNode {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly icon?: string;
  readonly kind: NodeKind;
  readonly section?: SectionId;
  readonly command?: vscode.Command;
  readonly collapsible: vscode.TreeItemCollapsibleState;
  readonly contextValue?: string;
}

const SECTION_ORDER: SectionId[] = ['bridge', 'mcp', 'plugin', 'runtime', 'system'];

const SECTION_LABELS: Record<SectionId, string> = {
  bridge: 'Bridge',
  mcp: 'MCP',
  plugin: 'Plugin',
  runtime: 'Runtime',
  system: 'System',
};

export class TreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private unsubscribe: () => void;

  constructor(private readonly store: StateStore) {
    this.unsubscribe = store.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, element.collapsible);
    item.id = element.id;
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.contextValue = element.contextValue;
    if (element.command) {
      item.command = element.command;
    }
    if (element.icon) {
      item.iconPath = new vscode.ThemeIcon(element.icon);
    }
    return item;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    const snapshot = this.store.get();
    if (!element) {
      return SECTION_ORDER.map((section) => sectionNode(section, snapshot));
    }
    if (element.kind === 'section' && element.section) {
      return sectionChildren(element.section, snapshot);
    }
    return [];
  }

  dispose(): void {
    this.unsubscribe();
    this.emitter.dispose();
  }
}

function sectionNode(section: SectionId, snapshot: AppSnapshot): TreeNode {
  const status = sectionStatus(section, snapshot);
  return {
    id: `section:${section}`,
    label: SECTION_LABELS[section],
    description: status.label,
    kind: 'section',
    section,
    icon: status.icon,
    collapsible: vscode.TreeItemCollapsibleState.Expanded,
    contextValue: `figmaMcp.${section}`,
  };
}

function sectionStatus(
  section: SectionId,
  snapshot: AppSnapshot,
): { label: string; icon: string } {
  switch (section) {
    case 'bridge': {
      const s = snapshot.bridge.status;
      if (s === 'running') {return { label: 'Running', icon: 'check' };}
      if (s === 'running-external') {return { label: 'External', icon: 'link-external' };}
      if (s === 'starting' || s === 'stopping') {return { label: '…', icon: 'sync~spin' };}
      if (s === 'error') {return { label: 'Error', icon: 'error' };}
      return { label: 'Stopped', icon: 'debug-disconnect' };
    }
    case 'mcp': {
      const s = snapshot.mcp.status;
      if (s === 'running') {return { label: 'Provided', icon: 'check' };}
      if (s === 'error') {return { label: 'Error', icon: 'error' };}
      return { label: 'Idle', icon: 'circle-slash' };
    }
    case 'plugin':
      return snapshot.plugin.installed
        ? { label: 'Installed', icon: 'check' }
        : { label: 'Not installed', icon: 'circle-slash' };
    case 'runtime': {
      if (snapshot.runtime.building) {return { label: 'Building…', icon: 'sync~spin' };}
      const sha = snapshot.runtime.installedSha;
      return {
        label: sha ? sha.slice(0, 10) : snapshot.runtime.healthy ? 'OK' : 'Missing',
        icon: snapshot.runtime.healthy ? 'package' : 'error',
      };
    }
    case 'system': {
      const reqs = snapshot.system.requirements;
      if (snapshot.system.checking) {return { label: 'Checking…', icon: 'sync~spin' };}
      if (reqs.length === 0) {return { label: 'Not checked', icon: 'circle-slash' };}
      const met = reqs.filter((r) => r.met).length;
      return {
        label: `${met}/${reqs.length}`,
        icon: met === reqs.length ? 'pass' : 'warning',
      };
    }
  }
}

function sectionChildren(section: SectionId, snapshot: AppSnapshot): TreeNode[] {
  switch (section) {
    case 'bridge': {
      const b = snapshot.bridge;
      const items: TreeNode[] = [
        item('bridge.status', 'Status', statusText(b.status)),
        item('bridge.port', 'Port', b.port !== undefined ? String(b.port) : undefined),
        item('bridge.session', 'Session', b.sessionId),
        item(
          'bridge.uptime',
          'Uptime',
          b.startedAt && (b.status === 'running' || b.status === 'running-external')
            ? formatDuration(Math.floor((Date.now() - b.startedAt) / 1000))
            : undefined,
        ),
        item('bridge.pid', 'PID', b.pid !== undefined ? String(b.pid) : undefined),
      ];
      if (b.errorMessage) {
        items.push(item('bridge.error', 'Error', b.errorMessage));
      }
      items.push(
        cmd('bridge.start', 'Start bridge', 'figmaMcpBridge.startBridge', 'play', 'figmaMcp.bridge.start'),
        cmd('bridge.stop', 'Stop bridge', 'figmaMcpBridge.stopBridge', 'debug-stop', 'figmaMcp.bridge.stop'),
        cmd('bridge.restart', 'Restart bridge', 'figmaMcpBridge.restartBridge', 'refresh', 'figmaMcp.bridge.restart'),
        cmd('bridge.kill', 'Kill orphans', 'figmaMcpBridge.killOrphans', 'trash', 'figmaMcp.bridge.kill'),
        cmd('bridge.test', 'Test connection', 'figmaMcpBridge.testConnection', 'pulse', 'figmaMcp.bridge.test'),
        cmd('bridge.copyUrl', 'Copy URL', 'figmaMcpBridge.copyUrl', 'clippy', 'figmaMcp.bridge.copyUrl'),
        cmd('bridge.copyToken', 'Copy token', 'figmaMcpBridge.copyToken', 'key', 'figmaMcp.bridge.copyToken'),
        cmd('bridge.openLogs', 'Open logs', 'figmaMcpBridge.openBridgeLogs', 'output', 'figmaMcp.bridge.logs'),
      );
      return items;
    }
    case 'mcp': {
      const m = snapshot.mcp;
      return [
        item('mcp.status', 'Status', statusText(m.status)),
        item('mcp.error', 'Error', m.errorMessage),
        cmd('mcp.configureOpencode', 'Configure opencode', 'figmaMcpBridge.configureOpencode', 'file-code', 'figmaMcp.mcp.opencode'),
        cmd('mcp.preview', 'Preview opencode config', 'figmaMcpBridge.previewOpencodeConfig', 'preview', 'figmaMcp.mcp.preview'),
        cmd('mcp.clearFigmaToken', 'Clear Figma token', 'figmaMcpBridge.clearFigmaToken', 'key', 'figmaMcp.mcp.clearToken'),
        cmd('mcp.setFigmaToken', 'Set Figma token', 'figmaMcpBridge.setFigmaToken', 'key', 'figmaMcp.mcp.setToken'),
      ];
    }
    case 'plugin': {
      const p = snapshot.plugin;
      return [
        item('plugin.path', 'Path', p.pluginPath ?? (p.installed ? undefined : 'Not installed')),
        cmd('plugin.install', 'Install plugin', 'figmaMcpBridge.installPlugin', 'repo-clone', 'figmaMcp.plugin.install'),
        cmd('plugin.uninstall', 'Uninstall plugin', 'figmaMcpBridge.uninstallPlugin', 'trash', 'figmaMcp.plugin.uninstall'),
        cmd('plugin.open', 'Open folder', 'figmaMcpBridge.openPluginFolder', 'folder-opened', 'figmaMcp.plugin.open'),
        cmd('plugin.refresh', 'Refresh status', 'figmaMcpBridge.refreshPluginStatus', 'search', 'figmaMcp.plugin.refresh'),
      ];
    }
    case 'runtime': {
      const r = snapshot.runtime;
      const items: TreeNode[] = [
        item('runtime.sha', 'Upstream SHA', r.installedSha ? r.installedSha.slice(0, 12) : undefined),
        item('runtime.builtAt', 'Built at', r.builtAt),
        item('runtime.builtBy', 'Built by', r.builtBy),
        item(
          'runtime.update',
          'Update',
          r.updateAvailable
            ? `Available (${(r.latestUpstreamSha ?? '').slice(0, 10)})`
            : r.latestUpstreamSha
              ? 'Up to date'
              : undefined,
        ),
        item('runtime.rollback', 'Rollback', r.hasRollback ? 'Available' : 'None'),
      ];
      if (r.buildStatus) {
        items.push(item('runtime.buildStatus', 'Build', r.buildStatus));
      }
      items.push(
        cmd('runtime.build', 'Build from source', 'figmaMcpBridge.buildFromSource', 'tools', 'figmaMcp.runtime.build'),
        cmd('runtime.checkUpdate', 'Check for updates', 'figmaMcpBridge.checkRuntimeUpdate', 'cloud-download', 'figmaMcp.runtime.check'),
        cmd('runtime.rollback', 'Rollback', 'figmaMcpBridge.rollbackRuntime', 'history', 'figmaMcp.runtime.rollback'),
        cmd('runtime.forceReinstall', 'Force reinstall seed', 'figmaMcpBridge.forceReinstallRuntime', 'refresh', 'figmaMcp.runtime.reinstall'),
        cmd('runtime.openLogs', 'Open build logs', 'figmaMcpBridge.openBuildLogs', 'output', 'figmaMcp.runtime.logs'),
      );
      return items;
    }
    case 'system': {
      if (snapshot.system.requirements.length === 0) {
        return [
          cmd('system.check', 'Run system check', 'figmaMcpBridge.runSystemCheck', 'checklist', 'figmaMcp.system.check'),
        ];
      }
      return [
        ...snapshot.system.requirements.map((r) =>
          item(`system.${r.id}`, r.title, r.detail, r.met ? undefined : r.detail),
        ),
        cmd('system.check', 'Re-run system check', 'figmaMcpBridge.runSystemCheck', 'checklist', 'figmaMcp.system.check'),
      ];
    }
  }
}

function statusText(status: string): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'running-external':
      return 'Running (external)';
    case 'starting':
      return 'Starting…';
    case 'stopping':
      return 'Stopping…';
    case 'error':
      return 'Error';
    default:
      return 'Stopped';
  }
}

function item(id: string, label: string, description?: string, tooltip?: string): TreeNode {
  return {
    id,
    label,
    description: description ?? undefined,
    tooltip: tooltip ?? (description ? `${label}: ${description}` : label),
    kind: 'item',
    collapsible: vscode.TreeItemCollapsibleState.None,
  };
}

function cmd(
  id: string,
  label: string,
  command: string,
  icon: string,
  contextValue: string,
): TreeNode {
  return {
    id,
    label,
    kind: 'item',
    icon,
    contextValue,
    command: { command, title: label },
    collapsible: vscode.TreeItemCollapsibleState.None,
  };
}

// silence unused import if path not needed
void path;
