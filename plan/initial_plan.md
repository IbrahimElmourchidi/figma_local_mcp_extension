# Revised Plan — Figma MCP Bridge VS Code Extension

## Context

[figma-mcp-vscode-extension](.) is a port of the Flutter desktop app at
`../figma_local_mcp_gui`. Today it is scaffolding only: ~155 lines across
[extension.ts](src/extension.ts), [constants.ts](src/constants.ts),
[bridgeConfig.ts](src/config/bridgeConfig.ts), [secretsStore.ts](src/config/secretsStore.ts),
[secretsCommands.ts](src/commands/secretsCommands.ts), [bridgeUrl.ts](src/util/bridgeUrl.ts).
esbuild bundles to `dist/extension.js`; vitest covers unit, `@vscode/test-cli` covers integration.

The extension must manage: a local Figma bridge HTTP server, an MCP server, the Figma dev
plugin, and opencode integration — everything the Flutter app does, but idiomatic to VS Code.

**What changed from the reviewed plan** (decisions made during review):

| Area | Original plan | Revised |
|---|---|---|
| Runtime source | Download `runtime-latest` from `IbrahimElmourchidi/figma_mcp_local_gui` | That repo is being deleted. Sole upstream is `superdoccimo/figma-mcp-free`. Runtime comes from a VSIX-bundled seed built by our own script, refreshed by on-device source build. |
| UI | 4 webview pages mirroring the Flutter nav rail | Native only — TreeView, StatusBar, OutputChannel, QuickPick, native Settings UI |
| MCP | Self-spawn `node mcp-server.cjs` | `McpServerDefinitionProvider` (VS Code 1.101+) so Copilot agent mode actually gets the tools; opencode export stays separate |
| Node | Download pinned v24.21.0 on first run (~50MB) | Reuse VS Code's own Node via `ELECTRON_RUN_AS_NODE`; download only when a source build needs real Node |
| Update services | `runtimeUpdateService` + `updateService` (GitHub releases) | Both deleted — no release repo exists. Update check = compare installed sha vs upstream `main`, apply via source build |
| Error model | Port Flutter's `Result<T>`/`AppFailure`/`guardResult` | Small `BridgeError extends Error { code }` + a `runCommand()` boundary |

Net effect: ~22 source files instead of ~30, two whole services deleted, six webview files
never written — and build-from-source promoted from a Phase 4 afterthought to the backbone of
runtime provisioning.

---

## Review of the original plan — what was wrong

**Fatal, given the repo deletion**

1. Every runtime path routed through `IbrahimElmourchidi/figma_mcp_local_gui` releases. With that
   repo gone, first-run install, update check, and rollback all have no source. The build script
   + bundled seed replaces all three.

**Design problems that survived from the Flutter app**

2. **Self-spawning the MCP server is near-pointless.** `mcp_service.dart:` spawns
   `node mcp-server.cjs` over stdio with nothing attached to stdin. It idles. VS Code's
   `McpServerDefinitionProvider` is the real integration.
3. **No health gate on start.** Flutter flips status to `running` the moment `Process.start`
   returns; a bridge that dies during bind reports Running until the exit stream fires.
4. **`ensureInstalled` never version-compares** (`runtime_installer.dart`) — it only checks for
   *presence*. A newer seed shipped in a new VSIX would never replace an installed runtime.
5. **Checksums soft-fail in two places** — node `SHASUMS256.txt` unreachable → skipped;
   runtime `.sha256` mismatch → caught and logged only.
6. **Plugin staleness check is wrong** — hashes the port-injected installed manifest against the
   template, so it reports stale whenever port ≠ 3845 or a plugin id is set.
7. **Bootstrap is dead code.** `BootstrapService.run()` is never invoked; `main.dart`'s
   `_bootstrap()` is an empty post-frame callback. The plan proposed porting an unexercised path.

**Problems specific to the VS Code model that the plan missed entirely**

8. **Multi-window.** One extension host *per window*. Two windows = two activations = two bridges
   racing for port 3845. The Flutter app is single-instance and has no answer for this.
9. **Packaging trap.** [.vscodeignore](.vscodeignore) excludes `src/**` and `**/*.ts`, so
   anything under `src/ui/webview/` is silently dropped from the VSIX — and [esbuild.js](esbuild.js)
   has a single entry, so webview scripts would never be built. (Moot now, but the same trap
   applies to `runtime-seed/`, which must be explicitly *un*-ignored.)
