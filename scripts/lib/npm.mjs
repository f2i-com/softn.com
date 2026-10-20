/**
 * Running npm from a script without a shell. On Windows `npm` is `npm.cmd`,
 * which only a shell runs, and Node deprecates handing a shell an argument
 * list (DEP0190); npm's own CLI script, run by this Node, needs neither.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * The npm-cli.js `npm run` names, else the one beside the node binary (a
 * Windows or a plain install), else the one under its lib/ (a Unix install);
 * null when none is there.
 */
export function npmCli() {
  const beside = path.dirname(process.execPath);
  return [
    process.env.npm_execpath,
    path.join(beside, 'node_modules/npm/bin/npm-cli.js'),
    path.join(beside, '../lib/node_modules/npm/bin/npm-cli.js'),
  ].find((file) => file && /npm-cli\.js$/.test(file) && fs.existsSync(file)) ?? null;
}

/**
 * `[command, args, options]` for spawn/execFile that run `npm <args>`:
 * Node with npm-cli.js where there is one, else `npm` itself, through a shell
 * only on Windows.
 */
export function npmCommand(args) {
  const cli = npmCli();
  if (cli) return [process.execPath, [cli, ...args], {}];
  return ['npm', args, { shell: process.platform === 'win32' }];
}
