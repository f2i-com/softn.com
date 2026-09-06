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
