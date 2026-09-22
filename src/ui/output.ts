import * as vscode from 'vscode';

const BRIDGE_CHANNEL = 'Figma MCP Bridge';
const BUILD_CHANNEL = 'Figma MCP Bridge: Build';

export class OutputChannels implements vscode.Disposable {
  readonly bridge: vscode.OutputChannel;
  readonly build: vscode.OutputChannel;

  constructor() {
    this.bridge = vscode.window.createOutputChannel(BRIDGE_CHANNEL);
    this.build = vscode.window.createOutputChannel(BUILD_CHANNEL);
  }

  appendBridge(line: string): void {
    this.bridge.appendLine(line);
  }

  appendBuild(line: string): void {
    this.build.appendLine(line);
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
