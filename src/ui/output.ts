import * as vscode from 'vscode';

const BRIDGE_CHANNEL = 'Figma MCP Bridge';
const BUILD_CHANNEL = 'Figma MCP Bridge: Build';

export class OutputChannels implements vscode.Disposable {
  // Log channels: timestamps + level filtering (respects the user's log-level
  // setting) come for free, instead of appendLine's plain, unstamped text.
  readonly bridge: vscode.LogOutputChannel;
  readonly build: vscode.LogOutputChannel;

  constructor() {
    this.bridge = vscode.window.createOutputChannel(BRIDGE_CHANNEL, { log: true });
    this.build = vscode.window.createOutputChannel(BUILD_CHANNEL, { log: true });
  }

  appendBridge(line: string): void {
    logLine(this.bridge, line);
  }

  appendBuild(line: string): void {
    logLine(this.build, line);
  }

  showBridge(): void {
    this.bridge.show(true);
  }

  showBuild(): void {
    this.build.show(true);
  }

  clearBridge(): void {
    this.bridge.clear();
  }

  clearBuild(): void {
    this.build.clear();
  }

  dispose(): void {
    this.bridge.dispose();
    this.build.dispose();
  }
}

/** Routes callers' existing "[ERROR] ..." / "[WARN] ..." prefixed lines to the matching log level. */
function logLine(channel: vscode.LogOutputChannel, line: string): void {
  if (line.startsWith('[ERROR]')) {
    channel.error(line.slice('[ERROR]'.length).trim());
  } else if (line.startsWith('[WARN]')) {
    channel.warn(line.slice('[WARN]'.length).trim());
  } else {
    channel.info(line);
  }
}
