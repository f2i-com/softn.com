#!/usr/bin/env node
/**
 * Install the ZIPP engine into `wasm-zipp/` from a published zipp.org release,
 * and check an install. `wasm-zipp/` is generated, never committed: the build,
 * test, typecheck and licence hooks run --ensure.
 *
 *   node scripts/fetch-zipp-release.mjs [vX.Y.Z]         install a release (no tag: the declared one)
 *   node scripts/fetch-zipp-release.mjs --latest         install the latest release
 *   node scripts/fetch-zipp-release.mjs --check          verify the install, offline
 *   node scripts/fetch-zipp-release.mjs --check --online and against the published release
 *   node scripts/fetch-zipp-release.mjs --resolve-only [vX.Y.Z | --latest]   print {release, sumsSha256}
 *   node scripts/fetch-zipp-release.mjs --ensure         install unless the declared release checks
 *   node scripts/fetch-zipp-release.mjs --install-local <dir>       a build-zipp-wasm.mjs output
 *
 * The declared release is the zipp-vm tag in apps/softn-host-rust/Cargo.toml:
 * one commit builds against one ZIPP in every job, and a new ZIPP release
 * never changes an existing commit's result. Only the release gate
 * (scripts/zipp-release-gate.mjs) asks for the latest.
 *
 * Environment: ZIPP_RELEASE=vX.Y.Z names the release; ZIPP_RELEASE_DIR=<dir>
 * reads SHA256SUMS and the bundle from a folder instead of GitHub (offline);
 * ZIPP_SUMS_SHA256 is the digest the release's SHA256SUMS must have; ZIPP_OUT
 * installs somewhere other than wasm-zipp/.
 *
 * Only the web-python bundle is taken: the web bundle has no Python, a 1 MiB
 * stack and different glue. The bundle must match ZIPP's top-level SHA256SUMS,
 * every file taken from it the bundle's own SHA256SUMS, BUILD-INFO.txt must
 * describe that variant, and the module itself must report the release's
 * commit. Nothing is post-processed: a changed byte breaks that chain.
 *
 * SOURCE.json records the release, both SHA256SUMS digests and where the
 * third-party notices came from. The bundle ships none, so the RustPython and
 * Unicode notices come from zipp-notices/ ('softn-curated') until it does.
 *
 * Installs into one folder take turns under `.wasm-zipp.lock` beside it, and
 * are staged there and swapped in whole.
 *
 * Node built-ins only at the top: fflate is imported where a bundle is
 * unzipped, so --check and --resolve-only run without node_modules.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'https://github.com/f2i-com/zipp.org';
const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(CORE, '../../..');
export const ENGINE_DIR = path.join(CORE, 'wasm-zipp');
export const CURATED_NOTICES = path.join(CORE, 'zipp-notices', 'THIRD_PARTY_LICENSES.txt');
export const CACHE_DIR = path.join(ROOT, '.zipp-release');
export const CARGO_TOML = path.join(ROOT, 'apps/softn-host-rust/Cargo.toml');

export const VARIANT = 'javascript-python';
export const LANGUAGES = ['javascript', 'python'];
export const STACK_BYTES = 16777216;
export const NOTICES = 'THIRD_PARTY_LICENSES.txt';
/** Taken from the bundle byte for byte. SHA256SUMS is the bundle's own, verbatim. */
export const BUNDLE_FILES = ['zipp_wasm.js', 'zipp_wasm.d.ts', 'zipp_wasm_bg.wasm', 'zipp_wasm_bg.wasm.d.ts', 'LICENSE-APACHE', 'BUILD-INFO.txt', 'PROFILE.json', 'SHA256SUMS'];
/** An install is exactly these: the bundle files, ZIPP's top-level SHA256SUMS, the notices, SOURCE.json. */
export const INSTALLED_FILES = [...BUNDLE_FILES, 'RELEASE-SHA256SUMS', NOTICES, 'SOURCE.json'];

