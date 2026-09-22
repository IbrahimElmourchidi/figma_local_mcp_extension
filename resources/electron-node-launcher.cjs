'use strict';
// Usage: <node|electron> electron-node-launcher.cjs <script> [args...]
//
// Under ELECTRON_RUN_AS_NODE, process.versions.electron is set, so CLI parsers
// such as commander (used by bridge-cli.cjs) assume a *packaged* Electron app
// and read user args from argv[1] — treating the script path itself as an
// unknown command. Setting process.defaultApp restores node-style argv[2]
// parsing. runMain() keeps require.main === the target, so main-module guards
// in the target still fire.
const script = process.argv[2];
if (!script) {
  console.error('electron-node-launcher: missing script path');
  process.exit(2);
}
process.argv.splice(1, 1);
// Node resolves argv[1] to an absolute path before running main; do the same,
// or runMain() would treat a relative path as a bare module specifier.
process.argv[1] = require('node:path').resolve(script);
if (process.versions.electron) {
  process.defaultApp = true;
}
const Module = require('node:module');
if (typeof Module.runMain === 'function') {
  Module.runMain();
} else {
  require(process.argv[1]);
}
