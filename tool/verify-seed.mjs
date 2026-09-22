#!/usr/bin/env node
// Fails packaging if runtime-seed/ no longer matches the SHA-256 hashes in its
// runtime.json — a corrupt seed fails verification on every user's activation.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const seedDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime-seed');
const manifest = JSON.parse(readFileSync(path.join(seedDir, 'runtime.json'), 'utf8'));
const files = Object.entries(manifest.files ?? {});
if (files.length === 0) {
  console.error('runtime-seed/runtime.json lists no files.');
  process.exit(1);
}

let failed = false;
for (const [rel, expected] of files) {
  let actual;
  try {
    actual = createHash('sha256').update(readFileSync(path.join(seedDir, ...rel.split('/')))).digest('hex');
  } catch {
    console.error(`runtime-seed: missing ${rel}`);
    failed = true;
    continue;
  }
  if (actual !== expected.toLowerCase()) {
    console.error(`runtime-seed: SHA-256 mismatch for ${rel} (expected ${expected}, got ${actual})`);
    failed = true;
  }
}
if (failed) {
  console.error('Restore with `git checkout -- runtime-seed` or regenerate with `npm run sync-runtime`.');
  process.exit(1);
}
console.log(`runtime-seed OK (${files.length} files, upstream ${manifest.upstreamSha.slice(0, 12)})`);
