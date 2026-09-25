/**
 * The ZIPP install takes a release only when every layer checks: the bundle
 * against ZIPP's SHA256SUMS, each file against the bundle's own, BUILD-INFO.txt
 * and the module itself against the web-python-base build of that release —
 * and the release's web bundle, installed beside it as a variant, against the
 * same SHA256SUMS and then against the engine: the same commit, the same
 * imports, no export the engine lacks, and exactly JavaScript once loaded
 * under the engine's glue — and its web-torch bundle, installed beside it as
 * the engine's torch package, against the same SHA256SUMS, the engine bundle
 * it pairs with and its commit, and then really added to the engine by its
 * own loader, after which an `import torch` project runs.
 *
 * The fixture release is built around the installed engine and its installed
 * variant (a real glue and two real modules, so the install's zippProfile()
 * checks really run), with the inner and top-level SHA256SUMS rebuilt per case,
 * so a case trips only the refusal it is about. Releases come from a folder
 * (ZIPP_RELEASE_DIR) through the command line, or from a stubbed fetch in
 * process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { CURATED_NOTICES, INSTALLED_FILES, PACKAGE_INSTALLED_FILES, REPOSITORY, TORCH_DECLARATIONS, TORCH_PACKAGE, VARIANT_INSTALLED_FILES, WEB_VARIANT, ZippReleaseError, checkEngine, checkEngineOnline, ensureEngine, ensureReleaseEngine, installLocal, installRelease, packageDir, packageModuleProblems, removeStaleLock, resolveRelease, sha256, variantDir, variantModuleProblems, verifyPackage, verifyRelease, verifyVariant, withInstallLock, writeInstall } from './fetch-zipp-release.mjs';
import { wasmExportNames, wasmImportNames } from '../../../../scripts/lib/zipp-engine-copy.mjs';

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(CORE, 'wasm-zipp');
const WEB_ENGINE = path.join(CORE, 'wasm-zipp-web');
const TORCH_ENGINE = path.join(CORE, 'wasm-zipp-torch');
const SCRIPT = path.join(CORE, 'scripts/fetch-zipp-release.mjs');
const ENGINE_COPY_LIB = path.resolve(CORE, '../../../scripts/lib/zipp-engine-copy.mjs');
const installed = (name) => fs.readFileSync(path.join(ENGINE, name));
const installedWeb = (name) => fs.readFileSync(path.join(WEB_ENGINE, name));
const installedTorch = (name) => fs.readFileSync(path.join(TORCH_ENGINE, name));
const source = JSON.parse(installed('SOURCE.json'));
const TAG = source.release;
const VERSION = source.version;
const BUNDLE = `zipp-wasm-${VERSION}-web-python-base`;
const WEB_BUNDLE = `zipp-wasm-${VERSION}-web`;
const TORCH_BUNDLE = `zipp-wasm-${VERSION}-web-torch`;
/** The three folders an install is: what a test looks for beside `out`. */
const BOTH = ['wasm-zipp', 'wasm-zipp-torch', 'wasm-zipp-web'];
const quiet = () => {};

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const setBuildInfo = (files, key, value) => files.set('BUILD-INFO.txt', Buffer.from(files.get('BUILD-INFO.txt').toString('utf8').replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)));

/** A bundle's files zipped under `name/`, with its SHA256SUMS written over `files` unless `innerSums` rewrites it and `tamper` edits after. */
function packBundle(name, files, { innerSums, tamper, level = 0 } = {}) {
  let sums = `${[...files].map(([file, bytes]) => `${sha256(bytes)}  ${file}`).join('\n')}\n`;
  if (innerSums) sums = innerSums(sums);
  files.set('SHA256SUMS', Buffer.from(sums));
  tamper?.(files);
  const entries = Object.fromEntries([...files].map(([file, bytes]) => [`${name}/${file}`, new Uint8Array(bytes)]));
  return { zip: Buffer.from(zipSync(entries, { level })), entries };
}

/**
 * A release folder holding SHA256SUMS, the web-python-base zip, the web zip
 * and the web-torch zip. `edit` changes the web-python-base bundle before its
 * SHA256SUMS is written, `innerSums` that text, `tamper` the bundle after it;
 * `editWeb`, `innerWebSums` and `tamperWeb` do the same to the web bundle, and
 * `editTorch`, `innerTorchSums` and `tamperTorch` to the web-torch bundle
 * (built from the installed package); `repack` packs the web-python-base
 * files again after the top-level sums are written, a valid zip whose bytes are
 * not the ones listed. The web bundle carries the installed variant's files and
 * the engine's glue as its own (a stand-in: the real web glue is not installed
 * anywhere, and only its digest is recorded).
 */
function releaseFolder(t, { edit, innerSums, tamper, repack = false, editWeb, innerWebSums, tamperWeb, withWeb = true, editTorch, innerTorchSums, tamperTorch, withTorch = true } = {}) {
  const files = new Map([
    ...['zipp_wasm.js', 'zipp_wasm.d.ts', 'zipp_wasm_bg.wasm', 'zipp_wasm_bg.wasm.d.ts', 'LICENSE-APACHE', 'BUILD-INFO.txt', 'PROFILE.json'].map((n) => [n, installed(n)]),
    // Listed by the bundle's SHA256SUMS, never installed.
    ['README.md', Buffer.from('# zipp-wasm\n')],
    ['docs/TORCH_COMPATIBILITY.md', Buffer.from('torch\n')],
    ['gpu-lab/LICENSE', Buffer.from('gpu-lab licence\n')],
    ['host-sdk/zipp-host.mjs', Buffer.from('export {};\n')],
  ]);
  edit?.(files);
  const packed = packBundle(BUNDLE, files, { innerSums, tamper });
  let zip = packed.zip;
  const webFiles = new Map([
    ...['zipp_wasm_bg.wasm', 'BUILD-INFO.txt', 'PROFILE.json'].map((n) => [n, installedWeb(n)]),
    ['zipp_wasm.js', installed('zipp_wasm.js')],
    ['zipp_wasm.d.ts', installed('zipp_wasm.d.ts')],
    ['zipp_wasm_bg.wasm.d.ts', installed('zipp_wasm_bg.wasm.d.ts')],
    ['LICENSE-APACHE', installed('LICENSE-APACHE')],
    ['README.md', Buffer.from('# zipp-wasm (web)\n')],
    ['host-sdk/zipp-host.mjs', Buffer.from('export {};\n')],
  ]);
  editWeb?.(webFiles);
  const webZip = packBundle(WEB_BUNDLE, webFiles, { innerSums: innerWebSums, tamper: tamperWeb }).zip;
  const torchFiles = new Map([
    ...['zipp_torch.wasm', 'zipp_torch.js', 'BUILD-INFO.txt'].map((n) => [n, installedTorch(n)]),
    // Listed by the bundle's SHA256SUMS, never installed.
    ['LICENSE-APACHE', installed('LICENSE-APACHE')],
    ['README.md', Buffer.from('# zipp-wasm (torch)\n')],
    ['docs/TORCH_COMPATIBILITY.md', Buffer.from('torch\n')],
  ]);
  editTorch?.(torchFiles);
  const torchZip = packBundle(TORCH_BUNDLE, torchFiles, { innerSums: innerTorchSums, tamper: tamperTorch }).zip;
  const top = Buffer.from(`${sha256(webZip)}  ${WEB_BUNDLE}.zip\n${sha256(zip)}  ${BUNDLE}.zip\n${sha256(torchZip)}  ${TORCH_BUNDLE}.zip\n`);
  if (repack) zip = Buffer.from(zipSync(packed.entries, { level: 1 }));
  const dir = tempDir(t, 'zipp-release-fixture-');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), top);
  fs.writeFileSync(path.join(dir, `${BUNDLE}.zip`), zip);
  if (withWeb) fs.writeFileSync(path.join(dir, `${WEB_BUNDLE}.zip`), webZip);
  if (withTorch) fs.writeFileSync(path.join(dir, `${TORCH_BUNDLE}.zip`), torchZip);
  return { dir, top, zip, webZip, torchZip, files, webFiles, torchFiles };
}

/** The release's SHA256SUMS and bundle urls a stubbed GitHub serves for a folder. */
const publishedUrls = (folder) => new Map([
  [`${REPOSITORY}/releases/download/${TAG}/SHA256SUMS`, folder.top],
  [`${REPOSITORY}/releases/download/${TAG}/${BUNDLE}.zip`, folder.zip],
  [`${REPOSITORY}/releases/download/${TAG}/${WEB_BUNDLE}.zip`, folder.webZip],
  [`${REPOSITORY}/releases/download/${TAG}/${TORCH_BUNDLE}.zip`, folder.torchZip],
]);

/**
 * `bytes` with one more entry appended to section `id` (the import section 2
 * or the export section 7): the vector count goes up by one, the section
 * length with it. A spliced module may no longer instantiate — that is the
 * point: it must be refused before anything tries.
 */
function appendToSection(bytes, id, entry) {
  const b = new Uint8Array(bytes);
  const readLeb = (at) => {
    let value = 0;
    let length = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = b[at + length++];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return { value, length };
    }
  };
  const leb = (n) => {
    const out = [];
    do {
      let byte = n & 0x7f;
      n = Math.floor(n / 128);
      if (n) byte |= 0x80;
      out.push(byte);
    } while (n);
    return out;
  };
  let offset = 8;
  while (offset < b.length) {
    const section = b[offset];
    const size = readLeb(offset + 1);
    const start = offset + 1 + size.length;
    const end = start + size.value;
    if (section === id) {
      const count = readLeb(start);
      const body = [...leb(count.value + 1), ...b.subarray(start + count.length, end), ...entry];
      return Buffer.concat([b.subarray(0, offset), Buffer.from([id, ...leb(body.length), ...body]), b.subarray(end)]);
    }
    offset = end;
  }
  throw new Error(`no section ${id}`);
}
const text = (s) => [Buffer.byteLength(s), ...Buffer.from(s)];
/** The web module importing one function more than the engine does. */
const withExtraImport = (bytes) => appendToSection(bytes, 2, [...text('./zipp_wasm_bg.js'), ...text('__wbg_extra_0000'), 0x00, 0x00]);
/** The web module exporting one function the engine does not. */
const withExtraExport = (bytes) => appendToSection(bytes, 7, [...text('engine_extra'), 0x00, 0x00]);

function cli(args, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ZIPP_|CI$)/i.test(key)));
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...clean, ...env }, encoding: 'utf8' });
}

function install(t, folder, { env = {}, args = [TAG], out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp') } = {}) {
  return { out, run: cli(args, { ZIPP_RELEASE_DIR: folder.dir, ZIPP_OUT: out, ...env }) };
}

function refused({ run, out }, pattern) {
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, pattern);
  assert.doesNotMatch(run.stderr, /^\s+at /m, 'a refusal, not a stack trace');
  if (out) {
    assert.ok(!fs.existsSync(out), 'nothing is installed');
    assert.ok(!fs.existsSync(variantDir(out)), 'no variant is installed either');
    assert.ok(!fs.existsSync(packageDir(out)), 'nor the torch package');
  }
}

const editText = (dir, name, change) => fs.writeFileSync(path.join(dir, name), change(fs.readFileSync(path.join(dir, name), 'utf8')));
const editSource = (dir, change) => editText(dir, 'SOURCE.json', (text) => {
  const record = JSON.parse(text);
  change(record);
  return `${JSON.stringify(record, null, 2)}\n`;
});
/** Brings the install's own SHA256SUMS line for `name` in step with the file, so only the check a case is about can trip. */
const resum = (dir, name) => editText(dir, 'SHA256SUMS', (text) => text.replace(new RegExp(`^[0-9a-f]{64}(  ${escaped(name)})$`, 'm'), `${sha256(fs.readFileSync(path.join(dir, name)))}$1`));
/**
 * A module that describes itself as `profile`, standing in for the engine
 * where what it reports is the point. Loaded over the web variant's bytes it
 * answers `webProfile` (JavaScript only, by default) and its Python entry
 * points throw, as the real glue's do over that module. Its Python packages
 * behave as the base engine's do: none built in (unless `torchBuiltIn`),
 * torch listed once ZIPP's loader has called addPythonPackage, and an
 * `import torch` project answering `answer` only then.
 */
const standInGlue = (profile, webProfile = { ...profile, languages: ['javascript'] }, { torchBuiltIn = false, answer = 9, refusePackage } = {}) => Buffer.from([
  'import { createHash } from "node:crypto";',
  `const WEB = "${sha256(installedWeb('zipp_wasm_bg.wasm')).slice(0, 16)}";`,
  'let web = false;',
  'let torch = false;',
  'export function initSync({ module }) { web = createHash("sha256").update(module).digest("hex").startsWith(WEB); }',
  `export function zippProfile() { return web ? ${JSON.stringify(JSON.stringify(webProfile))} : ${JSON.stringify(JSON.stringify(profile))}; }`,
  `export function pythonPackages() { return JSON.stringify({ engineAbi: "0123456789abcdef", torchBuiltIn: ${torchBuiltIn}, installed: torch ? [{ name: "torch", version: "${VERSION}" }] : [] }); }`,
  `export function addPythonPackage(archive, kernels) { if (!(archive instanceof Uint8Array) || typeof kernels?.zippTorchKernel !== "function") throw new Error("not a package");${refusePackage ? ` throw new Error(${JSON.stringify(refusePackage)});` : ''} torch = true; return JSON.stringify({ name: "torch", version: "${VERSION}", modules: 1, kernels: true }); }`,
  `export class Engine { initSource(_s, language) { if (language === "python" && web) throw new Error("Python support is not built"); } pythonHas() { if (web) throw new TypeError("not a function"); return false; } initPythonProject() { if (!torch) throw new Error("ModuleNotFoundError: No module named 'torch'"); } pythonCall() { return ${answer}; } dispose() {} free() {} }`,
  '',
].join('\n'));

