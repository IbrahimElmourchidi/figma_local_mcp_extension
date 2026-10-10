#!/usr/bin/env node
/**
 * Publishes the extension, prompting for a marketplace PAT when one isn't
 * already in the environment.
 *
 * Credential handling, in order of preference:
 *   1. `VSCE_PAT` from the environment (CI, or a shell that already exports it)
 *   2. an interactive prompt with the input masked
 *   3. vsce's own stored login (`npx vsce login UtaniumOrg`)
 *
 * The token is passed to vsce through the environment rather than `--pat`, so it
 * never appears in shell history or in `ps` output. It is never written to disk
 * by this script and never echoed back.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VSIX = `figma-mcp-bridge-${version}.vsix`;

const PUBLISH_HINT = [
  'Create a token at https://marketplace.visualstudio.com/manage',
  '  -> Personal Access Tokens -> New Token',
  '  organization: "All accessible organizations"',
  '',
  'Or skip the prompt next time by exporting it:',
  '  export VSCE_PAT=<token>',
].join('\n');

/**
 * Reads one line from stdin with the input masked.
 *
 * Uses readline's `terminal` mode, which does its own line editing — so we only
 * have to hide the echo rather than reimplement backspace/arrows. Resolves null
 * at EOF or when there is no TTY to prompt on.
 */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const input = process.stdin;
    const output = process.stdout;
    if (!input.isTTY) {
      resolve(null);
      return;
    }

    const rl = readline.createInterface({ input, output, terminal: true });
    const wasMuted = output.muted;
    // Muted output stops readline from echoing what is typed. It still draws the
    // prompt and a newline, so the cursor is left in a sane place.
    output.muted = true;
    output.write(prompt);

    // `line` and `close` can both fire for the same input, and whichever
    // resolves first wins — so settle on the line value and let a later `close`
    // become a no-op.
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      output.muted = wasMuted;
      output.write('\n');
      rl.close();
      input.pause();
      resolve(value);
    };

    rl.once('line', (line) => finish(line));
    rl.once('close', () => finish(null));
  });
}

async function resolvePat() {
  const existing = (process.env.VSCE_PAT ?? '').trim();
  if (existing) {
    return existing;
  }

  if (!process.stdin.isTTY) {
    console.error(
      '[vsce] VSCE_PAT is not set and stdin is not a terminal, so it cannot be prompted for.\n' +
        `Set it in the environment instead:\n\n${PUBLISH_HINT}\n`,
    );
    process.exit(1);
  }

  console.log(`Publishing ${VSIX}`);
  console.log('No VSCE_PAT found in the environment — enter your marketplace token.');
  console.log('(input is hidden; it is not saved anywhere)\n');

  const entered = (await askHidden('  Personal Access Token: ')) ?? '';
  const token = entered.trim();

  if (!token) {
    console.error('\n[vsce] No token entered. Aborted.');
    process.exit(1);
  }
  return token;
}

async function main() {
  const vsixPath = path.join(ROOT, VSIX);
  if (!fs.existsSync(vsixPath)) {
    console.error(`[vsce] ${VSIX} not found — run \`npm run vsce:package\` first.`);
    process.exit(1);
  }

  const token = await resolvePat();

  const vsceBin = path.join(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'vsce.cmd' : 'vsce',
  );

  await new Promise((resolve) => {
    const child = spawn(vsceBin, ['publish', '--packagePath', VSIX], {
      cwd: ROOT,
      stdio: 'inherit',
      // Token travels via env; `--pat` is deliberately omitted so it stays out
      // of the process table and shell history.
      env: { ...process.env, VSCE_PAT: token },
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    child.on('error', (error) => {
      console.error(
        error.code === 'ENOENT'
          ? '[vsce] not installed — run `npm install` first.'
          : `[vsce] ${error.message}`,
      );
      process.exit(1);
    });
    child.on('close', (code) => resolve(code ?? 0));
  }).then((code) => process.exit(code));
}

await main();