/** A refusal: the release, the bundle or the install is not what it has to be. */
export class ZippReleaseError extends Error {}
const refuse = (message) => {
  throw new ZippReleaseError(message);
};

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const isReleaseTag = (tag) => /^v\d+\.\d+\.\d+$/.test(tag ?? '');
export const bundleName = (version) => `zipp-wasm-${version}-web-python`;
/** Negative, zero or positive as release tag `a` is older than, the same as or newer than `b`. */
export const compareReleases = (a, b) => {
  const [x, y] = [a, b].map((t) => t.slice(1).split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
const HEX64 = /^[0-9a-f]{64}$/;
const rel = (p) => path.relative(ROOT, p).replaceAll('\\', '/') || '.';

/** SHA256SUMS lines are `<hex>  <name>` (or `<hex> *<name>`). */
export function parseSums(text) {
  const sums = new Map();
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

/** BUILD-INFO.txt lines are `key=value`; a value may itself hold `=`. */
export function parseBuildInfo(text) {
  const info = {};
  for (const line of String(text).split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) info[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return info;
}

function buildInfoLanguages(info) {
  try {
    return JSON.parse(info.languages);
  } catch {
    return undefined;
  }
}

/** What BUILD-INFO.txt must say, as problems; `expected` holds version, revision (optional), variant, languages, stackBytes. */
function buildInfoProblems(info, expected) {
  const problems = [];
  if (info.version !== expected.version) problems.push(`BUILD-INFO.txt says version ${info.version}, not ${expected.version}`);
  if (!/^[0-9a-f]{40}$/.test(info.commit ?? '')) problems.push(`BUILD-INFO.txt commit "${info.commit}" is not a full 40-hex commit`);
  else if (expected.revision !== undefined && info.commit !== expected.revision) problems.push(`BUILD-INFO.txt commit ${info.commit} is not the recorded revision ${expected.revision}`);
  if (info.variant !== expected.variant) problems.push(`BUILD-INFO.txt variant is ${info.variant}, not ${expected.variant} (only the web-python bundle carries Python and the 16 MiB stack)`);
  if (!isDeepStrictEqual(buildInfoLanguages(info), expected.languages)) problems.push(`BUILD-INFO.txt languages are ${info.languages}, not ${JSON.stringify(expected.languages)}`);
  if (Number(info['stack-bytes']) !== expected.stackBytes) problems.push(`BUILD-INFO.txt stack-bytes is ${info['stack-bytes']}, not ${expected.stackBytes}`);
  return problems;
}

const fail = (what, problems) => {
  if (problems.length) refuse(`${what}:\n  - ${problems.join('\n  - ')}`);
};

// ---------------------------------------------------------------------------
// Where the release comes from
// ---------------------------------------------------------------------------
const releaseUrl = (tag, name) => `${REPOSITORY}/releases/download/${tag}/${name}`;
// GitHub's redirect to the newest release's asset: no API call, no token, no rate limit.
const LATEST_SUMS_URL = `${REPOSITORY}/releases/latest/download/SHA256SUMS`;

async function download(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    const unreachable = new ZippReleaseError(`could not fetch ${url}: ${error.message}`);
    unreachable.unreachable = true;
    throw unreachable;
  }
  refuse(`${url} answered ${response.status}`);
}

function readReleaseFile(releaseDir, name) {
  const file = path.join(releaseDir, name);
  if (!fs.existsSync(file)) refuse(`ZIPP_RELEASE_DIR ${releaseDir} holds no ${name}`);
  return fs.readFileSync(file);
}

/** The one web-python version a SHA256SUMS lists. */
export function versionFromSums(sums) {
  const versions = [...parseSums(sums).keys()].map((n) => /^zipp-wasm-(\d+\.\d+\.\d+)-web-python\.zip$/.exec(n)?.[1]).filter(Boolean);
  if (versions.length !== 1) refuse(`SHA256SUMS lists ${versions.length} web-python bundles; expected exactly one`);
  return versions[0];
}

/**
 * The repository's declared ZIPP release: the zipp-vm tag the Rust host builds
 * with (scripts/engine-pin.test.mjs holds the browser engine to it).
 */
export function declaredRelease(cargoToml = CARGO_TOML) {
  let text;
  try {
    text = fs.readFileSync(cargoToml, 'utf8');
  } catch (error) {
    refuse(`cannot read the declared ZIPP release from ${rel(cargoToml)} (${error.code ?? error.message}); name a release (vX.Y.Z), set ZIPP_RELEASE, or pass --latest`);
  }
  const tag = /^zipp-vm\s*=\s*\{[^}]*tag\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  if (!isReleaseTag(tag)) refuse(`${rel(cargoToml)} declares no zipp-vm release tag (vX.Y.Z)${tag ? `, only "${tag}"` : ''}`);
  return tag;
}

/**
 * A tag's SHA256SUMS from GitHub. Offline, a release downloaded earlier is
 * named rather than used behind the caller's back: the cache is a folder
 * ZIPP_RELEASE_DIR reads as it is.
 */
async function downloadSums(tag, { cacheDir, fetchImpl }) {
  try {
    return await download(releaseUrl(tag, 'SHA256SUMS'), fetchImpl);
  } catch (error) {
    const cached = path.resolve(cacheDir, tag);
    if (error.unreachable && fs.existsSync(path.join(cached, 'SHA256SUMS')) && fs.existsSync(path.join(cached, `${bundleName(tag.slice(1))}.zip`))) {
      refuse(`${error.message}; to install the ${tag} downloaded earlier without the network, set ZIPP_RELEASE_DIR=${cached}`);
    }
    throw error;
  }
}

/**
 * The release to take and its top-level SHA256SUMS bytes, which must list the
 * release's web-python bundle. A tag is taken as named; no tag means the
 * declared release; `latest` means GitHub's latest release, whose SHA256SUMS
 * must be byte for byte the one under its own tag, so the tag recorded is the
 * release really read.
 */
export async function resolveRelease({ tag, latest = false, releaseDir, cargoToml, cacheDir = CACHE_DIR, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (latest && tag) refuse('name a release or --latest, not both');
  if (!latest) {
    tag ??= declaredRelease(cargoToml);
    if (!isReleaseTag(tag)) refuse(`"${tag}" is not a ZIPP release tag (vMAJOR.MINOR.PATCH)`);
    const sums = releaseDir ? readReleaseFile(releaseDir, 'SHA256SUMS') : await downloadSums(tag, { cacheDir, fetchImpl });
    const bundle = `${bundleName(tag.slice(1))}.zip`;
    if (!parseSums(sums).has(bundle)) refuse(`the SHA256SUMS ${releaseDir ? `in ${releaseDir}` : `published under ${tag}`} does not list ${bundle}`);
    return { release: tag, sums };
  }
  const latestSums = await download(LATEST_SUMS_URL, fetchImpl);
  const release = `v${versionFromSums(latestSums)}`;
  const tagged = await download(releaseUrl(release, 'SHA256SUMS'), fetchImpl);
  if (!latestSums.equals(tagged)) refuse(`the latest release's SHA256SUMS is not the one published under ${release}; the latest release changed while it was read, so try again`);
  return { release, sums: tagged };
}

/** The bundle zip, checked against the top-level SHA256SUMS; downloads are cached per tag. */
async function loadBundle({ release, sums, releaseDir, cacheDir = CACHE_DIR, fetch: fetchImpl = globalThis.fetch }) {
  const name = `${bundleName(release.slice(1))}.zip`;
  const expected = parseSums(sums).get(name);
  if (!expected) refuse(`the ${release} SHA256SUMS does not list ${name}`);
  let zip;
  if (releaseDir) zip = readReleaseFile(releaseDir, name);
  else {
    const cached = path.join(cacheDir, release, name);
    zip = fs.existsSync(cached) ? fs.readFileSync(cached) : null;
    if (!zip || sha256(zip) !== expected) zip = await download(releaseUrl(release, name), fetchImpl);
  }
  const actual = sha256(zip);
  if (actual !== expected) refuse(`${name} has sha256 ${actual}; the ${release} SHA256SUMS says ${expected}`);
  if (!releaseDir) {
    // Best effort, and whole files only: another install may be reading the cache.
    try {
      fs.mkdirSync(path.join(cacheDir, release), { recursive: true });
      for (const [file, bytes] of [['SHA256SUMS', sums], [name, zip]]) {
        const target = path.join(cacheDir, release, file);
        const partial = `${target}.${process.pid}-${randomBytes(4).toString('hex')}.partial`;
        fs.writeFileSync(partial, bytes);
        try {
          renameWithRetry(partial, target);
        } finally {
          fs.rmSync(partial, { force: true });
        }
      }
    } catch {}
  }
  return zip;
}

async function unzipBundle(zip, version) {
  const { unzipSync } = await import('fflate');
  const entries = unzipSync(new Uint8Array(zip.buffer, zip.byteOffset, zip.byteLength));
  const prefix = `${bundleName(version)}/`;
  const files = new Map();
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.startsWith(prefix) && !name.endsWith('/')) files.set(name.slice(prefix.length), Buffer.from(bytes));
  }
  return files;
}

// ---------------------------------------------------------------------------
// Verify a release and build the install
// ---------------------------------------------------------------------------

/** What the module reports about itself, from its own glue; nothing is written to disk for this. */
async function engineProfile(glue, wasm) {
  // A data: URL per call: each import is a fresh module with its own instance,
  // so a second bundle in the same process is not answered by the first.
  const source = Buffer.concat([glue, Buffer.from(`\n// ${randomBytes(8).toString('hex')}\n`)]);
  const module = await import(`data:text/javascript;base64,${source.toString('base64')}`);
  module.initSync({ module: wasm });
  return JSON.parse(module.zippProfile());
}

/**
 * Verify a release's SHA256SUMS and bundle all the way down and return the
 * files to install with their SOURCE.json. Refuses with ZippReleaseError.
 */
export async function verifyRelease({ release, sums, zip, expectSumsSha256, curatedNotices = CURATED_NOTICES }) {
  if (!isReleaseTag(release)) refuse(`"${release}" is not a ZIPP release tag`);
  const version = release.slice(1);
  const sumsSha256 = sha256(sums);
  if (expectSumsSha256 && sumsSha256 !== expectSumsSha256.toLowerCase()) refuse(`the ${release} SHA256SUMS has sha256 ${sumsSha256}; ZIPP_SUMS_SHA256 says ${expectSumsSha256}`);
  const bundle = `${bundleName(version)}.zip`;
  const bundleSha256 = parseSums(sums).get(bundle);
  if (!bundleSha256) refuse(`the ${release} SHA256SUMS does not list ${bundle}`);
  if (sha256(zip) !== bundleSha256) refuse(`${bundle} does not match the ${release} SHA256SUMS`);

  const entries = await unzipBundle(zip, version);
  if (!entries.has('SHA256SUMS')) refuse(`${bundle} carries no SHA256SUMS`);
  const inner = parseSums(entries.get('SHA256SUMS'));
  // Everything the bundle lists is what it lists, and everything taken from it is listed.
  for (const [name, digest] of inner) {
    if (!entries.has(name)) refuse(`${bundle} lists ${name} in its SHA256SUMS but does not carry it`);
    if (sha256(entries.get(name)) !== digest) refuse(`${name} in ${bundle} does not match the bundle's SHA256SUMS`);
  }
  const files = new Map();
  for (const name of BUNDLE_FILES) {
    if (!entries.has(name)) refuse(`${bundle} has no ${name}`);
    if (name !== 'SHA256SUMS' && !inner.has(name)) refuse(`${name} in ${bundle} is not listed in the bundle's SHA256SUMS`);
    files.set(name, entries.get(name));
  }

  const info = parseBuildInfo(entries.get('BUILD-INFO.txt'));
  fail(`${bundle} is not the ZIPP ${release} web-python build`, buildInfoProblems(info, { version, variant: VARIANT, languages: LANGUAGES, stackBytes: STACK_BYTES }));
  let profileFile;
  try {
    profileFile = JSON.parse(entries.get('PROFILE.json').toString('utf8'));
  } catch {
    refuse(`${bundle} PROFILE.json is not JSON`);
  }
  if (profileFile.version !== version) refuse(`${bundle} PROFILE.json says version ${profileFile.version}, not ${version}`);

  const glue = entries.get('zipp_wasm.js');
  const wasm = entries.get('zipp_wasm_bg.wasm');
  let profile;
  try {
    profile = await engineProfile(glue, wasm);
  } catch (error) {
    refuse(`the ${bundle} engine does not load: ${error.message}`);
  }
  fail(`the ${bundle} engine does not describe itself as ZIPP ${release}`, [
    ...(profile.version !== version ? [`zippProfile() version is ${profile.version}, not ${version}`] : []),
    ...(!profile.features?.includes('safe-sandbox') ? ['zippProfile() lacks the safe-sandbox feature'] : []),
    ...(!isDeepStrictEqual(profile.languages, LANGUAGES) ? [`zippProfile() languages are ${JSON.stringify(profile.languages)}, not ${JSON.stringify(LANGUAGES)}`] : []),
    ...(profile.source?.sha !== info.commit ? [`zippProfile() source.sha is ${profile.source?.sha}, not the BUILD-INFO.txt commit ${info.commit}`] : []),
  ]);

  let noticesSource;
  if (entries.has(NOTICES)) {
    if (!inner.has(NOTICES)) refuse(`${NOTICES} in ${bundle} is not listed in the bundle's SHA256SUMS`);
    files.set(NOTICES, entries.get(NOTICES));
    noticesSource = 'zipp-release';
  } else {
    if (!fs.existsSync(curatedNotices)) refuse(`${bundle} ships no ${NOTICES} and the curated copy ${rel(curatedNotices)} is missing`);
    files.set(NOTICES, fs.readFileSync(curatedNotices));
    noticesSource = 'softn-curated';
  }
  files.set('RELEASE-SHA256SUMS', sums);

  const source = {
    repository: REPOSITORY,
    release,
    version,
    revision: info.commit,
    build: 'release',
    bundle,
    bundleSha256,
    sumsSha256,
    variant: info.variant,
    languages: buildInfoLanguages(info),
    stackBytes: Number(info['stack-bytes']),
    rustc: info.rustc,
    wasmBindgen: (info['wasm-bindgen'] ?? '').replace(/^wasm-bindgen\s+/, ''),
    license: 'Apache-2.0',
    artifact: 'zipp_wasm_bg.wasm',
    sha256: sha256(wasm),
    glueSha256: sha256(glue),
    notices: { file: NOTICES, source: noticesSource, sha256: sha256(files.get(NOTICES)) },
  };
  files.set('SOURCE.json', Buffer.from(`${JSON.stringify(source, null, 2)}\n`));
  return { files, source };
}

// Windows refuses a rename now and then while a scanner holds a handle.
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(from, to);
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
    }
  }
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// An install takes seconds; a lock this old outlived its holder even if its pid was reused.
const LOCK_STALE_MS = 10 * 60_000;