10. **Settings duplication.** A webview settings form re-implements `contributes.configuration`,
    which already exists and gives sync, per-workspace scope, and search for free.
11. **`deactivate()` has a short async budget** — spawned children can outlive the host.
12. **IPv6 bug already in tree:** [bridgeUrl.ts](src/util/bridgeUrl.ts) returns `http://::1:3845`
    for the `::1` host, which is an allowed value of `figmaMcpBridge.host`.

**Scope/sequencing**

13. ~25 commands would flood the palette. Most must be `when: false` in `commandPalette` and
    surfaced only via view title/context menus.
14. Phase 3 (UI) was called "largest". Going native makes it one of the smallest.

---

## Architecture

```
src/
  extension.ts            activate/deactivate, wiring, disposables
  constants.ts            upstream repo, pinned pnpm/esbuild, paths, defaults
  errors.ts               BridgeError { code }, runCommand() boundary
  core/
    paths.ts              globalStorage layout
    exec.ts               spawn + streamed output + timeout + CancellationToken
    download.ts           https → file, progress, retry, sha256
    archive.ts            tar.gz + zip extraction, traversal/symlink guards
    lock.ts               cross-process lockfile
    github.ts             resolveRef(ref) → { sha, committedAt }
  config/
    bridgeConfig.ts       + validation (port range, host enum, path existence)
    secretsStore.ts       existing
  services/
    nodeResolver.ts       electron → override → system → managed
    runtimeStore.ts       seed, manifest, stage-and-swap, rollback, health
    sourceBuilder.ts      download → pnpm → build → esbuild → plugin → verify → swap
    runtimeVerifier.ts    MCP initialize + bridge /health 401/200 smoke test
    bridgeService.ts      spawn, health gate, adopt-external, orphan kill, log ring
    mcpProvider.ts        McpServerDefinitionProvider
    opencodeConfig.ts     generate + atomic merge write
    pluginManager.ts      install/uninstall/open, port + id injection
    systemChecker.ts      node / port / Figma / plugin checks
    state.ts              EventEmitter snapshot store
  ui/
    treeView.ts           single TreeDataProvider, 5 sections
    statusBar.ts
    output.ts             "Figma MCP Bridge" + "…: Build" channels
  commands/
    index.ts              registration + when-clause wiring
    secretsCommands.ts    existing
tool/
  build-runtime.mjs       dev/CI: upstream → runtime-seed/
runtime-seed/             committed build artifact, shipped in the VSIX
```

**Data dir** = `context.globalStorageUri.fsPath` — no per-platform branching, auto-removed on
uninstall. Layout: `runtime/`, `runtime.previous/`, `runtime-staging/`, `node/`, `build/`, `locks/`.

**State flow**: services own state → push snapshots into `state.ts` → `treeView` and `statusBar`
subscribe. One direction, no drift.

**Secrets never leave the host.** Copy actions call `vscode.env.clipboard.writeText()` from a
command; the token is never rendered. `opencode.json` is written `0600` on POSIX with an explicit
warning that it contains a plaintext token.

---

## Phase 0 — Build pipeline and seed (the "build from source" foundation)

This is the direct answer to *"build the server and the figma plugin from
superdoccimo/figma-mcp-free"*, delivered first and reused by Phase 4.

Port `../figma_local_mcp_gui/tool/build_runtime_bundle.sh` and the build/verify steps of
`.github/workflows/runtime-sync.yml` into **`tool/build-runtime.mjs`** (Node, no bash, so it runs
on Windows too):

1. Resolve ref: `GET https://api.github.com/repos/superdoccimo/figma-mcp-free/commits/main`,
   or a CLI-supplied sha/tag/branch.
2. `git clone --depth 1` (or codeload tarball) → temp dir.
3. `pnpm install --frozen-lockfile` then `pnpm -r run build` using ambient toolchain.
4. esbuild each entry — **CJS, not ESM**, preserving the upstream comment's reason: esbuild's ESM
   output shims `require()` in a way that breaks commander's dynamic `require("node:events")`.
   - `packages/mcp-server/dist/index.js` → `mcp-server.cjs`
   - `packages/cli/dist/bridge-cli.js` → `bridge-cli.cjs`
   - flags: `--bundle --platform=node --format=cjs --target=node18`
5. Copy `plugins/local-bridge/{code.js,ui.html,manifest.template.json}` → `plugin/`.
   **Hard-fail on any missing file** — the bash script skips silently, which lets a broken bundle
   look valid.
