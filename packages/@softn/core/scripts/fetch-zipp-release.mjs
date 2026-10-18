#!/usr/bin/env node
/**
 * Install the ZIPP engine into `wasm-zipp/` from a published zipp.org release,
 * and check an install. `wasm-zipp/` is generated, never committed: the build,
 * test, typecheck and licence hooks run --ensure.
 *
 *   node scripts/fetch-zipp-release.mjs [vX.Y.Z]         install a release (no tag: the declared one)
 *   node scripts/fetch-zipp-release.mjs --latest         install the latest release
 *   node scripts/fetch-zipp-release.mjs --check          verify the install offline: digests, recorded fields, module records, import/export subset
 *   node scripts/fetch-zipp-release.mjs --check --online and that it is what the release publishes now
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
 * reads SHA256SUMS and the release's files from a folder instead of GitHub
 * (offline); ZIPP_SUMS_SHA256 is the digest the release's SHA256SUMS must
 * have; ZIPP_OUT installs somewhere other than wasm-zipp/.
 *
 * Since 0.0.26 a ZIPP release publishes each WebAssembly engine as one plain
 * `.wasm` file that carries its own wasm-bindgen bindings in a `zipp.glue`
 * custom section, beside a `zipp.meta` record of its format, variant,
 * version, commit, languages and the glue's sha256. Releases before 0.0.26
 * published zip bundles instead, which this script no longer reads.
 *
 * The engine is `zipp-<v>-javascript-python-base.wasm`: JavaScript and Python
 * in one module, with a 16 MiB stack, and no torch built in. It must match
 * ZIPP's SHA256SUMS, and is installed as published, byte for byte, as
 * `zipp_wasm_bg.wasm`: its sha256 is the line in SHA256SUMS. Its record must
 * name that variant, the release and a full commit; `zipp_wasm.js` is its
 * `zipp.glue` section, byte for byte, whose sha256 the record names; its
 * stack, read from the module (its first global, Rust's stack pointer, starts
 * at the top of the stack), must be 16 MiB; and loaded under that glue the
 * module must report the release and the commit and, through
 * pythonPackages(), that torch is not built in. (ZIPP's complete
 * `-javascript-python.wasm`, torch built in, is not taken: the same engine
 * plus torch, which every app would download whether it imports torch or not.)
 *
 * The release's embed kit, `zipp-<v>-wasm-embed-kit.zip`, gives the engine's
 * TypeScript declarations (`zipp-engine.d.ts`, installed as `zipp_wasm.d.ts`)
 * and `LICENSE-APACHE`. It must match SHA256SUMS, every file in it its own
 * SHA256SUMS, and its BUILD-INFO.txt and modules.json must name the release
 * and the engine's commit, and every module the digest SHA256SUMS gives it.
 * Nothing else is taken from it: SoftN loads the engine its own way, not with
 * the kit's zipp.mjs.
 *
 * The same release's torch package, `zipp-<v>-torch-package.wasm`, is
 * installed beside it, into `wasm-zipp-torch/`, as `zipp_torch.wasm` (the
 * package archive and its tensor kernels, a module with no imports of its
 * own). Softn's runtime adds it, once per page, only for an app whose manifest
 * declares torch. Its record must say `torch-package`, the release and the
 * engine's commit. ZIPP no longer publishes a loader of its own for it (the
 * steps are inside the kit's zipp.mjs), so `zipp_torch.js` is SoftN's:
 * generated here (TORCH_LOADER), with its TypeScript declarations
 * (TORCH_DECLARATIONS), each recorded by digest and held to that exact text.
 * At install (verifyPackage) the engine is loaded under its glue, that loader
 * is run over the package with addTorchSync, the engine must then list torch
 * in pythonPackages().installed, and a two-line `import torch` project must
 * run and answer. --check re-verifies digests, recorded fields and the
 * package module's shape (no imports, the package exports) and loads nothing.
 * The primary SOURCE.json gains `packages.torch` naming it.
 *
 * The same release's JavaScript-only engine, `zipp-<v>-javascript.wasm`, is
 * installed beside it, into `wasm-zipp-web/`, as a VARIANT of that engine:
 * much smaller, no Python, a 1 MiB stack, otherwise the same VM. It is held to
 * the same SHA256SUMS and to its own record, and then to the primary: built
 * from the same commit, asking the host for nothing the primary does not,
 * exporting nothing the primary does not — so it can run under the primary's
 * glue, which is the only glue Softn ships — and, loaded under that glue,
 * reporting exactly ['javascript'] with its Python entry points refusing.
 * That load happens at install (verifyVariant); --check re-verifies digests,
 * recorded fields, its record and the import/export subset over the installed
 * bytes and loads nothing. Only its module is installed, with a SOURCE.json of
 * its own; its own glue is recorded by digest and not shipped. The primary
 * SOURCE.json gains `variants.web` naming it.
 *
 * An install without the variant or the torch package is refused: one
 * release, all of it, or nothing.
 *
 * SOURCE.json records the release, the digest of its SHA256SUMS, the kit's
 * files and where the third-party notices came from. The release ships
 * none, so the Unicode notice comes from zipp-notices/ ('softn-curated')
 * until it does.
 *
 * Installs into one folder take turns under `.wasm-zipp.lock` beside it (a
 * dead install's lock is taken over by one waiter at a time, under
 * `.wasm-zipp.lock.break`), and are staged there and swapped in whole; the
 * variant and package folders are written under the same lock, before the
 * primary, so the SOURCE.json that names them lands last.
 *
 * Node built-ins only at the top, plus the repository's own WebAssembly
 * section reader: fflate is imported where the kit is unzipped, so --check
 * and --resolve-only run without node_modules.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ZIPP_TORCH_EXPORTS, isZippEngineWasm, wasmCustomSections, wasmExportNames, wasmImportNames, wasmStackBytes } from '../../../../scripts/lib/zipp-engine-copy.mjs';

export const REPOSITORY = 'https://github.com/f2i-com/zipp.org';
const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(CORE, '../../..');
export const ENGINE_DIR = path.join(CORE, 'wasm-zipp');
export const CURATED_NOTICES = path.join(CORE, 'zipp-notices', 'THIRD_PARTY_LICENSES.txt');
export const CACHE_DIR = path.join(ROOT, '.zipp-release');
export const CARGO_TOML = path.join(ROOT, 'apps/softn-host-rust/Cargo.toml');

/** The first release published as plain modules with their bindings inside; older ones are zips this script does not read. */
export const FIRST_MODULE_RELEASE = 'v0.0.26';
/** The `zipp.meta` record format this script reads; a newer one is refused rather than half understood. */
export const META_FORMAT = 1;
export const META_SECTION = 'zipp.meta';
export const GLUE_SECTION = 'zipp.glue';

export const VARIANT = 'javascript-python-base';
export const LANGUAGES = ['javascript', 'python'];
export const STACK_BYTES = 16777216;
export const NOTICES = 'THIRD_PARTY_LICENSES.txt';
/** What the embed kit gives the install, by installed name: the file in the kit it is, byte for byte. */
export const KIT_FILES = Object.freeze({ 'zipp_wasm.d.ts': 'zipp-engine.d.ts', 'LICENSE-APACHE': 'LICENSE-APACHE' });
/** An install is exactly these: the module, its glue, the kit's files, ZIPP's SHA256SUMS, the notices, SOURCE.json. */
export const INSTALLED_FILES = ['zipp_wasm_bg.wasm', 'zipp_wasm.js', ...Object.keys(KIT_FILES), 'RELEASE-SHA256SUMS', NOTICES, 'SOURCE.json'];

/**
 * The web variant: what its record must say. `id` is its key in the primary
 * SOURCE.json's `variants` and the suffix of its folder (`wasm-zipp-web`) and
 * of its tree in the FormLogic archive (`zipp-web/`).
 */
export const WEB_VARIANT = Object.freeze({ id: 'web', variant: 'javascript', languages: Object.freeze(['javascript']), stackBytes: 1048576 });
/** A variant install is exactly these: its module (its glue is not shipped; the primary's runs it) and SOURCE.json. */
export const VARIANT_INSTALLED_FILES = ['zipp_wasm_bg.wasm', 'SOURCE.json'];
/** The variant's folder: a sibling of the install's, never inside it. */
export const variantDir = (dir, id = WEB_VARIANT.id) => path.join(path.dirname(dir), `${path.basename(dir)}-${id}`);
export const WEB_ENGINE_DIR = variantDir(ENGINE_DIR);

