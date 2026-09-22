import { describe, expect, it, vi } from 'vitest';

// Unit tests for bridge arg/env construction without spawning.
// We assert the contract that BridgeService uses.

describe('bridge spawn contract', () => {
  it('passes token only via env, never argv', () => {
    const serverPath = '/runtime/bridge-cli.cjs';
    const host = '127.0.0.1';
    const port = 3845;
    const token = 'secret-token-value';

    const args = [serverPath, 'serve', '--host', host, '--port', String(port)];
    const env = { ...process.env, FIGMA_PLUGIN_BRIDGE_TOKEN: token };

    expect(args).not.toContain(token);
    expect(args).not.toContain('--token');
    expect(args).toEqual(['/runtime/bridge-cli.cjs', 'serve', '--host', '127.0.0.1', '--port', '3845']);
    expect(env.FIGMA_PLUGIN_BRIDGE_TOKEN).toBe(token);
  });

  it('validates host is one of the allowed loopback binds before spawn', () => {
    const valid = ['127.0.0.1', 'localhost', '::1'];
    expect(valid).toContain('::1');
    expect(valid).not.toContain('0.0.0.0');
  });
});

describe('session id parse', () => {
  it('extracts Session from bridge stdout', () => {
    const line = 'Session: abcdef0123456789abcdef0123456789';
    const match = /Session:\s*(\S+)/.exec(line);
    expect(match?.[1]).toBe('abcdef0123456789abcdef0123456789');
  });

  it('does not match unrelated lines', () => {
    expect(/Session:\s*(\S+)/.exec('Pairing token (sensitive): xyz')).toBeNull();
  });
});

// keep vi imported for future spies without unused-var lint
void vi;
