import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { ENV_BRIDGE_TOKEN, ENV_BRIDGE_URL, ENV_FIGMA_TOKEN } from '../constants';
import { bridgeUrl } from '../util/bridgeUrl';
import {
  AGENT_TARGETS,
  AgentEnv,
  AgentTarget,
  MCP_SERVER_KEY,
  McpLaunchSpec,
  defaultAgentEnv,
  findAgentTarget,
  genericSnippet,
  writeAgentConfig,
} from '../services/agentConfigs';
import type { CommandDeps } from './index';

const CONFIGURED_KEY = 'figmaMcpBridge.configuredAgents';
const OTHER_ID = '__other__';

type Reg = (id: string, fn: (...args: unknown[]) => unknown, label?: string) => void;

/**
 * "Connect AI agent…": writes the Figma MCP entry into the config of any
 * supported agent (Claude Code, Gemini CLI, Codex, opencode, Kilo, Cline, …).
 * Remembered targets are rewritten when the bridge token changes.
 */
export function registerAgentCommands(deps: CommandDeps, reg: Reg): void {
  const agentEnv = (): AgentEnv => defaultAgentEnv(path.dirname(deps.context.globalStorageUri.fsPath));

  const configure = async (preselect?: string) => {
    const env = agentEnv();
    const picked = preselect ? [preselect] : await pickAgents(env, true);
    if (!picked || picked.length === 0) {
      return;
    }
    const spec = await buildSpec(deps, { persistLauncher: true });

    if (picked.includes(OTHER_ID)) {
      await vscode.env.clipboard.writeText(genericSnippet(spec.spec));
      void vscode.window.showInformationMessage(
        'Generic MCP config copied (contains your bridge token). Paste it into your agent\'s MCP settings.',
      );
    }
    const targets = picked.map(findAgentTarget).filter((t): t is AgentTarget => !!t);
    if (targets.length === 0) {
      return;
    }

    const files = targets.map((t) => `• ${t.label}: ${safePath(t, env)}`).join('\n');
    const confirm = await vscode.window.showWarningMessage(
      'Add the Figma MCP server to these agents?',
      { modal: true, detail: `${files}\n\nThe entry contains your bridge token in plaintext (files are chmod 600).` },
      'Write',
    );
    if (confirm !== 'Write') {
      return;
    }

    const results = await writeAll(targets, spec.spec, env, deps);
    await remember(deps, results.filter((r) => r.ok).map((r) => r.target.id));
    report(results, spec.usesVsCodeBinary);
  };

  reg('figmaMcpBridge.configureAgent', () => configure(), 'Connect AI agent');
  // Kept for existing keybindings / tree items.
  reg('figmaMcpBridge.configureOpencode', () => configure('opencode'), 'Configure opencode');

  const preview = async (preselect?: string) => {
    const env = agentEnv();
    const id = preselect ?? (await pickAgents(env, false))?.[0];
    if (!id) {
      return;
    }
    const { spec } = await buildSpec(deps, { persistLauncher: false });
    const target = findAgentTarget(id);
    const content = target ? target.render(null, spec) : genericSnippet(spec);
    const doc = await vscode.workspace.openTextDocument({
      content,
      language: target?.id === 'codex' ? 'toml' : 'json',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  };

  reg('figmaMcpBridge.previewAgentConfig', () => preview(), 'Preview agent config');
  reg('figmaMcpBridge.previewOpencodeConfig', () => preview('opencode'), 'Preview opencode config');

  reg('figmaMcpBridge.refreshAgentConfigs', async (arg?: unknown) => {
    const ids = deps.context.globalState.get<string[]>(CONFIGURED_KEY, []);
    const targets = ids.map(findAgentTarget).filter((t): t is AgentTarget => !!t);
    const quiet = typeof arg === 'object' && arg !== null && (arg as { quiet?: boolean }).quiet === true;
    if (targets.length === 0) {
      if (!quiet) {
        void vscode.window.showInformationMessage('No agents connected yet — run "Connect AI agent…" first.');
      }
      return;
    }
    const { spec, usesVsCodeBinary } = await buildSpec(deps, { persistLauncher: true });
    report(await writeAll(targets, spec, agentEnv(), deps), usesVsCodeBinary);
  }, 'Update connected agents');
}

async function pickAgents(env: AgentEnv, many: boolean): Promise<string[] | undefined> {
  type Item = vscode.QuickPickItem & { id: string };
  const items: Item[] = AGENT_TARGETS.map((t) => {
    const detected = safeDetect(t, env);
    return {
      id: t.id,
      label: t.label,
      description: detected ? '$(check) detected' : undefined,
      detail: t.detail,
      picked: many && detected,
      detected,
    };
  })
    .sort((a, b) => Number(b.detected) - Number(a.detected))
    .map(({ detected: _d, ...item }) => item);
  items.push({
    id: OTHER_ID,
    label: 'Other agent…',
    detail: 'Copy a generic `mcpServers` JSON snippet to the clipboard',
  });

  if (many) {
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: 'Connect Figma MCP to AI agents',
      placeHolder: 'Select the agents to configure (detected ones are preselected)',
    });
    return picked?.map((p) => p.id);
  }
  const picked = await vscode.window.showQuickPick(items, { title: 'Preview Figma MCP config for…' });
  return picked ? [picked.id] : undefined;
}