function spawnCli(args, env, preload = []) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ZIPP_|CI$)/i.test(key)));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...preload, SCRIPT, ...args], { env: { ...clean, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** The pid of a process that has exited: what a killed install leaves in its lock. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

/** The pid of a process that runs until the test ends: an install still holding its lock. */
function livePid(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  return child.pid;
}

test('the fixture is built around a verified release install, with its web variant and torch package beside it', () => {
  assert.equal(checkEngine(ENGINE).release, TAG, 'packages/@softn/core/wasm-zipp checks (npm run fetch:zipp)');
  assert.deepEqual(fs.readdirSync(WEB_ENGINE).sort(), [...VARIANT_INSTALLED_FILES].sort(), 'packages/@softn/core/wasm-zipp-web is the variant install');
  assert.equal(variantDir(ENGINE), WEB_ENGINE, 'a sibling folder, never inside the install');
  assert.deepEqual(fs.readdirSync(TORCH_ENGINE).sort(), [...PACKAGE_INSTALLED_FILES].sort(), 'packages/@softn/core/wasm-zipp-torch is the package install');
  assert.equal(packageDir(ENGINE), TORCH_ENGINE, 'a sibling folder too');
});

test('a release that checks all the way down installs exactly the install set, and --check passes', (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(fs.readdirSync(out).sort(), [...INSTALLED_FILES].sort(), 'unshipped SHA256SUMS entries (README.md, docs/, gpu-lab/, host-sdk/) stay behind');
  const record = JSON.parse(fs.readFileSync(path.join(out, 'SOURCE.json'), 'utf8'));
  assert.deepEqual(
    { release: record.release, version: record.version, revision: record.revision, build: record.build, bundle: record.bundle, bundleSha256: record.bundleSha256, sumsSha256: record.sumsSha256, variant: record.variant, languages: record.languages, stackBytes: record.stackBytes, sha256: record.sha256, glueSha256: record.glueSha256 },
    { release: TAG, version: VERSION, revision: source.revision, build: 'release', bundle: `${BUNDLE}.zip`, bundleSha256: sha256(folder.zip), sumsSha256: sha256(folder.top), variant: 'javascript-python-base', languages: ['javascript', 'python'], stackBytes: 16777216, sha256: source.sha256, glueSha256: sha256(installed('zipp_wasm.js')) },
  );
  assert.ok(fs.readFileSync(path.join(out, 'RELEASE-SHA256SUMS')).equals(folder.top), 'ZIPP\'s top-level SHA256SUMS, verbatim');
  assert.ok(fs.readFileSync(path.join(out, 'SHA256SUMS')).equals(folder.files.get('SHA256SUMS')), 'the bundle\'s SHA256SUMS, verbatim');
  for (const name of ['zipp_wasm.js', 'zipp_wasm_bg.wasm', 'BUILD-INFO.txt', 'PROFILE.json']) assert.ok(fs.readFileSync(path.join(out, name)).equals(folder.files.get(name)), `${name} byte for byte`);
  // The bundle ships no notices, so the curated copy is installed and says so.
  assert.equal(record.notices.source, 'softn-curated');
  assert.ok(fs.readFileSync(path.join(out, 'THIRD_PARTY_LICENSES.txt')).equals(fs.readFileSync(CURATED_NOTICES)));
  assert.equal(record.notices.sha256, sha256(fs.readFileSync(CURATED_NOTICES)));
  const check = cli(['--check'], { ZIPP_OUT: out });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
  assert.match(check.stdout, /checks, with its web variant \([0-9a-f]{12}\) in .* and its torch package \([0-9a-f]{12}\) in /);
  assert.deepEqual(fs.readdirSync(path.dirname(out)).sort(), BOTH, 'the install, its variant and its package, and no staging folder');
  // Every key the record had before variants is what it was; `variants` and `packages` are two more keys, last.
  const keys = Object.keys(record);
  assert.deepEqual(keys.slice(-2), ['variants', 'packages']);
  assert.deepEqual(keys.slice(0, -2), ['repository', 'release', 'version', 'revision', 'build', 'bundle', 'bundleSha256', 'sumsSha256', 'variant', 'languages', 'stackBytes', 'rustc', 'wasmBindgen', 'license', 'artifact', 'sha256', 'glueSha256', 'notices']);
});

test('the web bundle installs beside the engine as a verified variant, recorded on both sides', (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, new RegExp(`Taking ${escaped(BUNDLE)}\\.zip, ${escaped(WEB_BUNDLE)}\\.zip and ${escaped(TORCH_BUNDLE)}\\.zip from ZIPP`));
  assert.match(run.stdout, /web variant sha256 [0-9a-f]{64} into /);
  const web = variantDir(out);
  assert.equal(web, path.join(path.dirname(out), 'wasm-zipp-web'), 'a sibling, never inside wasm-zipp/');
  assert.deepEqual(fs.readdirSync(web).sort(), [...VARIANT_INSTALLED_FILES].sort(), 'the module, BUILD-INFO.txt, PROFILE.json, the bundle\'s SHA256SUMS and SOURCE.json; no glue');
  for (const name of ['zipp_wasm_bg.wasm', 'BUILD-INFO.txt', 'PROFILE.json', 'SHA256SUMS']) assert.ok(fs.readFileSync(path.join(web, name)).equals(folder.webFiles.get(name)), `${name} byte for byte`);
  const webSha = sha256(folder.webFiles.get('zipp_wasm_bg.wasm'));
  assert.notEqual(webSha, source.sha256, 'another build');
  // The primary record gains exactly the eight-key variants.web FormLogic compares by key.
  const record = JSON.parse(fs.readFileSync(path.join(out, 'SOURCE.json'), 'utf8'));
  assert.deepEqual(record.variants, {
    web: { bundle: `${WEB_BUNDLE}.zip`, bundleSha256: sha256(folder.webZip), sha256: webSha, glueSha256: sha256(folder.webFiles.get('zipp_wasm.js')), variant: 'javascript', languages: ['javascript'], stackBytes: 1048576, commit: source.revision },
  });
  // The variant's own record: the same eight fields, and the release, the toolchain and the engine it runs under.
  const variant = JSON.parse(fs.readFileSync(path.join(web, 'SOURCE.json'), 'utf8'));
  for (const [k, v] of Object.entries(record.variants.web)) assert.deepEqual(variant[k], v, `variant SOURCE.json ${k}`);
  assert.deepEqual(
    { repository: variant.repository, release: variant.release, version: variant.version, revision: variant.revision, build: variant.build, sumsSha256: variant.sumsSha256, artifact: variant.artifact, license: variant.license, rustc: variant.rustc, wasmBindgen: variant.wasmBindgen, primary: variant.primary },
    { repository: REPOSITORY, release: TAG, version: VERSION, revision: source.revision, build: 'release', sumsSha256: sha256(folder.top), artifact: 'zipp_wasm_bg.wasm', license: 'Apache-2.0', rustc: source.rustc, wasmBindgen: source.wasmBindgen, primary: { bundle: `${BUNDLE}.zip`, sha256: source.sha256, glueSha256: source.glueSha256 } },
  );
  assert.equal(WEB_VARIANT.id, 'web');
});

test('the web zip, and its line in the release\'s SHA256SUMS, are required: one release, both builds, or nothing', (t) => {
  const folder = releaseFolder(t);
  fs.rmSync(path.join(folder.dir, `${WEB_BUNDLE}.zip`));
  refused(install(t, folder), new RegExp(`holds no ${WEB_BUNDLE}\\.zip`));
  const unlisted = releaseFolder(t);
  fs.writeFileSync(path.join(unlisted.dir, 'SHA256SUMS'), unlisted.top.toString('utf8').split('\n').filter((line) => !line.endsWith(`  ${WEB_BUNDLE}.zip`)).join('\n'));
  refused(install(t, unlisted), new RegExp(`SHA256SUMS in .* does not list ${WEB_BUNDLE}\\.zip`));
  // A web zip whose bytes are not the ones listed, however good its contents.
  const other = releaseFolder(t, { editWeb: (files) => files.set('README.md', Buffer.from('# another web README\n')) });
  fs.copyFileSync(path.join(other.dir, `${WEB_BUNDLE}.zip`), path.join(folder.dir, `${WEB_BUNDLE}.zip`));
  refused(install(t, folder), new RegExp(`${WEB_BUNDLE}\\.zip has sha256 [0-9a-f]{64}; the ${escaped(TAG)} SHA256SUMS says [0-9a-f]{64}`));
});

test('the web bundle is a variant only when it is the same source built again: another commit is refused', (t) => {
  // Refused for the commit itself, before the module is asked anything (the profile check would trip too, later).
  refused(install(t, releaseFolder(t, { editWeb: (files) => setBuildInfo(files, 'commit', 'b'.repeat(40)) })), new RegExp(`${WEB_BUNDLE}\\.zip is built from commit b{40}, not ${source.revision} like ${escaped(BUNDLE)}\\.zip; a variant ships only from the release's own commit`));
  // Its BUILD-INFO.txt must say the web build, each fact on its own.
  refused(install(t, releaseFolder(t, { editWeb: (files) => setBuildInfo(files, 'variant', 'javascript-python') })), /is not the ZIPP v\d+\.\d+\.\d+ web build:\n {2}- BUILD-INFO\.txt variant is javascript-python, not javascript$/m);
  refused(install(t, releaseFolder(t, { editWeb: (files) => setBuildInfo(files, 'languages', '["javascript","python"]') })), /BUILD-INFO\.txt languages are \["javascript","python"\], not \["javascript"\]/);
  refused(install(t, releaseFolder(t, { editWeb: (files) => setBuildInfo(files, 'stack-bytes', '16777216') })), /BUILD-INFO\.txt stack-bytes is 16777216, not 1048576/);
  refused(install(t, releaseFolder(t, { editWeb: (files) => setBuildInfo(files, 'version', '9.9.9') })), /BUILD-INFO\.txt says version 9\.9\.9, not /);
  // The web-python-base module smuggled in as the web bundle, with the web bundle's
  // own BUILD-INFO.txt and PROFILE.json around it: the same commit, the same
  // imports, trivially its own export subset — and the same bytes, which is
  // not a variant of anything. (Had it been another Python-carrying build, the
  // real load under the glue refuses it: see the stand-in glue cases below.)
  refused(install(t, releaseFolder(t, { editWeb: (files) => files.set('zipp_wasm_bg.wasm', installed('zipp_wasm_bg.wasm')) })), new RegExp(`${WEB_BUNDLE}\\.zip carries the ${escaped(BUNDLE)}\\.zip module itself \\(${source.sha256.slice(0, 12)}\\), not a variant of it`));
});

test('the web module may ask the host for nothing the engine does not, and export nothing the engine lacks', async (t) => {
  const engine = installed('zipp_wasm_bg.wasm');
  const web = installedWeb('zipp_wasm_bg.wasm');
  assert.deepEqual(variantModuleProblems(web, engine), [], 'the installed pair fits');
  const extraImport = withExtraImport(web);
  assert.deepEqual(wasmImportNames(extraImport), [...wasmImportNames(web), './zipp_wasm_bg.js.__wbg_extra_0000:function'], 'the splice added one import');
  assert.deepEqual(variantModuleProblems(extraImport, engine, { bundle: 'web.zip', primary: 'wp.zip' }), ['web.zip imports ./zipp_wasm_bg.js.__wbg_extra_0000:function, which wp.zip does not, so the engine\'s glue cannot be known to bind it']);
  // Importing less is not a problem: instantiation reads only what a module
  // declares, and the glue's extra import (0.0.21's torch kernel hook) goes unread.
  assert.deepEqual(variantModuleProblems(web, withExtraImport(engine)), [], 'a variant may import less than the engine');
  const extraExport = withExtraExport(web);
  assert.deepEqual(wasmExportNames(extraExport), [...wasmExportNames(web), 'engine_extra'], 'the splice added one export');
  assert.deepEqual(variantModuleProblems(extraExport, engine, { bundle: 'web.zip', primary: 'wp.zip' }), ['web.zip exports engine_extra, which wp.zip does not; a variant runs under the engine\'s glue and may export nothing that engine lacks']);
  // The primary module as its own variant fits; a module that is not the engine at all does not.
  assert.deepEqual(variantModuleProblems(engine, engine), []);
  assert.match(variantModuleProblems(Buffer.from('not wasm'), engine)[0], /does not export what a ZIPP engine exports \(not a WebAssembly module\)/);
  // Through the install, each refused before the module is ever loaded — a spliced module may not instantiate.
  refused(install(t, releaseFolder(t, { editWeb: (files) => files.set('zipp_wasm_bg.wasm', extraImport) })), new RegExp(`cannot run under the engine's glue:\\n {2}- ${WEB_BUNDLE}\\.zip imports \\./zipp_wasm_bg\\.js\\.__wbg_extra_0000:function, which ${escaped(BUNDLE)}\\.zip does not`));
  refused(install(t, releaseFolder(t, { editWeb: (files) => files.set('zipp_wasm_bg.wasm', extraExport) })), new RegExp(`${WEB_BUNDLE}\\.zip exports engine_extra, which ${escaped(BUNDLE)}\\.zip does not`));
  // verifyVariant holds the zip to the SHA256SUMS itself, whoever loaded it, and to the primary it is given.
  const folder = releaseFolder(t);
  const primary = await verifyRelease({ release: TAG, sums: folder.top, zip: folder.zip });
  const variant = await verifyVariant({ release: TAG, sums: folder.top, zip: folder.webZip, primary });
  assert.equal(variant.record.sha256, sha256(web));
  assert.deepEqual([...variant.files.keys()].sort(), [...VARIANT_INSTALLED_FILES].sort());
  await assert.rejects(verifyVariant({ release: TAG, sums: folder.top, zip: folder.zip, primary }), (error) => error instanceof ZippReleaseError && new RegExp(`^${WEB_BUNDLE}\\.zip does not match the ${escaped(TAG)} SHA256SUMS$`).test(error.message));
  await assert.rejects(verifyVariant({ release: TAG, sums: folder.top, zip: folder.webZip, primary: { ...primary, source: { ...primary.source, revision: 'd'.repeat(40) } } }), /is built from commit [0-9a-f]{40}, not d{40}/);
});

test('loaded under the engine\'s glue, the web module must say JavaScript alone and refuse Python', (t) => {
  const profile = { version: VERSION, features: ['safe-sandbox'], languages: ['javascript', 'python'], source: { sha: source.revision } };
  const saying = (webProfile) => releaseFolder(t, { edit: (files) => files.set('zipp_wasm.js', standInGlue(profile, webProfile)) });
  // The stand-in is taken when it says the right things of both modules.
  const accepted = install(t, saying(undefined));
  assert.equal(accepted.run.status, 0, accepted.run.stderr);
  refused(install(t, saying({ ...profile })), new RegExp(`the ${WEB_BUNDLE}\\.zip engine does not describe itself as the ZIPP ${escaped(TAG)} web build:\\n {2}- zippProfile\\(\\) languages are \\["javascript","python"\\], not \\["javascript"\\]`));
  refused(install(t, saying({ ...profile, languages: ['javascript'], version: '9.9.9' })), /zippProfile\(\) version is 9\.9\.9, not /);
  refused(install(t, saying({ ...profile, languages: ['javascript'], features: [] })), /zippProfile\(\) lacks the safe-sandbox feature/);
  refused(install(t, saying({ ...profile, languages: ['javascript'], source: { sha: 'e'.repeat(40) } })), /zippProfile\(\) source\.sha is e{40}, not the BUILD-INFO\.txt commit/);
  // A glue whose Python entry points run over the web module: not the JavaScript-only build, whatever the profile says.
  const permissive = Buffer.from(`${standInGlue(profile).toString('utf8').replace('if (language === "python" && web) throw new Error("Python support is not built");', '').replace('if (web) throw new TypeError("not a function");', '')}`);
  refused(install(t, releaseFolder(t, { edit: (files) => files.set('zipp_wasm.js', permissive) })), new RegExp(`- initSource\\(source, "python"\\) runs on the ${WEB_BUNDLE}\\.zip engine, so it is not the JavaScript-only build\\n {2}- pythonHas\\(name\\) runs on the ${WEB_BUNDLE}\\.zip engine`));
});

test('the web-torch bundle installs beside the engine as its verified torch package, recorded on both sides', (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /torch package sha256 [0-9a-f]{64} into /);
  const torch = packageDir(out);
  assert.equal(torch, path.join(path.dirname(out), 'wasm-zipp-torch'), 'a sibling, never inside wasm-zipp/');
  assert.deepEqual(fs.readdirSync(torch).sort(), [...PACKAGE_INSTALLED_FILES].sort(), 'the module, the loader, BUILD-INFO.txt, the bundle\'s SHA256SUMS, the generated declarations and SOURCE.json');
  for (const name of ['zipp_torch.wasm', 'zipp_torch.js', 'BUILD-INFO.txt', 'SHA256SUMS']) assert.ok(fs.readFileSync(path.join(torch, name)).equals(folder.torchFiles.get(name)), `${name} byte for byte`);
  assert.equal(fs.readFileSync(path.join(torch, 'zipp_torch.d.ts'), 'utf8'), TORCH_DECLARATIONS, 'the declarations are generated, and exactly that text');
  const wasmSha = sha256(folder.torchFiles.get('zipp_torch.wasm'));
  const record = JSON.parse(fs.readFileSync(path.join(out, 'SOURCE.json'), 'utf8'));
  // The ABI the real engine reported when the package was added to it at install.
  const engineAbi = JSON.parse(installedTorch('SOURCE.json')).engineAbi;
  assert.match(engineAbi, /^[0-9a-f]+$/);
  assert.deepEqual(record.packages, {
    torch: { bundle: `${TORCH_BUNDLE}.zip`, bundleSha256: sha256(folder.torchZip), sha256: wasmSha, loaderSha256: sha256(folder.torchFiles.get('zipp_torch.js')), variant: 'torch', pairsWith: BUNDLE, commit: source.revision, engineAbi },
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(torch, 'SOURCE.json'), 'utf8'));
  for (const [k, v] of Object.entries(record.packages.torch)) assert.deepEqual(pkg[k], v, `package SOURCE.json ${k}`);
  assert.deepEqual(
    { repository: pkg.repository, release: pkg.release, version: pkg.version, revision: pkg.revision, build: pkg.build, sumsSha256: pkg.sumsSha256, artifact: pkg.artifact, loader: pkg.loader, license: pkg.license, rustc: pkg.rustc, declarations: pkg.declarations, primary: pkg.primary },
    { repository: REPOSITORY, release: TAG, version: VERSION, revision: source.revision, build: 'release', sumsSha256: sha256(folder.top), artifact: 'zipp_torch.wasm', loader: 'zipp_torch.js', license: 'Apache-2.0', rustc: source.rustc, declarations: { file: 'zipp_torch.d.ts', source: 'softn-generated', sha256: sha256(Buffer.from(TORCH_DECLARATIONS)) }, primary: { bundle: `${BUNDLE}.zip`, sha256: source.sha256, glueSha256: source.glueSha256 } },
  );
  assert.equal(TORCH_PACKAGE.id, 'torch');
});

