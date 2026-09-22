import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

const BRIDGE_PASSWORD_KEY = 'bridgePassword';
const FIGMA_TOKEN_KEY = 'figmaToken';

// Matches BridgeConfig.minPasswordLength (32) from the Flutter app: randomBytes(16) -> 32 hex chars.
const GENERATED_PASSWORD_BYTES = 16;

export class SecretsStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getOrCreateBridgePassword(): Promise<string> {
    const existing = await this.secrets.get(BRIDGE_PASSWORD_KEY);
    if (existing) {
      return existing;
    }
    return this.regenerateBridgePassword();
  }

  async setBridgePassword(password: string): Promise<void> {
    await this.secrets.store(BRIDGE_PASSWORD_KEY, password);
  }

  async regenerateBridgePassword(): Promise<string> {
    const generated = randomBytes(GENERATED_PASSWORD_BYTES).toString('hex');
    await this.secrets.store(BRIDGE_PASSWORD_KEY, generated);
    return generated;
  }

  async getFigmaToken(): Promise<string | undefined> {
    return this.secrets.get(FIGMA_TOKEN_KEY);
  }

  async setFigmaToken(token: string): Promise<void> {
    await this.secrets.store(FIGMA_TOKEN_KEY, token);
  }

  async clearFigmaToken(): Promise<void> {
    await this.secrets.delete(FIGMA_TOKEN_KEY);
  }
}
