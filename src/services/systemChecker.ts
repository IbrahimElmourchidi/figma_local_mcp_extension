import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { MIN_NODE_VERSION, RECOMMENDED_NODE_VERSION } from '../constants';
import { probeHealth } from './health';
import { figmaDevelopmentDirCandidates } from './pluginManager';
import { PLUGIN_INSTALL_DIR_NAME } from '../constants';
import { StateStore, SystemRequirementSnapshot } from './state';
import { NodeResolver } from './nodeResolver';

export interface CheckContext {
  readonly port: number;
  readonly host: string;
  readonly nodes: NodeResolver;
}

export class SystemChecker {
  constructor(private readonly state: StateStore) {}

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

  private async checkNode(context: CheckContext): Promise<SystemRequirementSnapshot> {
    try {
      const node = await context.nodes.resolveRealNode();
      return {
        id: 'node',
        title: 'Node.js',
        met: true,
        detail: `${node.version ?? 'ok'} (${node.via})`,
      };
    } catch {
      const probed = await probeNodeOnPath();
      if (probed) {
        return { id: 'node', title: 'Node.js', met: true, detail: `${probed} (system)` };
      }
      return {
        id: 'node',
        title: 'Node.js',
        met: false,
        detail: `Missing — need >= ${MIN_NODE_VERSION} (recommended ${RECOMMENDED_NODE_VERSION})`,
      };
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
    for (const devDir of figmaDevelopmentDirCandidates()) {
      const pluginDir = path.join(devDir, PLUGIN_INSTALL_DIR_NAME);
      const manifest = path.join(pluginDir, 'manifest.json');
      if (fs.existsSync(manifest)) {
        return { id: 'plugin', title: 'Figma plugin', met: true, detail: pluginDir };
      }
    }
    return {
      id: 'plugin',
      title: 'Figma plugin',
      met: false,
      detail: 'Not installed — run Install plugin',
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
