import * as vscode from 'vscode';
import { AppSnapshot, ServerStatus } from '../services/state';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private disposeListener: () => void;

  constructor(store: { onDidChange(fn: (s: AppSnapshot) => void): () => void }) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'figmaMcpBridge.showTree';
    this.item.text = '$(debug-disconnect) Figma MCP';
    this.item.tooltip = 'Figma MCP Bridge';
    this.item.show();
    this.disposeListener = store.onDidChange((snapshot) => this.render(snapshot));
  }

  private render(snapshot: AppSnapshot): void {
    const { status, port, sessionId, startedAt, errorMessage } = snapshot.bridge;
    const icon = statusIcon(status);
    const label = statusLabel(status);
    this.item.text = `${icon} Figma MCP: ${label}`;
    const lines: string[] = [`Bridge: ${label}`];
    if (port) {
      lines.push(`Port: ${port}`);
    }
    if (sessionId) {
      lines.push(`Session: ${sessionId}`);
    }
    if (startedAt && (status === 'running' || status === 'running-external')) {
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      lines.push(`Uptime: ${formatDuration(secs)}`);
    }
    if (snapshot.runtime.installedSha) {
      lines.push(`Runtime: ${snapshot.runtime.installedSha.slice(0, 12)}`);
    }
    if (errorMessage) {
      lines.push(`Error: ${errorMessage}`);
    }
    this.item.tooltip = lines.join('\n');
  }

  dispose(): void {
    this.disposeListener();
    this.item.dispose();
  }
}

function statusIcon(status: ServerStatus): string {
  switch (status) {
    case 'running':
    case 'running-external':
      return '$(check)';
    case 'starting':
    case 'stopping':
      return '$(sync~spin)';
    case 'error':
      return '$(error)';
    default:
      return '$(debug-disconnect)';
  }
}

function statusLabel(status: ServerStatus): string {
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

export function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  if (h > 0) {
    return `${h}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}