/**
 * The torch package: what its record must say, and its files. `id` is its key
 * in the primary SOURCE.json's `packages`, the suffix of its folder
 * (`wasm-zipp-torch`) and the Python package name the engine reports once it
 * is added.
 */
export const TORCH_PACKAGE = Object.freeze({ id: 'torch', variant: 'torch-package', languages: Object.freeze(['python']), artifact: 'zipp_torch.wasm', loader: 'zipp_torch.js', declarations: 'zipp_torch.d.ts' });
/** A package install is exactly these: the module, the generated loader and declarations, and SOURCE.json. */
export const PACKAGE_INSTALLED_FILES = [TORCH_PACKAGE.artifact, TORCH_PACKAGE.loader, TORCH_PACKAGE.declarations, 'SOURCE.json'];
export const packageDir = (dir, id = TORCH_PACKAGE.id) => variantDir(dir, id);
export const TORCH_ENGINE_DIR = packageDir(ENGINE_DIR);

/**
 * The torch package's loader. ZIPP published one (`zipp_torch.js`) through
 * 0.0.25; since 0.0.26 the same steps are inside the embed kit's zipp.mjs,
 * which Softn does not use, so the loader is written here, the install is
 * still exactly what this script produces, and --check holds the file to this
 * text. verifyPackage runs it.
 */
export const TORCH_LOADER = `// Generated by packages/@softn/core/scripts/fetch-zipp-release.mjs (TORCH_LOADER):
// adds ZIPP's torch package (zipp_torch.wasm) to an engine built without torch,
// the steps ZIPP's own loader takes (zipp_torch.js through ZIPP 0.0.25, the
// embed kit's zipp.mjs since). Not part of the ZIPP release; --check holds this
// file to that text.
//
// The package is process-wide: add it once, before creating the engines that
// import torch. The engine checks the archive (format, engine ABI, SHA-256 of
// every file) and throws on any mismatch. The module has no imports and its
// own memory: each tensor kernel call arrives as request bytes, is copied into
// the package's memory, runs there, and its response is copied back.

function install(zipp, instance) {
  const x = instance.exports;
  const archive = new Uint8Array(x.memory.buffer, x.zipp_package_ptr(), x.zipp_package_len()).slice();
  const kernels = {
    zippTorchKernel(request) {
      const ptr = x.zipp_alloc(request.length);
      new Uint8Array(x.memory.buffer, ptr, request.length).set(request);
      const out = x.zipp_kernel(ptr, request.length);
      const len = new DataView(x.memory.buffer).getUint32(out, true);
      const response = new Uint8Array(x.memory.buffer, out + 4, len).slice();
      x.zipp_free(out, len + 4);
      return response;
    },
  };
  return JSON.parse(zipp.addPythonPackage(archive, kernels));
}

/** Add the torch package from its module's bytes or compiled module, synchronously. */
export function addTorchSync(zipp, wasm) {
  const module = wasm instanceof WebAssembly.Module ? wasm : new WebAssembly.Module(wasm);
  return install(zipp, new WebAssembly.Instance(module, {}));
}

/** Add the torch package from a URL, a Response, bytes or a compiled module. */
export async function addTorch(zipp, source) {
  let module;
  if (source instanceof WebAssembly.Module) module = source;
  else if (typeof Response !== "undefined" && source instanceof Response) module = await WebAssembly.compileStreaming(source);
  else if (typeof source === "string" || source instanceof URL) module = await WebAssembly.compileStreaming(fetch(source));
  else module = await WebAssembly.compile(source);
  return install(zipp, await WebAssembly.instantiate(module, {}));
}
`;

/**
 * The loader's declarations, which @softn/core imports it by. What the types
 * say is what TORCH_LOADER does; verifyPackage runs it.
 */
export const TORCH_DECLARATIONS = `// Generated by packages/@softn/core/scripts/fetch-zipp-release.mjs (TORCH_DECLARATIONS):
// the types of the zipp_torch.js loader generated beside it (TORCH_LOADER). Not
// part of the ZIPP release; --check holds this file to that text.

/** What the loader needs of the engine's glue: its addPythonPackage. */
export interface ZippPythonPackageHost {
  addPythonPackage(archive: Uint8Array, kernels: unknown): string;
}

/** The engine's report of the package it added, e.g. {"name":"torch","version":"0.0.21","modules":108,"kernels":true}. */
export interface ZippPythonPackageReport {
  name: string;
  version: string;
  modules?: number;
  kernels?: boolean;
}

/** Add the torch package from its module's bytes or compiled module, synchronously. */
export function addTorchSync(zipp: ZippPythonPackageHost, wasm: BufferSource | WebAssembly.Module): ZippPythonPackageReport;

/** Add the torch package from a URL, a Response, bytes or a compiled module. */
export function addTorch(zipp: ZippPythonPackageHost, source: string | URL | Response | BufferSource | WebAssembly.Module): Promise<ZippPythonPackageReport>;
`;

