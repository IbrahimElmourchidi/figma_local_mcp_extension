/**
 * Types for `tool/runtimePatches.mjs`. That module is plain `.mjs` (executed by
 * `build-runtime.mjs` under node, and excluded from both tsconfig `include` and
 * eslint), so this declaration lets the unit tests import it type-safely without
 * pulling the build scripts into the TypeScript program.
 */

export interface PatchOutcome {
  readonly name: string;
  readonly anchor: string;
  readonly detail: 'applied' | 'already patched' | 'anchor not found';
}

export interface RuntimePatchResult {
  readonly text: string;
  readonly applied: readonly PatchOutcome[];
  readonly skipped: readonly PatchOutcome[];
}

export declare const MAX_INSPECT_DEPTH: number;
export declare const DEFAULT_INSPECT_DEPTH: number;
export declare const MAX_DEPTH_ENV: string;
export declare const PATCH_LEVEL: number;

export declare function patchMcpServer(text: string): RuntimePatchResult;
export declare function patchBridgeCli(text: string): RuntimePatchResult;