import * as vscode from 'vscode';
import { ENV_BRIDGE_TOKEN, ENV_BRIDGE_URL, ENV_FIGMA_TOKEN } from '../constants';
import { BridgeConfig } from '../config/bridgeConfig';
import { SecretsStore } from '../config/secretsStore';
import { RuntimeStore } from './runtimeStore';
import { NodeResolver } from './nodeResolver';
import { BridgeService } from './bridgeService';
import { StateStore } from './state';
import { bridgeUrl } from '../util/bridgeUrl';

const PROVIDER_ID = 'figmaMcpBridge.servers';

/**
 * Registers a native McpServerDefinitionProvider so Copilot agent mode gets the
 * Figma MCP tools. `provideMcpServerDefinitions` must be side-effect free;
 * bridge startup + token injection happen in `resolveMcpServerDefinition`.
 */
export function registerMcpProvider(context: vscode.ExtensionContext, deps: {
  readonly config: () => BridgeConfig;
  readonly secrets: SecretsStore;
  readonly runtime: RuntimeStore;
  readonly nodes: NodeResolver;
  readonly bridge: BridgeService;
  readonly state: StateStore;
}): vscode.Disposable {
  const changed = new vscode.EventEmitter<void>();

  const provider: vscode.McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => {
      const cfg = deps.config();
      const mcpPath = deps.runtime.getMcpServerPath(cfg.mcpServerPath || undefined);
      const node = deps.nodes.resolveElectronNode();
      const env: Record<string, string | number | null> = {
        ...flattenEnv(node.env),
        ELECTRON_RUN_AS_NODE: '1',
      };
      const manifest = deps.runtime.getInstalledManifest();
      const definition = new vscode.McpStdioServerDefinition(
        'Figma MCP Bridge',
        node.command,
        [mcpPath],
        env,
        manifest?.upstreamSha,
      );
      return [definition];
    },
    resolveMcpServerDefinition: async (server) => {
      if (!isStdioDefinition(server)) {
        return server;
      }
      const cfg = deps.config();
      const token = await deps.secrets.getOrCreateBridgePassword();

      // Ensure the bridge is up so the MCP server can talk to it.
      const bridgeState = deps.state.get().bridge.status;
      if (bridgeState === 'stopped' || bridgeState === 'error') {
        try {
          await deps.bridge.start({ config: cfg, token });
        } catch (error) {
          void vscode.window.showWarningMessage(
            `Figma MCP: could not start bridge before launching server: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const env: Record<string, string | number | null> = {
        ...(server.env as Record<string, string | number | null> | undefined),
        [ENV_BRIDGE_TOKEN]: token,
        [ENV_BRIDGE_URL]: bridgeUrl({ host: cfg.host, port: cfg.port }),
      };
      const figmaToken = await deps.secrets.getFigmaToken();
      if (figmaToken) {
        env[ENV_FIGMA_TOKEN] = figmaToken;
      }

      return { ...server, env };
    },
  };

  const registered = vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider);

  // Fire change events when port/token/runtime move.
  const unsub = deps.state.onDidChange((snap) => {
    void snap;
    changed.fire();
  });
  const onConfig = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('figmaMcpBridge')) {
      changed.fire();
    }
  });

  context.subscriptions.push(
    registered,
    changed,
    { dispose: unsub },
    onConfig,
  );
  return registered;
}

function flattenEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}

function isStdioDefinition(
  server: vscode.McpServerDefinition,
): server is vscode.McpStdioServerDefinition {
  return 'command' in server;
}
