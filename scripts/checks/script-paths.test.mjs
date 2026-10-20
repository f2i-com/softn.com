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
    if (!/\.(mjs|js|cjs|ts|tsx|mts|json|md|yml|yaml|py|html)$|(^|\/)\.gitignore$/.test(file)) continue;
    if (file.startsWith('vendor/') || file === 'package-lock.json') continue;
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
