#!/usr/bin/env node
/**
 * The folder in one go: fetch every app, then photograph it.
 *
 *   npm run apps:build [-- --out <folder>] [--only Name,Name] [--include-unlisted]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : '';
};
const out = value('--out');
const only = value('--only');
const run = (script, extra) => {
  const r = spawnSync(process.execPath, [path.join(here, script), ...extra], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('fetch.mjs', [...(out ? ['--out', out] : []), ...(args.includes('--include-unlisted') ? ['--include-unlisted'] : [])]);
run('screenshot.mjs', [...(out ? ['--dir', out] : []), ...(only ? ['--only', only] : [])]);
