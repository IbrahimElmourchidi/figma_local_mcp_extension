import * as vscode from 'vscode';
import { SecretsStore } from '../config/secretsStore';

const MIN_PASSWORD_LENGTH = 32;
const MAX_PASSWORD_LENGTH = 512;

export function registerSecretsCommands(context: vscode.ExtensionContext, secrets: SecretsStore): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('figmaMcpBridge.setBridgePassword', async () => {
      const value = await vscode.window.showInputBox({
        prompt: `Bridge pairing password (${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters)`,
        password: true,
        validateInput: (input) =>
          input.length >= MIN_PASSWORD_LENGTH && input.length <= MAX_PASSWORD_LENGTH
            ? undefined
            : `Must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`,
      });
      if (value === undefined) {
        return;
      }
      await secrets.setBridgePassword(value);
      vscode.window.showInformationMessage('Bridge pairing password updated.');
      void vscode.commands.executeCommand('figmaMcpBridge.refreshAgentConfigs', { quiet: true });
    }),

    vscode.commands.registerCommand('figmaMcpBridge.regenerateBridgePassword', async () => {
      await secrets.regenerateBridgePassword();
      vscode.window.showInformationMessage('Bridge pairing password regenerated.');
      // Agent configs embed the token; rewrite the ones we manage.
      void vscode.commands.executeCommand('figmaMcpBridge.refreshAgentConfigs', { quiet: true });
    }),

    vscode.commands.registerCommand('figmaMcpBridge.setFigmaToken', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Figma personal access token (figd_...)',
        password: true,
      });
      if (value === undefined) {
        return;
      }
      await secrets.setFigmaToken(value);
      vscode.window.showInformationMessage('Figma token saved.');
    }),

    vscode.commands.registerCommand('figmaMcpBridge.clearFigmaToken', async () => {
      await secrets.clearFigmaToken();
      vscode.window.showInformationMessage('Figma token cleared.');
    }),
  );
}
