import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { ENV_BRIDGE_TOKEN } from '../constants';
import { BridgeError } from '../errors';
import { probeHealth } from './health';

const SMOKE_TOKEN = 'runtime-verifier-smoke-token-0123456789abcdef';

/**
 * Smoke-test a staged runtime before stage-and-swap:
 *  - MCP initialize returns a JSON-RPC result
 *  - bridge /health → 401 unauthenticated, 200 with Bearer token
 */
export async function verifyRuntimeBundle(
  runtimeDir: string,
  nodeCommand: string,
  nodeEnv: NodeJS.ProcessEnv,
  log: (line: string) => void = () => {},
): Promise<void> {
  const mcpPath = path.join(runtimeDir, 'mcp-server.cjs');
  const bridgePath = path.join(runtimeDir, 'bridge-cli.cjs');

  log('Verifier: MCP initialize…');
  await verifyMcpInitialize(mcpPath, nodeCommand, nodeEnv);

  log('Verifier: bridge /health 401/200…');
  await verifyBridgeHealth(bridgePath, nodeCommand, nodeEnv);

  log('Verifier: passed');
}

async function verifyMcpInitialize(
  mcpPath: string,
  nodeCommand: string,
  nodeEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const init = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'runtime-verifier', version: '1.0' },
    },
  })}\n`;

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(nodeCommand, [mcpPath], {
      env: { ...nodeEnv, [ENV_BRIDGE_TOKEN]: SMOKE_TOKEN },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new BridgeError('verification_failed', 'MCP initialize timed out'));
    }, 10_000);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('"result"')) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve(out);
      }
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new BridgeError('verification_failed', `Failed to spawn MCP server: ${e.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out || err);
    });
    child.stdin.write(init);
    child.stdin.end();
  });

  if (!output.includes('"result"')) {
    throw new BridgeError('verification_failed', `MCP initialize did not return result:\n${output}`);
  }
}

async function verifyBridgeHealth(
  bridgePath: string,
  nodeCommand: string,
  nodeEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const port = 18845 + Math.floor(Math.random() * 2000);
  const bridge = spawn(
    nodeCommand,
    [bridgePath, 'serve', '--host', '127.0.0.1', '--port', String(port)],
    {
      env: { ...nodeEnv, [ENV_BRIDGE_TOKEN]: SMOKE_TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stderr = '';
  bridge.stderr.on('data', (d) => {
    stderr += d;
  });

  try {
    let ready = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) });
        ready = true;
        break;
      } catch {
        if (bridge.exitCode !== null) {break;}
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!ready) {
      throw new BridgeError('verification_failed', `Bridge did not listen on :${port}\n${stderr}`);
    }

    const unauth = await fetch(`http://127.0.0.1:${port}/health`);
    if (unauth.status !== 401) {
      throw new BridgeError('verification_failed', `Expected 401 unauthenticated /health, got ${unauth.status}`);
    }

    const auth = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${SMOKE_TOKEN}` },
    });
    if (auth.status !== 200) {
      throw new BridgeError('verification_failed', `Expected 200 authenticated /health, got ${auth.status}`);
    }

    const health = await probeHealth('127.0.0.1', port, SMOKE_TOKEN, 2000);
    if (!health.ok) {
      throw new BridgeError('verification_failed', health.error ?? 'health probe failed');
    }
  } finally {
    bridge.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    bridge.kill('SIGKILL');
  }
}
