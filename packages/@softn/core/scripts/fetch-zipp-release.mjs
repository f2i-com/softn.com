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
 * The web-python bundle is the engine: JavaScript and Python in one module,
 * with a 16 MiB stack. It must match ZIPP's top-level SHA256SUMS, every file
 * taken from it the bundle's own SHA256SUMS, BUILD-INFO.txt must describe that
 * variant, and the module itself must report the release's commit. Nothing is
 * post-processed: a changed byte breaks that chain.
 *
 * The same release's JavaScript-only web bundle is installed beside it, into
 * `wasm-zipp-web/`, as a VARIANT of that engine: a third smaller, no Python, a
 * 1 MiB stack, otherwise the same VM. It is held to the same top-level
 * SHA256SUMS and its own inner one, and then to the primary: built from the
 * same commit, asking the host for exactly the same imports, exporting nothing
 * the primary does not — so it can run under the primary's glue, which is the
 * only glue Softn ships — and, loaded under that glue, reporting exactly
 * ['javascript'] with its Python entry points refusing. Only its module,
 * BUILD-INFO.txt, PROFILE.json and SHA256SUMS are installed, with a SOURCE.json
 * of its own; its glue is recorded by digest for provenance and not shipped.
 * The primary SOURCE.json gains `variants.web` naming it. An install without
 * the variant is refused: one release, both builds, or nothing.
 *
 * SOURCE.json records the release, both SHA256SUMS digests and where the
 * third-party notices came from. The bundle ships none, so the RustPython and
 * Unicode notices come from zipp-notices/ ('softn-curated') until it does.
 *
 * Installs into one folder take turns under `.wasm-zipp.lock` beside it (a
 * dead install's lock is taken over by one waiter at a time, under
 * `.wasm-zipp.lock.break`), and are staged there and swapped in whole; the
 * variant folder is written under the same lock, before the primary, so the
 * SOURCE.json that names it lands last.
 *
 * Node built-ins only at the top, plus the repository's own WebAssembly
 * section reader: fflate is imported where a bundle is unzipped, so --check
 * and --resolve-only run without node_modules.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isZippEngineWasm, wasmExportNames, wasmImportNames } from '../../../../scripts/lib/zipp-engine-copy.mjs';

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

/**
 * The web variant: what its BUILD-INFO.txt must say. `id` is its key in the
 * primary SOURCE.json's `variants` and the suffix of its folder (`wasm-zipp-web`)
 * and of its tree in the FormLogic archive (`zipp-web/`).
 */
export const WEB_VARIANT = Object.freeze({ id: 'web', variant: 'javascript', languages: Object.freeze(['javascript']), stackBytes: 1048576 });
/** Taken from the web bundle byte for byte; its glue is not (the primary's runs it). */
export const VARIANT_BUNDLE_FILES = ['zipp_wasm_bg.wasm', 'BUILD-INFO.txt', 'PROFILE.json', 'SHA256SUMS'];
/** A variant install is exactly these. */
export const VARIANT_INSTALLED_FILES = [...VARIANT_BUNDLE_FILES, 'SOURCE.json'];
/** The variant's folder: a sibling of the install's, never inside it. */
export const variantDir = (dir, id = WEB_VARIANT.id) => path.join(path.dirname(dir), `${path.basename(dir)}-${id}`);
export const WEB_ENGINE_DIR = variantDir(ENGINE_DIR);

/** A refusal: the release, the bundle or the install is not what it has to be. */
export class ZippReleaseError extends Error {}
const refuse = (message) => {
  throw new ZippReleaseError(message);
};

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const isReleaseTag = (tag) => /^v\d+\.\d+\.\d+$/.test(tag ?? '');
export const bundleName = (version) => `zipp-wasm-${version}-web-python`;
export const variantBundleName = (version, id = WEB_VARIANT.id) => `zipp-wasm-${version}-${id}`;
/** Both zips a release must publish, the primary first. */
const releaseBundles = (version) => [`${bundleName(version)}.zip`, `${variantBundleName(version)}.zip`];
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
  if (info.variant !== expected.variant) problems.push(`BUILD-INFO.txt variant is ${info.variant}, not ${expected.variant}${expected.variant === VARIANT ? ' (only the web-python bundle carries Python and the 16 MiB stack)' : ''}`);
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
    if (error.unreachable && ['SHA256SUMS', ...releaseBundles(tag.slice(1))].every((name) => fs.existsSync(path.join(cached, name)))) {
      refuse(`${error.message}; to install the ${tag} downloaded earlier without the network, set ZIPP_RELEASE_DIR=${cached}`);
    }
    throw error;
  }
}

