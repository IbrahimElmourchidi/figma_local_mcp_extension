# Changelog

All notable changes to the "Figma MCP Bridge" extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- Project scaffolding: esbuild bundling, ESLint, TypeScript, unit (vitest) and integration (`@vscode/test-cli`) test harnesses, F5 debug launch.
- Configuration schema for port, host, autoStart, mcpServerPath, nodePath, opencodeNodePath, figmaPluginId, autoCheckUpdates.
- Secret storage for the bridge pairing password and Figma token, with commands to set/regenerate/clear them.
- **Phase 0:** `tool/build-runtime.mjs` builds `runtime-seed/` from `superdoccimo/figma-mcp-free` (pnpm + esbuild CJS, hard-fail on missing plugin files, SHA-256 manifest, MCP/`/health` smoke verify). Seed committed for offline packaging.
- **Phase 1:** core primitives (`paths`, `errors` + `BridgeError`/`runCommand`, streamed `exec`, download with retry/sha256, zip/tar.gz archive with traversal/symlink guards, cross-process `mkdir` lock, GitHub `resolveRef`); `RuntimeStore` with sha-compared seed upgrade, hard-fail verification, stage-and-swap, rollback, force-reinstall; `NodeResolver` tiers (Electron → override → system → managed).
- **Phase 2:** `BridgeService` with health gate, adopt-external (multi-window), orphan kill, session parse, 100-line log ring; activity-bar tree view (Bridge/MCP/Plugin/Runtime/System), status bar, OutputChannels; IPv6 URL bracketing; config validation; `autoStart` + `deactivate()` cleanup.
- **Phase 3:** native `McpServerDefinitionProvider` (VS Code ≥ 1.101) with resolve-time bridge start + token injection; opencode config generate/merge/write (chmod 600, prompt before first write); `PluginManager` with port injection and `.installed.json` sidecar; `SystemChecker` (Node/port/Figma/plugin).
- **Phase 4:** `SourceBuilder` on-device build-from-source (codeload → pnpm → esbuild → plugin → manifest → verify → stage-and-swap), cancellable with progress + Build output channel; runtime update check vs upstream `main`; rollback/reinstall commands.
- **Phase 5:** unit tests for archive guards, manifest compare, opencode merge, config validation, lock contention, node tiers, IPv6 URL, state store; integration tests for command registration, view, and MCP provider contribution; lint scope includes `test/`; Extension Tests launch config; README + this changelog; clear-logs command; optional-path settings validation; MIT LICENSE; extension icon; activation update-prompt wiring to Build from source.