/**
 * Run `fn` holding `.<folder>.lock` beside the install. Hooks started together
 * (npm test and npm run typecheck in two terminals) would otherwise swap
 * folders under each other; the one that waits finds the install done. A lock
 * whose process is gone, or that is older than any install, is taken over.
 */
export async function withInstallLock(dir, fn, { warn = console.warn } = {}) {
  const lock = path.join(path.dirname(dir), `.${path.basename(dir)}.lock`);
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
  } catch (error) {
    refuse(`cannot create ${rel(path.dirname(lock))} for a ZIPP install (${error.code ?? error.message})`);
  }
  const started = Date.now();
  let told = false;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') refuse(`cannot lock ${rel(dir)} for an install (${rel(lock)}: ${error.code ?? error.message})`);
    }
    let holder;
    let age;
    try {
      holder = fs.readFileSync(lock, 'utf8');
      age = Date.now() - fs.statSync(lock).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') continue; // released while it was read
      refuse(`cannot read the install lock ${rel(lock)} (${error.code ?? error.message}); if no install is running, delete it`);
    }
    const pid = Number(holder);
    // An empty lock is one being written this instant, unless it has been empty a while.
    const stale = age > LOCK_STALE_MS || (Number.isInteger(pid) && pid > 0 ? !pidAlive(pid) : age > 30_000);
    if (stale) {
      try {
        if (fs.readFileSync(lock, 'utf8') === holder) fs.rmSync(lock, { force: true });
      } catch {}
      continue;
    }
    if (Date.now() - started > LOCK_STALE_MS) refuse(`${rel(lock)} has been held by process ${holder || '(unknown)'} for ${Math.round(age / 1000)} s; if no install is running, delete it`);
    if (!told) warn(`Waiting for the ZIPP install another process (${holder || 'starting'}) is making into ${rel(dir)} ...`);
    told = true;
    await sleep(250);
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/**
 * Write the files to a sibling folder and swap it in, so a stale file from an
 * earlier install cannot survive and a failed write leaves the old install.
 * Callers hold the install lock; a filesystem failure is a refusal.
 */
