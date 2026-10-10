/**
 * Build-time patches for the bundled upstream runtime (`mcp-server.cjs` /
 * `bridge-cli.cjs`), applied by `build-runtime.mjs` right after esbuild.
 *
 * Purpose: upstream hard-codes the inspect tool's depth ceiling to 5 in three
 * independent places, and the zod `.max(5)` in particular is published to MCP
 * clients as JSON-Schema `"maximum": 5` — so a client rejects `depth > 5`
 * locally and the server clamp is never even reached. This makes the ceiling
 * read `FIGMA_MCP_MAX_DEPTH` instead, so the user's `figmaMcpBridge.maxDepth`
 * setting can move it through the environment at spawn time.
 *
 * Two properties are deliberate:
 *
 *  - **Deterministic.** The output depends only on upstream bytes, never on any
 *    user setting, so `runtime.json`'s SHA-256 map stays reproducible and
 *    `verify-seed.mjs` / the packaging gate keep passing.
 *  - **Fail-safe.** Every patch is anchored on an exact upstream snippet and
 *    skipped when that anchor is absent (upstream refactored or fixed it), so an
 *    update can never yield a half-patched file. Skips are reported, not fatal.
 *
 * Mirrors the approach of `src/services/pluginPatches.ts`, which patches the
 * Figma plugin files the same way.
 */

/**
 * Hard ceiling for `figmaMcpBridge.maxDepth`; must match `package.json`.
 *
 * Matches upstream's REST document capture depth (`bridge-cli serve
 * --max-depth`, default 64), so the ceiling can never exceed how deeply the
 * bridge actually captured the selection — otherwise a user could raise this
 * and still see no extra nodes, with nothing to explain why.
 */
export const MAX_INSPECT_DEPTH = 64;

/** Upstream's compiled-in default; also our fallback when the env var is unset. */
export const DEFAULT_INSPECT_DEPTH = 5;

/** Env var read by the patched bundles. */
export const MAX_DEPTH_ENV = 'FIGMA_MCP_MAX_DEPTH';

/**
 * Bump when a patch here changes what already-installed users need, so
 * `manifestNeedsUpgrade` re-copies the seed even when `upstreamSha` is
 * unchanged. (That predicate returns false on a matching SHA, so without this a
 * patched bundle would never reach an existing install.)
 *
 * 1 = inspect depth made configurable (ceiling 24)
 * 2 = ceiling raised to 64, matching upstream's REST capture depth
 */
export const PATCH_LEVEL = 2;

/**
 * Self-contained replacement for upstream's `var MAX_DEPTH = 5;`.
 *
 * `bridge-cli.cjs` has no `envInteger` helper (mcp-server.cjs does), so the
 * same inline expression goes into both bundles rather than branching.
 *
 * Uses `Number.isFinite` rather than `|| fallback` so an explicit `0` stays `0`
 * instead of silently becoming 5 — upstream's own `envInteger` has that same
 * `||` behaviour, but depth 0 is a legitimate request. The empty-string case
 * is handled explicitly because `Number("")` is `0`, not `NaN`.
 */
const MAX_DEPTH_DECL =
  'var MAX_DEPTH = /* figma-mcp-bridge: user-configurable inspect depth */ (function () {' +
  `  var raw = String(process.env.${MAX_DEPTH_ENV} == null ? "" : process.env.${MAX_DEPTH_ENV}).trim();` +
  '  var v = raw === "" ? NaN : Number(raw);' +
  `  return Math.min(${MAX_INSPECT_DEPTH}, Math.max(0, Number.isFinite(v) ? Math.trunc(v) : ${DEFAULT_INSPECT_DEPTH}));` +
  '})();';

/**
 * Anchors are written against esbuild's CJS output shape. The `<alias>` stands
 * in for the bundler's zod variable, which has changed name across upstream
 * builds (`external_exports` today); the surrounding call shape is stable.
 */
const MAX_DEPTH_DECL_RE = /^var MAX_DEPTH = 5;$/m;

/** Matches `depth: <alias>.number().int().min(0).max(5).optional(),` — 2 occurrences. */
const SCHEMA_DEPTH_RE =
  /(\bdepth:\s*[A-Za-z_$][\w$]*\.number\(\)\.int\(\)\.min\(0\)\.max\()5(\)\.optional\(\),)/g;

/**
 * Idempotency sentinels are derived from MAX_INSPECT_DEPTH rather than written
 * literally: a hard-coded ceiling would silently stop matching the moment the
 * ceiling changes, and every patch would report "anchor not found" against an
 * already-patched bundle instead of "already patched".
 */
const SCHEMA_PATCHED_RE = new RegExp(
  String.raw`\bdepth:\s*[A-Za-z_$][\w$]*\.number\(\)\.int\(\)\.min\(0\)\.max\(${MAX_INSPECT_DEPTH}\)\.optional\(\),`,
);
const CLI_GUARD_PATCHED_RE = new RegExp(String.raw`options\.depth > ${MAX_INSPECT_DEPTH}\)`);
const CLI_HELP_PATCHED_RE = new RegExp(
  String.raw`child depth to include \(0-${MAX_INSPECT_DEPTH}\)`,
);
const CLI_ERROR_PATCHED_RE = new RegExp(
  String.raw`depth must be between 0 and ${MAX_INSPECT_DEPTH}\.`,
);

