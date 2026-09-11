#!/usr/bin/env node
/**
 * Writes this fixture: a small catalogue with the shapes the listing has to
 * get right (two versions, a remix and its parent, a hidden app, a linked
 * app, declared capabilities and storage policies, comments, ratings, daily
 * runs), and expected.json, every answer the queries in queries.mjs give
 * for it. The catalogue code is what produces expected.json, so run this
 * only from a revision whose answers are known to be right, and read the
 * diff before committing it: the test compares the current code against
 * this file field for field.
 *
 * The bundles are written with a fixed entry time and committed as bytes,
 * so their digests are stable across fflate versions; every timestamp in
 * app.json is fixed for the same reason.
 *
 *   node test/fixtures/catalog/make.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { copyFixture, snapshot } from './queries.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { zipSync, strToU8 } = require('fflate');

const T0 = 1735689600; // 2025-01-01T00:00:00Z
const mtime = new Date(T0 * 1000);

function bundle(name, { version = '1.0.0', description, permissions, extra = {} }) {
  const files = {
    'manifest.json': [strToU8(JSON.stringify({ name, version, description, main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] }, author: 'Ada' })), { mtime }],
    'ui/main.ui': [strToU8(`<App><Text>${name}</Text></App>\n`), { mtime }],
    'logic/main.logic': [strToU8('let x = 1\n'), { mtime }],
  };
  if (permissions) files['permission.json'] = [strToU8(JSON.stringify({ permissions })), { mtime }];
  for (const [k, v] of Object.entries(extra)) files[k] = [v, { mtime }];
  return zipSync(files, { mtime });
}

const APPS = {
  alpha: {
    bundles: {
      'v1.softn': bundle('Alpha Harbour', { description: 'Build a harbour city that tells a story.' }),
      'v2.softn': bundle('Alpha Harbour', { version: '1.1.0', description: 'Build a harbour city that tells a story. Now with tides.' }),
    },
    app: { name: 'Alpha Harbour', category: 'games', tags: ['city', 'harbour'], author: 'Ada', runs: 40, launches: 12, rating_sum: 13, rating_count: 3, comments: 1, edit_key_hash: 'a'.repeat(64), primary_color: '#3366cc', created_at: T0, updated_at: T0 + 86400 },
    versions: [
      { file: 'v2.softn', notes: 'Tides.', created_at: T0 + 86400 },
      { file: 'v1.softn', notes: '', created_at: T0 },
    ],
    comments: [
      { id: 1, slug: 'alpha', name: 'Bea', body: 'Lovely.', visitor: 'v1', hidden: 0, created_at: T0 + 100 },
      { id: 2, slug: 'alpha', name: 'Spam', body: 'hidden', visitor: 'v2', hidden: 1, created_at: T0 + 200 },
    ],
    ratings: [
      { visitor: 'v1', stars: 5, created_at: T0 },
      { visitor: 'v2', stars: 4, created_at: T0 },
      { visitor: 'v3', stars: 4, created_at: T0 },
    ],
    runsDaily: [{ day: Math.floor(T0 / 86400), count: 40 }],
  },
  'beta-lantern': {
    bundles: { 'v1.softn': bundle('Beta Lantern', { description: 'A remix of the harbour with lanterns.' }) },
    app: { name: 'Beta Lantern', category: 'games', tags: ['city'], author: 'Ben', parent_slug: 'alpha', root_slug: 'alpha', runs: 3, created_at: T0 + 3600, updated_at: T0 + 3600 },
    versions: [{ file: 'v1.softn', notes: '', created_at: T0 + 3600 }],
  },
  gamma: {
    bundles: { 'v1.softn': bundle('Gamma Hidden', { description: 'Hidden from the listing.' }) },
    app: { name: 'Gamma Hidden', category: 'tools', tags: [], author: 'Ada', hidden: 1, created_at: T0 + 7200, updated_at: T0 + 7200 },
    versions: [{ file: 'v1.softn', notes: '', created_at: T0 + 7200 }],
  },
  delta: {
    bundles: {},
    app: { name: 'Delta Elsewhere', category: 'other', tags: ['linked'], author: 'Dee', description: 'Plays on its own site.', play_url: 'https://delta.example/', created_at: T0 + 10800, updated_at: T0 + 10800 },
    versions: [],
  },
  epsilon: {
    bundles: {
      'v1.softn': bundle('Epsilon Notes', {
        description: 'Shared notes with storage.',
        permissions: { net: { enabled: true }, storage: { enabled: true, collections: { notes: 'owner-write', '*': 'public' } } },
      }),
    },
    app: { name: 'Epsilon Notes', category: 'productivity', tags: ['notes'], author: 'Eve', runs: 7, rating_sum: 3, rating_count: 1, created_at: T0 + 14400, updated_at: T0 + 14400 },
    versions: [{ file: 'v1.softn', notes: '', created_at: T0 + 14400 }],
    ratings: [{ visitor: 'v9', stars: 3, created_at: T0 }],
  },
};

const dataDir = path.join(here, 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
for (const [slug, spec] of Object.entries(APPS)) {
  const dir = path.join(dataDir, 'apps', slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, bytes] of Object.entries(spec.bundles)) fs.writeFileSync(path.join(dir, file), bytes);
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ schemaVersion: 1, app: { slug, ...spec.app } }, null, 2) + '\n');
}

// Let the catalogue complete every app.json once (versions, digests,
// capabilities from the bundles), then pin the timestamps it chose.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-fixture-'));
try {
  copyFixture(dataDir, scratch);
  snapshot(scratch);
  for (const [slug, spec] of Object.entries(APPS)) {
    const doc = JSON.parse(fs.readFileSync(path.join(scratch, 'apps', slug, 'app.json'), 'utf8'));
    doc.app.created_at = spec.app.created_at;
    doc.app.updated_at = spec.app.updated_at;
    const pinned = new Map(spec.versions.map((v) => [v.file, v]));
    doc.versions = doc.versions.map((v) => ({ ...v, notes: pinned.get(v.file)?.notes ?? '', created_at: pinned.get(v.file)?.created_at ?? spec.app.created_at }));
    doc.comments = spec.comments ?? [];
    doc.ratings = spec.ratings ?? [];
    doc.runsDaily = spec.runsDaily ?? [];
    fs.writeFileSync(path.join(dataDir, 'apps', slug, 'app.json'), JSON.stringify(doc, null, 2) + '\n');
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// A second pass over the finished fixture must change nothing on disk; its answers are the expectation.
const check = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-fixture-'));
try {
  copyFixture(dataDir, check);
  const before = Object.fromEntries(Object.keys(APPS).map((s) => [s, fs.readFileSync(path.join(check, 'apps', s, 'app.json'), 'utf8')]));
  const answers = snapshot(check);
  for (const s of Object.keys(APPS)) {
    if (fs.readFileSync(path.join(check, 'apps', s, 'app.json'), 'utf8') !== before[s]) throw new Error(`the catalogue rewrote ${s}/app.json; the fixture is not settled`);
  }
  fs.writeFileSync(path.join(here, 'expected.json'), JSON.stringify(answers, null, 2) + '\n');
  console.log(`wrote ${path.join(here, 'expected.json')} (${Object.keys(answers).length} answers) and ${Object.keys(APPS).length} app folders`);
} finally {
  fs.rmSync(check, { recursive: true, force: true });
}