export function writeInstall(dir, files) {
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  try {
    fs.mkdirSync(parent, { recursive: true });
    // Leftovers of an install that died; a live process's stage is its own.
    for (const leftover of fs.readdirSync(parent)) {
      const owner = new RegExp(`^\\.${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(?:stage|previous)-(\\d+)-`).exec(leftover);
      if (owner && (Number(owner[1]) === process.pid || !pidAlive(Number(owner[1])))) fs.rmSync(path.join(parent, leftover), { recursive: true, force: true });
    }
    const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`;
    const stage = path.join(parent, `.${base}.stage-${suffix}`);
    const previous = path.join(parent, `.${base}.previous-${suffix}`);
    fs.mkdirSync(stage);
    try {
      for (const [name, bytes] of files) fs.writeFileSync(path.join(stage, name), bytes);
      const had = fs.existsSync(dir);
      if (had) renameWithRetry(dir, previous);
      try {
        renameWithRetry(stage, dir);
      } catch (error) {
        if (had) renameWithRetry(previous, dir);
        throw error;
      }
      if (had) fs.rmSync(previous, { recursive: true, force: true });
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  } catch (error) {
    if (error instanceof ZippReleaseError) throw error;
    refuse(`could not write the install into ${rel(dir)}: ${error.message}`);
  }
}

async function installReleaseLocked({ dir, tag, latest, releaseDir, cargoToml, cacheDir, expectSumsSha256, fetch: fetchImpl = globalThis.fetch, curatedNotices, log = console.log }) {
  const { release, sums } = await resolveRelease({ tag, latest, releaseDir, cargoToml, cacheDir, fetch: fetchImpl });
  if (expectSumsSha256 && sha256(sums) !== expectSumsSha256.toLowerCase()) refuse(`the ${release} SHA256SUMS has sha256 ${sha256(sums)}; ZIPP_SUMS_SHA256 says ${expectSumsSha256}`);
  log(`Taking ${bundleName(release.slice(1))}.zip from ZIPP ${release}${releaseDir ? ` in ${releaseDir}` : ''} ...`);
  const zip = await loadBundle({ release, sums, releaseDir, cacheDir, fetch: fetchImpl });
  const { files, source } = await verifyRelease({ release, sums, zip, expectSumsSha256, curatedNotices });
  writeInstall(dir, files);
  // What landed on disk, not what was meant to.
  checkEngine(dir, { curatedNotices });
  log(`Installed ZIPP ${release} (${source.revision.slice(0, 8)}) into ${rel(dir)}; engine sha256 ${source.sha256}${source.notices.source === 'softn-curated' ? `; notices: the curated copy (${release} ships none)` : ''}`);
  return source;
}

/** Resolve, fetch (or read), verify and install a release. Returns its SOURCE.json. */
export async function installRelease({ dir = ENGINE_DIR, warn, ...options } = {}) {
  return withInstallLock(dir, () => installReleaseLocked({ dir, ...options }), { warn });
}

// ---------------------------------------------------------------------------
// Check an install
// ---------------------------------------------------------------------------

/**
 * Check an install offline and return its SOURCE.json. Every installed file
 * but SOURCE.json, RELEASE-SHA256SUMS and curated notices must be listed in
 * and match the bundle's SHA256SUMS (that list also names files an install
 * does not take, which is fine); RELEASE-SHA256SUMS must be the digest
 * recorded and list the bundle; BUILD-INFO.txt must agree with SOURCE.json.
 */
export function checkEngine(dir = ENGINE_DIR, { curatedNotices = CURATED_NOTICES } = {}) {
  const where = rel(dir);
  const sourceFile = path.join(dir, 'SOURCE.json');
  if (!fs.existsSync(sourceFile)) refuse(`${where} holds no ZIPP install (no SOURCE.json); run npm run fetch:zipp`);
  let source;
  try {
    source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  } catch (error) {
    refuse(`${where}/SOURCE.json is not JSON: ${error.message}`);
  }
  if (source.build !== 'release') refuse(`${where} holds a '${source.build}' ZIPP build, not a verified release install; run npm run fetch:zipp`);

  const problems = [];
  const present = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) problems.push(`${entry.name} is not a plain file`);
    else if (!INSTALLED_FILES.includes(entry.name)) problems.push(`${entry.name} is not part of an install`);
    else present.set(entry.name, fs.readFileSync(path.join(dir, entry.name)));
  }
  for (const name of INSTALLED_FILES) if (!present.has(name)) problems.push(`${name} is missing`);

  const version = source.version;
  if (source.repository !== REPOSITORY) problems.push(`SOURCE.json repository is ${source.repository}, not ${REPOSITORY}`);
  if (!isReleaseTag(source.release) || source.release !== `v${version}`) problems.push(`SOURCE.json release ${source.release} and version ${version} do not agree`);
  if (!/^[0-9a-f]{40}$/.test(source.revision ?? '')) problems.push('SOURCE.json revision is not a full commit');
  if (source.bundle !== `${bundleName(version)}.zip`) problems.push(`SOURCE.json bundle ${source.bundle} is not the web-python bundle`);
  for (const field of ['bundleSha256', 'sumsSha256', 'sha256', 'glueSha256']) if (!HEX64.test(source[field] ?? '')) problems.push(`SOURCE.json ${field} is not a sha256`);
  if (source.variant !== VARIANT || !isDeepStrictEqual(source.languages, LANGUAGES) || source.stackBytes !== STACK_BYTES) problems.push(`SOURCE.json records ${source.variant} ${JSON.stringify(source.languages)} with a ${source.stackBytes}-byte stack, not the web-python build`);
  if (source.artifact !== 'zipp_wasm_bg.wasm') problems.push(`SOURCE.json artifact is ${source.artifact}`);
  const notices = source.notices ?? {};
  if (notices.file !== NOTICES || !['zipp-release', 'softn-curated'].includes(notices.source) || !HEX64.test(notices.sha256 ?? '')) problems.push(`SOURCE.json notices ${JSON.stringify(source.notices)} are not recorded`);

  const inner = present.has('SHA256SUMS') ? parseSums(present.get('SHA256SUMS')) : new Map();
  // Shipped file to sums, never sums to files.
  const exempt = new Set(['SOURCE.json', 'RELEASE-SHA256SUMS', 'SHA256SUMS', ...(notices.source === 'softn-curated' ? [NOTICES] : [])]);
  for (const [name, bytes] of present) {
    if (exempt.has(name)) continue;
    if (!inner.has(name)) problems.push(`${name} is not listed in the bundle's SHA256SUMS`);
    else if (sha256(bytes) !== inner.get(name)) problems.push(`${name} does not match the bundle's SHA256SUMS`);
  }
  if (present.has('RELEASE-SHA256SUMS')) {
    const sums = present.get('RELEASE-SHA256SUMS');
    if (sha256(sums) !== source.sumsSha256) problems.push(`RELEASE-SHA256SUMS has sha256 ${sha256(sums)}, not the recorded ${source.sumsSha256}`);
    if (parseSums(sums).get(source.bundle) !== source.bundleSha256) problems.push(`RELEASE-SHA256SUMS does not list ${source.bundle} with the recorded ${source.bundleSha256}`);
  }
  if (present.has('BUILD-INFO.txt')) problems.push(...buildInfoProblems(parseBuildInfo(present.get('BUILD-INFO.txt')), { version, revision: source.revision, variant: source.variant, languages: source.languages, stackBytes: source.stackBytes }));
  if (present.has('PROFILE.json')) {
    let profileVersion;
    try {
      profileVersion = JSON.parse(present.get('PROFILE.json').toString('utf8')).version;
    } catch {}
    if (profileVersion !== version) problems.push(`PROFILE.json says version ${profileVersion}, not ${version}`);
  }
  if (present.has('zipp_wasm_bg.wasm') && sha256(present.get('zipp_wasm_bg.wasm')) !== source.sha256) problems.push(`zipp_wasm_bg.wasm is not the recorded ${source.sha256}`);
  if (present.has('zipp_wasm.js') && sha256(present.get('zipp_wasm.js')) !== source.glueSha256) problems.push(`zipp_wasm.js is not the recorded ${source.glueSha256}`);
  if (present.has(NOTICES)) {
    if (sha256(present.get(NOTICES)) !== notices.sha256) problems.push(`${NOTICES} is not the recorded ${notices.sha256}`);
    else if (notices.source === 'softn-curated' && !(fs.existsSync(curatedNotices) && fs.readFileSync(curatedNotices).equals(present.get(NOTICES)))) problems.push(`${NOTICES} is not the curated copy in ${rel(curatedNotices)}`);
  }
  fail(`the ZIPP install in ${where} does not check (run npm run fetch:zipp)`, problems);
  return source;
}

