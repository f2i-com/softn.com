/**
 * The demo downloader's credential rule, pinned.
 *
 * A token in GH_TOKEN used to be attached to every https source the catalogue
 * named, which made an edit to index.json a way to read the token. What is
 * pinned: a credential may go to GitHub, for the pinned repository's own
 * release and API paths, and nowhere else — not another host, not another
 * repository on the same host, not a lookalike, and never over plain http.
 *
 * Usage: node --test scripts/fetch-demos.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mayCarryCredential } from './fetch-demos.mjs';

const REPO = 'f2i-com/softn-Examples';

test('a credential goes only to the pinned repository on GitHub', () => {
  for (const url of [
    `https://github.com/${REPO}/releases/download/v1.0.0/Twenty48.softn`,
    `https://api.github.com/repos/${REPO}/releases/latest`,
  ]) {
    assert.equal(mayCarryCredential(url, REPO), true, url);
  }
});

test('and to nothing else', () => {
  for (const url of [
    'https://third-party.test/fixture.softn',
    'https://objects.githubusercontent.com/github-production-release-asset/x',
    'https://github.com/someone-else/softn-Examples/releases/download/v1.0.0/x.softn',
    'https://github.com.evil.test/f2i-com/softn-Examples/x',
    `http://github.com/${REPO}/releases/download/v1.0.0/x.softn`,
    `https://github.com/${REPO}`,
    'not a url',
  ]) {
    assert.equal(mayCarryCredential(url, REPO), false, url);
  }
});

/**
 * A verified download waits beside the served bundles as `<name>.softn.download`
 * until every archive of the run has verified. A run stopped in between (Ctrl-C,
 * a killed job) left those files there, and the site build copies the whole
 * folder: a staging file of an interrupted fetch shipped under /demos/. The
 * script works on the folder beside its own scripts/, so it is copied into a
 * temporary root whose one pinned bundle is already on disk; nothing is fetched.
 */
function pinnedRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-fetch-demos-'));
  t.after(() => {
    const checked = fs.realpathSync(root);
    assert.equal(path.dirname(checked), fs.realpathSync(os.tmpdir()));
    fs.rmSync(checked, { recursive: true, force: true });
  });
  const demos = path.join(root, 'apps/softn-web/public/demos');
  fs.mkdirSync(demos, { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(new URL('./fetch-demos.mjs', import.meta.url), path.join(root, 'scripts/fetch-demos.mjs'));
  const bundle = Buffer.from('PK a pinned bundle');
  fs.writeFileSync(path.join(demos, 'Notes.softn'), bundle);
  fs.writeFileSync(
    path.join(demos, 'index.json'),
    JSON.stringify([{ file: 'Notes.softn', source: 'https://unreachable.invalid/Notes.softn', size: bundle.length, sha256: crypto.createHash('sha256').update(bundle).digest('hex') }]),
  );
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/fetch-demos.mjs'), ...args], { encoding: 'utf8' });
  return { demos, run };
}

test('a staging file an interrupted fetch left behind is cleared, not served', (t) => {
  const { demos, run } = pinnedRoot(t);
  fs.writeFileSync(path.join(demos, 'Notes.softn.download'), 'half of an earlier download');
  fs.writeFileSync(path.join(demos, 'Retired.softn.download'), 'a bundle the index no longer lists');

  // Checking changes nothing, and says what is in the way.
  const check = run('--check');
  assert.equal(check.status, 1, check.stdout + check.stderr);
  assert.match(check.stderr, /Notes\.softn\.download is left from an interrupted fetch/);
  assert.ok(fs.existsSync(path.join(demos, 'Notes.softn.download')));

  const fetched = run();
  assert.equal(fetched.status, 0, fetched.stdout + fetched.stderr);
  assert.deepEqual(fs.readdirSync(demos).sort(), ['Notes.softn', 'index.json']);
  assert.equal(run('--check').status, 0);
});
