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
 *   node scripts/fetch-demos.mjs --pin v1.0.1 --catalogue ../softn-Examples/dist/catalogue.json
 *                                             the same, from a catalogue built locally with
 *                                             `build-release.cjs --expect-tag v1.0.1`: the build
 *                                             is reproducible, so the pin can be prepared before
 *                                             the tag is pushed, and checked against the local
 *                                             archives until the release exists
 *
 * What it will not do:
 *
 * - Send a credential anywhere but GitHub. Public release assets need none,
 *   and none is sent unless the source is the pinned repository on
 *   github.com; a token in GH_TOKEN or GITHUB_TOKEN used to be attached to
 *   every https source the catalogue named, which made a catalogue edit a
 *   way to read the token. When one is sent, redirects are followed by hand
 *   and the credential stays on the first hop.
 * - Read more than an archive declares. A download is streamed against its
 *   pinned size and cut off the moment it exceeds it, with a deadline on the
 *   whole transfer, so a wrong or hostile source cannot fill the disk or
 *   hang the build.
 * - Leave the served set half replaced. Every archive is downloaded and
 *   verified into a staging file first; the served files change only once
 *   all of them have, and a failure anywhere leaves what was there before.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demosDir = path.join(root, 'apps/softn-web/public/demos');
const indexPath = path.join(demosDir, 'index.json');
const DEFAULT_REPO = 'f2i-com/softn-Examples';

/** The only hosts a credential may be sent to, and only for the pinned repository's own paths. */
const CREDENTIAL_HOSTS = new Set(['github.com', 'api.github.com']);
/** How long one archive may take, end to end. */
const TRANSFER_DEADLINE_MS = 120_000;
/** How long a catalogue may take; it is a few kilobytes. */
const CATALOGUE_DEADLINE_MS = 30_000;
/** The most a catalogue may be, which is far more than one has ever been. */
const MAX_CATALOGUE_BYTES = 1024 * 1024;
/** How many redirects a download may follow. GitHub's release assets take one. */
const MAX_REDIRECTS = 5;

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const pinIndex = args.indexOf('--pin');
const pinTag = pinIndex >= 0 ? args[pinIndex + 1] : null;
const repoIndex = args.indexOf('--repo');
const repo = repoIndex >= 0 ? args[repoIndex + 1] : DEFAULT_REPO;
const catalogueIndex = args.indexOf('--catalogue');
const catalogueFile = catalogueIndex >= 0 ? args[catalogueIndex + 1] : null;
if (catalogueIndex >= 0 && (!catalogueFile || !pinTag)) {
  console.error('ERROR: --catalogue takes a file and goes with --pin');
  process.exit(1);
}
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
  return typeof name === 'string' && path.basename(name) === name && /^[A-Za-z0-9._-]+\.softn$/.test(name);
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isSize(value) {
  return Number.isInteger(value) && value > 0;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Whether a credential may accompany a request to `url`: GitHub itself, and
 * only the pinned repository's own release and API paths. Anything else —
 * another host, another repository, a redirect target — goes anonymously.
 */
export function mayCarryCredential(url, repository = repo) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || !CREDENTIAL_HOSTS.has(parsed.hostname)) return false;
  const prefix = `/${repository}/`;
  return parsed.pathname.startsWith(prefix) || parsed.pathname.startsWith(`/repos${prefix}`);
}

function readIndex() {
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!Array.isArray(index) || index.length === 0) {
    throw new Error(`${path.relative(root, indexPath)} must be a non-empty array`);
  }
  const seen = new Set();
  for (const entry of index) {
    if (!entry || !isSafeBundleName(entry.file)) {
      throw new Error(`index.json entry has an unsafe file name: ${JSON.stringify(entry && entry.file)}`);
    }
    const lower = entry.file.toLowerCase();
    if (seen.has(lower)) throw new Error(`index.json lists ${entry.file} more than once`);
    seen.add(lower);
  }
  return index;
}

function writeIndex(index) {
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

/**
 * Download `url` to a Buffer, reading no more than `maxBytes` and taking no
 * longer than `deadlineMs`. Redirects are followed by hand so that a
 * credential, when one is sent at all, goes to the first hop only: GitHub
 * answers a release download with a redirect to its object store, and the
 * object store must not see the token.
 */
async function download(url, { maxBytes, deadlineMs, attempts = 3 }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`took longer than ${deadlineMs / 1000}s`)), deadlineMs);
    try {
      return await downloadOnce(url, { maxBytes, signal: controller.signal });
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`could not download ${url}: ${lastError.message}`);
}