/** --check, then the install against the release as published now: ZIPP's SHA256SUMS and every file taken from the bundle. */
export async function checkEngineOnline(dir = ENGINE_DIR, { fetch: fetchImpl = globalThis.fetch, curatedNotices } = {}) {
  const source = checkEngine(dir, { curatedNotices });
  const problems = [];
  const sums = await download(releaseUrl(source.release, 'SHA256SUMS'), fetchImpl);
  if (!sums.equals(fs.readFileSync(path.join(dir, 'RELEASE-SHA256SUMS')))) problems.push(`RELEASE-SHA256SUMS is not the SHA256SUMS published under ${source.release}`);
  const zip = await download(releaseUrl(source.release, source.bundle), fetchImpl);
  if (sha256(zip) !== source.bundleSha256) problems.push(`the published ${source.bundle} is not the recorded ${source.bundleSha256}`);
  else {
    const entries = await unzipBundle(zip, source.version);
    for (const name of [...BUNDLE_FILES, ...(source.notices.source === 'zipp-release' ? [NOTICES] : [])]) {
      if (!entries.get(name)?.equals(fs.readFileSync(path.join(dir, name)))) problems.push(`${name} is not the file in the published ${source.bundle}`);
    }
  }
  fail(`the ZIPP install in ${rel(dir)} is not what ${source.release} publishes`, problems);
  return source;
}

