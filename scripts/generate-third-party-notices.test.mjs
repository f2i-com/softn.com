/**
 * The licence inventory records every package the deployed apps bundle.
 *
 * The generator walks `dependencies` from the deployed workspaces. A bundler
 * does not read package.json, though: it ships whatever the sources import.
 * Builder imports the Tauri bridge for its desktop build, declares it under
 * devDependencies, and Vite puts it in the web build's chunks all the same
 * (dist/builder/assets/window-*.js is @tauri-apps/api). The walk never
 * reached it, so the website archive and the FormLogic runtime archive
 * shipped that code with no licence record and no notice.
 *
 * So the inventory is checked against the imports: every registry package a
 * deployed workspace's sources import, or a workspace package it links, has
 * to be recorded. One that the walk cannot reach belongs in the generator's
 * EMITTED_BUILD_PACKAGES.
 *
 * Usage: node --test scripts/generate-third-party-notices.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoRoot as root } from './lib/paths.mjs';

const generator = path.join(root, 'scripts/generate-third-party-notices.mjs');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages;

/** The deployed workspaces and every workspace package they link, as lockfile locations. */
function reachedWorkspaces(roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const location = queue.shift();
    if (seen.has(location) || !lock[location]) continue;
    seen.add(location);
    const meta = lock[location];
    for (const name of Object.keys({ ...meta.dependencies, ...meta.peerDependencies, ...meta.optionalDependencies })) {
      const link = lock[`node_modules/${name}`];
      if (link?.link && link.resolved) queue.push(link.resolved);
    }
  }
  return [...seen];
}

function sourceFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'test', 'tests', '__tests__'].includes(entry.name)) sourceFiles(full, out);
    } else if (/\.(?:ts|tsx|mts|js|mjs|jsx)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Registry packages the file imports for their code: `import type` is erased and is not counted. */
function importedPackages(text) {
  const names = new Set();
  const imports = /^\s*(?:import|export)\s+(?!type\b)[^'"\n;]*?\bfrom\s*['"]([^'"\n]+)['"]|^\s*import\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/gm;
  for (const match of text.matchAll(imports)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    const meta = lock[`node_modules/${name}`];
    // Only what the lockfile installs from the registry: a workspace link is SoftN's own.
    if (meta && !meta.link) names.add(name);
  }
  return names;
}

test('every package the deployed apps import is in the licence inventory', (t) => {
  if (!fs.existsSync(path.join(root, 'packages/@softn/core/wasm-zipp/SOURCE.json'))) {
    return t.skip('the ZIPP engine is not installed (npm run fetch:zipp); the generator reads its provenance');
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-notices-test-'));
  t.after(() => {
    const checked = fs.realpathSync(outDir);
    assert.equal(path.dirname(checked), fs.realpathSync(os.tmpdir()));
    fs.rmSync(checked, { recursive: true, force: true });
  });
  execFileSync(process.execPath, [generator, '--out-dir', outDir], { cwd: root, stdio: 'pipe' });
  const inventory = JSON.parse(fs.readFileSync(path.join(outDir, 'THIRD-PARTY-INVENTORY.json'), 'utf8'));
  const notices = fs.readFileSync(path.join(outDir, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  const recorded = new Set(inventory.packages.map((entry) => entry.name));

  const unrecorded = new Map();
  for (const workspace of reachedWorkspaces(inventory.roots)) {
    for (const file of sourceFiles(path.join(root, workspace, 'src'))) {
      for (const name of importedPackages(fs.readFileSync(file, 'utf8'))) {
        if (!recorded.has(name) && !unrecorded.has(name)) unrecorded.set(name, path.relative(root, file).replaceAll('\\', '/'));
      }
    }
  }
  assert.deepEqual(
    [...unrecorded].map(([name, file]) => `${name} (imported by ${file})`),
    [],
    'imported by a deployed app, bundled by its build, and absent from the inventory',
  );

  // Builder's web build carries the Tauri bridge; its record and its text are there.
  for (const name of ['@tauri-apps/api', '@tauri-apps/plugin-dialog', '@tauri-apps/plugin-fs']) {
    const entry = inventory.packages.find((candidate) => candidate.name === name);
    assert.ok(entry, `${name} is recorded`);
    assert.ok(entry.licenseFiles.length > 0, `${name} has a licence text`);
    assert.ok(notices.includes(`${name}@${entry.version} — ${entry.license}`), `${name} is listed in the notices`);
  }
});
