import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  // Pin to the declared engines.vscode floor instead of "stable" (a moving
  // target) — CI should fail if the code drifts onto an API that only exists
  // on newer VS Code than we claim to support.
  version: '1.101.0',
  workspaceFolder: 'test/fixtures/workspace',
});
