/**
 * No file names a script by a path it has left.
 *
 * scripts/ is arranged in folders (scripts/README.md); a script that moved
 * into one is no longer at `scripts/<name>`, and a workflow, a package.json
 * script, a doc or a comment still naming it there points at nothing. This
 * reads every tracked text file for `scripts/<name>` where `<name>` now lives
 * in a folder. The changelog's released sections are history and keep the
 * paths they had; its Unreleased section is read like every other file.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { repoRoot } from '../lib/paths.mjs';

const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean);
const FOLDERS = ['build', 'release', 'dev', 'brand', 'licenses', 'demos', 'checks'];

test('no file names a script by a path it has left', () => {
  const moved = tracked
    .map((file) => file.match(/^scripts\/([^/]+)\/([^/]+)$/))
    .filter((m) => m && FOLDERS.includes(m[1]))
    .map((m) => m[2]);
  // A name that is also a file at scripts/ itself (none today) would be a real path.
  const stale = new Set(moved.filter((name) => !tracked.includes(`scripts/${name}`)));
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // From the root (`scripts/x.mjs`) or relative to a file (`../../scripts/x.mjs`); not a
  // longer path that merely ends in scripts/ (packages/@softn/core/scripts/…).
  const pattern = new RegExp(`(^|[^\\w@./-]|(?:\\.\\./)+)scripts/(${[...stale].map(escape).join('|')}|softn-apps/)(?![\\w-])`, 'm');
  const problems = [];
  for (const file of tracked) {
    // Rust, PHP, TOML and shell name scripts in comments too (Cargo.toml named
    // two that had moved).
    if (!/\.(mjs|js|cjs|ts|tsx|mts|json|md|yml|yaml|py|html|rs|php|toml|sh|ps1)$|(^|\/)\.gitignore$/.test(file)) continue;
    if (file.startsWith('vendor/') || file === 'package-lock.json') continue;
    // Listed by git until its deletion is staged, but no longer there to name anything.
    if (!fs.existsSync(path.join(repoRoot, file))) continue;
    let text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    if (file === 'CHANGELOG.md') {
      const start = text.indexOf('## Unreleased');
      text = start < 0 ? '' : text.slice(start, text.indexOf('\n## ', start + 5));
    }
    const hit = text.match(pattern);
    if (hit) problems.push(`${file}: scripts/${hit[2]}`);
  }
  assert.deepEqual(problems, []);
});

// A script that finds the repository from where it lies counts the folders
// up to it, and a move into a folder adds one. test-single-backend.py kept
// counting from scripts/ and looked for the PHP host's tests under
// scripts/apps/, which only the dispatched build ran, and failed.
test('a Python script that finds the repository from its own path finds it', () => {
  const problems = [];
  for (const file of tracked.filter((f) => f.startsWith('scripts/') && f.endsWith('.py'))) {
    const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    for (const m of text.matchAll(/Path\(__file__\)\.resolve\(\)(\.parents\[(\d+)\]|(?:\.parent(?!s))+)/g)) {
      const up = m[2] !== undefined ? Number(m[2]) + 1 : m[1].split('.parent').length - 1;
      const dir = path.resolve(path.dirname(path.join(repoRoot, file)), ...Array(up - 1).fill('..'));
      if (dir !== repoRoot) problems.push(`${file}: ${m[0]} is ${path.relative(repoRoot, dir) || '.'}, not the repository`);
    }
  }
  assert.deepEqual(problems, []);
});