/** bridge-cli `inspect` subcommand's hand-rolled guard and help/error strings. */
const CLI_GUARD_RE = /(if \(options\.depth !== void 0 && options\.depth > )5(\))/;
const CLI_HELP_RE = /(child depth to include \(0-)5(\))/;
const CLI_ERROR_RE = /(depth must be between 0 and )5(\.)/;

/**
 * @typedef {{ name: string, anchor: string, detail: 'applied'|'already patched'|'anchor not found' }} PatchOutcome
 * @typedef {{ text: string, applied: PatchOutcome[], skipped: PatchOutcome[] }} RuntimePatchResult
 */

/**
 * Run one anchored patch.
 *
 * Idempotency uses a per-patch sentinel (`patchedRe`) rather than a shared
 * marker string: the clamp patch and the CLI patches land in the same file, so a
 * shared marker would make the CLI patches report "already patched" the moment
 * the clamp succeeded.
 *
 * @param {string} text
 * @param {string} name
 * @param {RegExp} anchorRe  regex for the upstream snippet to replace
 * @param {RegExp} patchedRe regex matching this patch's own output (idempotency)
 * @param {string} replacement uses `$1…$2`, matching both regexes' capture groups
 * @param {string} anchor human-readable form of the snippet, for reporting
 * @returns {{ text: string, outcome: PatchOutcome }}
 */
function runPatch(text, name, anchorRe, patchedRe, replacement, anchor) {
  patchedRe.lastIndex = 0;
  if (patchedRe.test(text)) {
    return { text, outcome: { name, anchor, detail: 'already patched' } };
  }
  anchorRe.lastIndex = 0;
  if (!anchorRe.test(text)) {
    return { text, outcome: { name, anchor, detail: 'anchor not found' } };
  }
  anchorRe.lastIndex = 0;
  return {
    text: text.replace(anchorRe, replacement),
    outcome: { name, anchor, detail: 'applied' },
  };
}

/**
 * Patch `mcp-server.cjs`: the runtime clamp plus the two zod schemas that
 * become the client-visible `maximum`.
 *
 * Both schemas must be lifted, or the client still rejects the higher depth for
 * one of the two tools — `inspectSelectionInputSchema` and
 * `inspectCurrentSelectionInputSchema` each carry their own `.max(5)`.
 *
 * @param {string} text
 * @returns {RuntimePatchResult}
 */
export function patchMcpServer(text) {
  const applied = [];
  const skipped = [];
  let current = text;

  const steps = [
    ['max-depth-decl', MAX_DEPTH_DECL_RE, /var MAX_DEPTH = \/\* figma-mcp-bridge/, MAX_DEPTH_DECL, 'var MAX_DEPTH = 5;'],
    [
      'inspect-depth-schema',
      SCHEMA_DEPTH_RE,
      SCHEMA_PATCHED_RE,
      `$1${MAX_INSPECT_DEPTH}$2`,
      'depth: <alias>.number().int().min(0).max(5).optional(),',
    ],
  ];

  for (const [name, anchorRe, patchedRe, replacement, anchor] of steps) {
    const result = runPatch(current, name, anchorRe, patchedRe, replacement, anchor);
    current = result.text;
    (result.outcome.detail === 'applied' ? applied : skipped).push(result.outcome);
  }

  return { text: current, applied, skipped };
}

/**
 * Patch `bridge-cli.cjs`: the runtime clamp, the `inspect` subcommand's hard
 * `depth > 5` throw, and its help/error strings.
 *
 * @param {string} text
 * @returns {RuntimePatchResult}
 */
export function patchBridgeCli(text) {
  const applied = [];
  const skipped = [];
  let current = text;

  const steps = [
    ['max-depth-decl', MAX_DEPTH_DECL_RE, /var MAX_DEPTH = \/\* figma-mcp-bridge/, MAX_DEPTH_DECL, 'var MAX_DEPTH = 5;'],
    [
      'inspect-cli-guard',
      CLI_GUARD_RE,
      CLI_GUARD_PATCHED_RE,
      `$1${MAX_INSPECT_DEPTH}$2`,
      'if (options.depth !== void 0 && options.depth > 5)',
    ],
    [
      'inspect-cli-help',
      CLI_HELP_RE,
      CLI_HELP_PATCHED_RE,
      `$1${MAX_INSPECT_DEPTH}$2`,
      '"child depth to include (0-5)"',
    ],
    [
      'inspect-cli-error',
      CLI_ERROR_RE,
      CLI_ERROR_PATCHED_RE,
      `$1${MAX_INSPECT_DEPTH}$2`,
      '"depth must be between 0 and 5."',
    ],
  ];

  for (const [name, anchorRe, patchedRe, replacement, anchor] of steps) {
    const result = runPatch(current, name, anchorRe, patchedRe, replacement, anchor);
    current = result.text;
    (result.outcome.detail === 'applied' ? applied : skipped).push(result.outcome);
  }

  return { text: current, applied, skipped };
}