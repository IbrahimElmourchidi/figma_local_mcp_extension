import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStorageLayout } from '../../src/core/paths';

describe('createStorageLayout', () => {
  it('keeps runtime/node/locks under the given root', () => {
    const root = path.join('/fake', 'globalStorage', 'ibrahimelmourchidi.figma-mcp-bridge');
    const layout = createStorageLayout(root);
    expect(layout.runtime.startsWith(root)).toBe(true);
    expect(layout.runtimePrevious.startsWith(root)).toBe(true);
    expect(layout.runtimeStaging.startsWith(root)).toBe(true);
    expect(layout.node.startsWith(root)).toBe(true);
    expect(layout.locks.startsWith(root)).toBe(true);
  });

  it('puts build scratch in the OS temp dir, not under root', () => {
    // pnpm's virtual store (node_modules/.pnpm/<pkg>@<ver>_<hash>/node_modules/<pkg>/...)
    // nested under a long globalStorage path regularly exceeds Windows MAX_PATH.
    const root = path.join(
      'C:\\Users\\someone\\AppData\\Roaming\\Code\\User\\globalStorage',
      'ibrahimelmourchidi.figma-mcp-bridge',
    );
    const layout = createStorageLayout(root);
    expect(layout.build.startsWith(root)).toBe(false);
    expect(layout.build.startsWith(os.tmpdir())).toBe(true);
  });

  it('derives a stable build dir for the same root', () => {
    const root = '/fake/globalStorage/ibrahimelmourchidi.figma-mcp-bridge';
    expect(createStorageLayout(root).build).toBe(createStorageLayout(root).build);
  });

  it('derives distinct build dirs for distinct roots', () => {
    const a = createStorageLayout('/fake/a').build;
    const b = createStorageLayout('/fake/b').build;
    expect(a).not.toBe(b);
  });
});
