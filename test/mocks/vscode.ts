/**
 * Minimal `vscode` module stub for unit tests. Only the surface actually
 * touched by non-UI modules (errors.runCommand, bridgeConfig.readBridgeConfig)
 * is implemented.
 */

export class Uri {
  constructor(public readonly fsPath: string) {}
  static file(p: string): Uri {
    return new Uri(p);
  }
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void): (() => void) => {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  };
  fire(value: T): void {
    for (const l of this.listeners) l(value);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class TreeItem {
  label?: string;
  id?: string;
  description?: string | boolean;
  tooltip?: string;
  contextValue?: string;
  command?: Command;
  iconPath?: ThemeIcon | string;
  collapsibleState?: TreeItemCollapsibleState;
  constructor(label?: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export interface Command {
  command: string;
  title: string;
}

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: (listener: () => void) => { dispose(): void };
}

const configurationValues = new Map<string, unknown>();

export const workspace = {
  getConfiguration(section?: string) {
    return {
      get<T>(key: string, defaultValue?: T): T {
        const full = section ? `${section}.${key}` : key;
        if (configurationValues.has(full)) {
          return configurationValues.get(full) as T;
        }
        return defaultValue as T;
      },
    };
  },
  onDidChangeConfiguration(_listener: unknown): { dispose(): void } {
    return { dispose() {} };
  },
  openTextDocument: async (_opts: unknown) => ({ languageId: 'json', getText: () => '' }),
};

export const window = {
  showInformationMessage: async (..._args: unknown[]) => undefined,
  showWarningMessage: async (..._args: unknown[]) => undefined,
  showErrorMessage: async (..._args: unknown[]) => undefined,
  showInputBox: async (..._args: unknown[]) => undefined,
  createOutputChannel: (_name: string, _options?: { log: true }) => ({
    appendLine: (_line: string) => {},
    trace: (_message: string) => {},
    debug: (_message: string) => {},
    info: (_message: string) => {},
    warn: (_message: string) => {},
    error: (_message: string | Error) => {},
    show: (_preserveFocus?: boolean) => {},
    clear: () => {},
    dispose: () => {},
  }),
  createStatusBarItem: (_align?: number, _prio?: number) => ({
    text: '',
    tooltip: undefined as string | undefined,
    command: undefined as string | undefined,
    show: () => {},
    dispose: () => {},
  }),
  withProgress: async <T>(
    _options: unknown,
    task: (progress: { report(v: unknown): void }, token: CancellationToken) => Promise<T>,
  ): Promise<T> => {
    const token: CancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    };
    return task({ report() {} }, token);
  },
  registerTreeDataProvider: (_id: string, _provider: unknown) => ({ dispose() {} }),
};

export const commands = {
  registerCommand: (_id: string, _fn: (...args: unknown[]) => unknown) => ({ dispose() {} }),
  executeCommand: async (..._args: unknown[]) => undefined,
  getCommands: async (_filterInternal?: boolean) => [] as string[],
};

export const env = {
  clipboard: {
    writeText: async (_t: string) => {},
    readText: async () => '',
  },
  openExternal: async (_uri: Uri) => true,
};

export const lm = {
  registerMcpServerDefinitionProvider: (_id: string, _provider: unknown) => ({ dispose() {} }),
};

export class McpStdioServerDefinition {
  constructor(
    public readonly label: string,
    public readonly command: string,
    public readonly args?: string[],
    public readonly env?: Record<string, string | number | null>,
    public readonly version?: string,
  ) {}
}

export type McpServerDefinition = McpStdioServerDefinition | { type: 'http'; url: string };
export interface McpServerDefinitionProvider {
  onDidChangeMcpServerDefinitions?: (listener: () => void) => { dispose(): void };
  provideMcpServerDefinitions(): McpServerDefinition[] | Promise<McpServerDefinition[]>;
  resolveMcpServerDefinition?(
    server: McpServerDefinition,
  ): McpServerDefinition | Promise<McpServerDefinition>;
}

export interface ExtensionContext {
  readonly subscriptions: Array<{ dispose(): unknown }>;
  readonly secrets: {
    get(k: string): Promise<string | undefined>;
    store(k: string, v: string): Promise<void>;
    delete(k: string): Promise<void>;
  };
  readonly globalStorageUri: Uri;
  readonly extensionPath: string;
}

export default {
  Uri,
  ThemeIcon,
  StatusBarAlignment,
  TreeItemCollapsibleState,
  ProgressLocation,
  EventEmitter,
  TreeItem,
  workspace,
  window,
  commands,
  env,
  lm,
  McpStdioServerDefinition,
};
