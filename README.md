# Figma Local MCP Bridge

A VS Code extension for managing the local Figma MCP bridge server: server lifecycle, the Figma dev plugin, MCP tool integration for Copilot, and opencode export — all without leaving the editor.

This is a from-scratch port of the Figma Local MCP GUI Flutter desktop app, rebuilt around native VS Code UI (activity-bar tree view, status bar, output channels, commands) instead of a standalone window.

## Features

- **Bridge lifecycle** — start/stop/restart the local bridge with a health gate (status flips to Running only after `/health` returns 200), orphan-kill, multi-window adopt-external, session/uptime in the status bar.
- **MCP for Copilot** — registers an `McpServerDefinitionProvider` so agent mode gets the Figma MCP tools natively (VS Code ≥ 1.101).
- **Plugin build** — builds the Figma development plugin (`manifest.json`, `code.js`, `ui.html`, with the bridge port injected) into an extension-owned folder, ready to import into Figma; rebuilds update it in place and a sidecar `.installed.json` tracks staleness.
- **opencode export** — generate and atomically merge a `mcp["figma-mcp-free"]` entry into `opencode.json` (chmod 600; contains a plaintext bridge token — you are warned before the first write).
- **Runtime** — seeds from a VSIX-bundled `runtime-seed/` built from `superdoccimo/figma-mcp-free`; stage-and-swap, rollback, force-reinstall; optional on-device **Build from source** with verification (MCP `initialize` + `/health` 401/200) before swap.
- **System check** — Node ≥ 18, port availability/health, Figma desktop process, plugin installed.

## Requirements

- VS Code **1.101+** (native MCP support)
- Figma desktop (to import and run the development plugin)
- Node.js ≥ 18 for source builds and opencode export (bridge/MCP child processes reuse VS Code's own Node via `ELECTRON_RUN_AS_NODE`)

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `figmaMcpBridge.port` | `3845` | Bridge listen port (must match plugin `devAllowedDomains`) |
| `figmaMcpBridge.host` | `127.0.0.1` | Bind address: `127.0.0.1`, `localhost`, or `::1` |
| `figmaMcpBridge.autoStart` | `false` | Start the bridge on activation |
| `figmaMcpBridge.mcpServerPath` | `""` | Custom `mcp-server.cjs` path |
| `figmaMcpBridge.nodePath` | `""` | Real Node.js for source builds / server fallback |
| `figmaMcpBridge.opencodeNodePath` | `""` | Node written into exported `opencode.json` |
| `figmaMcpBridge.figmaPluginId` | `""` | Override plugin manifest `id` |
| `figmaMcpBridge.autoCheckUpdates` | `true` | Check upstream SHA on activation |

Secrets (pairing password, Figma token) live in VS Code Secret Storage — never in settings or argv.

## Commands

Open the **Figma MCP** activity-bar icon for the dashboard tree (Bridge / MCP / Plugin / Runtime / System). Title-bar and context-menu actions cover start/stop/restart, test connection, build plugin, build from source, rollback, and system check. Palette-visible commands use the `Figma MCP:` prefix.

## Loading the plugin into Figma

Figma desktop does not pick up plugins from a folder — development plugins are imported once by manifest path:

1. Run **Build Figma Plugin** (Plugin section of the tree, or the Command Palette). It prints the path of the built `manifest.json`; use **Copy manifest path** to put it on the clipboard.
2. In Figma desktop: **Plugins → Development → Import plugin from manifest…** and select that file (in the Linux/macOS file dialog, press `Ctrl+L` / `Cmd+Shift+G` and paste the path).
3. Run it from **Plugins → Development**. Keep the pre-filled bridge URL (`http://localhost:<port>`) and paste the pairing token (**Copy token** in the Bridge section of the tree).
4. Later rebuilds (port change, runtime update) overwrite the same folder and keep the manifest `id`, so Figma picks up the new files without re-importing.

The manifest lists only `http://localhost:<port>` in `devAllowedDomains`: Figma rejects IP literals such as `127.0.0.1` there (the plugin then shows "Manifest issue" and won't run). The plugin iframe's CSP is built from that list, so inside Figma the bridge must be addressed as `localhost`, not `127.0.0.1`.

## Security notes

- The bridge token is passed only via `FIGMA_PLUGIN_BRIDGE_TOKEN` (never argv).
- `opencode.json` is written with mode `600` on POSIX and contains the bridge token in plaintext by design.
- Runtime `runtime.json` files are SHA-256 verified hard-fail before stage-and-swap.

## Development

```bash
npm install
npm run watch          # esbuild --watch; or press F5 → Extension Development Host
npm run lint
npm run check-types
npm test               # unit (vitest) + integration (@vscode/test-cli)
npm run sync-runtime   # rebuild runtime-seed/ from superdoccimo/figma-mcp-free
npx @vscode/vsce package
```

### Runtime seed

`runtime-seed/` is a committed build artifact (bridge + MCP + plugin + `runtime.json`). Refresh it with:

```bash
npm run sync-runtime
# or pin a ref:
node tool/build-runtime.mjs --ref <sha>
```

The script downloads upstream source, builds with pnpm, bundles with esbuild (CJS), hard-fails on missing plugin files, writes per-file SHA-256s, and smoke-verifies (MCP `initialize` + `/health` 401/200).

## License

MIT — see the `LICENSE` file.