/** A refusal: the release, a module or the install is not what it has to be. */
export class ZippReleaseError extends Error {}
const refuse = (message) => {
  throw new ZippReleaseError(message);
};

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const isReleaseTag = (tag) => /^v\d+\.\d+\.\d+$/.test(tag ?? '');
/** A release's file for one of its WebAssembly modules (`javascript-python-base`, `javascript`, `torch-package`). */
export const moduleFileName = (version, variant = VARIANT) => `zipp-${version}-${variant}.wasm`;
export const kitFileName = (version) => `zipp-${version}-wasm-embed-kit.zip`;
/** The kit's folder inside its zip. */
const kitFolder = (version) => kitFileName(version).replace(/\.zip$/, '');
/** The files a release must publish for an install: the engine first, then its web variant, its torch package and the kit. */
const releaseFiles = (version) => [moduleFileName(version), moduleFileName(version, WEB_VARIANT.variant), moduleFileName(version, TORCH_PACKAGE.variant), kitFileName(version)];
/** Negative, zero or positive as release tag `a` is older than, the same as or newer than `b`. */
export const compareReleases = (a, b) => {
  const [x, y] = [a, b].map((t) => t.slice(1).split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
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

const fail = (what, problems) => {
  if (problems.length) refuse(`${what}:\n  - ${problems.join('\n  - ')}`);
};

// ---------------------------------------------------------------------------
// What a module says about itself
// ---------------------------------------------------------------------------

/**
 * A module's `zipp.meta` record, parsed, or a refusal: `what` names the module.
 * Read from the binary; nothing is compiled.
 */
export function moduleMeta(bytes, what) {
  const records = wasmCustomSections(bytes, META_SECTION);
  if (records === null) refuse(`${what} is not a WebAssembly module`);
  if (records.length !== 1) refuse(`${what} carries ${records.length} ${META_SECTION} records, not one; ZIPP releases from ${FIRST_MODULE_RELEASE} on publish every module with one`);
  try {
    const meta = JSON.parse(Buffer.from(records[0]).toString('utf8'));
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) return meta;
  } catch {}
  refuse(`${what} ${META_SECTION} record is not a JSON object`);
}

/** The module's `zipp.glue` section, its bindings, or null when it carries none; more than one is a refusal. */
export function moduleGlue(bytes, what) {
  const sections = wasmCustomSections(bytes, GLUE_SECTION);
  if (sections === null) refuse(`${what} is not a WebAssembly module`);
  if (sections.length > 1) refuse(`${what} carries ${sections.length} ${GLUE_SECTION} sections, not one`);
  return sections.length ? Buffer.from(sections[0]) : null;
}

/**
 * What a module's record must say, as problems. `expected` holds version,
 * variant, languages and, when known, commit (otherwise any full commit), and
 * `glue`: the bindings the module carries (their sha256 must be the record's
 * glueSha256), or null when it carries none, which is right only for a
 * module that names none and is not an engine (`engine`: it must carry them).
 */
function metaProblems(meta, { version, variant, languages, commit, glue, engine = true }) {
  const problems = [];
  if (meta.format !== META_FORMAT) problems.push(`${META_SECTION} format is ${JSON.stringify(meta.format)}, not ${META_FORMAT}`);
  if (meta.version !== version) problems.push(`${META_SECTION} says version ${meta.version}, not ${version}`);
  if (meta.variant !== variant) problems.push(`${META_SECTION} variant is ${meta.variant}, not ${variant}${variant === VARIANT ? ' (the engine is the javascript-python-base module: Python and the 16 MiB stack, torch as a package)' : ''}`);
  if (!isDeepStrictEqual(meta.languages, languages)) problems.push(`${META_SECTION} languages are ${JSON.stringify(meta.languages)}, not ${JSON.stringify(languages)}`);
  if (!COMMIT.test(meta.commit ?? '')) problems.push(`${META_SECTION} commit ${JSON.stringify(meta.commit)} is not a full 40-hex commit`);
  else if (commit !== undefined && meta.commit !== commit) problems.push(`${META_SECTION} commit ${meta.commit} is not ${commit}`);
  if (glue) {
    if (sha256(glue) !== meta.glueSha256) problems.push(`its ${GLUE_SECTION} section has sha256 ${sha256(glue)}; ${META_SECTION} says glueSha256 ${meta.glueSha256}`);
  } else if (meta.glueSha256 !== undefined) problems.push(`${META_SECTION} names bindings (glueSha256 ${meta.glueSha256}) the module does not carry`);
  else if (engine) problems.push(`the module carries no ${GLUE_SECTION} section, so no bindings`);
  return problems;
}

/** The stack a module was linked with, as problems: `expected` bytes, read from its first global. */
function stackProblems(bytes, expected) {
  const stack = wasmStackBytes(bytes);
  return stack === expected ? [] : [`its stack is ${stack === null ? 'not readable (its first global is not an i32 stack pointer)' : `${stack} bytes`}, not ${expected}`];
}

/**
 * Problems with the torch package's module read from its binary: it imports
 * nothing (it runs beside the engine with its own memory; anything it asked
 * the host for, the loader does not give) and exports what the loader reads.
 */
export function packageModuleProblems(bytes, { bundle = 'the torch package' } = {}) {
  const exports = wasmExportNames(bytes);
  if (exports === null) return [`${bundle} is not a WebAssembly module`];
  const problems = [];
  const missing = ZIPP_TORCH_EXPORTS.filter((name) => !exports.includes(name));
  if (missing.length) problems.push(`${bundle} does not export ${missing.join(', ')}, which its loader reads`);
  const imports = wasmImportNames(bytes) ?? [];
  if (imports.length) problems.push(`${bundle} imports ${imports.join(', ')}; the package module imports nothing, and its loader provides nothing`);
  return problems;
}

/** The names a pythonPackages() report lists as installed. */
const installedPackages = (report) => (Array.isArray(report?.installed) ? report.installed.map((entry) => (typeof entry === 'string' ? entry : entry?.name)).filter((name) => typeof name === 'string') : []);

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

/** The one javascript-python-base version a SHA256SUMS lists. */
export function versionFromSums(sums) {
  const versions = [...parseSums(sums).keys()].map((n) => /^zipp-(\d+\.\d+\.\d+)-javascript-python-base\.wasm$/.exec(n)?.[1]).filter(Boolean);
  if (versions.length !== 1) refuse(`SHA256SUMS lists ${versions.length} javascript-python-base engines; expected exactly one (ZIPP publishes its engines as plain .wasm files from ${FIRST_MODULE_RELEASE} on)`);
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

/** A release this script can read: one published as plain modules. */
function requireModuleRelease(tag) {
  if (compareReleases(tag, FIRST_MODULE_RELEASE) < 0) refuse(`ZIPP ${tag} was published as zip bundles, which this script no longer reads; Softn installs ${FIRST_MODULE_RELEASE} or later, whose modules carry their own bindings`);
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
    if (error.unreachable && ['SHA256SUMS', ...releaseFiles(tag.slice(1))].every((name) => fs.existsSync(path.join(cached, name)))) {
      refuse(`${error.message}; to install the ${tag} downloaded earlier without the network, set ZIPP_RELEASE_DIR=${cached}`);
    }
    throw error;
  }
}

/** A release's SHA256SUMS must list the files an install takes: the engine, its web variant, its torch package and the kit. */
function requireFilesListed(sums, release, where) {
  const listed = parseSums(sums);
  for (const name of releaseFiles(release.slice(1))) {
    if (!listed.has(name)) refuse(`the SHA256SUMS ${where} does not list ${name}`);
  }
}

/**
 * The release to take and its top-level SHA256SUMS bytes, which must list the
 * release's javascript-python-base, javascript and torch-package modules and
 * its embed kit. A tag is taken as named; no tag means the declared release;
 * `latest` means GitHub's latest release, whose SHA256SUMS must be byte for
 * byte the one under its own tag, so the tag recorded is the release really
 * read.
 */
export async function resolveRelease({ tag, latest = false, releaseDir, cargoToml, cacheDir = CACHE_DIR, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (latest && tag) refuse('name a release or --latest, not both');
  if (!latest) {
    tag ??= declaredRelease(cargoToml);
    if (!isReleaseTag(tag)) refuse(`"${tag}" is not a ZIPP release tag (vMAJOR.MINOR.PATCH)`);
    requireModuleRelease(tag);
    const sums = releaseDir ? readReleaseFile(releaseDir, 'SHA256SUMS') : await downloadSums(tag, { cacheDir, fetchImpl });
    requireFilesListed(sums, tag, releaseDir ? `in ${releaseDir}` : `published under ${tag}`);
    return { release: tag, sums };
  }
  const latestSums = await download(LATEST_SUMS_URL, fetchImpl);
  const release = `v${versionFromSums(latestSums)}`;
  requireModuleRelease(release);
  const tagged = await download(releaseUrl(release, 'SHA256SUMS'), fetchImpl);
  if (!latestSums.equals(tagged)) refuse(`the latest release's SHA256SUMS is not the one published under ${release}; the latest release changed while it was read, so try again`);
  requireFilesListed(tagged, release, `published under ${release}`);
  return { release, sums: tagged };
}

/** A release file by name, checked against the top-level SHA256SUMS; downloads are cached per tag. */
async function loadReleaseFile({ release, sums, name, releaseDir, cacheDir = CACHE_DIR, fetch: fetchImpl = globalThis.fetch }) {
  const expected = parseSums(sums).get(name);
  if (!expected) refuse(`the ${release} SHA256SUMS does not list ${name}`);
  let bytes;
  if (releaseDir) bytes = readReleaseFile(releaseDir, name);
  else {
    const cached = path.join(cacheDir, release, name);
    bytes = fs.existsSync(cached) ? fs.readFileSync(cached) : null;
    if (!bytes || sha256(bytes) !== expected) bytes = await download(releaseUrl(release, name), fetchImpl);
  }
  const actual = sha256(bytes);
  if (actual !== expected) refuse(`${name} has sha256 ${actual}; the ${release} SHA256SUMS says ${expected}`);
  if (!releaseDir) {
    // Best effort, and whole files only: another install may be reading the cache.
    try {
      fs.mkdirSync(path.join(cacheDir, release), { recursive: true });
      for (const [file, content] of [['SHA256SUMS', sums], [name, bytes]]) {
        const target = path.join(cacheDir, release, file);
        const partial = `${target}.${process.pid}-${randomBytes(4).toString('hex')}.partial`;
        fs.writeFileSync(partial, content);
        try {
          renameWithRetry(partial, target);
        } finally {
          fs.rmSync(partial, { force: true });
        }
      }
    } catch {}
  }
  return bytes;
}

/** The kit's files by their path inside its folder. */
async function unzipKit(zip, version) {
  const { unzipSync } = await import('fflate');
  const entries = unzipSync(new Uint8Array(zip.buffer, zip.byteOffset, zip.byteLength));
  const prefix = `${kitFolder(version)}/`;
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
  // so a second module in the same process is not answered by the first.
  const source = Buffer.concat([glue, Buffer.from(`\n// ${randomBytes(8).toString('hex')}\n`)]);
  const module = await import(`data:text/javascript;base64,${source.toString('base64')}`);
  module.initSync({ module: wasm });
  return module;
}

/** What the module reports about itself and its Python packages, from its own glue. */
async function engineProfile(glue, wasm) {
  const module = await loadEngine(glue, wasm);
  return { profile: JSON.parse(module.zippProfile()), packages: JSON.parse(module.pythonPackages()) };
}

/** What a loaded module must say to be the release's engine of `languages`, as problems. */
function profileProblems(profile, { version, languages, commit }) {
  return [
    ...(profile.version !== version ? [`zippProfile() version is ${profile.version}, not ${version}`] : []),
    ...(!profile.features?.includes('safe-sandbox') ? ['zippProfile() lacks the safe-sandbox feature'] : []),
    ...(!isDeepStrictEqual(profile.languages, languages) ? [`zippProfile() languages are ${JSON.stringify(profile.languages)}, not ${JSON.stringify(languages)}`] : []),
    ...(profile.source?.sha !== commit ? [`zippProfile() source.sha is ${profile.source?.sha}, not the ${META_SECTION} commit ${commit}`] : []),
  ];
}

/** A release file must be the bytes its SHA256SUMS line names; returns that digest. */
function listedDigest(sums, release, name, bytes) {
  const listed = parseSums(sums).get(name);
  if (!listed) refuse(`the ${release} SHA256SUMS does not list ${name}`);
  if (sha256(bytes) !== listed) refuse(`${name} does not match the ${release} SHA256SUMS`);
  return listed;
}

/**
 * The embed kit, held to the release: its zip to SHA256SUMS, every file in it
 * to its own SHA256SUMS, its BUILD-INFO.txt and modules.json to the release
 * and `commit`, and every module modules.json names to the digest SHA256SUMS
 * gives it. Returns the installed files it gives (KIT_FILES) and the record
 * SOURCE.json keeps of it.
 */
async function verifyKit({ release, sums, kit, commit }) {
  const version = release.slice(1);
  const name = kitFileName(version);
  const bundleSha256 = listedDigest(sums, release, name, kit);
  const entries = await unzipKit(kit, version);
  if (!entries.has('SHA256SUMS')) refuse(`${name} carries no SHA256SUMS`);
  const inner = parseSums(entries.get('SHA256SUMS'));
  for (const [file, digest] of inner) {
    if (!entries.has(file)) refuse(`${name} lists ${file} in its SHA256SUMS but does not carry it`);
    if (sha256(entries.get(file)) !== digest) refuse(`${file} in ${name} does not match the kit's SHA256SUMS`);
  }
  for (const file of [...Object.values(KIT_FILES), 'BUILD-INFO.txt', 'modules.json']) {
    if (!entries.has(file)) refuse(`${name} has no ${file}`);
    if (!inner.has(file)) refuse(`${file} in ${name} is not listed in the kit's SHA256SUMS`);
  }
  const problems = [];
  const info = parseBuildInfo(entries.get('BUILD-INFO.txt'));
  if (info.version !== version) problems.push(`BUILD-INFO.txt says version ${info.version}, not ${version}`);
  if (info.commit !== commit) problems.push(`BUILD-INFO.txt commit ${info.commit} is not the engine's commit ${commit}`);
  let modules;
  try {
    modules = JSON.parse(entries.get('modules.json').toString('utf8'));
  } catch {
    refuse(`${name} modules.json is not JSON`);
  }
  if (modules?.version !== version) problems.push(`modules.json says version ${modules?.version}, not ${version}`);
  if (modules?.commit !== commit) problems.push(`modules.json commit ${modules?.commit} is not the engine's commit ${commit}`);
  const listed = parseSums(sums);
  const named = Array.isArray(modules?.modules) ? modules.modules : [];
  for (const file of releaseFiles(version).filter((f) => f.endsWith('.wasm'))) {
    const entry = named.find((m) => m?.file === file);
    if (!entry) problems.push(`modules.json does not list ${file}`);
    else if (entry.sha256 !== listed.get(file)) problems.push(`modules.json gives ${file} sha256 ${entry.sha256}; the ${release} SHA256SUMS says ${listed.get(file)}`);
  }
  fail(`${name} is not the ZIPP ${release} embed kit of commit ${commit}`, problems);
  const files = new Map(Object.entries(KIT_FILES).map(([installed, from]) => [installed, entries.get(from)]));
  const record = { bundle: name, bundleSha256, files: Object.fromEntries(Object.entries(KIT_FILES).map(([installed, from]) => [installed, { from, sha256: sha256(files.get(installed)) }])) };
  // Third-party notices, should the kit ever ship them; 0.0.26's does not.
  if (entries.has(NOTICES) && !inner.has(NOTICES)) refuse(`${NOTICES} in ${name} is not listed in the kit's SHA256SUMS`);
  return { files, record, notices: entries.get(NOTICES) ?? null };
}

/**
 * Verify a release's SHA256SUMS, engine module and kit all the way down and
 * return the files to install with their SOURCE.json. Refuses with
 * ZippReleaseError.
 */
export async function verifyRelease({ release, sums, wasm, kit, expectSumsSha256, curatedNotices = CURATED_NOTICES }) {
  if (!isReleaseTag(release)) refuse(`"${release}" is not a ZIPP release tag`);
  requireModuleRelease(release);
  const version = release.slice(1);
  const sumsSha256 = sha256(sums);
  if (expectSumsSha256 && sumsSha256 !== expectSumsSha256.toLowerCase()) refuse(`the ${release} SHA256SUMS has sha256 ${sumsSha256}; ZIPP_SUMS_SHA256 says ${expectSumsSha256}`);
  const bundle = moduleFileName(version);
  const bundleSha256 = listedDigest(sums, release, bundle, wasm);

  const meta = moduleMeta(wasm, bundle);
  const glue = moduleGlue(wasm, bundle);
  fail(`${bundle} is not the ZIPP ${release} javascript-python-base engine`, [...metaProblems(meta, { version, variant: VARIANT, languages: LANGUAGES, glue }), ...stackProblems(wasm, STACK_BYTES)]);

  let profile;
  let packages;
  try {
    ({ profile, packages } = await engineProfile(glue, wasm));
  } catch (error) {
    refuse(`the ${bundle} engine does not load under its own bindings: ${error.message}`);
  }
  // The base build: torch comes as the release's package, never built in, and nothing is added yet.
  const packageProblems = [
    ...(packages?.torchBuiltIn !== false ? [`pythonPackages() torchBuiltIn is ${JSON.stringify(packages?.torchBuiltIn)}, not false; the engine is the build without torch, which comes as ${moduleFileName(version, TORCH_PACKAGE.variant)}`] : []),
    ...(installedPackages(packages).length ? [`pythonPackages() already lists ${installedPackages(packages).join(', ')} as installed in a fresh engine`] : []),
  ];
  fail(`the ${bundle} engine does not describe itself as ZIPP ${release}`, [...profileProblems(profile, { version, languages: LANGUAGES, commit: meta.commit }), ...packageProblems]);

  const { files: kitFiles, record: kitRecord, notices } = await verifyKit({ release, sums, kit, commit: meta.commit });
  const files = new Map([['zipp_wasm_bg.wasm', wasm], ['zipp_wasm.js', glue], ...kitFiles]);
  let noticesSource;
  if (notices) {
    files.set(NOTICES, notices);
    noticesSource = 'zipp-release';
  } else {
    if (!fs.existsSync(curatedNotices)) refuse(`ZIPP ${release} ships no ${NOTICES} and the curated copy ${rel(curatedNotices)} is missing`);
    files.set(NOTICES, fs.readFileSync(curatedNotices));
    noticesSource = 'softn-curated';
  }
  files.set('RELEASE-SHA256SUMS', sums);

  const source = {
    repository: REPOSITORY,
    release,
    version,
    revision: meta.commit,
    build: 'release',
    bundle,
    bundleSha256,
    sumsSha256,
    variant: meta.variant,
    languages: meta.languages,
    stackBytes: wasmStackBytes(wasm),
    license: 'Apache-2.0',
    artifact: 'zipp_wasm_bg.wasm',
    sha256: sha256(wasm),
    glueSha256: sha256(glue),
    kit: kitRecord,
    notices: { file: NOTICES, source: noticesSource, sha256: sha256(files.get(NOTICES)) },
  };
  files.set('SOURCE.json', Buffer.from(`${JSON.stringify(source, null, 2)}\n`));
  return { files, source };
}

/** The `variants.<id>` record the primary SOURCE.json carries for a variant: the fields FormLogic compares by key. */
const variantRecord = (source) => ({ bundle: source.bundle, bundleSha256: source.bundleSha256, sha256: source.sha256, glueSha256: source.glueSha256, variant: source.variant, languages: source.languages, stackBytes: source.stackBytes, commit: source.commit });

/**
 * Problems with a variant module set beside the primary's: it must ask the host
 * for nothing the primary's glue — the only glue Softn ships — does not provide,
 * and export nothing the primary does not. Instantiation reads only the imports
 * a module declares, so a variant may import less than the primary (0.0.21's
 * web build has no torch, so it does not import the torch kernel hook), never
 * more. Read from the binaries; nothing is compiled.
 */
export function variantModuleProblems(variantWasm, primaryWasm, { bundle = 'the variant', primary = 'the engine' } = {}) {
  const problems = [];
  if (!isZippEngineWasm(variantWasm)) return [`${bundle} does not export what a ZIPP engine exports (${wasmExportNames(variantWasm) === null ? 'not a WebAssembly module' : 'a module, but not the engine'})`];
  const [imports, primaryImports] = [wasmImportNames(variantWasm), wasmImportNames(primaryWasm)];
  const extra = imports.filter((name) => !primaryImports.includes(name));
  if (extra.length) problems.push(`${bundle} imports ${extra.join(', ')}, which ${primary} does not, so the engine's glue cannot be known to bind it`);
  const foreign = wasmExportNames(variantWasm).filter((name) => !wasmExportNames(primaryWasm).includes(name));
  if (foreign.length) problems.push(`${bundle} exports ${foreign.join(', ')}, which ${primary} does not; a variant runs under the engine's glue and may export nothing that engine lacks`);
  return problems;
}

/**
 * Verify the release's JavaScript-only module as a variant of the verified
 * primary (`verifyRelease`'s result) and return the files of its install with
 * its SOURCE.json, and the record the primary SOURCE.json carries for it.
 * Refuses with ZippReleaseError.
 */
export async function verifyVariant({ release, sums, wasm, primary, id = WEB_VARIANT.id }) {
  const version = release.slice(1);
  const expected = WEB_VARIANT;
  const bundle = moduleFileName(version, expected.variant);
  const bundleSha256 = listedDigest(sums, release, bundle, wasm);

  const meta = moduleMeta(wasm, bundle);
  const glue = moduleGlue(wasm, bundle);
  // The one fact that makes it a variant rather than another engine: the same source.
  if (COMMIT.test(meta.commit ?? '') && meta.commit !== primary.source.revision) refuse(`${bundle} is built from commit ${meta.commit}, not ${primary.source.revision} like ${primary.source.bundle}; a variant ships only from the release's own commit`);
  fail(`${bundle} is not the ZIPP ${release} javascript engine`, [...metaProblems(meta, { version, variant: expected.variant, languages: [...expected.languages], glue }), ...stackProblems(wasm, expected.stackBytes)]);

  const primaryWasm = primary.files.get('zipp_wasm_bg.wasm');
  // Another build of the same source, not the same build under another name.
  if (sha256(wasm) === primary.source.sha256) refuse(`${bundle} is the ${primary.source.bundle} module itself (${primary.source.sha256.slice(0, 12)}), not a variant of it`);
  fail(`${bundle} cannot run under the engine's glue`, variantModuleProblems(wasm, primaryWasm, { bundle, primary: primary.source.bundle }));

  // Loaded under the glue it will really run under, it must say it is this
  // release's JavaScript-only engine, and every Python entry point must refuse.
  let profile;
  const pythonRefusals = [];
  try {
    const module = await loadEngine(primary.files.get('zipp_wasm.js'), wasm);
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
    refuse(`the ${bundle} engine does not load under the engine's glue: ${error.message}`);
  }
  fail(`the ${bundle} engine does not describe itself as the ZIPP ${release} javascript engine`, [...profileProblems(profile, { version, languages: [...expected.languages], commit: meta.commit }), ...pythonRefusals]);

  const files = new Map([['zipp_wasm_bg.wasm', wasm]]);
  const source = {
    repository: REPOSITORY,
    release,
    version,
    revision: meta.commit,
    build: 'release',
    bundle,
    bundleSha256,
    sumsSha256: sha256(sums),
    variant: meta.variant,
    languages: meta.languages,
    stackBytes: wasmStackBytes(wasm),
    license: 'Apache-2.0',
    artifact: 'zipp_wasm_bg.wasm',
    sha256: sha256(wasm),
    // The module's own bindings, recorded and not shipped: this build runs under the primary's.
    glueSha256: sha256(glue),
    commit: meta.commit,
    // The engine this is a variant of, and whose glue runs it.
    primary: { bundle: primary.source.bundle, sha256: primary.source.sha256, glueSha256: primary.source.glueSha256 },
  };
  files.set('SOURCE.json', Buffer.from(`${JSON.stringify(source, null, 2)}\n`));
  return { files, source, record: variantRecord(source) };
}

/** The `packages.<id>` record the primary SOURCE.json carries for a package: the fields both sides must agree on. */
const packageRecord = (source) => ({ bundle: source.bundle, bundleSha256: source.bundleSha256, sha256: source.sha256, loaderSha256: source.loaderSha256, variant: source.variant, pairsWith: source.pairsWith, commit: source.commit, engineAbi: source.engineAbi });

/** A small program only an engine with torch can run, and what it answers. */
const TORCH_PROBE = { files: { 'probe.py': 'import torch\n\ndef answer():\n    return float((torch.tensor([1.0, 2.0]) * 3.0).sum())\n' }, entry: 'probe', call: 'answer', expect: 9 };

/** The generated loader as a module, imported from its own text: what verifyPackage runs the package through. */
async function importLoader(text) {
  return import(`data:text/javascript;base64,${Buffer.from(`${text}\n// ${randomBytes(8).toString('hex')}\n`).toString('base64')}`);
}

/**
 * Verify the release's torch-package module as the torch package of the
 * verified primary (`verifyRelease`'s result) and return the files of its
 * install with its SOURCE.json, and the record the primary SOURCE.json
 * carries for it. `loader` is the loader's text (TORCH_LOADER), which the
 * package is added through. Refuses with ZippReleaseError.
 */
export async function verifyPackage({ release, sums, wasm, primary, id = TORCH_PACKAGE.id, loader = TORCH_LOADER }) {
  const version = release.slice(1);
  const bundle = moduleFileName(version, TORCH_PACKAGE.variant);
  const bundleSha256 = listedDigest(sums, release, bundle, wasm);

  const meta = moduleMeta(wasm, bundle);
  // Refused for its commit before the module is asked anything.
  if (COMMIT.test(meta.commit ?? '') && meta.commit !== primary.source.revision) refuse(`${bundle} is built from commit ${meta.commit}, not ${primary.source.revision} like ${primary.source.bundle}; a package ships only from the release's own commit`);
  fail(`${bundle} is not the ZIPP ${release} torch package`, metaProblems(meta, { version, variant: TORCH_PACKAGE.variant, languages: [...TORCH_PACKAGE.languages], glue: moduleGlue(wasm, bundle), engine: false }));
  fail(`${bundle} is not a torch package module`, packageModuleProblems(wasm, { bundle }));

  // The pairing proven, not just declared: the engine loaded under its glue,
  // the package added by the loader Softn ships, and torch then really imported.
  const problems = [];
  let engineAbi;
  try {
    const engine = await loadEngine(primary.files.get('zipp_wasm.js'), primary.files.get('zipp_wasm_bg.wasm'));
    const loaderModule = await importLoader(loader);
    if (typeof loaderModule.addTorchSync !== 'function' || typeof loaderModule.addTorch !== 'function') refuse(`${TORCH_PACKAGE.loader} does not export addTorch and addTorchSync`);
    let report;
    try {
      report = loaderModule.addTorchSync(engine, wasm);
    } catch (error) {
      refuse(`the ${primary.source.bundle} engine refuses the ${bundle} package: ${error.message}`);
    }
    if (report?.name !== id) problems.push(`addTorchSync() reports the package ${JSON.stringify(report?.name)}, not ${id}`);
    if (report?.version !== version) problems.push(`addTorchSync() reports version ${JSON.stringify(report?.version)}, not ${version}`);
    const after = JSON.parse(engine.pythonPackages());
    engineAbi = after.engineAbi;
    if (!installedPackages(after).includes(id)) problems.push(`pythonPackages() does not list ${id} as installed after addTorchSync()`);
    if (typeof engineAbi !== 'string' || !/^[0-9a-f]+$/.test(engineAbi)) problems.push(`pythonPackages() engineAbi ${JSON.stringify(engineAbi)} is not a hex digest`);
    const probe = new engine.Engine();
    try {
      probe.initPythonProject(TORCH_PROBE.files, TORCH_PROBE.entry, []);
      const answer = probe.pythonCall(TORCH_PROBE.call, []);
      if (answer !== TORCH_PROBE.expect) problems.push(`an \`import torch\` project answers ${JSON.stringify(answer)}, not ${TORCH_PROBE.expect}`);
    } catch (error) {
      problems.push(`an \`import torch\` project does not run on the engine with the package added: ${error.message}`);
    } finally {
      try {
        probe.dispose?.();
        probe.free?.();
      } catch {}
    }
  } catch (error) {
    if (error instanceof ZippReleaseError) throw error;
    refuse(`the ${bundle} package does not load into the ${primary.source.bundle} engine: ${error.message}`);
  }
  fail(`the ${bundle} package does not give the ${primary.source.bundle} engine torch`, problems);

  const loaderBytes = Buffer.from(loader);
  const declarations = Buffer.from(TORCH_DECLARATIONS);
  const files = new Map([[TORCH_PACKAGE.artifact, wasm], [TORCH_PACKAGE.loader, loaderBytes], [TORCH_PACKAGE.declarations, declarations]]);
  const source = {
    repository: REPOSITORY,
    release,
    version,
    revision: meta.commit,
    build: 'release',
    bundle,
    bundleSha256,
    sumsSha256: sha256(sums),
    variant: meta.variant,
    languages: meta.languages,
    // The engine it was added to and ran torch on at install.
    pairsWith: primary.source.bundle,
    license: 'Apache-2.0',
    artifact: TORCH_PACKAGE.artifact,
    sha256: sha256(wasm),
    // Softn's, not the release's: the loader and its types, generated here.
    loader: TORCH_PACKAGE.loader,
    loaderSha256: sha256(loaderBytes),
    loaderSource: 'softn-generated',
    declarations: { file: TORCH_PACKAGE.declarations, source: 'softn-generated', sha256: sha256(declarations) },
    commit: meta.commit,
    // The engine ABI the package was accepted under (pythonPackages().engineAbi).
    engineAbi,
    // The engine this package is added to.
    primary: { bundle: primary.source.bundle, sha256: primary.source.sha256, glueSha256: primary.source.glueSha256 },
  };
  files.set('SOURCE.json', Buffer.from(`${JSON.stringify(source, null, 2)}\n`));
  return { files, source, record: packageRecord(source) };
}

/**
 * Verify a release all the way down: the primary engine and the kit, then its
 * web variant and its torch package against it. Returns the three installs'
 * files, with the primary SOURCE.json carrying `variants.web` and
 * `packages.torch`. Refuses with ZippReleaseError.
 */
export async function verifyReleaseFiles({ release, sums, wasm, kit, variantWasm, packageWasm, expectSumsSha256, curatedNotices }) {
  const primary = await verifyRelease({ release, sums, wasm, kit, expectSumsSha256, curatedNotices });
  const variant = await verifyVariant({ release, sums, wasm: variantWasm, primary });
  const torch = await verifyPackage({ release, sums, wasm: packageWasm, primary });
  // Additive, and last: every key before them is byte for byte what it was.
  primary.source.variants = { [WEB_VARIANT.id]: variant.record };
  primary.source.packages = { [TORCH_PACKAGE.id]: torch.record };
  primary.files.set('SOURCE.json', Buffer.from(`${JSON.stringify(primary.source, null, 2)}\n`));
  return { primary, variant, torch };
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
  const [engine, web, torchPackage, kitName] = releaseFiles(release.slice(1));
  log(`Taking ${engine}, ${web}, ${torchPackage} and ${kitName} from ZIPP ${release}${releaseDir ? ` in ${releaseDir}` : ''} ...`);
  const load = (name) => loadReleaseFile({ release, sums, name, releaseDir, cacheDir, fetch: fetchImpl });
  const wasm = await load(engine);
  const variantWasm = await load(web);
  const packageWasm = await load(torchPackage);
  const kit = await load(kitName);
  const { primary, variant, torch } = await verifyReleaseFiles({ release, sums, wasm, kit, variantWasm, packageWasm, expectSumsSha256, curatedNotices });
  assertHeld();
  // The variant and the package first: the primary's SOURCE.json is what says they are there.
  writeInstall(variantDir(dir), variant.files);
  writeInstall(packageDir(dir), torch.files);
  writeInstall(dir, primary.files);
  // What landed on disk, not what was meant to.
  const source = checkEngine(dir, { curatedNotices });
  log(`Installed ZIPP ${release} (${source.revision.slice(0, 8)}) into ${rel(dir)}; engine sha256 ${source.sha256}; web variant sha256 ${variant.source.sha256} into ${rel(variantDir(dir))}; torch package sha256 ${torch.source.sha256} into ${rel(packageDir(dir))}${source.notices.source === 'softn-curated' ? `; notices: the curated copy (${release} ships none)` : ''}`);
  return source;
}

/** Resolve, fetch (or read), verify and install a release. Returns its SOURCE.json. */
export async function installRelease({ dir = ENGINE_DIR, warn, ...options } = {}) {
  return withInstallLock(dir, (assertHeld) => installReleaseLocked({ dir, ...options, assertHeld }), { warn });
}

// ---------------------------------------------------------------------------
// Check an install
// ---------------------------------------------------------------------------

/** A folder's files, as name to bytes, and the problems of what it holds against `expected` (`kind` names the install). */
function readInstall(dir, expected, kind) {
  const problems = [];
  const present = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) problems.push(`${entry.name} is not a plain file`);
    else if (!expected.includes(entry.name)) problems.push(`${entry.name} is not part of ${kind}`);
    else present.set(entry.name, fs.readFileSync(path.join(dir, entry.name)));
  }
  for (const name of expected) if (!present.has(name)) problems.push(`${name} is missing`);
  return { present, problems };
}

/** A folder's SOURCE.json, or a refusal saying the folder holds no such install. */
function readSource(dir, what) {
  const where = rel(dir);
  const sourceFile = path.join(dir, 'SOURCE.json');
  if (!fs.existsSync(sourceFile)) refuse(`${where} holds no ${what} (no SOURCE.json); run npm run fetch:zipp`);
  try {
    return JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  } catch (error) {
    refuse(`${where}/SOURCE.json is not JSON: ${error.message}`);
  }
}

/** A module's record read back from its installed bytes, as problems instead of a refusal. */
function installedMetaProblems(bytes, name, expected) {
  try {
    return metaProblems(moduleMeta(bytes, name), { ...expected, glue: moduleGlue(bytes, name) });
  } catch (error) {
    if (!(error instanceof ZippReleaseError)) throw error;
    return [error.message];
  }
}

/**
 * Check an install offline and return its SOURCE.json. Its module must be the
 * file RELEASE-SHA256SUMS lists, byte for byte, with the record and the stack
 * SOURCE.json says; zipp_wasm.js must be that module's own bindings; the
 * kit's files the digests recorded, the kit itself listed in
 * RELEASE-SHA256SUMS; RELEASE-SHA256SUMS the digest recorded; and the web
 * variant and torch package beside it must check (checkVariant,
 * checkPackage).
 */
export function checkEngine(dir = ENGINE_DIR, { curatedNotices = CURATED_NOTICES } = {}) {
  const where = rel(dir);
  const source = readSource(dir, 'ZIPP install');
  if (source.build !== 'release') refuse(`${where} holds a '${source.build}' ZIPP build, not a verified release install; run npm run fetch:zipp`);
  const { present, problems } = readInstall(dir, INSTALLED_FILES, 'an install');

  const version = source.version;
  if (source.repository !== REPOSITORY) problems.push(`SOURCE.json repository is ${source.repository}, not ${REPOSITORY}`);
  if (!isReleaseTag(source.release) || source.release !== `v${version}`) problems.push(`SOURCE.json release ${source.release} and version ${version} do not agree`);
  if (!COMMIT.test(source.revision ?? '')) problems.push('SOURCE.json revision is not a full commit');
  if (source.bundle !== moduleFileName(version)) problems.push(`SOURCE.json bundle ${source.bundle} is not the javascript-python-base engine (${moduleFileName(version)})`);
  for (const field of ['bundleSha256', 'sumsSha256', 'sha256', 'glueSha256']) if (!HEX64.test(source[field] ?? '')) problems.push(`SOURCE.json ${field} is not a sha256`);
  if (source.bundleSha256 !== source.sha256) problems.push(`SOURCE.json sha256 ${source.sha256} is not the bundleSha256 ${source.bundleSha256}; the engine is installed as published`);
  if (source.variant !== VARIANT || !isDeepStrictEqual(source.languages, LANGUAGES) || source.stackBytes !== STACK_BYTES) problems.push(`SOURCE.json records ${source.variant} ${JSON.stringify(source.languages)} with a ${source.stackBytes}-byte stack, not the javascript-python-base engine`);
  if (source.artifact !== 'zipp_wasm_bg.wasm') problems.push(`SOURCE.json artifact is ${source.artifact}`);
  const kit = source.kit ?? {};
  if (kit.bundle !== kitFileName(version) || !HEX64.test(kit.bundleSha256 ?? '')) problems.push(`SOURCE.json kit ${JSON.stringify(kit.bundle)} is not the release's embed kit (${kitFileName(version)}) with its sha256`);
  for (const [name, from] of Object.entries(KIT_FILES)) {
    const file = kit.files?.[name];
    if (file?.from !== from || !HEX64.test(file?.sha256 ?? '')) problems.push(`SOURCE.json kit.files records ${name} as ${JSON.stringify(file)}, not the kit's ${from} with its sha256`);
    else if (present.has(name) && sha256(present.get(name)) !== file.sha256) problems.push(`${name} is not the kit's ${from} recorded (${file.sha256})`);
  }
  const notices = source.notices ?? {};
  if (notices.file !== NOTICES || !['zipp-release', 'softn-curated'].includes(notices.source) || !HEX64.test(notices.sha256 ?? '')) problems.push(`SOURCE.json notices ${JSON.stringify(source.notices)} are not recorded`);

  if (present.has('RELEASE-SHA256SUMS')) {
    const sums = present.get('RELEASE-SHA256SUMS');
    const listed = parseSums(sums);
    if (sha256(sums) !== source.sumsSha256) problems.push(`RELEASE-SHA256SUMS has sha256 ${sha256(sums)}, not the recorded ${source.sumsSha256}`);
    if (listed.get(source.bundle) !== source.bundleSha256) problems.push(`RELEASE-SHA256SUMS does not list ${source.bundle} with the recorded ${source.bundleSha256}`);
    if (listed.get(kit.bundle) !== kit.bundleSha256) problems.push(`RELEASE-SHA256SUMS does not list ${kit.bundle} with the recorded ${kit.bundleSha256}`);
  }
  if (present.has('zipp_wasm_bg.wasm')) {
    const wasm = present.get('zipp_wasm_bg.wasm');
    if (sha256(wasm) !== source.sha256) problems.push(`zipp_wasm_bg.wasm is not the recorded ${source.sha256}`);
    problems.push(...installedMetaProblems(wasm, 'zipp_wasm_bg.wasm', { version, variant: VARIANT, languages: LANGUAGES, commit: source.revision }).map((p) => `zipp_wasm_bg.wasm: ${p}`));
    problems.push(...stackProblems(wasm, STACK_BYTES).map((p) => `zipp_wasm_bg.wasm: ${p}`));
    let glue = null;
    try {
      glue = moduleGlue(wasm, 'zipp_wasm_bg.wasm');
    } catch {}
    if (present.has('zipp_wasm.js') && !(glue && glue.equals(present.get('zipp_wasm.js')))) problems.push(`zipp_wasm.js is not the bindings zipp_wasm_bg.wasm carries (its ${GLUE_SECTION} section)`);
  }
  if (present.has('zipp_wasm.js') && sha256(present.get('zipp_wasm.js')) !== source.glueSha256) problems.push(`zipp_wasm.js is not the recorded ${source.glueSha256}`);
  if (present.has(NOTICES)) {
    if (sha256(present.get(NOTICES)) !== notices.sha256) problems.push(`${NOTICES} is not the recorded ${notices.sha256}`);
    else if (notices.source === 'softn-curated' && !(fs.existsSync(curatedNotices) && fs.readFileSync(curatedNotices).equals(present.get(NOTICES)))) problems.push(`${NOTICES} is not the curated copy in ${rel(curatedNotices)}`);
  }
  if (!source.variants?.[WEB_VARIANT.id]) problems.push(`SOURCE.json records no ${WEB_VARIANT.id} variant of the engine (variants.${WEB_VARIANT.id}); the release's javascript engine is installed beside it as one`);
  if (!source.packages?.[TORCH_PACKAGE.id]) problems.push(`SOURCE.json records no ${TORCH_PACKAGE.id} package of the engine (packages.${TORCH_PACKAGE.id}); the release's torch package is installed beside it as one`);
  fail(`the ZIPP install in ${where} does not check (run npm run fetch:zipp)`, problems);
  checkVariant(variantDir(dir), source, present);
  checkPackage(packageDir(dir), source, present);
  return source;
}

/**
 * Check the torch package install beside a checked primary, offline. It is
 * exactly its files; its SOURCE.json is the record the primary's
 * `packages.torch` names, field for field; its module is the file the
 * primary's RELEASE-SHA256SUMS lists, with the record of the release's torch
 * package of the engine's commit, and still has the package's shape; and the
 * loader and declarations are the generated text. Nothing is loaded: the
 * addTorchSync probe ran at install over these bytes.
 */
export function checkPackage(dir, primarySource, primaryFiles, id = TORCH_PACKAGE.id) {
  const where = rel(dir);
  const record = primarySource.packages[id];
  const source = readSource(dir, `ZIPP ${id} package install`);
  const { present, problems } = readInstall(dir, PACKAGE_INSTALLED_FILES, 'a package install');

  const version = primarySource.version;
  for (const [field, value] of Object.entries(packageRecord(source))) {
    if (!isDeepStrictEqual(record[field], value)) problems.push(`SOURCE.json ${field} is ${JSON.stringify(value)}; the primary install's packages.${id} records ${JSON.stringify(record[field])}`);
  }
  if (source.build !== 'release') problems.push(`SOURCE.json build is '${source.build}', not a verified release install`);
  if (source.repository !== REPOSITORY) problems.push(`SOURCE.json repository is ${source.repository}, not ${REPOSITORY}`);
  if (source.release !== primarySource.release || source.version !== version) problems.push(`SOURCE.json names ZIPP ${source.release} (${source.version}), not the primary install's ${primarySource.release}`);
  if (source.bundle !== moduleFileName(version, TORCH_PACKAGE.variant)) problems.push(`SOURCE.json bundle ${source.bundle} is not the torch package (${moduleFileName(version, TORCH_PACKAGE.variant)})`);
  for (const field of ['bundleSha256', 'sumsSha256', 'sha256']) if (!HEX64.test(source[field] ?? '')) problems.push(`SOURCE.json ${field} is not a sha256`);
  if (source.bundleSha256 !== source.sha256) problems.push(`SOURCE.json sha256 ${source.sha256} is not the bundleSha256 ${source.bundleSha256}; the package is installed as published`);
  if (source.variant !== TORCH_PACKAGE.variant || !isDeepStrictEqual(source.languages, [...TORCH_PACKAGE.languages]) || source.artifact !== TORCH_PACKAGE.artifact) problems.push(`SOURCE.json records ${source.variant} ${JSON.stringify(source.languages)} ${source.artifact}, not the torch package`);
  if (source.pairsWith !== primarySource.bundle) problems.push(`SOURCE.json pairsWith ${source.pairsWith} is not the primary install's engine ${primarySource.bundle}`);
  if (source.revision !== primarySource.revision || source.commit !== primarySource.revision) problems.push(`SOURCE.json commit ${source.commit} is not the primary install's revision ${primarySource.revision}; a package is built from the engine's own source`);
  if (source.sumsSha256 !== primarySource.sumsSha256) problems.push(`SOURCE.json sumsSha256 ${source.sumsSha256} is not the primary install's ${primarySource.sumsSha256}; every file comes from one SHA256SUMS`);
  if (typeof source.engineAbi !== 'string' || !/^[0-9a-f]+$/.test(source.engineAbi)) problems.push(`SOURCE.json engineAbi ${JSON.stringify(source.engineAbi)} is not recorded`);
  if (!isDeepStrictEqual(source.primary, { bundle: primarySource.bundle, sha256: primarySource.sha256, glueSha256: primarySource.glueSha256 })) problems.push(`SOURCE.json primary ${JSON.stringify(source.primary)} is not the primary install`);
  // The loader is recorded as it always was (loader, loaderSha256), now with where it came from.
  const loader = { file: source.loader, source: source.loaderSource, sha256: source.loaderSha256 };
  for (const [key, recorded, file, text] of [['loader', loader, TORCH_PACKAGE.loader, TORCH_LOADER], ['declarations', source.declarations ?? {}, TORCH_PACKAGE.declarations, TORCH_DECLARATIONS]]) {
    if (recorded.file !== file || recorded.source !== 'softn-generated' || recorded.sha256 !== sha256(Buffer.from(text))) problems.push(`SOURCE.json ${key} ${JSON.stringify(recorded)} is not the generated ${file}`);
    if (present.has(file) && present.get(file).toString('utf8') !== text) problems.push(`${file} is not the text this script generates`);
  }

  if (primaryFiles.has('RELEASE-SHA256SUMS') && parseSums(primaryFiles.get('RELEASE-SHA256SUMS')).get(source.bundle) !== source.bundleSha256) problems.push(`RELEASE-SHA256SUMS does not list ${source.bundle} with the recorded ${source.bundleSha256}`);
  if (present.has(TORCH_PACKAGE.artifact)) {
    const bytes = present.get(TORCH_PACKAGE.artifact);
    if (sha256(bytes) !== source.sha256) problems.push(`${TORCH_PACKAGE.artifact} is not the recorded ${source.sha256}`);
    problems.push(...installedMetaProblems(bytes, TORCH_PACKAGE.artifact, { version, variant: TORCH_PACKAGE.variant, languages: [...TORCH_PACKAGE.languages], commit: primarySource.revision, engine: false }).map((p) => `${TORCH_PACKAGE.artifact}: ${p}`));
    problems.push(...packageModuleProblems(bytes, { bundle: TORCH_PACKAGE.artifact }));
  }
  fail(`the ZIPP ${id} package install in ${where} does not check (run npm run fetch:zipp)`, problems);
  return source;
}

/**
 * Check the web variant install beside a checked primary, offline. It is
 * exactly its files; its SOURCE.json is the record the primary's `variants.web`
 * names, field for field; its module is the file the primary's
 * RELEASE-SHA256SUMS lists, with the record and the stack of the release's
 * javascript engine of the primary's commit, its own bindings the digest
 * recorded; and it still fits under the primary's glue.
 */
export function checkVariant(dir, primarySource, primaryFiles, id = WEB_VARIANT.id) {
  const where = rel(dir);
  const record = primarySource.variants[id];
  const source = readSource(dir, `ZIPP ${id} variant install`);
  const { present, problems } = readInstall(dir, VARIANT_INSTALLED_FILES, 'a variant install');

  const version = primarySource.version;
  const expected = WEB_VARIANT;
  for (const [field, value] of Object.entries(variantRecord(source))) {
    if (!isDeepStrictEqual(record[field], value)) problems.push(`SOURCE.json ${field} is ${JSON.stringify(value)}; the primary install's variants.${id} records ${JSON.stringify(record[field])}`);
  }
  if (source.build !== 'release') problems.push(`SOURCE.json build is '${source.build}', not a verified release install`);
  if (source.repository !== REPOSITORY) problems.push(`SOURCE.json repository is ${source.repository}, not ${REPOSITORY}`);
  if (source.release !== primarySource.release || source.version !== version) problems.push(`SOURCE.json names ZIPP ${source.release} (${source.version}), not the primary install's ${primarySource.release}`);
  if (source.bundle !== moduleFileName(version, expected.variant)) problems.push(`SOURCE.json bundle ${source.bundle} is not the javascript engine (${moduleFileName(version, expected.variant)})`);
  for (const field of ['bundleSha256', 'sumsSha256', 'sha256', 'glueSha256']) if (!HEX64.test(source[field] ?? '')) problems.push(`SOURCE.json ${field} is not a sha256`);
  if (source.bundleSha256 !== source.sha256) problems.push(`SOURCE.json sha256 ${source.sha256} is not the bundleSha256 ${source.bundleSha256}; the variant is installed as published`);
  if (source.variant !== expected.variant || !isDeepStrictEqual(source.languages, [...expected.languages]) || source.stackBytes !== expected.stackBytes) problems.push(`SOURCE.json records ${source.variant} ${JSON.stringify(source.languages)} with a ${source.stackBytes}-byte stack, not the javascript engine`);
  if (source.artifact !== 'zipp_wasm_bg.wasm') problems.push(`SOURCE.json artifact is ${source.artifact}`);
  if (source.revision !== primarySource.revision || source.commit !== primarySource.revision) problems.push(`SOURCE.json commit ${source.commit} is not the primary install's revision ${primarySource.revision}; a variant is the same source built again`);
  if (source.sumsSha256 !== primarySource.sumsSha256) problems.push(`SOURCE.json sumsSha256 ${source.sumsSha256} is not the primary install's ${primarySource.sumsSha256}; every file comes from one SHA256SUMS`);
  if (!isDeepStrictEqual(source.primary, { bundle: primarySource.bundle, sha256: primarySource.sha256, glueSha256: primarySource.glueSha256 })) problems.push(`SOURCE.json primary ${JSON.stringify(source.primary)} is not the primary install`);

  if (primaryFiles.has('RELEASE-SHA256SUMS') && parseSums(primaryFiles.get('RELEASE-SHA256SUMS')).get(source.bundle) !== source.bundleSha256) problems.push(`RELEASE-SHA256SUMS does not list ${source.bundle} with the recorded ${source.bundleSha256}`);
  if (present.has('zipp_wasm_bg.wasm')) {
    const wasm = present.get('zipp_wasm_bg.wasm');
    const digest = sha256(wasm);
    if (digest !== source.sha256) problems.push(`zipp_wasm_bg.wasm is not the recorded ${source.sha256}`);
    if (digest === primarySource.sha256) problems.push(`zipp_wasm_bg.wasm is the primary install's module itself (${digest.slice(0, 12)}), not a variant of it`);
    problems.push(...installedMetaProblems(wasm, 'zipp_wasm_bg.wasm', { version, variant: expected.variant, languages: [...expected.languages], commit: primarySource.revision }).map((p) => `zipp_wasm_bg.wasm: ${p}`));
    problems.push(...stackProblems(wasm, expected.stackBytes).map((p) => `zipp_wasm_bg.wasm: ${p}`));
    let glue = null;
    try {
      glue = moduleGlue(wasm, 'zipp_wasm_bg.wasm');
    } catch {}
    if (glue && sha256(glue) !== source.glueSha256) problems.push(`zipp_wasm_bg.wasm carries bindings ${sha256(glue)}, not the recorded ${source.glueSha256}`);
    if (primaryFiles.has('zipp_wasm_bg.wasm')) problems.push(...variantModuleProblems(wasm, primaryFiles.get('zipp_wasm_bg.wasm'), { bundle: source.bundle, primary: primarySource.bundle }));
  }
  fail(`the ZIPP ${id} variant install in ${where} does not check (run npm run fetch:zipp)`, problems);
  return source;
}

/** --check, then the install against the release as published now: ZIPP's SHA256SUMS, every module taken, and the kit and the files taken from it. */
export async function checkEngineOnline(dir = ENGINE_DIR, { fetch: fetchImpl = globalThis.fetch, curatedNotices } = {}) {
  const source = checkEngine(dir, { curatedNotices });
  const problems = [];
  const sums = await download(releaseUrl(source.release, 'SHA256SUMS'), fetchImpl);
  if (!sums.equals(fs.readFileSync(path.join(dir, 'RELEASE-SHA256SUMS')))) problems.push(`RELEASE-SHA256SUMS is not the SHA256SUMS published under ${source.release}`);
  const torch = source.packages[TORCH_PACKAGE.id];
  for (const [bundle, file] of [[source.bundle, path.join(dir, 'zipp_wasm_bg.wasm')], [source.variants[WEB_VARIANT.id].bundle, path.join(variantDir(dir), 'zipp_wasm_bg.wasm')], [torch.bundle, path.join(packageDir(dir), TORCH_PACKAGE.artifact)]]) {
    const published = await download(releaseUrl(source.release, bundle), fetchImpl);
    if (!published.equals(fs.readFileSync(file))) problems.push(`${rel(file)} is not the published ${bundle}`);
  }
  const kit = await download(releaseUrl(source.release, source.kit.bundle), fetchImpl);
  if (sha256(kit) !== source.kit.bundleSha256) problems.push(`the published ${source.kit.bundle} is not the recorded ${source.kit.bundleSha256}`);
  else {
    const entries = await unzipKit(kit, source.version);
    for (const [name, from] of [...Object.entries(KIT_FILES), ...(source.notices.source === 'zipp-release' ? [[NOTICES, NOTICES]] : [])]) {
      if (!entries.get(from)?.equals(fs.readFileSync(path.join(dir, name)))) problems.push(`${name} is not ${from} in the published ${source.kit.bundle}`);
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
  // A local build has no variant or package; a release's must not survive beside it as if it were this build's.
  for (const [what, folder] of [['web variant', variantDir(dir)], ['torch package', packageDir(dir)]]) {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch (error) {
      refuse(`could not remove the release's ${what} in ${rel(folder)} beside the local build: ${error.message}`);
    }
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
    console.log(`ZIPP ${source.release} (${source.revision.slice(0, 8)}) in ${rel(dir)} checks, with its web variant (${source.variants[WEB_VARIANT.id].sha256.slice(0, 12)}) in ${rel(variantDir(dir))} and its torch package (${source.packages[TORCH_PACKAGE.id].sha256.slice(0, 12)}) in ${rel(packageDir(dir))}${has('--online') ? ', against the published release' : ''}.`);
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
