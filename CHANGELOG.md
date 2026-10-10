# Changelog

All notable changes to the "Figma MCP Bridge" extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.3.0] - 2026-10-10

### Added

- `figmaMcpBridge.maxDepth` (1–64, default 5) to raise the Figma inspect tools' node-tree depth ceiling. Upstream hard-codes this at 5 in three places and publishes it to MCP clients as a JSON-Schema `maximum`, so clients reject a deeper `inspect_selection` before the server is even asked — the setting could not be worked around from the client side. The ceiling matches upstream's REST capture depth (64) so it can never exceed how deeply the bridge captured the selection. Implemented as anchored build-time patches in `tool/runtimePatches.mjs` that make the limit read `FIGMA_MCP_MAX_DEPTH`, so changing the setting only updates the spawned server's environment — no rebuild, and the change applies on the next MCP server start.
- Cost warnings for the setting: an inline Settings description, a modal confirmation above the default (with an explicit revert, since the value is already persisted when the prompt appears), and a Runtime tree row showing the effective value. Warnings cover the `maxChildren × depth` blowup, that `inspect_selection` sends the depth to the Figma REST API too, and that oversized responses can be truncated or rejected.
- The Runtime tree surfaces skipped build patches, so an upstream refactor that silently disables `maxDepth` is visible instead of looking like a no-op setting.

### Changed

- `runtime.json` now records `patchLevel` and a per-file patch summary. `manifestNeedsUpgrade` treats a newer `patchLevel` as an upgrade even at an identical `upstreamSha`; without this the matching-sha short-circuit meant patched bundles never reached already-installed extensions.
- The MCP server definition's version now folds in `patchLevel` and `maxDepth` alongside the upstream SHA, so changing the depth actually restarts the server instead of leaving a live one that never receives the new value.

### Fixed

- Build-patch idempotency sentinels are derived from the configured ceiling rather than hardcoded, so raising the ceiling no longer made every patch misreport `anchor not found` against an already-patched bundle — which would have looked like upstream drift and prompted a rebuild that could not have fixed it.

## [0.2.0] - 2026-09-23

### Added

- Multi-agent MCP config support: Connect AI Agent / Preview Config / Update Connected Agents commands covering Copilot, Claude Code, Gemini CLI, Codex, opencode, Kilo Code, Cline, and more.
- Project scaffolding: esbuild bundling, ESLint, TypeScript, unit (vitest) and integration (`@vscode/test-cli`) test harnesses, F5 debug launch.
- Configuration schema for port, host, autoStart, mcpServerPath, nodePath, opencodeNodePath, figmaPluginId, autoCheckUpdates.
- Secret storage for the bridge pairing password and Figma token, with commands to set/regenerate/clear them.
- **Phase 0:** `tool/build-runtime.mjs` builds `runtime-seed/` from `superdoccimo/figma-mcp-free` (pnpm + esbuild CJS, hard-fail on missing plugin files, SHA-256 manifest, MCP/`/health` smoke verify). Seed committed for offline packaging.
- **Phase 1:** core primitives (`paths`, `errors` + `BridgeError`/`runCommand`, streamed `exec`, download with retry/sha256, zip/tar.gz archive with traversal/symlink guards, cross-process `mkdir` lock, GitHub `resolveRef`); `RuntimeStore` with sha-compared seed upgrade, hard-fail verification, stage-and-swap, rollback, force-reinstall; `NodeResolver` tiers (Electron → override → system → managed).
- **Phase 2:** `BridgeService` with health gate, adopt-external (multi-window), orphan kill, session parse, 100-line log ring; activity-bar tree view (Bridge/MCP/Plugin/Runtime/System), status bar, OutputChannels; IPv6 URL bracketing; config validation; `autoStart` + `deactivate()` cleanup.
- **Phase 3:** native `McpServerDefinitionProvider` (VS Code ≥ 1.101) with resolve-time bridge start + token injection; opencode config generate/merge/write (chmod 600, prompt before first write); `PluginManager` with port injection and `.installed.json` sidecar; `SystemChecker` (Node/port/Figma/plugin).
- **Phase 4:** `SourceBuilder` on-device build-from-source (codeload → pnpm → esbuild → plugin → manifest → verify → stage-and-swap), cancellable with progress + Build output channel; runtime update check vs upstream `main`; rollback/reinstall commands.
- **Phase 5:** unit tests for archive guards, manifest compare, opencode merge, config validation, lock contention, node tiers, IPv6 URL, state store; integration tests for command registration, view, and MCP provider contribution; lint scope includes `test/`; Extension Tests launch config; README + this changelog; clear-logs command; optional-path settings validation; MIT LICENSE; extension icon; activation update-prompt wiring to Build from source.