/** A release's SHA256SUMS must list both of its wasm bundles: the engine and its web variant. */
function requireBundlesListed(sums, release, where) {
  const listed = parseSums(sums);
  for (const bundle of releaseBundles(release.slice(1))) {
    if (!listed.has(bundle)) refuse(`the SHA256SUMS ${where} does not list ${bundle}`);
  }
}

/**
 * The release to take and its top-level SHA256SUMS bytes, which must list the
 * release's web-python bundle and its web bundle. A tag is taken as named; no
 * tag means the declared release; `latest` means GitHub's latest release,
 * whose SHA256SUMS must be byte for byte the one under its own tag, so the tag
 * recorded is the release really read.
 */
export async function resolveRelease({ tag, latest = false, releaseDir, cargoToml, cacheDir = CACHE_DIR, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (latest && tag) refuse('name a release or --latest, not both');
  if (!latest) {
    tag ??= declaredRelease(cargoToml);
    if (!isReleaseTag(tag)) refuse(`"${tag}" is not a ZIPP release tag (vMAJOR.MINOR.PATCH)`);
    const sums = releaseDir ? readReleaseFile(releaseDir, 'SHA256SUMS') : await downloadSums(tag, { cacheDir, fetchImpl });
    requireBundlesListed(sums, tag, releaseDir ? `in ${releaseDir}` : `published under ${tag}`);
    return { release: tag, sums };
  }
  const latestSums = await download(LATEST_SUMS_URL, fetchImpl);
  const release = `v${versionFromSums(latestSums)}`;
  const tagged = await download(releaseUrl(release, 'SHA256SUMS'), fetchImpl);
  if (!latestSums.equals(tagged)) refuse(`the latest release's SHA256SUMS is not the one published under ${release}; the latest release changed while it was read, so try again`);
  requireBundlesListed(tagged, release, `published under ${release}`);
  return { release, sums: tagged };
}

/** A bundle zip by name, checked against the top-level SHA256SUMS; downloads are cached per tag. */
async function loadBundle({ release, sums, name, releaseDir, cacheDir = CACHE_DIR, fetch: fetchImpl = globalThis.fetch }) {
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

async function unzipBundle(zip, version, name = bundleName(version)) {
  const { unzipSync } = await import('fflate');
  const entries = unzipSync(new Uint8Array(zip.buffer, zip.byteOffset, zip.byteLength));
  const prefix = `${name}/`;
  const files = new Map();
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.startsWith(prefix) && !name.endsWith('/')) files.set(name.slice(prefix.length), Buffer.from(bytes));
  }
  return files;
}

// ---------------------------------------------------------------------------
// Verify a release and build the install
// ---------------------------------------------------------------------------

/** The module loaded under `glue`, as the glue's own exports; nothing is written to disk for this. */
async function loadEngine(glue, wasm) {
  // A data: URL per call: each import is a fresh module with its own instance,
  // so a second bundle in the same process is not answered by the first.
  const source = Buffer.concat([glue, Buffer.from(`\n// ${randomBytes(8).toString('hex')}\n`)]);
  const module = await import(`data:text/javascript;base64,${source.toString('base64')}`);
  module.initSync({ module: wasm });
  return module;
}

/** What the module reports about itself, from its own glue. */
async function engineProfile(glue, wasm) {
  return JSON.parse((await loadEngine(glue, wasm)).zippProfile());
}

/** What a loaded module must say to be the release's engine of `languages`, as problems. */
function profileProblems(profile, { version, languages, commit }) {
  return [
    ...(profile.version !== version ? [`zippProfile() version is ${profile.version}, not ${version}`] : []),
    ...(!profile.features?.includes('safe-sandbox') ? ['zippProfile() lacks the safe-sandbox feature'] : []),
    ...(!isDeepStrictEqual(profile.languages, languages) ? [`zippProfile() languages are ${JSON.stringify(profile.languages)}, not ${JSON.stringify(languages)}`] : []),
    ...(profile.source?.sha !== commit ? [`zippProfile() source.sha is ${profile.source?.sha}, not the BUILD-INFO.txt commit ${commit}`] : []),
  ];
}