const isCI = (env) => /^(1|true)$/i.test(env.CI ?? '');

/**
 * Install unless the install checks and is the release asked for (no tag: the
 * declared release) with any SHA256SUMS digest asked for. A local build is
 * never replaced behind its owner's back: a warning here, a refusal under CI.
 */
export async function ensureEngine({ dir = ENGINE_DIR, tag, expectSumsSha256, env = process.env, log = console.log, warn = console.warn, ...install } = {}) {
  // The lock covers the check as well: whoever waited finds the install done.
  return withInstallLock(dir, async () => {
    let installed;
    try {
      installed = JSON.parse(fs.readFileSync(path.join(dir, 'SOURCE.json'), 'utf8'));
    } catch {}
    if (installed?.build === 'local') {
      const message = `${rel(dir)} holds a local ZIPP build (${String(installed.revision).slice(0, 8)}), which --ensure never replaces; npm run fetch:zipp puts a release back`;
      if (isCI(env)) refuse(`${message}. CI builds only from a verified release.`);
      warn(`warning: ${message}.`);
      return { action: 'kept-local', source: installed };
    }
    const wanted = tag ?? declaredRelease(install.cargoToml);
    let reason;
    try {
      const source = checkEngine(dir, { curatedNotices: install.curatedNotices });
      if (source.release !== wanted) {
        reason = `${rel(dir)} holds ${source.release}, not ${wanted}${tag ? '' : ` (the release ${rel(install.cargoToml ?? CARGO_TOML)} declares)`}`;
        // A release installed by hand does not survive the next hook; say so, and how it would.
        warn(`warning: replacing ZIPP ${source.release} with ${wanted}; to build and test against ${source.release}, set ZIPP_RELEASE=${source.release} for every command.`);
      } else if (expectSumsSha256 && source.sumsSha256 !== expectSumsSha256.toLowerCase()) reason = `${rel(dir)} was installed from a SHA256SUMS other than ZIPP_SUMS_SHA256 ${expectSumsSha256.slice(0, 12)}`;
      else return { action: 'none', source };
    } catch (error) {
      if (!(error instanceof ZippReleaseError)) throw error;
      reason = error.message;
    }
    log(`Installing ZIPP ${wanted}: ${reason}`);
    return { action: 'installed', source: await installReleaseLocked({ dir, tag: wanted, expectSumsSha256, log, ...install }) };
  }, { warn });
}

