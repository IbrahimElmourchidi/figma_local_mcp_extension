import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { MIN_NODE_VERSION, RECOMMENDED_NODE_VERSION } from '../constants';
import { probeHealth } from './health';
import { StateStore, SystemRequirementSnapshot } from './state';
import { NodeResolver, probeNode } from './nodeResolver';

export interface CheckContext {
  readonly port: number;
  readonly host: string;
  readonly nodes: NodeResolver;
}

export class SystemChecker {
  constructor(
    private readonly state: StateStore,
    private readonly pluginStatus: () => { installed: boolean; pluginPath?: string } = () => ({ installed: false }),
  ) {}

  async checkAll(context: CheckContext): Promise<SystemRequirementSnapshot[]> {
    this.state.updateSystem({ checking: true });
    try {
      const requirements: SystemRequirementSnapshot[] = [];
      requirements.push(await this.checkNode(context));
      requirements.push(await this.checkPort(context));
      requirements.push(await this.checkFigmaDesktop());
      requirements.push(await this.checkPlugin());
      this.state.updateSystem({ checking: false, requirements });
      return requirements;
    } catch (error) {
      this.state.updateSystem({
        checking: false,
        requirements: [
          {
            id: 'error',
            title: 'System check failed',
            met: false,
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
      });
      throw error;
    }
  }

  /**
   * Bridge/MCP run on VS Code's own binary (ELECTRON_RUN_AS_NODE), so a system
   * Node.js is optional — only source builds need it, and those can download a
   * managed copy. Fail only when neither runtime works.
   */
  private async checkNode(context: CheckContext): Promise<SystemRequirementSnapshot> {
    const title = 'Node runtime';
    const electron = context.nodes.resolveElectronNode();
    const electronVersion = await probeNode(electron.command, electron.env);
    const realVersion = await this.probeRealNode(context);

    if (electronVersion) {
      const extra = realVersion
        ? `system Node ${realVersion} available`
        : 'system Node not needed (only for Build from source)';
      return { id: 'node', title, met: true, detail: `${electronVersion} (VS Code built-in) · ${extra}` };
    }
    if (realVersion) {
      return { id: 'node', title, met: true, detail: `${realVersion} (system)` };
    }
    return {
      id: 'node',
      title,
      met: false,
      detail: `Missing — VS Code's built-in runtime failed; install Node >= ${MIN_NODE_VERSION} (recommended ${RECOMMENDED_NODE_VERSION})`,
    };
  }

  private async probeRealNode(context: CheckContext): Promise<string | null> {
    try {
      const node = await context.nodes.resolveRealNode();
      return `${node.version ?? 'ok'}${node.via === 'system' ? '' : ` (${node.via})`}`;
    } catch {
      return probeNodeOnPath();
    }
  }

  private async checkPort(context: CheckContext): Promise<SystemRequirementSnapshot> {
    const health = await probeHealth(context.host, context.port, undefined, 2000);
    if (health.ok) {
      return {
        id: 'port',
        title: `Port ${context.port}`,
        met: true,
        detail: 'Bridge server is running',
      };
    }
    if (health.status === 401) {
      return {
        id: 'port',
        title: `Port ${context.port}`,
        met: true,
        detail: 'Bridge listening (auth required)',
      };
    }
    const available = await canBind(context.host, context.port);
    return available
      ? { id: 'port', title: `Port ${context.port}`, met: true, detail: 'Available' }
      : { id: 'port', title: `Port ${context.port}`, met: false, detail: 'In use by another process' };
  }

  private async checkFigmaDesktop(): Promise<SystemRequirementSnapshot> {
    const running = await figmaRunning();
    return running
      ? { id: 'figma', title: 'Figma desktop', met: true, detail: 'Running' }
      : {
          id: 'figma',
          title: 'Figma desktop',
          met: false,
          detail: 'Not detected — install from figma.com/downloads',
        };
  }

  private checkPlugin(): SystemRequirementSnapshot {
    const { installed, pluginPath } = this.pluginStatus();
    if (installed && pluginPath) {
      return { id: 'plugin', title: 'Figma plugin', met: true, detail: `Built at ${pluginPath}` };
    }
    return {
      id: 'plugin',
      title: 'Figma plugin',
      met: false,
      detail: 'Not built — run Build Figma Plugin, then import its manifest in Figma',
    };
  }
}

function probeNodeOnPath(): Promise<string | null> {
  return probeNodeCmd('node', ['--version']);
}

function probeNodeCmd(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code === 0 && out.trim().startsWith('v')) {resolve(out.trim());}
      else {resolve(null);}
    });
  });
}

function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    const bindHost = host === 'localhost' ? '127.0.0.1' : host;
    server.listen(port, bindHost);
  });
}

function figmaRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const child = spawn('tasklist', ['/FI', 'IMAGENAME eq Figma.exe'], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
      });
      child.on('error', () => resolve(false));
      child.on('close', () => resolve(out.includes('Figma.exe')));
      return;
    }
    const child = spawn('pgrep', ['-f', 'Figma'], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}
