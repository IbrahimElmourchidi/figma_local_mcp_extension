import { describe, expect, it } from 'vitest';
import { systemNodeCandidates } from '../../src/services/nodeResolver';
import { probeNode } from '../../src/services/nodeResolver';

describe('systemNodeCandidates', () => {
  it('returns a non-empty ordered list', () => {
    const candidates = systemNodeCandidates();
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('prefers well-known install locations before version managers on linux', () => {
    if (process.platform !== 'linux') {return;}
    const candidates = systemNodeCandidates();
    expect(candidates[0]).toBe('/usr/local/bin/node');
    expect(candidates[1]).toBe('/usr/bin/node');
    const nvmIndex = candidates.findIndex((c) => c.includes('.nvm'));
    expect(nvmIndex).toBeGreaterThan(1);
  });
});

describe('probeNode', () => {
  it('returns version for a valid node binary', async () => {
    const version = await probeNode(process.execPath, process.env);
    // process.execPath under vitest is real node
    expect(version).toMatch(/^v\d+\./);
  });

  it('returns null for missing binary', async () => {
    const version = await probeNode('/nonexistent/node-xyz', process.env);
    expect(version).toBeNull();
  });
});