/**
 * The install a release artifact may be built from: --ensure, then --check,
 * so a local build is refused here even though --ensure keeps it.
 */
export async function ensureReleaseEngine(options = {}) {
  await ensureEngine(options);
  return checkEngine(options.dir ?? ENGINE_DIR, { curatedNotices: options.curatedNotices });
}

/** What the environment asks of an install (ZIPP_RELEASE, ZIPP_RELEASE_DIR, ZIPP_SUMS_SHA256), for --ensure and callers that ensure in process. */
export function releaseOptions(env = process.env) {
  const expectSumsSha256 = env.ZIPP_SUMS_SHA256 || undefined;
  if (expectSumsSha256 && !HEX64.test(expectSumsSha256.toLowerCase())) refuse('ZIPP_SUMS_SHA256 must be a sha256 (64 hex)');
  return { tag: env.ZIPP_RELEASE || undefined, releaseDir: env.ZIPP_RELEASE_DIR ? path.resolve(env.ZIPP_RELEASE_DIR) : undefined, expectSumsSha256, env };
}

/** A build-zipp-wasm.mjs output, installed on purpose; it stays build 'local' and no release gate accepts it. */
export async function installLocal(from, dir = ENGINE_DIR, { log = console.log, warn } = {}) {
  return withInstallLock(dir, () => installLocalLocked(from, dir, log), { warn });
}

