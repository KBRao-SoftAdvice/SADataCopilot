#!/usr/bin/env node
// Loader shim for the @github/copilot CLI.
//
// Why this exists:
//   The Copilot SDK spawns its CLI via `spawn(process.execPath, [cliPath, ...args])`.
//   Inside a VS Code extension host `process.execPath` is the Electron Helper.
//   With ELECTRON_RUN_AS_NODE=1 it does run JavaScript, but `process.versions.electron`
//   is still set, which puts commander.js (used by the Copilot CLI) into "electron mode".
//   In that mode commander treats `argv[1]` as a positional argument, which causes
//   `error: too many arguments. Expected 0 arguments but got 1.` before any flag
//   parsing happens.
//
// What this does:
//   Strips the electron signal from argv[0] and process.versions, then dynamic-imports
//   the real CLI entry point, which is provided as the first SHIM-level argv after
//   our own script path. Subsequent argv entries are the SDK's CLI flags and flow
//   through unchanged because the real CLI reads `process.argv` directly.

'use strict';

const realCliPath = process.env.COPILOT_CLI_REAL_PATH;
if (!realCliPath) {
  process.stderr.write(
    'copilot-cli-shim: COPILOT_CLI_REAL_PATH env var not set\n'
  );
  process.exit(1);
}

process.argv[0] = 'node';
delete process.versions.electron;

const { pathToFileURL } = require('node:url');
import(pathToFileURL(realCliPath).href).catch((e) => {
  process.stderr.write('copilot-cli-shim: import failed: ' + (e && e.message) + '\n');
  process.exit(1);
});