/**
 * Unzip a bundle and hold it to its own SHA256SUMS: everything it lists is what
 * it lists, and everything `taken` from it is listed. Returns its entries and
 * the parsed inner sums.
 */
async function openBundle({ zip, bundle, version, name, taken }) {
  const entries = await unzipBundle(zip, version, name);
  if (!entries.has('SHA256SUMS')) refuse(`${bundle} carries no SHA256SUMS`);
  const inner = parseSums(entries.get('SHA256SUMS'));
  for (const [file, digest] of inner) {
    if (!entries.has(file)) refuse(`${bundle} lists ${file} in its SHA256SUMS but does not carry it`);
    if (sha256(entries.get(file)) !== digest) refuse(`${file} in ${bundle} does not match the bundle's SHA256SUMS`);
  }
  for (const file of taken) {
    if (!entries.has(file)) refuse(`${bundle} has no ${file}`);
    if (file !== 'SHA256SUMS' && !inner.has(file)) refuse(`${file} in ${bundle} is not listed in the bundle's SHA256SUMS`);
  }
  return { entries, inner };
}

/** A bundle's PROFILE.json, which must be JSON and say the version. */
function bundleProfileFile(entries, bundle, version) {
  let profileFile;
  try {
    profileFile = JSON.parse(entries.get('PROFILE.json').toString('utf8'));
  } catch {
    refuse(`${bundle} PROFILE.json is not JSON`);
  }
  if (profileFile.version !== version) refuse(`${bundle} PROFILE.json says version ${profileFile.version}, not ${version}`);
  return profileFile;
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

  const { entries, inner } = await openBundle({ zip, bundle, version, taken: BUNDLE_FILES });
  const files = new Map();
  for (const name of BUNDLE_FILES) files.set(name, entries.get(name));

  const info = parseBuildInfo(entries.get('BUILD-INFO.txt'));
  fail(`${bundle} is not the ZIPP ${release} web-python build`, buildInfoProblems(info, { version, variant: VARIANT, languages: LANGUAGES, stackBytes: STACK_BYTES }));
  bundleProfileFile(entries, bundle, version);

  const glue = entries.get('zipp_wasm.js');
  const wasm = entries.get('zipp_wasm_bg.wasm');
  let profile;
  try {
    profile = await engineProfile(glue, wasm);
  } catch (error) {
    refuse(`the ${bundle} engine does not load: ${error.message}`);
  }
  fail(`the ${bundle} engine does not describe itself as ZIPP ${release}`, profileProblems(profile, { version, languages: LANGUAGES, commit: info.commit }));

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

/** The `variants.<id>` record the primary SOURCE.json carries for a variant: the fields FormLogic compares by key. */
const variantRecord = (source) => ({ bundle: source.bundle, bundleSha256: source.bundleSha256, sha256: source.sha256, glueSha256: source.glueSha256, variant: source.variant, languages: source.languages, stackBytes: source.stackBytes, commit: source.commit });

/**
 * Problems with a variant module set beside the primary's: it must ask the host
 * for exactly the same imports and export nothing the primary does not, so the
 * primary's glue — the only glue Softn ships — binds it exactly as it binds
 * the primary. Read from the binaries; nothing is compiled.
 */
export function variantModuleProblems(variantWasm, primaryWasm, { bundle = 'the variant', primary = 'the web-python engine' } = {}) {
  const problems = [];
  if (!isZippEngineWasm(variantWasm)) return [`${bundle} zipp_wasm_bg.wasm does not export what a ZIPP engine exports (${wasmExportNames(variantWasm) === null ? 'not a WebAssembly module' : 'a module, but not the engine'})`];
  const [imports, primaryImports] = [wasmImportNames(variantWasm), wasmImportNames(primaryWasm)];
  if (!isDeepStrictEqual(imports, primaryImports)) {
    const extra = imports.filter((name) => !primaryImports.includes(name));
    const missing = primaryImports.filter((name) => !imports.includes(name));
    problems.push(`${bundle} does not import what ${primary} imports${extra.length ? `; it also imports ${extra.join(', ')}` : ''}${missing.length ? `; it lacks ${missing.join(', ')}` : ''}${!extra.length && !missing.length ? ' (the same names in another order)' : ''}, so the web-python glue cannot be known to bind it`);
  }
  const foreign = wasmExportNames(variantWasm).filter((name) => !wasmExportNames(primaryWasm).includes(name));
  if (foreign.length) problems.push(`${bundle} exports ${foreign.join(', ')}, which ${primary} does not; a variant runs under the web-python glue and may export nothing that engine lacks`);
  return problems;
}

/**
 * Verify the release's web bundle as a variant of the verified primary
 * (`verifyRelease`'s result) and return the files of its install with its
 * SOURCE.json, and the record the primary SOURCE.json carries for it. Refuses
 * with ZippReleaseError.
 */
export async function verifyVariant({ release, sums, zip, primary, id = WEB_VARIANT.id }) {
  const version = release.slice(1);
  const expected = WEB_VARIANT;
  const name = variantBundleName(version, id);
  const bundle = `${name}.zip`;
  const bundleSha256 = parseSums(sums).get(bundle);
  if (!bundleSha256) refuse(`the ${release} SHA256SUMS does not list ${bundle}`);
  if (sha256(zip) !== bundleSha256) refuse(`${bundle} does not match the ${release} SHA256SUMS`);

  const { entries } = await openBundle({ zip, bundle, version, name, taken: [...VARIANT_BUNDLE_FILES, 'zipp_wasm.js'] });
  const files = new Map();
  for (const file of VARIANT_BUNDLE_FILES) files.set(file, entries.get(file));

  const info = parseBuildInfo(entries.get('BUILD-INFO.txt'));
  fail(`${bundle} is not the ZIPP ${release} web build`, buildInfoProblems(info, { version, variant: expected.variant, languages: [...expected.languages], stackBytes: expected.stackBytes }));
  // The one fact that makes it a variant rather than another engine: the same source.
  if (info.commit !== primary.source.revision) refuse(`${bundle} is built from commit ${info.commit}, not ${primary.source.revision} like ${primary.source.bundle}; a variant ships only from the release's own commit`);
  bundleProfileFile(entries, bundle, version);

  const wasm = entries.get('zipp_wasm_bg.wasm');
  const primaryGlue = primary.files.get('zipp_wasm.js');
  // Another build of the same source, not the same build under another name.
  if (sha256(wasm) === primary.source.sha256) refuse(`${bundle} carries the ${primary.source.bundle} module itself (${primary.source.sha256.slice(0, 12)}), not a variant of it`);
  fail(`${bundle} cannot run under the web-python glue`, variantModuleProblems(wasm, primary.files.get('zipp_wasm_bg.wasm'), { bundle, primary: primary.source.bundle }));

  // Loaded under the glue it will really run under, it must say it is this
  // release's JavaScript-only engine, and every Python entry point must refuse.
  let profile;
  const pythonRefusals = [];
  try {
    const module = await loadEngine(primaryGlue, wasm);
    profile = JSON.parse(module.zippProfile());
    // A fresh Engine per entry point: a guest that failed to start is disposed,
    // and a second call on it would refuse for that reason, not for the right one.
    for (const [entry, call] of [['initSource(source, "python")', (engine) => engine.initSource('x = 1\n', 'python')], ['pythonHas(name)', (engine) => engine.pythonHas('x')]]) {
      const engine = new module.Engine();
      let refused = false;
      try {
        call(engine);
      } catch {
        refused = true;
      } finally {
        try {
          engine.dispose?.();
          engine.free?.();
        } catch {}
      }
      if (!refused) pythonRefusals.push(`${entry} runs on the ${bundle} engine, so it is not the JavaScript-only build`);
    }
  } catch (error) {
    refuse(`the ${bundle} engine does not load under the web-python glue: ${error.message}`);
  }
  fail(`the ${bundle} engine does not describe itself as the ZIPP ${release} web build`, [...profileProblems(profile, { version, languages: [...expected.languages], commit: info.commit }), ...pythonRefusals]);

  const source = {
    repository: REPOSITORY,
    release,
    version,
    revision: info.commit,
    build: 'release',
    bundle,
    bundleSha256,
    sumsSha256: sha256(sums),
    variant: info.variant,
    languages: buildInfoLanguages(info),
    stackBytes: Number(info['stack-bytes']),
    rustc: info.rustc,
    wasmBindgen: (info['wasm-bindgen'] ?? '').replace(/^wasm-bindgen\s+/, ''),
    license: 'Apache-2.0',
    artifact: 'zipp_wasm_bg.wasm',
    sha256: sha256(wasm),
    // The bundle's own glue, recorded and not shipped: this build runs under the primary's.
    glueSha256: sha256(entries.get('zipp_wasm.js')),
    commit: info.commit,
    // The engine this is a variant of, and whose glue runs it.
    primary: { bundle: primary.source.bundle, sha256: primary.source.sha256, glueSha256: primary.source.glueSha256 },
  };
  files.set('SOURCE.json', Buffer.from(`${JSON.stringify(source, null, 2)}\n`));
  return { files, source, record: variantRecord(source) };
}

/**
 * Verify a release's bundles all the way down: the primary engine, then its
 * web variant against it. Returns both installs' files, with the primary
 * SOURCE.json carrying `variants.web`. Refuses with ZippReleaseError.
 */
export async function verifyReleaseBundles({ release, sums, zip, variantZip, expectSumsSha256, curatedNotices }) {
  const primary = await verifyRelease({ release, sums, zip, expectSumsSha256, curatedNotices });
  const variant = await verifyVariant({ release, sums, zip: variantZip, primary });
  // Additive, and last: every key before it is byte for byte what it was.
  primary.source.variants = { [WEB_VARIANT.id]: variant.record };
  primary.files.set('SOURCE.json', Buffer.from(`${JSON.stringify(primary.source, null, 2)}\n`));
  return { primary, variant };
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
// An install takes seconds, and minutes at most (every request times out at
// 120 s): a lock this old outlived its holder even if its pid was reused.
const LOCK_STALE_MS = 10 * 60_000;
// Windows refuses to create or open a file another process is deleting that
// instant; under contention that passes in milliseconds. Elsewhere these are real.
const lockBusy = (error) => process.platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code);
/** The locks this process holds: a lock naming this pid is live only if it is one of them. */
const heldLocks = new Set();
const lockToken = () => `${process.pid} ${randomBytes(8).toString('hex')}`;

/** A lock file as {text, pid, age}, or null once it is gone. Its text is `<pid> <nonce>`. */
function readLock(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { text, pid: Number(text.split(' ')[0]), age: Date.now() - fs.statSync(file).mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Whether the install a lock names may still be running. */
function lockLive({ text, pid, age }) {
  if (age > LOCK_STALE_MS) return false;
  // An empty lock is one being written this instant, unless it has been empty a while.
  if (!(Number.isInteger(pid) && pid > 0)) return age <= 30_000;
  // This pid but not a lock this process holds: an install that had the pid before.
  if (pid === process.pid) return heldLocks.has(text);
  return pidAlive(pid);
}

/** Remove a lock this process wrote, only while it still holds `token`. */
function releaseLock(file, token) {
  try {
    if (fs.readFileSync(file, 'utf8') === token) fs.rmSync(file, { force: true });
  } catch {}
}

/**
 * Remove the dead lock `stale` unless it has changed since it was read.
 * Waiters take turns at this under `<lock>.break`: otherwise two could find
 * the same dead lock, and the second remove the live one the first had just
 * written, so both would install. A turn left by a waiter that died is cleared.
 * False when something could not be removed or written (busy, or read-only).
 */
export async function removeStaleLock(lock, stale) {
  const breaker = `${lock}.break`;
  const token = lockToken();
  let done = true;
  try {
    fs.writeFileSync(breaker, token, { flag: 'wx' });
  } catch (error) {
    // Another waiter's turn, or one whose waiter died, which is cleared for the next.
    if (error.code !== 'EEXIST') done = false;
    else {
      try {
        const other = readLock(breaker);
        if (other && !lockLive(other) && fs.readFileSync(breaker, 'utf8') === other.text) fs.rmSync(breaker, { force: true });
      } catch {
        done = false;
      }
    }
    await sleep(20);
    return done;
  }
  try {
    const now = readLock(lock);
    if (now && now.text === stale.text && !lockLive(now)) fs.rmSync(lock, { force: true });
  } catch {
    done = false;
  } finally {
    releaseLock(breaker, token);
  }
  // The next look decides; a pause, not a spin.
  if (!done) await sleep(20);
  return done;
}

/**
 * Run `fn(assertHeld)` holding `.<folder>.lock` beside the install. Hooks
 * started together (npm test and npm run typecheck in two terminals) would
 * otherwise swap folders under each other; the one that waits finds the
 * install done. A lock whose process is gone, or that is older than any
 * install, is taken over. `assertHeld()` refuses once the lock is not this
 * install's, so nothing is written under another install's lock.
 */
export async function withInstallLock(dir, fn, { warn = console.warn } = {}) {
  const lock = path.join(path.dirname(dir), `.${path.basename(dir)}.lock`);
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
  } catch (error) {
    refuse(`cannot create ${rel(path.dirname(lock))} for a ZIPP install (${error.code ?? error.message})`);
  }
  const token = lockToken();
  const started = Date.now();
  let told = false;
  let busy = 0;
  let stuck = 0;
  for (;;) {
    try {
      fs.writeFileSync(lock, token, { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        if (lockBusy(error) && ++busy < 200) {
          await sleep(20);
          continue;
        }
        refuse(`cannot lock ${rel(dir)} for an install (${rel(lock)}: ${error.code ?? error.message})`);
      }
    }
    let holder;
    try {
      holder = readLock(lock);
    } catch (error) {
      if (lockBusy(error) && ++busy < 200) {
        await sleep(20);
        continue;
      }
      refuse(`cannot read the install lock ${rel(lock)} (${error.code ?? error.message}); if no install is running, delete it`);
    }
    if (!holder) continue; // released while it was read
    busy = 0;
    if (!lockLive(holder)) {
      // A dead lock that can never be removed (read-only, say) is refused in the end, not retried forever.
      if (!(await removeStaleLock(lock, holder)) && ++stuck >= 100) refuse(`cannot remove the install lock ${rel(lock)}, which process ${holder.pid || '(unknown)'} left; delete it`);
      continue;
    }
    stuck = 0;
    if (Date.now() - started > LOCK_STALE_MS) refuse(`${rel(lock)} has been held by process ${holder.pid || '(unknown)'} for ${Math.round(holder.age / 1000)} s; if no install is running, delete it`);
    if (!told) warn(`Waiting for the ZIPP install another process (${holder.pid || 'starting'}) is making into ${rel(dir)} ...`);
    told = true;
    await sleep(250);
  }
  heldLocks.add(token);
  const assertHeld = () => {
    let now = null;
    try {
      now = readLock(lock);
    } catch {}
    if (now?.text !== token) refuse(`the install lock ${rel(lock)} is no longer this install's (${now ? `process ${now.pid || '(unknown)'} holds it` : 'it is gone'}); nothing was written, so run it again`);
  };
  try {
    return await fn(assertHeld);
  } finally {
    heldLocks.delete(token);
    releaseLock(lock, token);
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

async function installReleaseLocked({ dir, tag, latest, releaseDir, cargoToml, cacheDir, expectSumsSha256, fetch: fetchImpl = globalThis.fetch, curatedNotices, log = console.log, assertHeld = () => {} }) {
  const { release, sums } = await resolveRelease({ tag, latest, releaseDir, cargoToml, cacheDir, fetch: fetchImpl });
  if (expectSumsSha256 && sha256(sums) !== expectSumsSha256.toLowerCase()) refuse(`the ${release} SHA256SUMS has sha256 ${sha256(sums)}; ZIPP_SUMS_SHA256 says ${expectSumsSha256}`);
  const [bundle, variantBundle] = releaseBundles(release.slice(1));
  log(`Taking ${bundle} and ${variantBundle} from ZIPP ${release}${releaseDir ? ` in ${releaseDir}` : ''} ...`);
  const zip = await loadBundle({ release, sums, name: bundle, releaseDir, cacheDir, fetch: fetchImpl });
  const variantZip = await loadBundle({ release, sums, name: variantBundle, releaseDir, cacheDir, fetch: fetchImpl });
  const { primary, variant } = await verifyReleaseBundles({ release, sums, zip, variantZip, expectSumsSha256, curatedNotices });
  assertHeld();
  // The variant first: the primary's SOURCE.json is what says the variant is there.
  writeInstall(variantDir(dir), variant.files);
  writeInstall(dir, primary.files);
  // What landed on disk, not what was meant to.
  const source = checkEngine(dir, { curatedNotices });
  log(`Installed ZIPP ${release} (${source.revision.slice(0, 8)}) into ${rel(dir)}; engine sha256 ${source.sha256}; web variant sha256 ${variant.source.sha256} into ${rel(variantDir(dir))}${source.notices.source === 'softn-curated' ? `; notices: the curated copy (${release} ships none)` : ''}`);
  return source;
}

/** Resolve, fetch (or read), verify and install a release. Returns its SOURCE.json. */
export async function installRelease({ dir = ENGINE_DIR, warn, ...options } = {}) {
  return withInstallLock(dir, (assertHeld) => installReleaseLocked({ dir, ...options, assertHeld }), { warn });
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
  if (!source.variants?.[WEB_VARIANT.id]) problems.push(`SOURCE.json records no ${WEB_VARIANT.id} variant of the engine (variants.${WEB_VARIANT.id}); the release's web bundle is installed beside it as one`);
  fail(`the ZIPP install in ${where} does not check (run npm run fetch:zipp)`, problems);
  checkVariant(variantDir(dir), source, present);
  return source;
}

/**
 * Check the web variant install beside a checked primary, offline. It is
 * exactly its files; its SOURCE.json is the record the primary's `variants.web`
 * names, field for field; every file the bundle ships matches the bundle's
 * SHA256SUMS; BUILD-INFO.txt describes the web build of the primary's commit;
 * the primary's RELEASE-SHA256SUMS lists its bundle with the recorded digest;
 * and its module still fits under the primary's glue.
 */
export function checkVariant(dir, primarySource, primaryFiles, id = WEB_VARIANT.id) {
  const where = rel(dir);
  const record = primarySource.variants[id];
  const sourceFile = path.join(dir, 'SOURCE.json');
  if (!fs.existsSync(sourceFile)) refuse(`${where} holds no ZIPP ${id} variant install (no SOURCE.json); run npm run fetch:zipp`);
  let source;
  try {
    source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  } catch (error) {
    refuse(`${where}/SOURCE.json is not JSON: ${error.message}`);
  }
  const problems = [];
  const present = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) problems.push(`${entry.name} is not a plain file`);
    else if (!VARIANT_INSTALLED_FILES.includes(entry.name)) problems.push(`${entry.name} is not part of a variant install`);
    else present.set(entry.name, fs.readFileSync(path.join(dir, entry.name)));
  }
  for (const name of VARIANT_INSTALLED_FILES) if (!present.has(name)) problems.push(`${name} is missing`);

  const version = primarySource.version;
  const expected = WEB_VARIANT;
  for (const [field, value] of Object.entries(variantRecord(source))) {
    if (!isDeepStrictEqual(record[field], value)) problems.push(`SOURCE.json ${field} is ${JSON.stringify(value)}; the primary install's variants.${id} records ${JSON.stringify(record[field])}`);
  }
  if (source.build !== 'release') problems.push(`SOURCE.json build is '${source.build}', not a verified release install`);
  if (source.repository !== REPOSITORY) problems.push(`SOURCE.json repository is ${source.repository}, not ${REPOSITORY}`);
  if (source.release !== primarySource.release || source.version !== version) problems.push(`SOURCE.json names ZIPP ${source.release} (${source.version}), not the primary install's ${primarySource.release}`);
  if (source.bundle !== `${variantBundleName(version, id)}.zip`) problems.push(`SOURCE.json bundle ${source.bundle} is not the ${id} bundle`);
  for (const field of ['bundleSha256', 'sumsSha256', 'sha256', 'glueSha256']) if (!HEX64.test(source[field] ?? '')) problems.push(`SOURCE.json ${field} is not a sha256`);
  if (source.variant !== expected.variant || !isDeepStrictEqual(source.languages, [...expected.languages]) || source.stackBytes !== expected.stackBytes) problems.push(`SOURCE.json records ${source.variant} ${JSON.stringify(source.languages)} with a ${source.stackBytes}-byte stack, not the web build`);
  if (source.artifact !== 'zipp_wasm_bg.wasm') problems.push(`SOURCE.json artifact is ${source.artifact}`);
  if (source.revision !== primarySource.revision || source.commit !== primarySource.revision) problems.push(`SOURCE.json commit ${source.commit} is not the primary install's revision ${primarySource.revision}; a variant is the same source built again`);
  if (source.sumsSha256 !== primarySource.sumsSha256) problems.push(`SOURCE.json sumsSha256 ${source.sumsSha256} is not the primary install's ${primarySource.sumsSha256}; both bundles come from one SHA256SUMS`);
  if (!isDeepStrictEqual(source.primary, { bundle: primarySource.bundle, sha256: primarySource.sha256, glueSha256: primarySource.glueSha256 })) problems.push(`SOURCE.json primary ${JSON.stringify(source.primary)} is not the primary install`);

  const inner = present.has('SHA256SUMS') ? parseSums(present.get('SHA256SUMS')) : new Map();
  for (const [name, bytes] of present) {
    if (name === 'SOURCE.json' || name === 'SHA256SUMS') continue;
    if (!inner.has(name)) problems.push(`${name} is not listed in the bundle's SHA256SUMS`);
    else if (sha256(bytes) !== inner.get(name)) problems.push(`${name} does not match the bundle's SHA256SUMS`);
  }
  if (primaryFiles.has('RELEASE-SHA256SUMS') && parseSums(primaryFiles.get('RELEASE-SHA256SUMS')).get(source.bundle) !== source.bundleSha256) problems.push(`RELEASE-SHA256SUMS does not list ${source.bundle} with the recorded ${source.bundleSha256}`);
  if (present.has('BUILD-INFO.txt')) problems.push(...buildInfoProblems(parseBuildInfo(present.get('BUILD-INFO.txt')), { version, revision: primarySource.revision, variant: expected.variant, languages: [...expected.languages], stackBytes: expected.stackBytes }));
  if (present.has('PROFILE.json')) {
    let profileVersion;
    try {
      profileVersion = JSON.parse(present.get('PROFILE.json').toString('utf8')).version;
    } catch {}
    if (profileVersion !== version) problems.push(`PROFILE.json says version ${profileVersion}, not ${version}`);
  }
  if (present.has('zipp_wasm_bg.wasm')) {
    const digest = sha256(present.get('zipp_wasm_bg.wasm'));
    if (digest !== source.sha256) problems.push(`zipp_wasm_bg.wasm is not the recorded ${source.sha256}`);
    if (digest === primarySource.sha256) problems.push(`zipp_wasm_bg.wasm is the primary install's module itself (${digest.slice(0, 12)}), not a variant of it`);
    if (primaryFiles.has('zipp_wasm_bg.wasm')) problems.push(...variantModuleProblems(present.get('zipp_wasm_bg.wasm'), primaryFiles.get('zipp_wasm_bg.wasm'), { bundle: source.bundle, primary: primarySource.bundle }));
  }
  fail(`the ZIPP ${id} variant install in ${where} does not check (run npm run fetch:zipp)`, problems);
  return source;
}

/** --check, then the install against the release as published now: ZIPP's SHA256SUMS and every file taken from either bundle. */
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
  const variant = source.variants[WEB_VARIANT.id];
  const variantZip = await download(releaseUrl(source.release, variant.bundle), fetchImpl);
  if (sha256(variantZip) !== variant.bundleSha256) problems.push(`the published ${variant.bundle} is not the recorded ${variant.bundleSha256}`);
  else {
    const entries = await unzipBundle(variantZip, source.version, variantBundleName(source.version));
    for (const name of VARIANT_BUNDLE_FILES) {
      if (!entries.get(name)?.equals(fs.readFileSync(path.join(variantDir(dir), name)))) problems.push(`${rel(variantDir(dir))}/${name} is not the file in the published ${variant.bundle}`);
    }
    if (sha256(entries.get('zipp_wasm.js') ?? '') !== variant.glueSha256) problems.push(`the published ${variant.bundle} glue is not the recorded ${variant.glueSha256}`);
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
  return withInstallLock(dir, async (assertHeld) => {
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
    return { action: 'installed', source: await installReleaseLocked({ dir, tag: wanted, expectSumsSha256, log, ...install, assertHeld }) };
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
  return withInstallLock(dir, (assertHeld) => installLocalLocked(from, dir, log, assertHeld), { warn });
}

function installLocalLocked(from, dir, log, assertHeld) {
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
  assertHeld();
  writeInstall(dir, files);
  // A local build has no variant; a release's must not survive beside it as if it were this build's.
  try {
    fs.rmSync(variantDir(dir), { recursive: true, force: true });
  } catch (error) {
    refuse(`could not remove the release's web variant in ${rel(variantDir(dir))} beside the local build: ${error.message}`);
  }
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
    console.log(`ZIPP ${source.release} (${source.revision.slice(0, 8)}) in ${rel(dir)} checks, with its web variant (${source.variants[WEB_VARIANT.id].sha256.slice(0, 12)}) in ${rel(variantDir(dir))}${has('--online') ? ', against the published release' : ''}.`);
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
