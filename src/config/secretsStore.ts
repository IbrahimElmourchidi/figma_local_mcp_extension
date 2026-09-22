import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { withLockAsync } from '../core/lock';

const BRIDGE_PASSWORD_KEY = 'bridgePassword';
const FIGMA_TOKEN_KEY = 'figmaToken';

// Matches BridgeConfig.minPasswordLength (32) from the Flutter app: randomBytes(16) -> 32 hex chars.
const GENERATED_PASSWORD_BYTES = 16;

export class SecretsStore {
  /** `locksDir` is optional so tests/tools can construct this without a StorageLayout. */
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly locksDir?: string,
  ) {}

  /**
   * Get-or-create, guarded by the cross-process lock: two VS Code windows
   * opening a fresh install at once must not both see "absent" and both
   * generate+store their own password (last write wins, silently desyncing
   * whichever window started first from the keyring).
   */
  async getOrCreateBridgePassword(): Promise<string> {
    const existing = await this.secrets.get(BRIDGE_PASSWORD_KEY);
    if (existing) {
      return existing;
    }
    if (!this.locksDir) {
      return this.regenerateBridgePassword();
    }
    return withLockAsync(this.locksDir, 'bridge-password', async () => {
      const reread = await this.secrets.get(BRIDGE_PASSWORD_KEY);
      if (reread) {
        return reread;
      }
      return this.regenerateBridgePassword();
    });
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