test('the web-torch zip, its line in the release\'s SHA256SUMS and every file it lists are required', (t) => {
  const folder = releaseFolder(t, { withTorch: false });
  refused(install(t, folder), new RegExp(`holds no ${escaped(TORCH_BUNDLE)}\\.zip`));
  const unlisted = releaseFolder(t);
  fs.writeFileSync(path.join(unlisted.dir, 'SHA256SUMS'), unlisted.top.toString('utf8').split('\n').filter((line) => !line.endsWith(`  ${TORCH_BUNDLE}.zip`)).join('\n'));
  refused(install(t, unlisted), new RegExp(`SHA256SUMS in .* does not list ${escaped(TORCH_BUNDLE)}\\.zip`));
  // A torch zip whose bytes are not the ones listed, however good its contents.
  const whole = releaseFolder(t);
  const other = releaseFolder(t, { editTorch: (files) => files.set('README.md', Buffer.from('# another torch README\n')) });
  fs.copyFileSync(path.join(other.dir, `${TORCH_BUNDLE}.zip`), path.join(whole.dir, `${TORCH_BUNDLE}.zip`));
  refused(install(t, whole), new RegExp(`${escaped(TORCH_BUNDLE)}\\.zip has sha256 [0-9a-f]{64}; the ${escaped(TAG)} SHA256SUMS says [0-9a-f]{64}`));
  // Tampered after the bundle's own SHA256SUMS was written: the module, then the loader.
  const flip = (name) => (files) => {
    const bytes = Buffer.from(files.get(name));
    bytes[bytes.length - 2] ^= 0x01;
    files.set(name, bytes);
  };
  refused(install(t, releaseFolder(t, { tamperTorch: flip('zipp_torch.wasm') })), /zipp_torch\.wasm in .* does not match the bundle's SHA256SUMS/);
  refused(install(t, releaseFolder(t, { tamperTorch: flip('zipp_torch.js') })), /zipp_torch\.js in .* does not match the bundle's SHA256SUMS/);
  // Missing from the bundle's own SHA256SUMS.
  for (const name of ['zipp_torch.wasm', 'zipp_torch.js', 'BUILD-INFO.txt']) {
    const innerTorchSums = (text) => text.split('\n').filter((line) => !line.endsWith(`  ${name}`)).join('\n');
    refused(install(t, releaseFolder(t, { innerTorchSums })), new RegExp(`${escaped(name)} in .* is not listed in the bundle's SHA256SUMS`));
  }
});

test('the torch package pairs with exactly the installed engine bundle, from its commit', (t) => {
  // The complete web-python engine named instead: the ABI check would refuse the pairing in every browser.
  refused(install(t, releaseFolder(t, { editTorch: (files) => setBuildInfo(files, 'pairs-with', `zipp-wasm-${VERSION}-web-python`) })), new RegExp(`is not the ZIPP ${escaped(TAG)} torch package of ${escaped(BUNDLE)}\\.zip:\\n {2}- BUILD-INFO\\.txt pairs-with is zipp-wasm-${escaped(VERSION)}-web-python, not ${escaped(BUNDLE)}, the engine it is added to$`, 'm'));
  refused(install(t, releaseFolder(t, { editTorch: (files) => setBuildInfo(files, 'pairs-with', `zipp-wasm-9.9.9-web-python-base`) })), /BUILD-INFO\.txt pairs-with is zipp-wasm-9\.9\.9-web-python-base, not /);
  refused(install(t, releaseFolder(t, { editTorch: (files) => setBuildInfo(files, 'commit', 'b'.repeat(40)) })), new RegExp(`${escaped(TORCH_BUNDLE)}\\.zip is built from commit b{40}, not ${source.revision} like ${escaped(BUNDLE)}\\.zip; a package ships only from the release's own commit`));
  refused(install(t, releaseFolder(t, { editTorch: (files) => setBuildInfo(files, 'commit', 'b'.repeat(8)) })), /BUILD-INFO\.txt commit "b{8}" is not a full 40-hex commit/);
  refused(install(t, releaseFolder(t, { editTorch: (files) => setBuildInfo(files, 'variant', 'javascript-python-base') })), /BUILD-INFO\.txt variant is javascript-python-base, not torch/);
  refused(install(t, releaseFolder(t, { editTorch: (files) => setBuildInfo(files, 'version', '9.9.9') })), /BUILD-INFO\.txt says version 9\.9\.9, not /);
});

test('the torch module has the package\'s shape, and ZIPP\'s loader really adds it to the engine', async (t) => {
  assert.deepEqual(packageModuleProblems(installedTorch('zipp_torch.wasm')), [], 'the installed package fits');
  // The engine itself is not a package: it imports the host's functions and exports no archive.
  const asEngine = packageModuleProblems(installed('zipp_wasm_bg.wasm'), { bundle: 'torch.zip' });
  assert.match(asEngine[0], /^torch\.zip zipp_torch\.wasm does not export zipp_package_ptr, zipp_package_len, zipp_kernel, zipp_alloc, zipp_free, which its loader reads$/);
  assert.match(asEngine[1], /^torch\.zip zipp_torch\.wasm imports \.\/zipp_wasm_bg\.js\..*; the package module imports nothing/);
  assert.deepEqual(packageModuleProblems(Buffer.from('not wasm'), { bundle: 'torch.zip' }), ['torch.zip zipp_torch.wasm is not a WebAssembly module']);
  // Through the install, listed and summed as if it were the release's own.
  refused(install(t, releaseFolder(t, { editTorch: (files) => files.set('zipp_torch.wasm', installedWeb('zipp_wasm_bg.wasm')) })), new RegExp(`${escaped(TORCH_BUNDLE)}\\.zip is not a torch package module:\\n {2}- .*does not export zipp_package_ptr`));
  // A loader that says it added torch and did not: the engine is asked, not the loader.
  const liar = Buffer.from(`export function addTorchSync() { return { name: "torch", version: "${VERSION}" }; }\nexport async function addTorch() { return addTorchSync(); }\n`);
  refused(install(t, releaseFolder(t, { editTorch: (files) => files.set('zipp_torch.js', liar) })), /does not give the .* engine torch:\n {2}- pythonPackages\(\) does not list torch as installed after addTorchSync\(\)\n {2}- an `import torch` project does not run on the engine with the package added: /);
  refused(install(t, releaseFolder(t, { editTorch: (files) => files.set('zipp_torch.js', Buffer.from('export const nothing = 1;\n')) })), /zipp_torch\.js does not export addTorch and addTorchSync/);
  // The engine refusing the package (its ABI or file check), a primary with torch already built in, a torch that answers wrong.
  const profile = { version: VERSION, features: ['safe-sandbox'], languages: ['javascript', 'python'], source: { sha: source.revision } };
  const glue = (options) => (files) => files.set('zipp_wasm.js', standInGlue(profile, undefined, options));
  const accepted = install(t, releaseFolder(t, { edit: glue({}) }));
  assert.equal(accepted.run.status, 0, `the stand-in is taken when it behaves: ${accepted.run.stderr}`);
  refused(install(t, releaseFolder(t, { edit: glue({ refusePackage: 'the package was built for engine ABI 0000' }) })), new RegExp(`the ${escaped(BUNDLE)}\\.zip engine refuses the ${escaped(TORCH_BUNDLE)}\\.zip package: the package was built for engine ABI 0000`));
  refused(install(t, releaseFolder(t, { edit: glue({ torchBuiltIn: true }) })), new RegExp(`the ${escaped(BUNDLE)}\\.zip engine does not describe itself as ZIPP ${escaped(TAG)}:\\n {2}- pythonPackages\\(\\) torchBuiltIn is true, not false; the engine is the build without torch`));
  refused(install(t, releaseFolder(t, { edit: glue({ answer: 8 }) })), /- an `import torch` project answers 8, not 9/);
  // verifyPackage holds the zip to the SHA256SUMS itself, and to the primary it is given.
  const folder = releaseFolder(t);
  const primary = await verifyRelease({ release: TAG, sums: folder.top, zip: folder.zip });
  const pkg = await verifyPackage({ release: TAG, sums: folder.top, zip: folder.torchZip, primary });
  assert.equal(pkg.record.sha256, sha256(installedTorch('zipp_torch.wasm')));
  assert.deepEqual([...pkg.files.keys()].sort(), [...PACKAGE_INSTALLED_FILES].sort());
  await assert.rejects(verifyPackage({ release: TAG, sums: folder.top, zip: folder.webZip, primary }), (error) => error instanceof ZippReleaseError && new RegExp(`^${escaped(TORCH_BUNDLE)}\\.zip does not match the ${escaped(TAG)} SHA256SUMS$`).test(error.message));
  await assert.rejects(verifyPackage({ release: TAG, sums: folder.top, zip: folder.torchZip, primary: { ...primary, source: { ...primary.source, revision: 'd'.repeat(40) } } }), /is built from commit [0-9a-f]{40}, not d{40}/);
  await assert.rejects(verifyPackage({ release: TAG, sums: folder.top, zip: folder.torchZip, primary: { ...primary, source: { ...primary.source, bundle: `zipp-wasm-${VERSION}-web-python.zip` } } }), /pairs-with is \S+-web-python-base, not \S+-web-python, the engine it is added to/);
});

test('--check holds the torch package install to the primary\'s record, its own, the bundle\'s SHA256SUMS and its shape, one invariant at a time', (t) => {
  const { out: pristine, run } = install(t, releaseFolder(t));
  assert.equal(run.status, 0, run.stderr);
  const E64 = 'e'.repeat(64);
  const pkgOf = (dir) => packageDir(dir);
  const editPkgSource = (dir, change) => editSource(pkgOf(dir), change);
  const flip = (dir, name) => {
    const file = path.join(pkgOf(dir), name);
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 2] ^= 0x01;
    fs.writeFileSync(file, bytes);
    return bytes;
  };
  const pkgBuildInfo = (key, value) => (dir) => {
    editText(pkgOf(dir), 'BUILD-INFO.txt', (text) => text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`));
    resum(pkgOf(dir), 'BUILD-INFO.txt');
  };
  const cases = [
    ['a tampered package module, listed as it was', (dir) => flip(dir, 'zipp_torch.wasm'), /^the ZIPP torch package install in .* does not check .*:\n {2}- zipp_torch\.wasm does not match the bundle's SHA256SUMS\n {2}- zipp_torch\.wasm is not the recorded [0-9a-f]{64}$/],
    ['a tampered package module, re-listed', (dir) => {
      flip(dir, 'zipp_torch.wasm');
      resum(pkgOf(dir), 'zipp_torch.wasm');
    }, /zipp_torch\.wasm is not the recorded [0-9a-f]{64}/],
    ['a tampered package module, re-listed and re-recorded on its own side', (dir) => {
      const bytes = flip(dir, 'zipp_torch.wasm');
      resum(pkgOf(dir), 'zipp_torch.wasm');
      editPkgSource(dir, (s) => void (s.sha256 = sha256(bytes)));
    }, /SOURCE\.json sha256 is "[0-9a-f]{64}"; the primary install's packages\.torch records "[0-9a-f]{64}"/],
    // Every record agrees, and the check still refuses: the engine is not a package.
    ['the engine module in the package\'s place, fully re-recorded on both sides', (dir) => {
      fs.copyFileSync(path.join(dir, 'zipp_wasm_bg.wasm'), path.join(pkgOf(dir), 'zipp_torch.wasm'));
      resum(pkgOf(dir), 'zipp_torch.wasm');
      editPkgSource(dir, (s) => void (s.sha256 = source.sha256));
      editSource(dir, (s) => void (s.packages.torch.sha256 = source.sha256));
    }, /zipp_torch\.wasm does not export zipp_package_ptr, .*which its loader reads\n {2}- .*zipp_torch\.wasm imports /],
    ['a tampered loader, listed as it was', (dir) => flip(dir, 'zipp_torch.js'), /zipp_torch\.js does not match the bundle's SHA256SUMS\n {2}- zipp_torch\.js is not the recorded [0-9a-f]{64}/],
    ['a tampered loader, re-listed', (dir) => {
      flip(dir, 'zipp_torch.js');
      resum(pkgOf(dir), 'zipp_torch.js');
    }, /zipp_torch\.js is not the recorded [0-9a-f]{64}/],
    ['edited declarations', (dir) => fs.appendFileSync(path.join(pkgOf(dir), 'zipp_torch.d.ts'), 'export const extra: 1;\n'), /zipp_torch\.d\.ts is not the text this script generates/],
    ['declarations recorded as another digest', (dir) => editPkgSource(dir, (s) => void (s.declarations.sha256 = E64)), /SOURCE\.json declarations .* are not the generated zipp_torch\.d\.ts/],
    ['a primary record without the package', (dir) => editSource(dir, (s) => void delete s.packages), /^the ZIPP install in .* does not check .*:\n {2}- SOURCE\.json records no torch package of the engine \(packages\.torch\)/],
    ['a primary record whose package digest disagrees', (dir) => editSource(dir, (s) => void (s.packages.torch.sha256 = E64)), /SOURCE\.json sha256 is "[0-9a-f]{64}"; the primary install's packages\.torch records "e{64}"/],
    ['a primary record whose loader digest disagrees', (dir) => editSource(dir, (s) => void (s.packages.torch.loaderSha256 = E64)), /SOURCE\.json loaderSha256 is "[0-9a-f]{64}"; the primary install's packages\.torch records "e{64}"/],
    ['a package record paired with the complete engine, agreed on both sides', (dir) => {
      editSource(dir, (s) => void (s.packages.torch.pairsWith = `zipp-wasm-${VERSION}-web-python`));
      editPkgSource(dir, (s) => void (s.pairsWith = `zipp-wasm-${VERSION}-web-python`));
    }, new RegExp(`SOURCE\\.json pairsWith zipp-wasm-${escaped(VERSION)}-web-python is not the primary install's bundle ${escaped(BUNDLE)}$`, 'm')],
    ['a package record of another commit, agreed on both sides', (dir) => {
      editSource(dir, (s) => void (s.packages.torch.commit = 'e'.repeat(40)));
      editPkgSource(dir, (s) => void (s.commit = 'e'.repeat(40)));
    }, /SOURCE\.json commit e{40} is not the primary install's revision [0-9a-f]{40}; a package is built from the engine's own source/],
    ['a package record from another SHA256SUMS', (dir) => editPkgSource(dir, (s) => void (s.sumsSha256 = E64)), /SOURCE\.json sumsSha256 e{64} is not the primary install's/],
    ['a package record of another engine', (dir) => editPkgSource(dir, (s) => void (s.primary.sha256 = E64)), /SOURCE\.json primary \{.*\} is not the primary install/],
    ['a package record recorded as a local build', (dir) => editPkgSource(dir, (s) => void (s.build = 'local')), /SOURCE\.json build is 'local'/],
    ['a package bundle digest the release\'s SHA256SUMS does not carry', (dir) => {
      editSource(dir, (s) => void (s.packages.torch.bundleSha256 = E64));
      editPkgSource(dir, (s) => void (s.bundleSha256 = E64));
    }, new RegExp(`RELEASE-SHA256SUMS does not list ${escaped(TORCH_BUNDLE)}\\.zip with the recorded e{64}`)],
    ['package BUILD-INFO.txt paired with another engine', pkgBuildInfo('pairs-with', `zipp-wasm-${VERSION}-web-python`), /BUILD-INFO\.txt pairs-with is \S+-web-python, not \S+-web-python-base, the engine it is added to/],
    ['package BUILD-INFO.txt of another commit', pkgBuildInfo('commit', 'e'.repeat(40)), /BUILD-INFO\.txt commit e{40} is not the engine's commit [0-9a-f]{40}/],
    ['package BUILD-INFO.txt of another variant', pkgBuildInfo('variant', 'javascript-python'), /BUILD-INFO\.txt variant is javascript-python, not torch/],
    ['a stray file in the package folder', (dir) => fs.copyFileSync(path.join(dir, 'zipp_wasm.js'), path.join(pkgOf(dir), 'zipp_wasm.js')), /zipp_wasm\.js is not part of a package install/],
    ['a missing package file', (dir) => fs.rmSync(path.join(pkgOf(dir), 'zipp_torch.d.ts')), /zipp_torch\.d\.ts is missing/],
    ['no package folder at all', (dir) => fs.rmSync(pkgOf(dir), { recursive: true }), /holds no ZIPP torch package install \(no SOURCE\.json\); run npm run fetch:zipp/],
  ];
  for (const [what, tamper, pattern] of cases) {
    const copy = path.join(tempDir(t, 'zipp-check-'), 'wasm-zipp');
    fs.cpSync(pristine, copy, { recursive: true });
    fs.cpSync(variantDir(pristine), variantDir(copy), { recursive: true });
    fs.cpSync(packageDir(pristine), packageDir(copy), { recursive: true });
    tamper(copy);
    assert.throws(() => checkEngine(copy), (error) => error instanceof ZippReleaseError && pattern.test(error.message), what);
    const run = cli(['--check'], { ZIPP_OUT: copy });
    assert.equal(run.status, 1, what);
    assert.doesNotMatch(run.stderr, /^\s+at /m, `${what}: a refusal, not a stack trace`);
  }
  assert.equal(checkEngine(pristine).packages.torch.sha256, sha256(installedTorch('zipp_torch.wasm')), 'the pristine copy still checks');
});

test('--ensure reinstalls when the torch package is gone or tampered, and --check --online compares it with the published bundle', async (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, run.stderr);
  const noRequest = async () => assert.fail('no request expected');
  fs.rmSync(packageDir(out), { recursive: true });
  assert.equal((await ensureEngine({ dir: out, fetch: noRequest, releaseDir: folder.dir, log: quiet })).action, 'installed');
  assert.deepEqual(fs.readdirSync(packageDir(out)).sort(), [...PACKAGE_INSTALLED_FILES].sort());
  fs.appendFileSync(path.join(packageDir(out), 'zipp_torch.js'), '\n');
  const logs = [];
  assert.equal((await ensureEngine({ dir: out, fetch: noRequest, releaseDir: folder.dir, log: (line) => logs.push(line) })).action, 'installed');
  assert.match(logs.join('\n'), /torch package install .* does not check/);
  assert.equal((await ensureEngine({ dir: out, fetch: noRequest, log: quiet })).action, 'none');
  // Online: the package as published, byte for byte.
  const published = publishedUrls(folder);
  const fetch = async (url) => (published.has(url) ? new Response(published.get(url)) : new Response('', { status: 404 }));
  assert.equal((await checkEngineOnline(out, { fetch })).release, TAG);
  const torchUrl = `${REPOSITORY}/releases/download/${TAG}/${TORCH_BUNDLE}.zip`;
  published.set(torchUrl, releaseFolder(t, { editTorch: (files) => files.set('README.md', Buffer.from('# torch, again\n')) }).torchZip);
  await assert.rejects(checkEngineOnline(out, { fetch }), new RegExp(`the published ${escaped(TORCH_BUNDLE)}\\.zip is not the recorded [0-9a-f]{64}`));
  published.set(torchUrl, folder.torchZip);
  // A package file edited and re-listed passes offline, and not against what is published.
  fs.appendFileSync(path.join(packageDir(out), 'BUILD-INFO.txt'), 'extra=1\n');
  resum(packageDir(out), 'BUILD-INFO.txt');
  assert.equal(checkEngine(out).release, TAG);
  await assert.rejects(checkEngineOnline(out, { fetch }), (error) => new RegExp(`\\n {2}- .*wasm-zipp-torch/BUILD-INFO\\.txt is not the file in the published ${escaped(TORCH_BUNDLE)}\\.zip`).test(error.message) && /wasm-zipp-torch\/SHA256SUMS is not the file in the published/.test(error.message));
});

test('notices the bundle ships itself are taken from it and recorded as the release\'s', (t) => {
  const folder = releaseFolder(t, { edit: (files) => files.set('THIRD_PARTY_LICENSES.txt', Buffer.from('ZIPP\'s own notices\n')) });
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const record = JSON.parse(fs.readFileSync(path.join(out, 'SOURCE.json'), 'utf8'));
  assert.deepEqual(record.notices, { file: 'THIRD_PARTY_LICENSES.txt', source: 'zipp-release', sha256: sha256(Buffer.from('ZIPP\'s own notices\n')) });
  assert.equal(cli(['--check'], { ZIPP_OUT: out }).status, 0);
});

test('a zip that disagrees with the release\'s SHA256SUMS is refused, even one holding the very same files', async (t) => {
  const folder = releaseFolder(t, { repack: true });
  // Every file inside checks, so only ZIPP's top-level SHA256SUMS can tell.
  const inside = unzipSync(new Uint8Array(folder.zip));
  for (const [name, bytes] of folder.files) assert.ok(Buffer.from(inside[`${BUNDLE}/${name}`]).equals(bytes), `${name} is in the re-packed zip unchanged`);
  refused(install(t, folder), /has sha256 [0-9a-f]{64}; the v\d+\.\d+\.\d+ SHA256SUMS says [0-9a-f]{64}/);
  // verifyRelease holds the zip to the SHA256SUMS itself, whoever loaded it.
  await assert.rejects(verifyRelease({ release: TAG, sums: folder.top, zip: folder.zip }), (error) => error instanceof ZippReleaseError && new RegExp(`^${escaped(BUNDLE)}\\.zip does not match the ${escaped(TAG)} SHA256SUMS$`).test(error.message));
});

test('a file that disagrees with the bundle\'s SHA256SUMS is refused', (t) => {
  const tamper = (files) => files.set('zipp_wasm.d.ts', Buffer.concat([files.get('zipp_wasm.d.ts'), Buffer.from(' ')]));
  refused(install(t, releaseFolder(t, { tamper })), /zipp_wasm\.d\.ts in .* does not match the bundle's SHA256SUMS/);
});

test('a file the install takes that the bundle\'s SHA256SUMS does not list is refused', (t) => {
  const innerSums = (text) => text.split('\n').filter((line) => !line.endsWith('  LICENSE-APACHE')).join('\n');
  refused(install(t, releaseFolder(t, { innerSums })), /LICENSE-APACHE in .* is not listed in the bundle's SHA256SUMS/);
});

test('the JavaScript-only web build is refused by what BUILD-INFO.txt says, whatever the zip is called', (t) => {
  const edit = (files) => {
    setBuildInfo(files, 'variant', 'javascript');
    setBuildInfo(files, 'languages', '["javascript"]');
    setBuildInfo(files, 'stack-bytes', '1048576');
  };
  refused(install(t, releaseFolder(t, { edit })), /variant is javascript, not javascript-python-base/);
});

test('BUILD-INFO.txt has to name the web-python-base languages and stack, each on its own', (t) => {
  refused(install(t, releaseFolder(t, { edit: (files) => setBuildInfo(files, 'stack-bytes', '1048576') })), /BUILD-INFO\.txt stack-bytes is 1048576, not 16777216/);
  refused(install(t, releaseFolder(t, { edit: (files) => setBuildInfo(files, 'languages', '["javascript"]') })), /BUILD-INFO\.txt languages are \["javascript"\], not \["javascript","python"\]/);
});

test('the module has to describe itself as the release: its version, both languages, the safe sandbox', (t) => {
  const profile = { version: VERSION, features: ['safe-sandbox'], languages: ['javascript', 'python'], source: { sha: source.revision } };
  const saying = (change) => releaseFolder(t, { edit: (files) => files.set('zipp_wasm.js', standInGlue({ ...profile, ...change })) });
  // The stand-in is taken when it says the right things, so each refusal below is about the one thing it changes.
  const accepted = install(t, saying({}));
  assert.equal(accepted.run.status, 0, accepted.run.stderr);
  refused(install(t, saying({ version: '9.9.9' })), /zippProfile\(\) version is 9\.9\.9, not /);
  refused(install(t, saying({ languages: ['javascript'] })), /zippProfile\(\) languages are \["javascript"\], not \["javascript","python"\]/);
  refused(install(t, saying({ features: ['meter-only'] })), /zippProfile\(\) lacks the safe-sandbox feature/);
});

test('a PROFILE.json of another version is refused', (t) => {
  const edit = (files) => files.set('PROFILE.json', Buffer.from(files.get('PROFILE.json').toString('utf8').replace(`"version": "${VERSION}"`, '"version": "9.9.9"')));
  refused(install(t, releaseFolder(t, { edit })), /PROFILE\.json says version 9\.9\.9/);
});

test('a BUILD-INFO.txt commit that is not a full commit is refused', (t) => {
  refused(install(t, releaseFolder(t, { edit: (files) => setBuildInfo(files, 'commit', source.revision.slice(0, 8)) })), /not a full 40-hex commit/);
});

test('a module that does not report the BUILD-INFO.txt commit is refused', (t) => {
  refused(install(t, releaseFolder(t, { edit: (files) => setBuildInfo(files, 'commit', 'b'.repeat(40)) })), /zippProfile\(\) source\.sha is [0-9a-f]{40}, not the BUILD-INFO\.txt commit b{40}/);
});

test('ZIPP_SUMS_SHA256 pins the release\'s SHA256SUMS', (t) => {
  refused(install(t, releaseFolder(t), { env: { ZIPP_SUMS_SHA256: '0'.repeat(64) } }), /ZIPP_SUMS_SHA256 says 0{64}/);
  const folder = releaseFolder(t);
  assert.equal(install(t, folder, { env: { ZIPP_SUMS_SHA256: sha256(folder.top) } }).run.status, 0);
});

test('a folder without the web-python-base bundle is refused', (t) => {
  const folder = releaseFolder(t);
  fs.rmSync(path.join(folder.dir, `${BUNDLE}.zip`));
  refused(install(t, folder), new RegExp(`holds no ${BUNDLE}\\.zip`));
});

test('an install replaces the whole folder, the variant\'s and the package\'s, so a stale file does not survive', (t) => {
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'zipp_wasm_bg.wasm.old'), 'stale');
  fs.writeFileSync(path.join(out, 'SOURCE.json'), '{"build":"release"}');
  fs.mkdirSync(variantDir(out));
  fs.writeFileSync(path.join(variantDir(out), 'zipp_wasm.js'), 'a glue a variant never ships');
  fs.mkdirSync(packageDir(out));
  fs.writeFileSync(path.join(packageDir(out), 'zipp_torch.wasm.old'), 'stale');
  const { run } = install(t, releaseFolder(t), { out });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(fs.readdirSync(out).sort(), [...INSTALLED_FILES].sort());
  assert.deepEqual(fs.readdirSync(variantDir(out)).sort(), [...VARIANT_INSTALLED_FILES].sort());
  assert.deepEqual(fs.readdirSync(packageDir(out)).sort(), [...PACKAGE_INSTALLED_FILES].sort());
  assert.deepEqual(fs.readdirSync(path.dirname(out)).sort(), BOTH, 'neither the stage nor the previous install is left behind');
});

test('--check holds the variant install to the primary\'s record, its own, the bundle\'s SHA256SUMS and the engine, one invariant at a time', (t) => {
  const { out: pristine, run } = install(t, releaseFolder(t));
  assert.equal(run.status, 0, run.stderr);
  const E64 = 'e'.repeat(64);
  const webOf = (dir) => variantDir(dir);
  const editWebSource = (dir, change) => editSource(webOf(dir), change);
  const webBuildInfo = (key, value) => (dir) => {
    editText(webOf(dir), 'BUILD-INFO.txt', (text) => text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`));
    resum(webOf(dir), 'BUILD-INFO.txt');
  };
  const cases = [
    ['a tampered variant module, listed as it was', (dir) => {
      const file = path.join(webOf(dir), 'zipp_wasm_bg.wasm');
      const bytes = fs.readFileSync(file);
      bytes[bytes.length - 1] ^= 0x01;
      fs.writeFileSync(file, bytes);
    }, /^the ZIPP web variant install in .* does not check .*:\n {2}- zipp_wasm_bg\.wasm does not match the bundle's SHA256SUMS\n {2}- zipp_wasm_bg\.wasm is not the recorded [0-9a-f]{64}$/],
    ['a tampered variant module, re-listed', (dir) => {
      const file = path.join(webOf(dir), 'zipp_wasm_bg.wasm');
      const bytes = fs.readFileSync(file);
      bytes[bytes.length - 1] ^= 0x01;
      fs.writeFileSync(file, bytes);
      resum(webOf(dir), 'zipp_wasm_bg.wasm');
    }, /zipp_wasm_bg\.wasm is not the recorded [0-9a-f]{64}/],
    ['a tampered variant module, re-listed and re-recorded on its own side', (dir) => {
      const file = path.join(webOf(dir), 'zipp_wasm_bg.wasm');
      const bytes = fs.readFileSync(file);
      bytes[bytes.length - 1] ^= 0x01;
      fs.writeFileSync(file, bytes);
      resum(webOf(dir), 'zipp_wasm_bg.wasm');
      editWebSource(dir, (s) => void (s.sha256 = sha256(bytes)));
    }, /SOURCE\.json sha256 is "[0-9a-f]{64}"; the primary install's variants\.web records "[0-9a-f]{64}"/],
    // Every record agrees, and the check still refuses: a variant that IS the primary is not one.
    ['the engine module in the variant\'s place, fully re-recorded on both sides', (dir) => {
      fs.copyFileSync(path.join(dir, 'zipp_wasm_bg.wasm'), path.join(webOf(dir), 'zipp_wasm_bg.wasm'));
      resum(webOf(dir), 'zipp_wasm_bg.wasm');
      editWebSource(dir, (s) => void (s.sha256 = source.sha256));
      editSource(dir, (s) => void (s.variants.web.sha256 = source.sha256));
    }, new RegExp(`^the ZIPP web variant install in .* does not check .*:\\n {2}- zipp_wasm_bg\\.wasm is the primary install's module itself \\(${source.sha256.slice(0, 12)}\\), not a variant of it$`)],
    ['a variant module exporting what the engine does not', (dir) => {
      const spliced = withExtraExport(fs.readFileSync(path.join(webOf(dir), 'zipp_wasm_bg.wasm')));
      fs.writeFileSync(path.join(webOf(dir), 'zipp_wasm_bg.wasm'), spliced);
      resum(webOf(dir), 'zipp_wasm_bg.wasm');
      editWebSource(dir, (s) => void (s.sha256 = sha256(spliced)));
      editSource(dir, (s) => void (s.variants.web.sha256 = sha256(spliced)));
    }, /exports engine_extra, which .* does not; a variant runs under the engine's glue/],
    ['a variant module importing what the engine does not', (dir) => {
      const spliced = withExtraImport(fs.readFileSync(path.join(webOf(dir), 'zipp_wasm_bg.wasm')));
      fs.writeFileSync(path.join(webOf(dir), 'zipp_wasm_bg.wasm'), spliced);
      resum(webOf(dir), 'zipp_wasm_bg.wasm');
      editWebSource(dir, (s) => void (s.sha256 = sha256(spliced)));
      editSource(dir, (s) => void (s.variants.web.sha256 = sha256(spliced)));
    }, /imports \.\/zipp_wasm_bg\.js\.__wbg_extra_0000:function, which .* does not/],
    ['a primary record without the variant', (dir) => editSource(dir, (s) => void delete s.variants), /^the ZIPP install in .* does not check .*:\n {2}- SOURCE\.json records no web variant of the engine \(variants\.web\)/],
    ['a primary record whose variant digest disagrees', (dir) => editSource(dir, (s) => void (s.variants.web.sha256 = E64)), /SOURCE\.json sha256 is "[0-9a-f]{64}"; the primary install's variants\.web records "e{64}"/],
    ['a primary record whose variant commit disagrees', (dir) => editSource(dir, (s) => void (s.variants.web.commit = 'e'.repeat(40))), /SOURCE\.json commit is "[0-9a-f]{40}"; the primary install's variants\.web records "e{40}"/],
    ['a variant record of another commit, agreed on both sides', (dir) => {
      editSource(dir, (s) => void (s.variants.web.commit = 'e'.repeat(40)));
      editWebSource(dir, (s) => void (s.commit = 'e'.repeat(40)));
    }, /SOURCE\.json commit e{40} is not the primary install's revision [0-9a-f]{40}; a variant is the same source built again/],
    ['a variant record from another SHA256SUMS', (dir) => editWebSource(dir, (s) => void (s.sumsSha256 = E64)), /SOURCE\.json sumsSha256 e{64} is not the primary install's/],
    ['a variant record of another engine', (dir) => editWebSource(dir, (s) => void (s.primary.sha256 = E64)), /SOURCE\.json primary \{.*\} is not the primary install/],
    ['a variant record recorded as a local build', (dir) => editWebSource(dir, (s) => void (s.build = 'local')), /SOURCE\.json build is 'local'/],
    ['a variant record naming the web-python-base bundle', (dir) => {
      editSource(dir, (s) => void (s.variants.web.bundle = `${BUNDLE}.zip`));
      editWebSource(dir, (s) => void (s.bundle = `${BUNDLE}.zip`));
    }, /SOURCE\.json bundle \S+-web-python-base\.zip is not the web bundle/],
    ['a variant bundle digest the release\'s SHA256SUMS does not carry', (dir) => {
      editSource(dir, (s) => void (s.variants.web.bundleSha256 = E64));
      editWebSource(dir, (s) => void (s.bundleSha256 = E64));
    }, new RegExp(`RELEASE-SHA256SUMS does not list ${WEB_BUNDLE}\\.zip with the recorded e{64}`)],
    ['variant BUILD-INFO.txt of another commit', webBuildInfo('commit', 'e'.repeat(40)), /BUILD-INFO\.txt commit e{40} is not the recorded revision [0-9a-f]{40}/],
    ['variant BUILD-INFO.txt of the web-python build', webBuildInfo('variant', 'javascript-python'), /BUILD-INFO\.txt variant is javascript-python, not javascript$/m],
    ['variant BUILD-INFO.txt of both languages', webBuildInfo('languages', '["javascript","python"]'), /BUILD-INFO\.txt languages are \["javascript","python"\], not \["javascript"\]/],
    ['variant BUILD-INFO.txt of the big stack', webBuildInfo('stack-bytes', '16777216'), /BUILD-INFO\.txt stack-bytes is 16777216, not 1048576/],
    ['variant PROFILE.json of another version', (dir) => {
      editText(webOf(dir), 'PROFILE.json', (text) => text.replace(`"version": "${VERSION}"`, '"version": "9.9.9"'));
      resum(webOf(dir), 'PROFILE.json');
    }, /PROFILE\.json says version 9\.9\.9, not /],
    ['a glue in the variant folder', (dir) => fs.copyFileSync(path.join(dir, 'zipp_wasm.js'), path.join(webOf(dir), 'zipp_wasm.js')), /zipp_wasm\.js is not part of a variant install/],
    ['a missing variant file', (dir) => fs.rmSync(path.join(webOf(dir), 'PROFILE.json')), /PROFILE\.json is missing/],
    ['no variant folder at all', (dir) => fs.rmSync(webOf(dir), { recursive: true }), /holds no ZIPP web variant install \(no SOURCE\.json\); run npm run fetch:zipp/],
  ];
  for (const [what, tamper, pattern] of cases) {
    const copy = path.join(tempDir(t, 'zipp-check-'), 'wasm-zipp');
    fs.cpSync(pristine, copy, { recursive: true });
    fs.cpSync(variantDir(pristine), variantDir(copy), { recursive: true });
    tamper(copy);
    assert.throws(() => checkEngine(copy), (error) => error instanceof ZippReleaseError && pattern.test(error.message), what);
    const run = cli(['--check'], { ZIPP_OUT: copy });
    assert.equal(run.status, 1, what);
    assert.doesNotMatch(run.stderr, /^\s+at /m, `${what}: a refusal, not a stack trace`);
  }
  assert.equal(checkEngine(pristine).variants.web.sha256, sha256(installedWeb('zipp_wasm_bg.wasm')), 'the pristine copy still checks');
});

test('--ensure reinstalls when the variant is gone or tampered, and --install-local removes it', async (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, run.stderr);
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    throw new Error('no request expected');
  };
  fs.rmSync(variantDir(out), { recursive: true });
  const restored = await ensureEngine({ dir: out, fetch, releaseDir: folder.dir, log: quiet });
  assert.equal(restored.action, 'installed');
  assert.deepEqual(fs.readdirSync(variantDir(out)).sort(), [...VARIANT_INSTALLED_FILES].sort());
  fs.appendFileSync(path.join(variantDir(out), 'BUILD-INFO.txt'), ' ');
  const logs = [];
  assert.equal((await ensureEngine({ dir: out, fetch, releaseDir: folder.dir, log: (line) => logs.push(line) })).action, 'installed');
  assert.match(logs.join('\n'), /web variant install .* does not check/);
  assert.equal((await ensureEngine({ dir: out, fetch, log: quiet })).action, 'none');
  assert.deepEqual(calls, [], 'the folder was the source');
  // A local build has no variant: the release's does not stay beside it as if it were this build's.
  const from = tempDir(t, 'zipp-local-build-');
  for (const name of ['zipp_wasm.js', 'zipp_wasm.d.ts', 'zipp_wasm_bg.wasm', 'zipp_wasm_bg.wasm.d.ts', 'LICENSE-APACHE']) fs.copyFileSync(path.join(ENGINE, name), path.join(from, name));
  fs.writeFileSync(path.join(from, 'SOURCE.json'), JSON.stringify({ repository: REPOSITORY, revision: 'c'.repeat(40), version: VERSION, build: 'local', variant: 'all', languages: ['javascript', 'python'], license: 'Apache-2.0', artifact: 'zipp_wasm_bg.wasm', sha256: source.sha256 }));
  await installLocal(from, out, { log: quiet, warn: quiet });
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['wasm-zipp'], 'the variant and package folders are gone with the release install');
});

test('--check fails after a one-byte edit, and on a file the bundle\'s SHA256SUMS does not list', (t) => {
  const { out, run } = install(t, releaseFolder(t));
  assert.equal(run.status, 0, run.stderr);
  const file = path.join(out, 'zipp_wasm_bg.wasm.d.ts');
  const original = fs.readFileSync(file);
  const edited = Buffer.from(original);
  edited[0] ^= 0x01;
  fs.writeFileSync(file, edited);
  refused({ run: cli(['--check'], { ZIPP_OUT: out }) }, /zipp_wasm_bg\.wasm\.d\.ts does not match the bundle's SHA256SUMS/);
  fs.writeFileSync(file, original);
  const sums = path.join(out, 'SHA256SUMS');
  fs.writeFileSync(sums, fs.readFileSync(sums, 'utf8').split('\n').filter((line) => !line.endsWith('  zipp_wasm_bg.wasm.d.ts')).join('\n'));
  refused({ run: cli(['--check'], { ZIPP_OUT: out }) }, /zipp_wasm_bg\.wasm\.d\.ts is not listed in the bundle's SHA256SUMS/);
});

test('--check holds an install to everything its SOURCE.json records, one invariant at a time', (t) => {
  const { out: pristine, run } = install(t, releaseFolder(t));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(checkEngine(pristine).release, TAG);
  const E64 = 'e'.repeat(64);
  const E40 = 'e'.repeat(40);
  const buildInfo = (key, value) => (dir) => {
    editText(dir, 'BUILD-INFO.txt', (text) => text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`));
    resum(dir, 'BUILD-INFO.txt');
  };
  const cases = [
    ['ZIPP\'s SHA256SUMS edited', (dir) => fs.appendFileSync(path.join(dir, 'RELEASE-SHA256SUMS'), '\n'), /RELEASE-SHA256SUMS has sha256 [0-9a-f]{64}, not the recorded [0-9a-f]{64}/],
    ['a recorded SHA256SUMS digest', (dir) => editSource(dir, (s) => void (s.sumsSha256 = E64)), /RELEASE-SHA256SUMS has sha256 [0-9a-f]{64}, not the recorded e{64}/],
    ['a recorded bundle digest', (dir) => editSource(dir, (s) => void (s.bundleSha256 = E64)), new RegExp(`RELEASE-SHA256SUMS does not list ${escaped(BUNDLE)}\\.zip with the recorded e{64}`)],
    ['a recorded revision', (dir) => editSource(dir, (s) => void (s.revision = E40)), /BUILD-INFO\.txt commit [0-9a-f]{40} is not the recorded revision e{40}/],
    ['a recorded stack', (dir) => editSource(dir, (s) => void (s.stackBytes = 1048576)), /SOURCE\.json records javascript-python-base \["javascript","python"\] with a 1048576-byte stack, not the web-python-base build/],
    ['a recorded engine digest', (dir) => editSource(dir, (s) => void (s.sha256 = E64)), /zipp_wasm_bg\.wasm is not the recorded e{64}/],
    ['a recorded glue digest', (dir) => editSource(dir, (s) => void (s.glueSha256 = E64)), /zipp_wasm\.js is not the recorded e{64}/],
    ['a recorded notices digest', (dir) => editSource(dir, (s) => void (s.notices.sha256 = E64)), /THIRD_PARTY_LICENSES\.txt is not the recorded e{64}/],
    ['notices of unknown origin', (dir) => editSource(dir, (s) => void (s.notices.source = 'elsewhere')), /SOURCE\.json notices .* are not recorded/],
    ['curated notices recorded as the release\'s', (dir) => editSource(dir, (s) => void (s.notices.source = 'zipp-release')), /THIRD_PARTY_LICENSES\.txt is not listed in the bundle's SHA256SUMS/],
    ['another repository', (dir) => editSource(dir, (s) => void (s.repository = 'https://example.com/zipp')), /SOURCE\.json repository is https:\/\/example\.com\/zipp/],
    ['a release that is not the version', (dir) => editSource(dir, (s) => void (s.release = 'v9.9.9')), /SOURCE\.json release v9\.9\.9 and version \S+ do not agree/],
    ['the web bundle recorded', (dir) => editSource(dir, (s) => void (s.bundle = `zipp-wasm-${VERSION}-web.zip`)), /SOURCE\.json bundle \S+-web\.zip is not the web-python-base bundle/],
    ['BUILD-INFO.txt of another commit', buildInfo('commit', E40), /BUILD-INFO\.txt commit e{40} is not the recorded revision [0-9a-f]{40}/],
    ['BUILD-INFO.txt of another version', buildInfo('version', '9.9.9'), /BUILD-INFO\.txt says version 9\.9\.9, not /],
    ['BUILD-INFO.txt of another variant', buildInfo('variant', 'javascript'), /BUILD-INFO\.txt variant is javascript, not javascript-python-base/],
    ['BUILD-INFO.txt of other languages', buildInfo('languages', '["javascript"]'), /BUILD-INFO\.txt languages are \["javascript"\], not \["javascript","python"\]/],
    ['BUILD-INFO.txt of another stack', buildInfo('stack-bytes', '1048576'), /BUILD-INFO\.txt stack-bytes is 1048576, not 16777216/],
    ['PROFILE.json of another version', (dir) => {
      editText(dir, 'PROFILE.json', (text) => text.replace(`"version": "${VERSION}"`, '"version": "9.9.9"'));
      resum(dir, 'PROFILE.json');
    }, /PROFILE\.json says version 9\.9\.9, not /],
    ['another engine, listed', (dir) => {
      const file = path.join(dir, 'zipp_wasm_bg.wasm');
      const bytes = fs.readFileSync(file);
      bytes[bytes.length - 1] ^= 0x01;
      fs.writeFileSync(file, bytes);
      resum(dir, 'zipp_wasm_bg.wasm');
    }, /zipp_wasm_bg\.wasm is not the recorded [0-9a-f]{64}/],
    ['other glue, listed', (dir) => {
      fs.appendFileSync(path.join(dir, 'zipp_wasm.js'), '\n');
      resum(dir, 'zipp_wasm.js');
    }, /zipp_wasm\.js is not the recorded [0-9a-f]{64}/],
    ['edited notices, recorded', (dir) => {
      fs.appendFileSync(path.join(dir, 'THIRD_PARTY_LICENSES.txt'), 'and one more\n');
      editSource(dir, (s) => void (s.notices.sha256 = sha256(fs.readFileSync(path.join(dir, 'THIRD_PARTY_LICENSES.txt')))));
    }, /THIRD_PARTY_LICENSES\.txt is not the curated copy in /],
    ['a stray file', (dir) => fs.writeFileSync(path.join(dir, '.DS_Store'), ''), /\.DS_Store is not part of an install/],
    ['a folder', (dir) => fs.mkdirSync(path.join(dir, 'docs')), /docs is not a plain file/],
    ['a missing file', (dir) => fs.rmSync(path.join(dir, 'LICENSE-APACHE')), /LICENSE-APACHE is missing/],
  ];
  for (const [what, tamper, pattern] of cases) {
    const copy = path.join(tempDir(t, 'zipp-check-'), 'wasm-zipp');
    fs.cpSync(pristine, copy, { recursive: true });
    tamper(copy);
    assert.throws(() => checkEngine(copy), (error) => error instanceof ZippReleaseError && pattern.test(error.message), what);
  }
  // The curated copy the install is held to is the one in zipp-notices/, not whatever the install says.
  const otherCurated = path.join(tempDir(t, 'zipp-curated-'), 'THIRD_PARTY_LICENSES.txt');
  fs.writeFileSync(otherCurated, 'a different curated copy\n');
  assert.throws(() => checkEngine(pristine, { curatedNotices: otherCurated }), /THIRD_PARTY_LICENSES\.txt is not the curated copy in /);
});

test('--resolve-only names the declared release and its SHA256SUMS digest without installing', (t) => {
  const folder = releaseFolder(t);
  const run = cli(['--resolve-only'], { ZIPP_RELEASE_DIR: folder.dir });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { release: TAG, sumsSha256: sha256(folder.top) }, 'apps/softn-host-rust/Cargo.toml declares the installed release (engine-pin.test.mjs)');
});

const declaring = (file, tag) => fs.writeFileSync(file, `[dependencies]\nzipp-vm = { git = "${REPOSITORY}", tag = "${tag}", features = ["instrument"] }\n`);

test('with no tag the release is the one Cargo.toml declares, and resolving or checking needs no node_modules', (t) => {
  // A copy of the script in the layout it expects, far from any node_modules.
  const tree = tempDir(t, 'zipp-script-copy-');
  const script = path.join(tree, 'packages/@softn/core/scripts/fetch-zipp-release.mjs');
  const cargo = path.join(tree, 'apps/softn-host-rust/Cargo.toml');
  for (const dir of [path.dirname(script), path.dirname(cargo), path.join(tree, 'packages/@softn/core/zipp-notices'), path.join(tree, 'scripts/lib')]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SCRIPT, script);
  // The one repository file the script imports: the WebAssembly section reader the packager's content scan uses too.
  fs.copyFileSync(ENGINE_COPY_LIB, path.join(tree, 'scripts/lib/zipp-engine-copy.mjs'));
  fs.copyFileSync(CURATED_NOTICES, path.join(tree, 'packages/@softn/core/zipp-notices/THIRD_PARTY_LICENSES.txt'));
  assert.notEqual(spawnSync(process.execPath, ['--input-type=module', '-e', "await import('fflate')"], { cwd: tree }).status, 0, 'no node_modules is reachable from the copy');
  const copy = (args, env = {}, preload = []) => spawnSync(process.execPath, [...preload, script, ...args], { cwd: tree, encoding: 'utf8', env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...env } });
  const folder = releaseFolder(t);

  declaring(cargo, TAG);
  const resolved = copy(['--resolve-only'], { ZIPP_RELEASE_DIR: folder.dir });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.deepEqual(JSON.parse(resolved.stdout), { release: TAG, sumsSha256: sha256(folder.top) });
  declaring(cargo, 'v99.0.0');
  refused({ run: copy(['--resolve-only'], { ZIPP_RELEASE_DIR: folder.dir }) }, /SHA256SUMS in .* does not list zipp-wasm-99\.0\.0-web-python-base\.zip/);
  assert.equal(JSON.parse(copy(['--resolve-only'], { ZIPP_RELEASE_DIR: folder.dir, ZIPP_RELEASE: TAG }).stdout).release, TAG, 'ZIPP_RELEASE comes before the declaration');
  fs.rmSync(cargo);
  refused({ run: copy(['--resolve-only'], { ZIPP_RELEASE_DIR: folder.dir }) }, /cannot read the declared ZIPP release from .*Cargo\.toml/);

  const check = copy(['--check'], { ZIPP_OUT: ENGINE });
  assert.equal(check.status, 0, `--check reads no Cargo.toml and no fflate:\n${check.stderr}`);
  assert.match(check.stdout, /with its web variant .* and its torch package/, '--check covers wasm-zipp-web/ and wasm-zipp-torch/ too');

  // --latest, with GitHub stubbed before the script loads. The latest release's SHA256SUMS must list all three bundles as well.
  const latestSums = Buffer.from(`${'3'.repeat(64)}  zipp-wasm-0.0.19-web.zip\n${'3'.repeat(64)}  zipp-wasm-0.0.19-web-python-base.zip\n${'3'.repeat(64)}  zipp-wasm-0.0.19-web-torch.zip\n`);
  const stub = path.join(tree, 'stub-fetch.mjs');
  fs.writeFileSync(stub, `const sums = Buffer.from(${JSON.stringify(latestSums.toString('base64'))}, 'base64');\nconst served = new Set([${JSON.stringify(`${REPOSITORY}/releases/latest/download/SHA256SUMS`)}, ${JSON.stringify(`${REPOSITORY}/releases/download/v0.0.19/SHA256SUMS`)}]);\nglobalThis.fetch = async (url) => (served.has(url) ? new Response(sums) : new Response('', { status: 404 }));\n`);
  const latest = copy(['--resolve-only', '--latest'], {}, ['--import', pathToFileURL(stub).href]);
  assert.equal(latest.status, 0, latest.stderr);
  assert.deepEqual(JSON.parse(latest.stdout), { release: 'v0.0.19', sumsSha256: sha256(latestSums) });
  // A latest release published without its web bundle is not one this can install.
  const onlyPython = Buffer.from(`${'4'.repeat(64)}  zipp-wasm-0.0.19-web-python-base.zip\n${'4'.repeat(64)}  zipp-wasm-0.0.19-web-torch.zip\n`);
  fs.writeFileSync(stub, fs.readFileSync(stub, 'utf8').replace(latestSums.toString('base64'), onlyPython.toString('base64')));
  refused({ run: copy(['--resolve-only', '--latest'], {}, ['--import', pathToFileURL(stub).href]) }, /SHA256SUMS published under v0\.0\.19 does not list zipp-wasm-0\.0\.19-web\.zip/);
});

test('--ensure replaces an install of a release other than the declared one', async (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, run.stderr);
  const cargo = path.join(tempDir(t, 'zipp-cargo-'), 'Cargo.toml');
  declaring(cargo, 'v99.0.0');
  const logs = [];
  const warnings = [];
  await assert.rejects(ensureEngine({ dir: out, cargoToml: cargo, releaseDir: folder.dir, log: (line) => logs.push(line), warn: (line) => warnings.push(line) }), /does not list zipp-wasm-99\.0\.0-web-python-base\.zip/);
  assert.match(logs.join('\n'), new RegExp(`holds ${escaped(TAG)}, not v99\\.0\\.0 \\(the release .*Cargo\\.toml declares\\)`));
  // A release installed by hand is not replaced quietly: the warning says how to keep building against it.
  assert.match(warnings.join('\n'), new RegExp(`^warning: replacing ZIPP ${escaped(TAG)} with v99\\.0\\.0; .*set ZIPP_RELEASE=${escaped(TAG)} for every command`, 'm'));
  assert.equal(checkEngine(out).release, TAG, 'a refused install leaves the one before it');
  declaring(cargo, TAG);
  const noRequest = async () => assert.fail('no request expected');
  assert.equal((await ensureEngine({ dir: out, cargoToml: cargo, fetch: noRequest, log: quiet })).action, 'none');
});

test('--ensure reinstalls when ZIPP_SUMS_SHA256 is not the digest the install was taken with', (t) => {
  const first = releaseFolder(t);
  const { out, run } = install(t, first);
  assert.equal(run.status, 0, run.stderr);
  // The same release published again with other bytes beside the engine, so another SHA256SUMS.
  const second = releaseFolder(t, { edit: (files) => files.set('README.md', Buffer.from('# zipp-wasm, published again\n')) });
  assert.notEqual(sha256(second.top), sha256(first.top));
  const ensure = cli(['--ensure'], { ZIPP_OUT: out, ZIPP_RELEASE_DIR: second.dir, ZIPP_SUMS_SHA256: sha256(second.top) });
  assert.equal(ensure.status, 0, ensure.stderr);
  assert.match(ensure.stdout, /installed from a SHA256SUMS other than ZIPP_SUMS_SHA256/);
  assert.equal(checkEngine(out).sumsSha256, sha256(second.top));
  refused({ run: cli(['--ensure'], { ZIPP_OUT: out, ZIPP_RELEASE_DIR: second.dir, ZIPP_SUMS_SHA256: '0'.repeat(64) }) }, /ZIPP_SUMS_SHA256 says 0{64}/);
  assert.equal(checkEngine(out).sumsSha256, sha256(second.top), 'the refusal left the install alone');
});

test('--latest takes GitHub\'s latest release only when its SHA256SUMS is the one under its tag', async () => {
  const latestUrl = `${REPOSITORY}/releases/latest/download/SHA256SUMS`;
  const tagUrl = `${REPOSITORY}/releases/download/v0.0.19/SHA256SUMS`;
  const sums = (digit) => Buffer.from(`${digit.repeat(64)}  zipp-wasm-0.0.19-web.zip\n${digit.repeat(64)}  zipp-wasm-0.0.19-web-python-base.zip\n${digit.repeat(64)}  zipp-wasm-0.0.19-web-torch.zip\n`);
  const serve = (responses) => {
    const calls = [];
    return { calls, fetch: async (url) => (calls.push(url), responses.has(url) ? new Response(responses.get(url)) : new Response('', { status: 404 })) };
  };
  const same = serve(new Map([[latestUrl, sums('1')], [tagUrl, sums('1')]]));
  const resolved = await resolveRelease({ latest: true, fetch: same.fetch });
  assert.equal(resolved.release, 'v0.0.19');
  assert.ok(resolved.sums.equals(sums('1')));
  assert.deepEqual(same.calls, [latestUrl, tagUrl], 'no API call: the latest redirect, then the tag\'s own asset');
  const moved = serve(new Map([[latestUrl, sums('1')], [tagUrl, sums('2')]]));
  await assert.rejects(resolveRelease({ latest: true, fetch: moved.fetch }), (error) => error instanceof ZippReleaseError && /try again/.test(error.message));
});

test('--ensure leaves an intact install alone without a single request, and reinstalls one that fails --check', async (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, run.stderr);
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    throw new Error('no request expected');
  };
  for (const wanted of [{}, { tag: TAG }, { expectSumsSha256: sha256(folder.top) }]) {
    assert.equal((await ensureEngine({ dir: out, fetch, log: quiet, ...wanted })).action, 'none', JSON.stringify(wanted));
  }
  assert.deepEqual(calls, []);
  fs.appendFileSync(path.join(out, 'PROFILE.json'), ' ');
  const repaired = await ensureEngine({ dir: out, fetch, releaseDir: folder.dir, log: quiet });
  assert.equal(repaired.action, 'installed');
  assert.equal(checkEngine(out).release, TAG);
  assert.deepEqual(calls, [], 'the folder was the source');
});

test('a local build installs only on purpose, never passes --check, and --ensure keeps it (refusing under CI)', async (t) => {
  const from = tempDir(t, 'zipp-local-build-');
  for (const name of ['zipp_wasm.js', 'zipp_wasm.d.ts', 'zipp_wasm_bg.wasm', 'zipp_wasm_bg.wasm.d.ts', 'LICENSE-APACHE']) fs.copyFileSync(path.join(ENGINE, name), path.join(from, name));
  fs.copyFileSync(CURATED_NOTICES, path.join(from, 'THIRD_PARTY_LICENSES.txt'));
  const local = { repository: REPOSITORY, revision: 'c'.repeat(40), version: VERSION, build: 'local', variant: 'all', languages: ['javascript', 'python'], license: 'Apache-2.0', artifact: 'zipp_wasm_bg.wasm', sha256: source.sha256 };
  fs.writeFileSync(path.join(from, 'SOURCE.json'), JSON.stringify(local));
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  const run = cli(['--install-local', from], { ZIPP_OUT: out });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'SOURCE.json'), 'utf8')), local);
  refused({ run: cli(['--check'], { ZIPP_OUT: out }) }, /holds a 'local' ZIPP build/);
  const kept = cli(['--ensure'], { ZIPP_OUT: out });
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stderr, /warning: .*local ZIPP build/);
  refused({ run: cli(['--ensure'], { ZIPP_OUT: out, CI: 'true' }) }, /CI builds only from a verified release/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'SOURCE.json'), 'utf8')).build, 'local', 'still the local build');
  // What the FormLogic runtime packager builds from: kept by --ensure, refused all the same.
  const warnings = [];
  await assert.rejects(ensureReleaseEngine({ dir: out, env: {}, warn: (line) => warnings.push(line) }), (error) => error instanceof ZippReleaseError && /holds a 'local' ZIPP build, not a verified release install/.test(error.message));
  assert.match(warnings.join('\n'), /local ZIPP build/);
  fs.writeFileSync(path.join(from, 'SOURCE.json'), JSON.stringify({ ...local, build: 'release' }));
  refused({ run: cli(['--install-local', from], { ZIPP_OUT: path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp') }) }, /takes only build-zipp-wasm\.mjs output/);
});

test('--check --online compares the install with what the release publishes now', async (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, run.stderr);
  const sumsUrl = `${REPOSITORY}/releases/download/${TAG}/SHA256SUMS`;
  const published = publishedUrls(folder);
  const fetch = async (url) => (published.has(url) ? new Response(published.get(url)) : new Response('', { status: 404 }));
  assert.equal((await checkEngineOnline(out, { fetch })).release, TAG);
  published.set(sumsUrl, Buffer.concat([folder.top, Buffer.from('\n')]));
  await assert.rejects(checkEngineOnline(out, { fetch }), /RELEASE-SHA256SUMS is not the SHA256SUMS published under/);
});

test('--check --online compares every file taken with the published bundles, byte for byte, the web bundle included', async (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, run.stderr);
  const zipUrl = `${REPOSITORY}/releases/download/${TAG}/${BUNDLE}.zip`;
  const webUrl = `${REPOSITORY}/releases/download/${TAG}/${WEB_BUNDLE}.zip`;
  const published = publishedUrls(folder);
  const fetch = async (url) => (published.has(url) ? new Response(published.get(url)) : new Response('', { status: 404 }));
  // The web bundle published again with other bytes: not the one recorded.
  const republished = releaseFolder(t, { editWeb: (files) => files.set('README.md', Buffer.from('# web, again\n')) });
  published.set(webUrl, republished.webZip);
  await assert.rejects(checkEngineOnline(out, { fetch }), new RegExp(`the published ${WEB_BUNDLE}\\.zip is not the recorded [0-9a-f]{64}`));
  published.set(webUrl, folder.webZip);
  // A variant file edited and re-listed passes offline, and not against what is published.
  fs.appendFileSync(path.join(variantDir(out), 'PROFILE.json'), ' ');
  resum(variantDir(out), 'PROFILE.json');
  assert.equal(checkEngine(out).release, TAG);
  await assert.rejects(checkEngineOnline(out, { fetch }), (error) => new RegExp(`\\n {2}- .*wasm-zipp-web/PROFILE\\.json is not the file in the published ${WEB_BUNDLE}\\.zip`).test(error.message) && new RegExp(`\\n {2}- .*wasm-zipp-web/SHA256SUMS is not the file in the published`).test(error.message));
  fs.rmSync(out, { recursive: true });
  fs.rmSync(variantDir(out), { recursive: true });
  assert.equal(install(t, folder, { out }).run.status, 0);
  // An edited file whose line in the install's own SHA256SUMS was rewritten to match passes offline ...
  fs.appendFileSync(path.join(out, 'zipp_wasm.d.ts'), '\n');
  resum(out, 'zipp_wasm.d.ts');
  assert.equal(checkEngine(out).release, TAG);
  // ... and not against what the release publishes.
  await assert.rejects(checkEngineOnline(out, { fetch }), (error) => /\n {2}- SHA256SUMS is not the file in the published /.test(error.message) && /\n {2}- zipp_wasm\.d\.ts is not the file in the published /.test(error.message));
  // A bundle published again under the tag is not the one recorded.
  const second = install(t, folder);
  published.set(zipUrl, releaseFolder(t, { repack: true }).zip);
  await assert.rejects(checkEngineOnline(second.out, { fetch }), new RegExp(`the published ${escaped(BUNDLE)}\\.zip is not the recorded [0-9a-f]{64}`));
});

test('installs into one folder take turns: hooks started together all succeed, and one of them installs', async (t) => {
  const folder = releaseFolder(t);
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  const runs = await Promise.all([0, 1, 2].map(() => spawnCli(['--ensure'], { ZIPP_OUT: out, ZIPP_RELEASE_DIR: folder.dir })));
  for (const run of runs) assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(runs.filter((run) => /Installed ZIPP/.test(run.stdout)).length, 1, 'the others found the install done');
  assert.equal(checkEngine(out).release, TAG);
  assert.deepEqual(fs.readdirSync(path.dirname(out)).sort(), BOTH, 'no stage, previous install or lock is left');
});

// Ctrl+C during a first install leaves its lock; the hooks started after it must not each take it over.
test('hooks started together on a lock a dead install left: one of them installs and every one succeeds', { timeout: 120_000 }, async (t) => {
  const folder = releaseFolder(t);
  // Holds every hook until the same instant, so all of them find the dead lock at once.
  const gate = path.join(tempDir(t, 'zipp-gate-'), 'gate.mjs');
  fs.writeFileSync(gate, 'const at = Number(process.env.LOCK_RACE_AT);\nconst wait = at - Date.now() - 20;\nif (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);\nwhile (Date.now() < at);\n');
  for (let round = 0; round < 5; round++) {
    const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
    fs.writeFileSync(path.join(path.dirname(out), '.wasm-zipp.lock'), String(deadPid()));
    const at = String(Date.now() + 1500);
    const runs = await Promise.all(Array.from({ length: 8 }, () => spawnCli(['--ensure'], { ZIPP_OUT: out, ZIPP_RELEASE_DIR: folder.dir, LOCK_RACE_AT: at }, ['--import', pathToFileURL(gate).href])));
    for (const run of runs) assert.equal(run.status, 0, `round ${round}: ${run.stdout}\n${run.stderr}`);
    assert.equal(runs.filter((run) => /Installed ZIPP/.test(run.stdout)).length, 1, `round ${round}: the others found the install done`);
    assert.equal(checkEngine(out).release, TAG);
    assert.deepEqual(fs.readdirSync(path.dirname(out)).sort(), BOTH, `round ${round}: no lock, turn, stage or previous install is left`);
  }
});

test('a lock whose process is gone is taken over with what it left; a live one is waited for', async (t) => {
  const folder = releaseFolder(t);
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  const lock = path.join(path.dirname(out), '.wasm-zipp.lock');
  const gone = deadPid();
  fs.writeFileSync(lock, String(gone));
  fs.mkdirSync(path.join(path.dirname(out), `.wasm-zipp.stage-${gone}-0badf00d`));
  const taken = cli(['--ensure'], { ZIPP_OUT: out, ZIPP_RELEASE_DIR: folder.dir });
  assert.equal(taken.status, 0, taken.stderr);
  assert.doesNotMatch(taken.stderr, /Waiting for/, 'a dead holder is not waited on');
  assert.deepEqual(fs.readdirSync(path.dirname(out)).sort(), BOTH);

  // Held by a live process: nothing happens until it lets go.
  fs.rmSync(out, { recursive: true });
  const holder = livePid(t);
  fs.writeFileSync(lock, `${holder} 0123456789abcdef`);
  let released = false;
  const timer = setTimeout(() => {
    released = true;
    fs.rmSync(lock);
  }, 700);
  const warnings = [];
  const result = await ensureEngine({ dir: out, releaseDir: folder.dir, log: quiet, warn: (line) => warnings.push(line) });
  clearTimeout(timer);
  assert.ok(released, 'the install did not go ahead while the lock was held');
  assert.equal(result.action, 'installed');
  assert.match(warnings.join('\n'), new RegExp(`Waiting for the ZIPP install another process \\(${holder}\\) is making`));
  assert.deepEqual(fs.readdirSync(path.dirname(out)).sort(), BOTH);
});

// Without this a hook would sit out the whole wait behind a lock left by a killed install whose pid Windows gave to another process.
test('a lock older than any install is taken over at once, even when its pid is alive again', { timeout: 30_000 }, async (t) => {
  const folder = releaseFolder(t);
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  const lock = path.join(path.dirname(out), '.wasm-zipp.lock');
  // A live process stands in for the unrelated one that now has the dead holder's pid (a lock written by an earlier version: the pid alone).
  fs.writeFileSync(lock, String(livePid(t)));
  const eleven = new Date(Date.now() - 11 * 60_000);
  fs.utimesSync(lock, eleven, eleven);
  const warnings = [];
  const result = await ensureEngine({ dir: out, releaseDir: folder.dir, log: quiet, warn: (line) => warnings.push(line) });
  assert.equal(result.action, 'installed');
  assert.deepEqual(warnings.filter((line) => /Waiting for/.test(line)), [], 'an expired lock is not waited on');
  assert.deepEqual(fs.readdirSync(path.dirname(out)).sort(), BOTH, 'the expired lock is gone with the install');
});

test('a lock naming this process is an earlier install\'s that had its pid, unless this process holds it', { timeout: 60_000 }, async (t) => {
  const folder = releaseFolder(t);
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  fs.writeFileSync(path.join(path.dirname(out), '.wasm-zipp.lock'), String(process.pid));
  const warnings = [];
  const result = await ensureEngine({ dir: out, releaseDir: folder.dir, log: quiet, warn: (line) => warnings.push(line) });
  assert.equal(result.action, 'installed');
  assert.deepEqual(warnings.filter((line) => /Waiting for/.test(line)), [], 'this process does not wait for itself');
  // Two installs in this process take turns like two processes do.
  fs.rmSync(out, { recursive: true });
  const both = await Promise.all([0, 1].map(() => ensureEngine({ dir: out, releaseDir: folder.dir, log: quiet, warn: quiet })));
  assert.deepEqual(both.map((r) => r.action).sort(), ['installed', 'none']);
  assert.deepEqual(fs.readdirSync(path.dirname(out)).sort(), BOTH);
});

test('an empty lock is one being written this instant, unless it has been empty a while', { timeout: 60_000 }, async (t) => {
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  const lock = path.join(path.dirname(out), '.wasm-zipp.lock');
  const warnings = [];
  const held = () => withInstallLock(out, async () => 'held', { warn: (line) => warnings.push(line) });
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 31_000);
  fs.utimesSync(lock, old, old);
  assert.equal(await held(), 'held');
  assert.deepEqual(warnings, [], 'empty for 31 s: its writer is gone');
  fs.writeFileSync(lock, '');
  const timer = setTimeout(() => fs.rmSync(lock), 600);
  assert.equal(await held(), 'held');
  clearTimeout(timer);
  assert.match(warnings.join('\n'), /Waiting for the ZIPP install another process \(starting\) is making/);
});

// A lock another hook has just removed can refuse its successor for a moment on Windows (delete pending).
test('a lock that cannot be created for a moment is tried again on Windows, and refused elsewhere', async (t) => {
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  const lock = path.join(path.dirname(out), '.wasm-zipp.lock');
  const { writeFileSync } = fs;
  let refusals = 3;
  t.mock.method(fs, 'writeFileSync', function (file, ...rest) {
    if (refusals > 0 && path.resolve(String(file)) === lock) {
      refusals--;
      throw Object.assign(new Error(`EPERM: operation not permitted, open '${file}'`), { code: 'EPERM' });
    }
    return writeFileSync.call(this, file, ...rest);
  });
  const locked = withInstallLock(out, async () => 'held', { warn: quiet });
  if (process.platform === 'win32') assert.equal(await locked, 'held');
  else await assert.rejects(locked, (error) => error instanceof ZippReleaseError && /cannot lock .* for an install \(.*: EPERM\)/.test(error.message));
});

test('a dead lock is removed only while it is still that lock, and by one waiter at a time', { timeout: 60_000 }, async (t) => {
  const dir = tempDir(t, 'zipp-lock-');
  const lock = path.join(dir, '.wasm-zipp.lock');
  const turn = `${lock}.break`;
  const dead = `${deadPid()} 00000000deadbeef`;
  const live = `${livePid(t)} 0000000011111111`;
  const seen = { text: dead, pid: Number(dead.split(' ')[0]), age: 0 };
  // Another waiter took it over and wrote its own lock since this one read the dead one: left alone.
  fs.writeFileSync(lock, live);
  assert.equal(await removeStaleLock(lock, seen), true);
  assert.equal(fs.readFileSync(lock, 'utf8'), live);
  // Still the dead lock: removed, and the turn given back.
  fs.writeFileSync(lock, dead);
  assert.equal(await removeStaleLock(lock, seen), true);
  assert.deepEqual(fs.readdirSync(dir), []);
  // Another waiter's turn: nothing is removed.
  fs.writeFileSync(lock, dead);
  fs.writeFileSync(turn, live);
  assert.equal(await removeStaleLock(lock, seen), true);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.wasm-zipp.lock', '.wasm-zipp.lock.break']);
  assert.equal(fs.readFileSync(turn, 'utf8'), live);
  // A turn whose waiter died is cleared, and the next one removes the dead lock.
  fs.writeFileSync(turn, dead);
  assert.equal(await removeStaleLock(lock, seen), true);
  assert.deepEqual(fs.readdirSync(dir), ['.wasm-zipp.lock']);
  assert.equal(await removeStaleLock(lock, seen), true);
  assert.deepEqual(fs.readdirSync(dir), []);
  // One that cannot be removed is looked at again after a pause, not in a spin, and the turn is given back.
  fs.writeFileSync(lock, dead);
  const { rmSync } = fs;
  const rm = t.mock.method(fs, 'rmSync', function (file, ...rest) {
    if (path.resolve(String(file)) === lock) throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${file}'`), { code: 'EPERM' });
    return rmSync.call(this, file, ...rest);
  });
  const began = Date.now();
  assert.equal(await removeStaleLock(lock, seen), false);
  assert.ok(Date.now() - began >= 15, 'a pause before the next look');
  assert.deepEqual(fs.readdirSync(dir), ['.wasm-zipp.lock']);
  // Never removable: refused in the end, not retried forever.
  await assert.rejects(withInstallLock(path.join(dir, 'wasm-zipp'), async () => assert.fail('the lock was never free'), { warn: quiet }), (error) => error instanceof ZippReleaseError && new RegExp(`cannot remove the install lock .*, which process ${seen.pid} left; delete it`).test(error.message));
  rm.mock.restore();
  assert.deepEqual(fs.readdirSync(dir), ['.wasm-zipp.lock']);
});

test('an install whose lock is no longer its own writes nothing and leaves that lock alone', async (t) => {
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  const lock = path.join(path.dirname(out), '.wasm-zipp.lock');
  const other = `${livePid(t)} 00000000cafef00d`;
  const takenOver = (error) => error instanceof ZippReleaseError && new RegExp(`install lock .* is no longer this install's \\(process ${other.split(' ')[0]} holds it\\); nothing was written, so run it again`).test(error.message);
  await assert.rejects(withInstallLock(out, async (assertHeld) => {
    assertHeld();
    fs.writeFileSync(lock, other);
    assertHeld();
  }, { warn: quiet }), takenOver);
  assert.equal(fs.readFileSync(lock, 'utf8'), other, 'the lock another install holds is not released');
  // Taken over while the bundles download: refused before either folder is written.
  fs.rmSync(lock);
  const folder = releaseFolder(t);
  const published = publishedUrls(folder);
  const fetch = async (url) => {
    if (url.endsWith('.zip')) fs.writeFileSync(lock, other);
    return published.has(url) ? new Response(published.get(url)) : new Response('', { status: 404 });
  };
  await assert.rejects(installRelease({ dir: out, tag: TAG, cacheDir: tempDir(t, 'zipp-cache-'), fetch, log: quiet, warn: quiet }), takenOver);
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['.wasm-zipp.lock'], 'none of wasm-zipp, wasm-zipp-web and wasm-zipp-torch was written');
  assert.equal(fs.readFileSync(lock, 'utf8'), other);
  // A local build likewise, taken over while it is read.
  fs.rmSync(lock);
  const from = tempDir(t, 'zipp-local-build-');
  for (const name of ['zipp_wasm.js', 'zipp_wasm.d.ts', 'zipp_wasm_bg.wasm', 'zipp_wasm_bg.wasm.d.ts']) fs.copyFileSync(path.join(ENGINE, name), path.join(from, name));
  fs.writeFileSync(path.join(from, 'SOURCE.json'), JSON.stringify({ build: 'local', revision: 'c'.repeat(40), sha256: source.sha256 }));
  const { readFileSync } = fs;
  t.mock.method(fs, 'readFileSync', function (file, ...rest) {
    if (path.resolve(String(file)) === path.join(from, 'SOURCE.json')) fs.writeFileSync(lock, other);
    return readFileSync.call(this, file, ...rest);
  });
  await assert.rejects(installLocal(from, out, { log: quiet, warn: quiet }), takenOver);
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['.wasm-zipp.lock']);
  assert.equal(readFileSync(lock, 'utf8'), other);
});

test('an install that cannot be written is a refusal, not a stack trace', (t) => {
  const file = path.join(tempDir(t, 'zipp-install-'), 'not-a-folder');
  fs.writeFileSync(file, '');
  assert.throws(() => writeInstall(path.join(file, 'wasm-zipp'), new Map([['SOURCE.json', Buffer.from('{}')]])), (error) => error instanceof ZippReleaseError && /could not write the install into /.test(error.message));
  refused({ run: cli(['--ensure'], { ZIPP_OUT: path.join(file, 'wasm-zipp'), ZIPP_RELEASE_DIR: releaseFolder(t).dir }) }, /^fetch-zipp-release: cannot create .* for a ZIPP install/);
});

test('offline, a release downloaded before is named for ZIPP_RELEASE_DIR, never used unasked', async (t) => {
  const folder = releaseFolder(t);
  const cacheDir = tempDir(t, 'zipp-cache-');
  const offline = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(resolveRelease({ tag: TAG, cacheDir, fetch: offline }), (error) => /could not fetch .*: fetch failed$/.test(error.message));
  const cached = path.join(cacheDir, TAG);
  fs.mkdirSync(cached);
  for (const name of ['SHA256SUMS', `${BUNDLE}.zip`]) fs.copyFileSync(path.join(folder.dir, name), path.join(cached, name));
  // Part of a release (no web zip, then no torch zip) is not named: it could not be installed.
  await assert.rejects(resolveRelease({ tag: TAG, cacheDir, fetch: offline }), (error) => /could not fetch .*: fetch failed$/.test(error.message));
  fs.copyFileSync(path.join(folder.dir, `${WEB_BUNDLE}.zip`), path.join(cached, `${WEB_BUNDLE}.zip`));
  await assert.rejects(resolveRelease({ tag: TAG, cacheDir, fetch: offline }), (error) => /could not fetch .*: fetch failed$/.test(error.message));
  fs.copyFileSync(path.join(folder.dir, `${TORCH_BUNDLE}.zip`), path.join(cached, `${TORCH_BUNDLE}.zip`));
  await assert.rejects(resolveRelease({ tag: TAG, cacheDir, fetch: offline }), new RegExp(`: fetch failed; to install the ${escaped(TAG)} downloaded earlier without the network, set ZIPP_RELEASE_DIR=${escaped(cached)}$`));
  // GitHub answering that there is no such release is not a network failure: no copy stands in for it.
  const missing = async () => new Response('', { status: 404 });
  await assert.rejects(resolveRelease({ tag: TAG, cacheDir, fetch: missing }), (error) => /answered 404$/.test(error.message));
  // The folder named is a release folder as it is.
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  const run = cli(['--ensure'], { ZIPP_OUT: out, ZIPP_RELEASE_DIR: cached });
  assert.equal(run.status, 0, run.stderr);
});