interface WriteResult {
  readonly target: AgentTarget;
  readonly ok: boolean;
  readonly where?: string;
  readonly error?: string;
}

async function writeAll(
  targets: readonly AgentTarget[],
  spec: McpLaunchSpec,
  env: AgentEnv,
  deps: CommandDeps,
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  for (const target of targets) {
    try {
      const where = (await tryCli(target, spec)) ?? writeAgentConfig(target, spec, env);
      deps.output.appendBridge(`Agent config: ${target.label} → ${where}`);
      results.push({ target, ok: true, where });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.output.appendBridge(`[WARN] Agent config: ${target.label} failed: ${message}`);
      results.push({ target, ok: false, error: message });
    }
  }
  return results;
}

/**
 * Prefer the agent's own CLI (it owns its config file and may rewrite it while
 * running). Returns null when the CLI is unavailable, so the caller edits the file.
 */
async function tryCli(target: AgentTarget, spec: McpLaunchSpec): Promise<string | null> {
  if (!target.cli) {
    return null;
  }
  const { command, args } = target.cli(spec);
  // add-json refuses to overwrite; remove any previous entry first.
  await run(command, ['mcp', 'remove', '--scope', 'user', MCP_SERVER_KEY]).catch(() => undefined);
  try {
    await run(command, args);
    return `${command} mcp (user scope)`;
  } catch {
    return null;
  }
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 15_000, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
  });
}

function report(results: readonly WriteResult[], usesVsCodeBinary: boolean): void {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  if (ok.length > 0) {
    const note = usesVsCodeBinary
      ? ' No system Node.js was found, so agents run the server with VS Code\'s own binary.'
      : '';
    void vscode.window.showInformationMessage(
      `Figma MCP added to ${ok.map((r) => r.target.label).join(', ')}. Restart those agents to load it; ` +
        `keep VS Code open with the bridge running while you use them.${note}`,
    );
  }
  for (const r of failed) {
    void vscode.window.showErrorMessage(`${r.target.label}: ${r.error}`);
  }
}

async function remember(deps: CommandDeps, ids: readonly string[]): Promise<void> {
  const current = new Set(deps.context.globalState.get<string[]>(CONFIGURED_KEY, []));
  ids.forEach((id) => current.add(id));
  await deps.context.globalState.update(CONFIGURED_KEY, [...current]);
}

function safePath(target: AgentTarget, env: AgentEnv): string {
  try {
    return target.cli ? `${target.configPath(env)} (via CLI if installed)` : target.configPath(env);
  } catch (error) {
    return `unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
}

function safeDetect(target: AgentTarget, env: AgentEnv): boolean {
  try {
    return target.detect(env);
  } catch {
    return false;
  }
}

async function buildSpec(
  deps: CommandDeps,
  options: { readonly persistLauncher: boolean },
): Promise<{ spec: McpLaunchSpec; usesVsCodeBinary: boolean }> {
  const cfg = deps.config();
  const token = await deps.secrets.getOrCreateBridgePassword();
  const figmaToken = await deps.secrets.getFigmaToken();
  const mcpPath = deps.runtime.getMcpServerPath(cfg.mcpServerPath || undefined);
  const runner = await resolveExternalRunner(deps, options);

  const env: Record<string, string> = {
    ...runner.extraEnv,
    [ENV_BRIDGE_TOKEN]: token,
    [ENV_BRIDGE_URL]: bridgeUrl({ host: cfg.host, port: cfg.port }),
  };
  if (figmaToken) {
    env[ENV_FIGMA_TOKEN] = figmaToken;
  }
  return {
    spec: {
      command: runner.nodePath,
      args: [...(runner.launcherPath ? [runner.launcherPath] : []), mcpPath],
      env,
    },
    usesVsCodeBinary: !!runner.launcherPath,
  };
}

interface ExternalRunner {
  readonly nodePath: string;
  readonly launcherPath?: string;
  readonly extraEnv?: Record<string, string>;
}

/**
 * Runtime for agents that spawn the server outside VS Code: explicit setting →
 * real Node → VS Code's own binary as Node. The Electron fallback needs
 * ELECTRON_RUN_AS_NODE plus a launcher copy in globalStorage (the extension's
 * install dir changes on every update).
 */
async function resolveExternalRunner(
  deps: CommandDeps,
  options: { readonly persistLauncher: boolean },
): Promise<ExternalRunner> {
  const cfg = deps.config();
  const configured = cfg.opencodeNodePath || cfg.nodePath;
  if (configured) {
    return { nodePath: configured };
  }
  try {
    return { nodePath: (await deps.nodes.resolveRealNode()).command };
  } catch {
    // fall through to VS Code's binary
  }
  const electron = deps.nodes.resolveElectronNode();
  const source = electron.launcher;
  const launcherPath = source
    ? path.join(deps.context.globalStorageUri.fsPath, path.basename(source))
    : undefined;
  if (source && launcherPath && options.persistLauncher) {
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.copyFileSync(source, launcherPath);
  }
  return { nodePath: electron.command, launcherPath, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } };
}
