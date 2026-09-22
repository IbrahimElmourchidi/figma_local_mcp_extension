import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(root, 'test/mocks/vscode.ts'),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
  },
});
