/**
 * Build-time fixes for upstream's Figma plugin files, applied when the plugin
 * is built (so they cover the VSIX seed, on-device source builds and runtime
 * updates alike — the hash-verified runtime itself is never modified).
 *
 * Each patch is anchored on an exact upstream snippet and skipped when that
 * anchor is absent (upstream changed or fixed it), so an update can never yield
 * a half-patched file.
 */

export interface PatchResult {
  readonly text: string;
  /** Names of the patches that were applied. */
  readonly applied: readonly string[];
}

interface Patch {
  readonly name: string;
  apply(text: string): string | null;
}

const UI_READY_TYPE = 'ui-ready';

const UI_PATCHES: readonly Patch[] = [
  {
    // Figma posts plugin messages from its top-level editor window straight into
    // the UI frame, which is nested inside Figma's own wrapper iframes — so
    // `event.source` is never `parent` and upstream drops every message (the
    // panel sticks on "Reading selection…", captures never finish). Figma's
    // documented pattern is to filter on the `pluginMessage` payload, which the
    // handler already does on the next line.
    name: 'ui-message-source',
    apply: (text) => {
      const anchor = /^([ \t]*)if \(event\.source !== parent\) return;[ \t]*$/m;
      if (!anchor.test(text)) {return null;}
      return text.replace(
        anchor,
        '$1// figma-mcp-bridge: Figma posts from its top-level window, not `parent`; filter on pluginMessage.',
      );
    },
  },
  {
    // The initial selection summary is queued only until Figma's wrapper frame
    // loads; the UI's own script runs later, so that first message can arrive
    // before `window.onmessage` exists. Ask for it once the listener is set.
    name: 'ui-ready-handshake',
    apply: (text) => {
      const end = text.lastIndexOf('</script>');
      if (end < 0 || !text.includes('window.onmessage =') || text.includes(UI_READY_TYPE)) {return null;}
      // Inserted after the `</script>` line's own indent, so this lands at 4 spaces.
      const line = `  parent.postMessage({ pluginMessage: { type: "${UI_READY_TYPE}" } }, "*");\n  `;
      return `${text.slice(0, end)}${line}${text.slice(end)}`;
    },
  },
];

const CODE_PATCHES: readonly Patch[] = [
  {
    name: 'code-ui-ready',
    apply: (text) => {
      const anchor = /^([ \t]*)if \(!message \|\| message\.type !== "capture-selection"\) return;/m;
      if (!anchor.test(text) || !text.includes('function postSelectionSummary(') || text.includes(UI_READY_TYPE)) {
        return null;
      }
      return text.replace(
        anchor,
        (line, indent: string) =>
          `${indent}if (message && message.type === "${UI_READY_TYPE}") { postSelectionSummary(); return; }\n${line}`,
      );
    },
  },
];

function run(text: string, patches: readonly Patch[]): PatchResult {
  const applied: string[] = [];
  let current = text;
  for (const patch of patches) {
    const next = patch.apply(current);
    if (next !== null) {
      current = next;
      applied.push(patch.name);
    }
  }
  return { text: current, applied };
}

export function patchPluginUi(html: string): PatchResult {
  return run(html, UI_PATCHES);
}

export function patchPluginCode(js: string): PatchResult {
  return run(js, CODE_PATCHES);
}
