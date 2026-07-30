#!/usr/bin/env node
/**
 * Remove build output and installed dependencies, on any platform.
 *
 * This used to be an `rm -rf` one-liner in package.json, which cannot run on
 * Windows: npm hands lifecycle scripts to `cmd.exe /d /s /c`, where `rm` does
 * not exist. It also leaned on `packages/**\/dist` globbing, which npm does not
 * expand itself and which the shells that do expand it disagree about.
 *
 * The workspace list is read from package.json rather than repeated here, so a
 * new app or package is cleaned the day it is added.
 *
 *   npm run clean                  build output only — the usual case
 *   npm run clean -- --deps        also delete every node_modules
 *
 * The bare `--` is required: without it npm treats `--deps` as its own flag and
 * the script never sees it, so the run silently does the smaller thing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const withDeps = process.argv.includes('--deps');

/** Expand the workspace globs in package.json into real directories. */
function workspaceDirs() {
  const { workspaces = [] } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dirs = [];
  for (const pattern of workspaces) {
    if (!pattern.endsWith('/*')) {
      dirs.push(path.join(root, pattern));
      continue;
    }
    const parent = path.join(root, pattern.slice(0, -2));
    if (!fs.existsSync(parent)) continue;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(parent, entry.name));
    }
  }
  return dirs;
}

// Build output, plus the caches that survive a rebuild and go stale: a Vite dep
// cache holding a pre-bundled copy of a package whose dist was rebuilt under it
// serves the old code, which reads as a mystery blank page rather than a stale
// cache.
const perWorkspace = ['dist', 'build', '.vite', 'coverage', 'node_modules/.vite', 'node_modules/.cache'];
const targets = [path.join(root, 'dist'), path.join(root, 'node_modules/.vite'), path.join(root, 'node_modules/.cache')];

for (const dir of workspaceDirs()) {
  for (const name of perWorkspace) targets.push(path.join(dir, name));
  if (withDeps) targets.push(path.join(dir, 'node_modules'));
}
if (withDeps) targets.push(path.join(root, 'node_modules'));

let removed = 0;
for (const target of targets) {
  if (!fs.existsSync(target)) continue;
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`  removed ${path.relative(root, target).replace(/\\/g, '/')}`);
  removed += 1;
}

// *.tsbuildinfo lands next to the tsconfig that produced it, not in dist.
for (const dir of [root, ...workspaceDirs()]) {
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.tsbuildinfo')) continue;
    fs.rmSync(path.join(dir, entry), { force: true });
    console.log(`  removed ${path.relative(root, path.join(dir, entry)).replace(/\\/g, '/')}`);
    removed += 1;
  }
}

console.log(removed ? `\nCleaned ${removed} paths.` : '\nNothing to clean.');
if (!withDeps) console.log('node_modules kept — run `npm run clean -- --deps` to remove it too.');