async function downloadOnce(url, { maxBytes, signal }) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!/^https:\/\//.test(current)) throw new Error(`refusing a non-https source: ${current}`);
    const headers = { 'User-Agent': 'softn.com fetch-demos', Accept: 'application/octet-stream' };
    if (token && mayCarryCredential(current)) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(current, { headers, redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`HTTP ${response.status} without a location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} for ${current}`);
      error.retryable = response.status >= 500 || response.status === 429;
      throw error;
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`${current} announces ${declared} bytes, more than the ${maxBytes} pinned`);
    }
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > maxBytes) {
        throw new Error(`${current} sent more than the ${maxBytes} bytes pinned; stopped reading`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects from ${url}`);
}

async function pin(index, tag) {
  let catalogue;
  if (catalogueFile) {
    console.log(`Pinning the demos to ${repo} ${tag} from ${catalogueFile}`);
    catalogue = JSON.parse(fs.readFileSync(catalogueFile, 'utf8'));
    if (catalogue.tag !== tag) throw new Error(`${catalogueFile} was built for ${catalogue.tag ?? 'no tag'}, not ${tag}`);
  } else {
    const url = `https://github.com/${repo}/releases/download/${tag}/catalogue.json`;
    console.log(`Pinning the demos to ${repo} ${tag} (${url})`);
    catalogue = JSON.parse(
      (await download(url, { maxBytes: MAX_CATALOGUE_BYTES, deadlineMs: CATALOGUE_DEADLINE_MS })).toString('utf8')
    );
  }
  const published = new Map();
  for (const bundle of [...(catalogue.bundles || []), ...(catalogue.unlisted || [])]) {
    if (!isSafeBundleName(bundle.file)) continue;
    if (published.has(bundle.file)) throw new Error(`the catalogue for ${tag} lists ${bundle.file} twice`);
    published.set(bundle.file, bundle);
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
    if (!isSha256(bundle.sha256)) throw new Error(`${entry.file}: the catalogue carries no SHA-256`);
    if (typeof bundle.source !== 'string' || !/^https:\/\//.test(bundle.source)) {
      throw new Error(`${entry.file}: the catalogue carries no https source URL`);
    }
    if (!isSize(bundle.size)) throw new Error(`${entry.file}: the catalogue carries no size`);
    if (entry.source !== bundle.source || entry.sha256 !== bundle.sha256 || entry.size !== bundle.size) changed++;
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
  console.log(`  ${changed} of ${index.length} entries updated in ${path.relative(root, indexPath)}`);
}

async function main() {
  const index = readIndex();
  if (pinTag) await pin(index, pinTag);

  fs.mkdirSync(demosDir, { recursive: true });
  let verified = 0;
  const problems = [];
  /** Archives downloaded and verified into a staging file, waiting to be moved into place together. */
  const staged = [];
  for (const entry of index) {
    const target = path.join(demosDir, entry.file);
    if (typeof entry.source !== 'string' || !isSha256(entry.sha256) || !isSize(entry.size)) {
      problems.push(`${entry.file} is not pinned to a release (no source, sha256 or size); run --pin <tag>`);
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
      bytes = await download(entry.source, { maxBytes: entry.size, deadlineMs: TRANSFER_DEADLINE_MS });
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
    staged.push({ file: entry.file, temporary, target, size: bytes.length });
  }

  // An archive nobody pins should not be served either: it would be unlisted
  // and, on the site build, refused as such.
  const pinned = new Set(index.map((entry) => entry.file.toLowerCase()));
  const strays = fs
    .readdirSync(demosDir)
    .filter((name) => name.toLowerCase().endsWith('.softn') && !pinned.has(name.toLowerCase()));
  for (const stray of strays) problems.push(`${stray} is in ${path.relative(root, demosDir)} but not in index.json`);

  if (problems.length) {
    for (const { temporary } of staged) fs.rmSync(temporary, { force: true });
    for (const problem of problems) console.error(`ERROR: ${problem}`);
    if (staged.length) console.error(`ERROR: nothing was changed; ${staged.length} verified download(s) were discarded with the rest`);
    process.exit(1);
  }
  for (const { temporary, target, file, size } of staged) {
    fs.renameSync(temporary, target);
    console.log(`  fetched ${file} (${(size / 1024).toFixed(0)} KB)`);
  }
  console.log(
    `Demo bundles: ${verified} verified, ${staged.length} fetched, ${index.length} pinned in ${path.relative(root, indexPath)}`
  );
}

// Run only as a script: the credential rule above is imported by its test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}
