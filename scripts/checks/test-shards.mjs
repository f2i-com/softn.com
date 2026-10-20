#!/usr/bin/env node
/**
 * The whole test suite cut into shards that CI runs side by side
 * (.github/workflows/verify.yml), so a push or a release waits for the
 * slowest shard rather than for every suite in a row.
 *
 *   node scripts/checks/test-shards.mjs --plan 4        what each of 4 shards runs
 *   node scripts/checks/test-shards.mjs --shard 2/4     run shard 2 of 4
 *   node scripts/checks/test-shards.mjs --shard 2/4 --needs
 *                                                what that shard needs set up
 *                                                first, as key=value lines
 *                                                (CI appends them to
 *                                                $GITHUB_OUTPUT)
 *
 * The units are read from the repository, not listed here: each pattern of
 * the root `test:scripts` script is one, each workspace with a `test` script
 * is one, and core's suite on the host JavaScript engine (`test:host-js`) is
 * one. `npm test` runs the first two kinds one after another, as it always
 * has; a shard runs its share of all three. A new workspace or pattern joins
 * a shard by itself, at a default weight, and test-shards.test.mjs holds the
 * plan to every unit exactly once.
 *
 * Shards are filled largest unit first, each unit to the lightest shard so
 * far, by the seconds each took on a CI runner (WEIGHTS). The weights only
 * balance the shards; a wrong one makes a shard slower, never a test missed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot as root } from '../lib/paths.mjs';

/**
 * Seconds on an ubuntu-latest runner (the v0.0.19 release's verify job; the
 * root patterns timed apart), with what the unit has to have built first.
 * `apps`: scripts/checks/host-js-isolation.test.mjs looks inside the built Builder,
 * Studio and web app and only skips when they are not there. `chromium`:
 * scripts/dev/dev-service-worker.test.mjs drives a real browser, and skips
 * without one. Each counts in the weight of the shard that has to do it.
 */
