/**
 * The shards CI runs side by side are the whole suite: every unit in exactly
 * one shard, whatever the count, and the counts verify.yml runs are the ones
 * its matrix names. A unit left out would be a suite that never runs again
 * and never says so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan, scriptPatterns, testedWorkspaces, units } from './test-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('npm test is the root patterns and then every workspace suite, as the shards take them', () => {
  assert.equal(pkg.scripts.test, 'npm run test:scripts && npm run test --workspaces --if-present');
  assert.deepEqual(scriptPatterns(pkg), [
    'docs/tests/*.test.mjs',
    'scripts/**/*.test.mjs',
    'packages/@softn/core/scripts/*.test.mjs',
    'apps/formlogic-host/test/*.test.mjs',
  ]);
  const workspaces = testedWorkspaces(pkg);
  for (const name of ['@softn/core', '@softn/components', '@softn/builder', '@softn/studio', '@softn/host-php', '@softn/api']) {
    assert.ok(workspaces.includes(name), `${name} has a test script and is a unit`);
  }
  // Every workspace with a test script, read the way npm reads the workspace globs.
  for (const dir of ['packages/@softn', 'apps']) {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const file = path.join(root, dir, entry.name, 'package.json');
      if (!entry.isDirectory() || !fs.existsSync(file)) continue;
      const workspace = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (workspace.scripts?.test) assert.ok(workspaces.includes(workspace.name), `${workspace.name} is in a shard`);
    }
  }
});

test('every unit is in exactly one shard, for any count', () => {
  const all = units();
  assert.ok(all.some((unit) => unit.name === 'test:host-js'), 'core on the host JavaScript engine is a unit');
  for (let count = 1; count <= 8; count++) {
    const shards = plan(count, all);
    assert.equal(shards.length, count);
    const placed = shards.flatMap((shard) => shard.units.map((unit) => unit.name)).sort();
    assert.deepEqual(placed, all.map((unit) => unit.name).sort(), `${count} shards`);
    for (const shard of shards) {
      const needs = new Set(shard.units.flatMap((unit) => unit.needs));
      assert.deepEqual(shard.needs, [...needs].sort((a, b) => ['apps', 'chromium'].indexOf(a) - ['apps', 'chromium'].indexOf(b)), 'a shard sets up what its units need, and nothing else');
    }
  }
  // What the browser-driven and build-reading script tests need goes with them.
  const scripts = plan(4, all).find((shard) => shard.units.some((unit) => unit.name === 'scripts/**/*.test.mjs'));
  assert.deepEqual(scripts.needs, ['apps', 'chromium']);
});

test('a unit the weights do not know is still placed, and the plan is the same every time', () => {
  const all = [...units(), { name: '@softn/new-workspace', command: ['npm', 'test', '-w', '@softn/new-workspace'], needs: [], weight: 10 }];
  const once = plan(4, all).map((shard) => shard.units.map((unit) => unit.name));
  assert.ok(once.flat().includes('@softn/new-workspace'));
  assert.deepEqual(plan(4, all).map((shard) => shard.units.map((unit) => unit.name)), once);
  assert.throws(() => plan(0), /whole number/);
});

test('verify.yml runs every shard of the count it names', () => {
  const verify = fs.readFileSync(path.join(root, '.github/workflows/verify.yml'), 'utf8').replace(/\r\n/g, '\n');
  const matrix = verify.match(/^\s+shard: \[([0-9, ]+)\]$/m);
  assert.ok(matrix, 'verify.yml has a shard matrix');
  const shards = matrix[1].split(',').map((n) => Number(n.trim()));
  const runs = [...verify.matchAll(/test-shards\.mjs --shard \$\{\{ matrix\.shard \}\}\/(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(runs.length >= 2, 'the needs step and the run step both name the count');
  for (const count of runs) {
    assert.equal(count, shards.length, 'the count each step names is the matrix length');
    assert.deepEqual(shards, Array.from({ length: count }, (_, i) => i + 1), 'the matrix lists shards 1 to n');
  }
});
