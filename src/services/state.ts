import { EventEmitter } from 'node:events';

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'running-external';

export interface BridgeSnapshot {
  readonly status: ServerStatus;
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  readonly sessionId?: string;
  readonly startedAt?: number;
  readonly errorMessage?: string;
  readonly logs: readonly string[];
  readonly pid?: number;
}

export interface McpSnapshot {
  readonly status: ServerStatus;
  readonly errorMessage?: string;
  readonly logs: readonly string[];
  readonly pid?: number;
}

export interface RuntimeSnapshot {
  readonly installedSha?: string;
  readonly builtAt?: string;
  readonly builtBy?: string;
  readonly healthy: boolean;
  readonly hasRollback: boolean;
  readonly latestUpstreamSha?: string;
  readonly updateAvailable: boolean;
  readonly building: boolean;
  readonly buildStatus?: string;
}

export interface PluginSnapshot {
  readonly installed: boolean;
  readonly pluginPath?: string;
}

export interface SystemSnapshot {
  readonly checking: boolean;
  readonly requirements: readonly SystemRequirementSnapshot[];
}

export interface SystemRequirementSnapshot {
  readonly id: string;
  readonly title: string;
  readonly met: boolean;
  readonly detail: string;
}

export interface AppSnapshot {
  readonly bridge: BridgeSnapshot;
  readonly mcp: McpSnapshot;
  readonly runtime: RuntimeSnapshot;
  readonly plugin: PluginSnapshot;
  readonly system: SystemSnapshot;
}

export function initialSnapshot(): AppSnapshot {
  return {
    bridge: { status: 'stopped', logs: [] },
    mcp: { status: 'stopped', logs: [] },
    runtime: { healthy: false, hasRollback: false, updateAvailable: false, building: false },
    plugin: { installed: false },
    system: { checking: false, requirements: [] },
  };
}

/**
 * Single direction state store: services push snapshots in, UI subscribes.
 */
export class StateStore {
  private readonly emitter = new EventEmitter();
  private snapshot: AppSnapshot = initialSnapshot();

  get(): AppSnapshot {
    return this.snapshot;
  }

  update(partial: Partial<AppSnapshot>): AppSnapshot {
    this.snapshot = { ...this.snapshot, ...partial };
    this.emitter.emit('change', this.snapshot);
    return this.snapshot;
  }

  updateBridge(partial: Partial<BridgeSnapshot>): AppSnapshot {
    return this.update({ bridge: { ...this.snapshot.bridge, ...partial } });
  }

  updateMcp(partial: Partial<McpSnapshot>): AppSnapshot {
    return this.update({ mcp: { ...this.snapshot.mcp, ...partial } });
  }

  updateRuntime(partial: Partial<RuntimeSnapshot>): AppSnapshot {
    return this.update({ runtime: { ...this.snapshot.runtime, ...partial } });
  }

  updatePlugin(partial: Partial<PluginSnapshot>): AppSnapshot {
    return this.update({ plugin: { ...this.snapshot.plugin, ...partial } });
  }

  updateSystem(partial: Partial<SystemSnapshot>): AppSnapshot {
    return this.update({ system: { ...this.snapshot.system, ...partial } });
  }

  onDidChange(listener: (snapshot: AppSnapshot) => void): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }

  dispose(): void {
    this.emitter.removeAllListeners();
  }
}