6. Write `VERSION` (the sha) and `runtime.json`:
   `{schema:1, upstreamRepo, upstreamSha, upstreamCommittedAt, builtAt, builtBy, esbuildVersion, nodeTarget, files:{path→sha256}}`.
   Use the *resolved* sha — the bash script's `git rev-parse` returns `unknown` on a tarball.
7. **Verify before emitting** (ported from `runtime-sync.yml`, the highest-value piece):
   - pipe `{"jsonrpc":"2.0","id":1,"method":"initialize",…}` into `mcp-server.cjs`, require `"result"`
   - start `bridge-cli.cjs serve --port 18845 --token …`, poll until listening, assert
     `/health` → **401** unauthenticated and **200** with `Authorization: Bearer`
8. Emit to `runtime-seed/`.

Also in this phase:
- Commit `runtime-seed/` so `npm run package` works offline and reproducibly.
- `.vscodeignore`: explicitly keep `runtime-seed/**` (nothing under `src/`).
- `npm run sync-runtime` script; optional CI job to open a PR when upstream moves.
- Rewrite [constants.ts](src/constants.ts): drop `GITHUB_OWNER`/`GITHUB_REPO`/`RUNTIME_RELEASE_TAG`,
  keep `UPSTREAM_OWNER`/`UPSTREAM_REPO`, add pinned pnpm `9.15.9` and esbuild `0.28.2`.

## Phase 1 — Core primitives + runtime store

1. `paths.ts`, `errors.ts`, `exec.ts`, `download.ts`, `archive.ts`, `lock.ts`, `github.ts`.
   - `archive.ts`: use `fflate` (zip + gunzip) plus a small tar reader — no shelling to `tar`,
     which the Flutter builder does. Use Node's `.tar.gz` dist rather than `.tar.xz` so no xz
     decoder is needed. Guards: reject `..`, absolute paths, and symlink entries.
   - `exec.ts`: `spawn` with streamed stdout/stderr into an OutputChannel. **Not `exec`** — pnpm
     install output exceeds the 1MB default `maxBuffer`. Timeout + `CancellationToken`.
2. `runtimeStore.ts`: seed from `runtime-seed/` on activation, **comparing
   `runtime.json.upstreamSha` and falling back to `VERSION`** so a newer VSIX actually upgrades
   (fixes review item 4). Per-file SHA-256 verification is a **hard** failure (item 5).
   Stage-and-swap via `runtime.previous`, plus `rollback()` and `forceReinstall()`.
3. `lock.ts`: cross-process lockfile around every runtime mutation. The Flutter mutex is
   in-process only and cannot survive two VS Code windows (item 8). Use `fs.mkdir` (atomic on all
   platforms) with a pid + timestamp and a stale-lock timeout.
4. `nodeResolver.ts`, tiers in order:
   - **0 — VS Code's own Node**: `process.execPath` + `env.ELECTRON_RUN_AS_NODE=1`, for spawning
     bridge/MCP only. This is the documented pattern, not a trick — `@types/vscode`
     `index.d.ts:20442` states *"Node.js-based servers may use `process.execPath` to use the
     editor's version of Node.js to run the script."* Still spike it against `bridge-cli.cjs` in
     Phase 1, since that docstring covers the MCP server case specifically.
   - 1 — `figmaMcpBridge.nodePath` override
   - 2 — system discovery (PATH, nvm/fnm/volta/asdf, Homebrew, Program Files)
   - 3 — managed download of pinned Node, **only on demand for a source build**, behind a
     confirmation naming the ~50MB cost. Do **not** copy Flutter's Windows extraction predicate
     (`!filename.contains('/')`) — it never matches Node's zip layout.
   - Real Node (tiers 1–3) is required for source builds and for `opencode.json`, which already
     has the `opencodeNodePath` setting for exactly this reason.
5. Unit tests: manifest compare, archive traversal guards, lock contention, node tier order.

## Phase 2 — Bridge lifecycle + native UI shell