const WEIGHTS = {
  'scripts/**/*.test.mjs': 60,
  'packages/@softn/core/scripts/*.test.mjs': 95,
  'docs/tests/*.test.mjs': 5,
  'apps/formlogic-host/test/*.test.mjs': 5,
  'test:host-js': 49,
  '@softn/host-php': 73,
  '@softn/core': 57,
  '@softn/studio': 48,
  '@softn/builder': 36,
  '@softn/components': 24,
  '@softn/api': 20,
  '@softn/web': 8,
  '@softn/site': 6,
};
const DEFAULT_WEIGHT = 10;
const NEEDS = { 'scripts/**/*.test.mjs': ['apps', 'chromium'] };
const SETUP_WEIGHT = { apps: 41, chromium: 19 };
export const NEED_KINDS = Object.keys(SETUP_WEIGHT);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The double-quoted patterns of the root `test:scripts` script. */
export function scriptPatterns(pkg = readJson(path.join(root, 'package.json'))) {
  const command = pkg.scripts?.['test:scripts'];
  if (typeof command !== 'string' || !/^node --test( "[^"]+")+$/.test(command)) {
    throw new Error('package.json test:scripts must be `node --test` followed by double-quoted patterns');
  }
  return [...command.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Every workspace with a `test` script, by package name, in workspace order. */
export function testedWorkspaces(pkg = readJson(path.join(root, 'package.json'))) {
  const names = [];
  for (const pattern of pkg.workspaces ?? []) {
    const dirs = pattern.endsWith('/*')
      ? fs.readdirSync(path.join(root, pattern.slice(0, -2)), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(pattern.slice(0, -2), d.name))
        .sort()
      : [pattern];
    for (const dir of dirs) {
      const file = path.join(root, dir, 'package.json');
      if (!fs.existsSync(file)) continue;
      const workspace = readJson(file);
      if (workspace.scripts?.test) names.push(workspace.name);
    }
  }
  return names;
}

/** Every unit of the suite: what it is called, how it runs and what it needs. */
export function units() {
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg.scripts?.['test:host-js']) throw new Error('package.json has no test:host-js script');
  return [
    ...scriptPatterns(pkg).map((pattern) => ({ name: pattern, command: ['node', '--test', pattern] })),
    ...testedWorkspaces(pkg).map((name) => ({ name, command: ['npm', 'test', '-w', name] })),
    { name: 'test:host-js', command: ['npm', 'run', 'test:host-js'] },
  ].map((unit) => ({ ...unit, needs: NEEDS[unit.name] ?? [], weight: WEIGHTS[unit.name] ?? DEFAULT_WEIGHT }));
}

/** The units cut into `count` shards, largest first, each to the lightest shard so far. */
export function plan(count, all = units()) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`a shard count is a whole number from 1 up, not ${count}`);
  const shards = Array.from({ length: count }, () => ({ units: [], needs: new Set(), weight: 0 }));
  const cost = (shard, unit) => unit.weight + unit.needs.filter((need) => !shard.needs.has(need)).reduce((sum, need) => sum + SETUP_WEIGHT[need], 0);
  const order = [...all].sort((a, b) => (b.weight + b.needs.reduce((s, n) => s + SETUP_WEIGHT[n], 0)) - (a.weight + a.needs.reduce((s, n) => s + SETUP_WEIGHT[n], 0)) || a.name.localeCompare(b.name));
  for (const unit of order) {
    let best = shards[0];
    for (const shard of shards) if (shard.weight + cost(shard, unit) < best.weight + cost(best, unit)) best = shard;
    best.weight += cost(best, unit);
    best.units.push(unit);
    for (const need of unit.needs) best.needs.add(need);
  }
  // A shard runs its units in the order the suite lists them.
  const position = new Map(all.map((unit, i) => [unit.name, i]));
  return shards.map((shard) => ({
    units: shard.units.sort((a, b) => position.get(a.name) - position.get(b.name)),
    needs: NEED_KINDS.filter((need) => shard.needs.has(need)),
    weight: shard.weight,
  }));
}

function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/.exec(text ?? '');
  if (!match || Number(match[1]) < 1 || Number(match[1]) > Number(match[2])) {
    throw new Error(`--shard takes i/n with 1 <= i <= n, not ${text}`);
  }
  return { index: Number(match[1]) - 1, count: Number(match[2]) };
}

function main(args) {
  if (args[0] === '--plan') {
    const shards = plan(Number(args[1]));
    shards.forEach((shard, i) => {
      console.log(`shard ${i + 1}/${shards.length}: about ${shard.weight}s${shard.needs.length ? `, needs ${shard.needs.join(' and ')}` : ''}`);
      for (const unit of shard.units) console.log(`  ${unit.name}`);
    });
    return 0;
  }
  if (args[0] !== '--shard') {
    console.error('usage: test-shards.mjs --plan <n> | --shard <i>/<n> [--needs]');
    return 2;
  }
  const { index, count } = parseShard(args[1]);
  const shard = plan(count)[index];
  if (args.includes('--needs')) {
    for (const need of NEED_KINDS) console.log(`${need}=${shard.needs.includes(need)}`);
    return 0;
  }
  const failed = [];
  const timings = [];
  for (const unit of shard.units) {
    console.log(`\n=== ${unit.name}: ${unit.command.join(' ')}`);
    const started = Date.now();
    // npm is npm.cmd on Windows, which only a shell runs.
    const result = spawnSync(unit.command[0], unit.command.slice(1), { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && unit.command[0] === 'npm' });
    const seconds = Math.round((Date.now() - started) / 1000);
    timings.push(`${unit.name} ${seconds}s${result.status === 0 ? '' : ' FAILED'}`);
    if (result.status !== 0) failed.push(unit.name);
  }
  console.log(`\nshard ${index + 1}/${count}:\n  ${timings.join('\n  ')}`);
  if (failed.length) {
    console.error(`failed: ${failed.join(', ')}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
