#!/usr/bin/env node
/**
 * Fetch the demo bundles softn.com serves from the softn-Examples release they
 * are pinned to.
 *
 * The demos' sources live in f2i-com/softn-Examples, whose Release workflow
 * packs them and publishes the archives; this repository carries no copies.
 * apps/softn-web/public/demos/index.json is the pin: each entry names its
 * archive's download URL, size and SHA-256. This script downloads any archive
 * that is missing or does not match its digest, refuses to keep one that does
 * not verify, and leaves a matching one alone, so it is cheap to run before
 * every dev server, site build and test run. The archives are ignored by git.
 *
 *   node scripts/fetch-demos.mjs              fetch whatever is missing or stale
 *   node scripts/fetch-demos.mjs --check      verify only; exit 1 if anything is missing or stale
 *   node scripts/fetch-demos.mjs --pin v1.0.1 read that release's catalogue.json from
 *                                             softn-Examples, rewrite the source, size and
 *                                             sha256 of every matching index.json entry,
 *                                             then fetch
 *
 * GH_TOKEN or GITHUB_TOKEN, if set, is sent as a bearer token. The examples
 * repository is public, so none is needed; a private fork of it would need one.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demosDir = path.join(root, 'apps/softn-web/public/demos');
const indexPath = path.join(demosDir, 'index.json');
const DEFAULT_REPO = 'f2i-com/softn-Examples';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const pinIndex = args.indexOf('--pin');
const pinTag = pinIndex >= 0 ? args[pinIndex + 1] : null;
const repoIndex = args.indexOf('--repo');
const repo = repoIndex >= 0 ? args[repoIndex + 1] : DEFAULT_REPO;
if (pinIndex >= 0 && !/^v\d+\.\d+\.\d+$/.test(pinTag || '')) {
  console.error('ERROR: --pin needs a tag such as v1.0.1');
  process.exit(1);
}
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error(`ERROR: --repo must be owner/name, not ${repo}`);
  process.exit(1);
}

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

function isSafeBundleName(name) {
  return (
    typeof name === 'string' &&
    path.basename(name) === name &&
    /^[A-Za-z0-9._-]+\.softn$/.test(name)
  );
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readIndex() {
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!Array.isArray(index) || index.length === 0) {
    throw new Error(`${path.relative(root, indexPath)} must be a non-empty array`);
  }
  for (const entry of index) {
    if (!entry || !isSafeBundleName(entry.file)) {
      throw new Error(
        `index.json entry has an unsafe file name: ${JSON.stringify(entry && entry.file)}`
      );
    }
  }
  return index;
}

function writeIndex(index) {
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

async function download(url, { attempts = 3 } = {}) {
  if (!/^https:\/\//.test(url)) throw new Error(`refusing a non-https source: ${url}`);
  const headers = { 'User-Agent': 'softn.com fetch-demos', Accept: 'application/octet-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { headers, redirect: 'follow' });
      if (response.status >= 500 && attempt < attempts) {
        lastError = new Error(`HTTP ${response.status}`);
      } else if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      } else {
        return Buffer.from(await response.arrayBuffer());
      }
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
  throw new Error(`could not download ${url}: ${lastError.message}`);
}

async function pin(index, tag) {
  const url = `https://github.com/${repo}/releases/download/${tag}/catalogue.json`;
  console.log(`Pinning the demos to ${repo} ${tag} (${url})`);
  const catalogue = JSON.parse((await download(url)).toString('utf8'));
  const published = new Map();
  for (const bundle of [...(catalogue.bundles || []), ...(catalogue.unlisted || [])]) {
    if (isSafeBundleName(bundle.file)) published.set(bundle.file, bundle);
  }
  if (published.size === 0) throw new Error(`the catalogue for ${tag} lists no bundles`);

  const missing = [];
  let changed = 0;
  for (const entry of index) {
    const bundle = published.get(entry.file);
    if (!bundle) {
      missing.push(entry.file);
      continue;
    }
    if (typeof bundle.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(bundle.sha256)) {
      throw new Error(`${entry.file}: the catalogue carries no SHA-256`);
    }
    if (typeof bundle.source !== 'string')
      throw new Error(`${entry.file}: the catalogue carries no source URL`);
    if (typeof bundle.size !== 'number')
      throw new Error(`${entry.file}: the catalogue carries no size`);
    if (
      entry.source !== bundle.source ||
      entry.sha256 !== bundle.sha256 ||
      entry.size !== bundle.size
    )
      changed++;
    entry.source = bundle.source;
    entry.sha256 = bundle.sha256;
    entry.size = bundle.size;
  }
  if (missing.length) {
    throw new Error(`index.json lists bundles that ${tag} does not publish: ${missing.join(', ')}`);
  }
  const listed = new Set(index.map((entry) => entry.file));
  const unused = [...published.keys()].filter((file) => !listed.has(file)).sort();
  if (unused.length) console.log(`  (published but not in index.json: ${unused.join(', ')})`);
  writeIndex(index);
  console.log(
    `  ${changed} of ${index.length} entries updated in ${path.relative(root, indexPath)}`
  );
}

async function main() {
  const index = readIndex();
  if (pinTag) await pin(index, pinTag);

  fs.mkdirSync(demosDir, { recursive: true });
  let verified = 0;
  let fetched = 0;
  const problems = [];
  for (const entry of index) {
    const target = path.join(demosDir, entry.file);
    if (
      typeof entry.source !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      typeof entry.size !== 'number'
    ) {
      problems.push(
        `${entry.file} is not pinned to a release (no source, sha256 or size); run --pin <tag>`
      );
      continue;
    }
    if (fs.existsSync(target)) {
      const bytes = fs.readFileSync(target);
      if (bytes.length === entry.size && sha256(bytes) === entry.sha256) {
        verified++;
        continue;
      }
      if (checkOnly) {
        problems.push(`${entry.file} on disk does not match its pinned digest`);
        continue;
      }
      console.log(`  ${entry.file} does not match its pinned digest; fetching`);
    } else if (checkOnly) {
      problems.push(`${entry.file} is missing`);
      continue;
    }

    let bytes;
    try {
      bytes = await download(entry.source);
    } catch (error) {
      problems.push(error.message);
      continue;
    }
    const digest = sha256(bytes);
    if (bytes.length !== entry.size || digest !== entry.sha256) {
      problems.push(
        `${entry.file} from ${entry.source} is ${bytes.length} bytes with digest ${digest}, but index.json pins ${entry.size} bytes and ${entry.sha256}`
      );
      continue;
    }
    const temporary = `${target}.download`;
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, target);
    fetched++;
    console.log(`  fetched ${entry.file} (${(bytes.length / 1024).toFixed(0)} KB)`);
  }

  // An archive nobody pins should not be served either: it would be unlisted
  // and, on the site build, refused as such.
  const pinned = new Set(index.map((entry) => entry.file.toLowerCase()));
  const strays = fs
    .readdirSync(demosDir)
    .filter((name) => name.toLowerCase().endsWith('.softn') && !pinned.has(name.toLowerCase()));
  for (const stray of strays)
    problems.push(`${stray} is in ${path.relative(root, demosDir)} but not in index.json`);

  if (problems.length) {
    for (const problem of problems) console.error(`ERROR: ${problem}`);
    process.exit(1);
  }
  console.log(
    `Demo bundles: ${verified} verified, ${fetched} fetched, ${index.length} pinned in ${path.relative(root, indexPath)}`
  );
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
