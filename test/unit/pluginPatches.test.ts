import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { patchPluginCode, patchPluginUi } from '../../src/services/pluginPatches';

const seedPlugin = path.resolve(__dirname, '../../runtime-seed/plugin');
const seedUi = fs.readFileSync(path.join(seedPlugin, 'ui.html'), 'utf8');
const seedCode = fs.readFileSync(path.join(seedPlugin, 'code.js'), 'utf8');

interface FakeElement {
  id: string;
  value: string;
  textContent: string;
  className: string;
  disabled: boolean;
  children: FakeElement[];
  addEventListener(): void;
  replaceChildren(): void;
  appendChild(child: FakeElement): void;
}

function element(id = ''): FakeElement {
  return {
    id,
    value: '',
    textContent: '',
    className: '',
    disabled: false,
    children: [],
    addEventListener() {},
    replaceChildren() {
      this.children = [];
    },
    appendChild(child) {
      this.children.push(child);
    },
  };
}

/** Runs ui.html's inline script against a minimal DOM, as Figma's UI frame would. */
function loadUi(html: string) {
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  if (!script) {throw new Error('no inline script in ui.html');}
  const elements = new Map<string, FakeElement>();
  for (const id of [
    'bridge-url', 'bridge-token', 'test-connection', 'clear-snapshot',
    'capture', 'status', 'selection-count', 'selection-list',
  ]) {
    elements.set(id, element(id));
  }
  elements.get('selection-count')!.textContent = 'Reading selection…';
  const toPlugin: unknown[] = [];
  const parent = { postMessage: (message: unknown) => toPlugin.push(message) };
  const sandbox: Record<string, unknown> = {
    parent,
    document: {
      getElementById: (id: string) => elements.get(id),
      createElement: () => element(),
    },
    URL, AbortController, Blob, setTimeout, clearTimeout, console,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(script, sandbox);
  return {
    toPlugin,
    count: () => elements.get('selection-count')!.textContent,
    list: () => elements.get('selection-list')!.children.map((c) => c.textContent),
    /** Deliver a message the way Figma does: posted by its top-level window, not `parent`. */
    fromFigma: (pluginMessage: unknown) =>
      (sandbox.onmessage as (e: unknown) => unknown)({ source: { top: true }, data: { pluginMessage } }),
  };
}

/** Runs code.js against a fake `figma` global. */
function loadCode(js: string) {
  const toUi: Array<Record<string, unknown>> = [];
  const selection = [{ id: '1:2', name: 'Card', type: 'FRAME' }];
  const figma: Record<string, unknown> = {
    showUI() {},
    on() {},
    currentPage: { name: 'Page 1', selection },
    root: { name: 'File' },
    ui: { postMessage: (message: Record<string, unknown>) => toUi.push(message), onmessage: undefined },
  };
  vm.runInNewContext(js, { figma, __html__: '' });
  const ui = figma.ui as { onmessage: (m: unknown) => unknown };
  return { toUi, send: (message: unknown) => ui.onmessage(message) };
}

describe('plugin build-time patches', () => {
  it('applies every patch to the bundled seed (anchors still match upstream)', () => {
    expect(patchPluginUi(seedUi).applied).toEqual(['ui-message-source', 'ui-ready-handshake']);
    expect(patchPluginCode(seedCode).applied).toEqual(['code-ui-ready']);
  });

  it('is idempotent and skips files it does not recognise', () => {
    const ui = patchPluginUi(seedUi).text;
    const code = patchPluginCode(seedCode).text;
    expect(patchPluginUi(ui)).toEqual({ text: ui, applied: [] });
    expect(patchPluginCode(code)).toEqual({ text: code, applied: [] });
    expect(patchPluginUi('<html></html>')).toEqual({ text: '<html></html>', applied: [] });
    expect(patchPluginCode('// nothing')).toEqual({ text: '// nothing', applied: [] });
  });

  it('reproduces the bug: unpatched UI ignores Figma messages and stays on "Reading selection…"', () => {
    const ui = loadUi(seedUi);
    ui.fromFigma({ type: 'selection-summary', pageName: 'Page 1', selections: [{ name: 'Card', type: 'FRAME' }] });
    expect(ui.count()).toBe('Reading selection…');
  });

  it('patched UI shows selection updates delivered from Figma', () => {
    const ui = loadUi(patchPluginUi(seedUi).text);
    ui.fromFigma({ type: 'selection-summary', pageName: 'Page 1', selections: [{ name: 'Card', type: 'FRAME' }] });
    expect(ui.count()).toBe('1 node(s) selected on Page 1.');
    expect(ui.list()).toEqual(['Card (FRAME)']);

    ui.fromFigma({ type: 'selection-summary', pageName: 'Page 1', selections: [] });
    expect(ui.count()).toBe('0 node(s) selected on Page 1.');
  });

  it('patched UI announces readiness and patched code answers with the current selection', () => {
    const ui = loadUi(patchPluginUi(seedUi).text);
    expect(ui.toPlugin).toEqual([{ pluginMessage: { type: 'ui-ready' } }]);

    const code = loadCode(patchPluginCode(seedCode).text);
    code.toUi.length = 0; // drop the startup post that may race the UI load
    code.send({ type: 'ui-ready' });
    expect(code.toUi).toEqual([
      { type: 'selection-summary', pageName: 'Page 1', selections: [{ id: '1:2', name: 'Card', type: 'FRAME' }] },
    ]);
  });
});