1. `bridgeService.ts`:
   - spawn `node bridge-cli.cjs serve --host H --port P`, token **only** via
     `FIGMA_PLUGIN_BRIDGE_TOKEN` (never argv — upstream's own rule)
   - **health gate**: poll `GET /health` with the bearer token before reporting Running (item 3)
   - **adopt-external**: if a healthy bridge already answers on the port with our token, mark
     `running (external)` instead of spawning — this is the multi-window answer (item 8).
     Stop/restart on an adopted server is disabled; only "Kill orphans" acts on it.
   - orphan kill (`lsof`/`netstat` + cmdline match, as Flutter does), uptime, session-id parse
     from stdout, 100-line log ring → OutputChannel
2. `ui/output.ts`, `ui/statusBar.ts`, `ui/treeView.ts` (one TreeDataProvider, sections: Bridge,
   MCP, Plugin, Runtime, System; inline icon actions via `contributes.menus` `view/item/context`).
3. Activity-bar `viewsContainers` + `views` in package.json.
4. Wire `autoStart`; implement `deactivate()` to kill children synchronously where possible, and
   rely on orphan-kill at next start as the backstop (item 11).
5. Fix [bridgeUrl.ts](src/util/bridgeUrl.ts) to bracket IPv6 (item 12). Add validation to
   [bridgeConfig.ts](src/config/bridgeConfig.ts) — the comment in
   [extension.ts](src/extension.ts) claims malformed settings surface at activation, but
   `cfg.get` only substitutes defaults for *absent* keys.

## Phase 3 — MCP + plugin + opencode (closes the end-to-end loop)

1. **`mcpProvider.ts`** — API shape verified against the already-installed
   `@types/vscode@1.138.0` (`index.d.ts:20430-20555, 20846`):

   ```ts
   // package.json
   "contributes": { "mcpServerDefinitionProviders": [
     { "id": "figmaMcpBridge.servers", "label": "Figma MCP Bridge" } ] }

   vscode.lm.registerMcpServerDefinitionProvider('figmaMcpBridge.servers', {
     onDidChangeMcpServerDefinitions: emitter.event,
     provideMcpServerDefinitions: () => [ new vscode.McpStdioServerDefinition(
       'Figma MCP Bridge', nodeCommand, [mcpServerPath], env, runtimeSha) ],
     resolveMcpServerDefinition: async (server) => { /* ensure bridge up, inject token */ },
   });
   ```

   - The contributed `id` must match the `registerMcpServerDefinitionProvider` argument.
   - `provideMcpServerDefinitions` is called **eagerly** and must not prompt or do work with side
     effects. Put "start the bridge if needed" and token injection in
     `resolveMcpServerDefinition`, which is explicitly the place user interaction is allowed.
   - `McpStdioServerDefinition(label, command, args?, env?, version?)`; `env` is
     `Record<string, string | number | null>`. Set `version` to the runtime sha — VS Code uses it
     to prompt for a tool refresh when it changes.
   - Fire `onDidChangeMcpServerDefinitions` when port, token, or runtime changes.
   - `engines.vscode` must still be bumped to `^1.101.0` (the installed typings are only a dev
     concern; `engines` is the runtime floor). `@types/vscode` already resolves to 1.138.0.
   - Bridge URL must follow `config.host`, not hardcode `127.0.0.1` as Flutter does.
2. `opencodeConfig.ts`: same JSON shape as Flutter (`$schema`, `mcp["figma-mcp-free"]` with
   `type: local`, `command`, `environment`, `enabled`), atomic temp+rename merge into
   `%APPDATA%\opencode\opencode.json` / `$XDG_CONFIG_HOME/opencode/opencode.json` /
   `~/.config/opencode/opencode.json`. Prompt before first write to another app's config; chmod 600.
3. `pluginManager.ts`: detect the Figma Development dir, install to `figma-mcp-free/` with port
   injected into `manifest.json` `networkAccess.devAllowedDomains` and into `ui.html`, uninstall,
   open folder. Replace Flutter's broken staleness hash with a sidecar
   `.installed.json` = `{runtimeSha, port, pluginId}` (item 6).
4. `systemChecker.ts` → Node ≥18, port/health, Figma process, plugin present.
5. Commands + `when` clauses; most `when: false` in `commandPalette` (item 13).

## Phase 4 — On-device build from source

`sourceBuilder.ts` — the runtime-update path, replacing the deleted release-polling services.
Same 8 steps as Phase 0, but fully self-contained (downloads its own pnpm and esbuild) and driven
from `withProgress({location: Notification, cancellable: true})` with logs streaming to the Build
output channel.

Differences from Phase 0 and fixes to the Flutter implementation:

- Requires real Node (tier 1–3); offers the managed download if none found.
- `pnpm` from `https://registry.npmjs.org/pnpm/-/pnpm-<v>.tgz` → `package/dist/pnpm.cjs`.
  Read upstream's `packageManager` field to pick the version; fall back to `9.15.9`.
- `esbuild` from `https://registry.npmjs.org/@esbuild/<os>-<arch>/-/<os>-<arch>-0.28.2.tgz`.
  Binary is `package/bin/esbuild` on POSIX but **`package/esbuild.exe` on win32** — the Flutter
  path is hardcoded and broken on Windows. `chmod 755` on POSIX.
- Drop `--frozen-lockfile` if no `pnpm-lock.yaml` is present.
- Preflight: disk space (~500MB for `node_modules`), network, existing lock.
- Resolve entry points defensively: try `packages/mcp-server/dist/index.js` and
  `packages/cli/dist/bridge-cli.js`, else read `packages/*/package.json` `main`/`bin`, else fail
  with "upstream layout changed" rather than an opaque esbuild error.
- **Run `runtimeVerifier.ts` on the staged output before stage-and-swap** — never swap in a
  bundle that fails the MCP `initialize` or `/health` 401/200 checks.
- Stop bridge + MCP before the swap; restart after.

Update check: `resolveRef('main')` vs installed `runtime.json.upstreamSha`; when they differ,
offer "Build from source". Rollback command restores `runtime.previous`.

## Phase 5 — Polish, tests, packaging

1. Validation (port 1–65535, password 32–512, host enum), settings-change listener.
2. Uptime/session in the status bar tooltip; clear-log command.
3. Tests: unit (vitest) for archive guards, manifest compare, opencode merge, config validation,
   bridge arg/env construction, IPv6 URL; integration (`@vscode/test-cli`) for activation, command
   registration, tree provider. Add `test/` to the lint scope and an "Extension Tests"
   launch config — both are missing today.
4. README/CHANGELOG, LICENSE, extension icon, `vsce package`.

---

## Risks

| Risk | Mitigation |
|---|---|
| `ELECTRON_RUN_AS_NODE` doesn't work for the bridge | Spike in Phase 1 before building on it; tiers 1–3 remain the fallback |
| Upstream repo layout changes | Defensive entry-point resolution + explicit "upstream layout changed" error; seed in the VSIX keeps the extension working regardless |
| Two VS Code windows | Adopt-external on health probe; cross-process lockfile on runtime mutations |
| Source build is slow/heavy | On demand only, confirm dialog, cancellable, progress + streamed logs, disk precheck |
| Swapping a runtime that a process holds open | Stop bridge + MCP before swap; verify staged bundle first; `runtime.previous` rollback |
| Plaintext token in `opencode.json` | Prompt on first write, chmod 600, state the tradeoff in README |
| Engine floor `^1.101.0` excludes older VS Code | Deliberate — accepted for native MCP support |

## Verification

1. `npm run sync-runtime` → `runtime-seed/` populated; `runtime.json` files map matches on-disk
   hashes; the smoke test passes (MCP `initialize` returns `result`; `/health` 401 then 200).
2. `npm run compile && npm test` — unit + integration green.
3. F5 → Extension Development Host. Runtime seeds into globalStorage on first activation with no
   network. Tree shows Bridge/MCP/Plugin/Runtime/System.
4. Start bridge → status flips to Running only after `/health` returns 200. `curl` `/health`
   without the token → 401, with it → 200.
5. Open a **second** VS Code window → it reports `running (external)` rather than failing to bind.
6. Install plugin → `~/.config/figma/Development/figma-mcp-free/manifest.json` has
   `devAllowedDomains` matching the configured port. Load it in Figma desktop and test connection.
7. Copilot agent mode lists the Figma MCP tools (Phase 3 gate). `Configure opencode` writes a
   valid merged `opencode.json` at mode 600 without clobbering other `mcp` entries.
8. Run **Build from source** → progress + streamed logs, cancellable; verifier passes; runtime sha
   updates in the tree; then **Rollback** restores the previous runtime.
9. Kill the bridge externally → status reconciles. Reload window → no orphaned node processes.
10. `vsce package` → VSIX contains `dist/extension.js` + `runtime-seed/**` and no `src/`.

## Open items to confirm during implementation

- Whether `ELECTRON_RUN_AS_NODE` runs `bridge-cli.cjs` cleanly (spike, Phase 1). The MCP-server
  case is documented; the bridge is not.
- Whether `superdoccimo/figma-mcp-free` still has `plugins/local-bridge/` and the two
  `packages/*/dist` entry points at the ref being built. (The Flutter
  `tool/build_runtime_bundle.sh` asserts this layout and its CI ran daily, so it was correct as of
  that repo's last green run — but it is the one external dependency left, so Phase 0 must fail
  loudly rather than silently skip, which is what the bash version does.)