function installLocalLocked(from, dir, log) {
  let source;
  try {
    source = JSON.parse(fs.readFileSync(path.join(from, 'SOURCE.json'), 'utf8'));
  } catch (error) {
    refuse(`${from} is not a build-zipp-wasm.mjs output (SOURCE.json: ${error.message})`);
  }
  if (source.build !== 'local') refuse(`${from}/SOURCE.json is build '${source.build}'; --install-local takes only build-zipp-wasm.mjs output`);
  const files = new Map();
  for (const name of ['zipp_wasm.js', 'zipp_wasm.d.ts', 'zipp_wasm_bg.wasm', 'zipp_wasm_bg.wasm.d.ts', 'SOURCE.json', 'LICENSE-APACHE', NOTICES]) {
    const file = path.join(from, name);
    if (fs.existsSync(file)) files.set(name, fs.readFileSync(file));
    else if (!['LICENSE-APACHE', NOTICES].includes(name)) refuse(`${from} has no ${name}`);
  }
  if (sha256(files.get('zipp_wasm_bg.wasm')) !== source.sha256) refuse(`${from}/SOURCE.json does not describe the zipp_wasm_bg.wasm beside it`);
  writeInstall(dir, files);
  log(`Installed the local ZIPP build ${String(source.revision).slice(0, 8)} into ${rel(dir)} (build 'local': not releasable; npm run fetch:zipp goes back to a release)`);
  return source;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------
const USAGE = 'Usage: node scripts/fetch-zipp-release.mjs [vX.Y.Z | --latest] | --check [--online] | --resolve-only [vX.Y.Z | --latest] | --ensure [vX.Y.Z] | --install-local <dir>';

async function main(args) {
  const flags = new Set(['--latest', '--check', '--online', '--resolve-only', '--ensure', '--install-local']);
  const localAt = args.indexOf('--install-local');
  const localDir = localAt >= 0 ? args[localAt + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith('--') && (localAt < 0 || i !== localAt + 1));
  const unknown = args.filter((a) => a.startsWith('--') && !flags.has(a));
  const has = (flag) => args.includes(flag);
  if (unknown.length || positional.length > 1 || (localAt >= 0 && !localDir) || (has('--online') && !has('--check')) || (has('--latest') && (has('--check') || has('--ensure')))) refuse(USAGE);

  const env = process.env;
  const dir = env.ZIPP_OUT ? path.resolve(env.ZIPP_OUT) : ENGINE_DIR;
  const { releaseDir, expectSumsSha256, tag: envTag } = releaseOptions(env);
  const latest = has('--latest');
  // No tag and no --latest: the declared release, read where it is needed, so --check needs no Cargo.toml.
  const tag = positional[0] ?? envTag;
  if (latest && tag) refuse('name a release or --latest, not both');

  if (has('--check')) {
    const source = has('--online') ? await checkEngineOnline(dir) : checkEngine(dir);
    console.log(`ZIPP ${source.release} (${source.revision.slice(0, 8)}) in ${rel(dir)} checks${has('--online') ? ' against the published release' : ''}.`);
  } else if (has('--resolve-only')) {
    const { release, sums } = await resolveRelease({ tag, latest, releaseDir });
    console.log(JSON.stringify({ release, sumsSha256: sha256(sums) }));
  } else if (has('--ensure')) {
    await ensureEngine({ dir, tag, expectSumsSha256, releaseDir });
  } else if (localDir) {
    await installLocal(path.resolve(localDir), dir);
  } else {
    await installRelease({ dir, tag, latest, releaseDir, expectSumsSha256 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    if (!(error instanceof ZippReleaseError)) throw error;
    console.error(`fetch-zipp-release: ${error.message}`);
    process.exitCode = 1;
  });
}
