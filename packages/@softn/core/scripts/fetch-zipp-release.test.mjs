/**
 * The ZIPP install takes a release only when every layer checks: each module
 * against ZIPP's SHA256SUMS and its own zipp.meta record (the release, the
 * variant, the commit, the bindings it carries), the engine's stack, and what
 * the engine reports once loaded under its own bindings; the embed kit against
 * the same SHA256SUMS and its own, naming the release, the engine's commit and
 * every module's digest; the release's JavaScript-only module, installed
 * beside it as a variant, against the engine — the same commit, the same
 * imports, no export the engine lacks, and exactly JavaScript once loaded
 * under the engine's glue; and its torch package, installed beside it, against
 * the engine's commit, and then really added to the engine by the loader
 * Softn ships, after which an `import torch` project runs.
 *
 * The fixture release is built around the installed engine, its installed
 * variant and its installed package (real modules carrying their real records
 * and bindings, so the install's zippProfile() checks really run), with the
 * kit and the top-level SHA256SUMS rebuilt per case, so a case trips only the
 * refusal it is about. A case changes a module by rewriting its custom
 * sections. Releases come from a folder (ZIPP_RELEASE_DIR) through the command
 * line, or from a stubbed fetch in process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { CURATED_NOTICES, INSTALLED_FILES, PACKAGE_INSTALLED_FILES, REPOSITORY, TORCH_DECLARATIONS, TORCH_LOADER, TORCH_PACKAGE, VARIANT_INSTALLED_FILES, WEB_VARIANT, ZippReleaseError, checkEngine, checkEngineOnline, ensureEngine, ensureReleaseEngine, installLocal, installRelease, moduleGlue, packageDir, packageModuleProblems, removeStaleLock, resolveRelease, sha256, variantDir, variantModuleProblems, verifyPackage, verifyRelease, verifyVariant, withInstallLock, writeInstall } from './fetch-zipp-release.mjs';
import { wasmCustomSections, wasmExportNames, wasmImportNames, wasmStackBytes } from '../../../../scripts/lib/zipp-engine-copy.mjs';

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
const REV = source.revision;
const BUNDLE = `zipp-${VERSION}-javascript-python-base.wasm`;
const WEB_BUNDLE = `zipp-${VERSION}-javascript.wasm`;
const TORCH_BUNDLE = `zipp-${VERSION}-torch-package.wasm`;
const KIT = `zipp-${VERSION}-wasm-embed-kit.zip`;
/** The three folders an install is: what a test looks for beside `out`. */
const BOTH = ['wasm-zipp', 'wasm-zipp-torch', 'wasm-zipp-web'];
const E64 = 'e'.repeat(64);
const E40 = 'e'.repeat(40);
const quiet = () => {};

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

/**
 * `bytes` with every custom section named in `replace` taken out and, for each
 * name whose payload is not null, one section of that payload appended: how a
 * case changes what a module says about itself without touching its code.
 */
function withSections(bytes, replace) {
  const b = Buffer.from(bytes);
  const kept = [b.subarray(0, 8)];
  let offset = 8;
  const readLeb = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = b[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
  };
  while (offset < b.length) {
    const start = offset;
    const id = b[offset++];
    const end = readLeb() + offset;
    let drop = false;
    if (id === 0) {
      const length = readLeb();
      drop = Object.hasOwn(replace, b.subarray(offset, offset + length).toString('utf8'));
    }
    if (!drop) kept.push(b.subarray(start, end));
    offset = end;
  }
  for (const [name, payload] of Object.entries(replace)) {
    if (payload === null) continue;
    const body = Buffer.concat([Buffer.from(leb(Buffer.byteLength(name))), Buffer.from(name), Buffer.from(payload)]);
    kept.push(Buffer.from([0, ...leb(body.length)]), body);
  }
  return Buffer.concat(kept);
}
const metaOf = (bytes) => JSON.parse(Buffer.from(wasmCustomSections(bytes, 'zipp.meta')[0]).toString('utf8'));
/** The module with its zipp.meta record changed by `change`; its bindings left as they are. */
const withMeta = (bytes, change) => {
  const meta = metaOf(bytes);
  change(meta);
  return withSections(bytes, { 'zipp.meta': JSON.stringify(meta) });
};
/** The module carrying `glue` as its bindings, and its record naming them. */
const withGlue = (bytes, glue) => withSections(withMeta(bytes, (meta) => void (meta.glueSha256 = sha256(glue))), { 'zipp.glue': glue });
/** A byte of the module's code flipped: another build, the same record. */
const flipCode = (bytes) => {
  const copy = Buffer.from(bytes);
  copy[Math.floor(copy.length / 3)] ^= 0x01;
  return copy;
};

const VARIANT_OF = { [BUNDLE]: 'javascript-python-base', [WEB_BUNDLE]: 'javascript', [TORCH_BUNDLE]: 'torch-package' };

/**
 * A release folder holding SHA256SUMS, the three modules and the embed kit.
 * `engine`, `web` and `torch` change a module (the installed one) before
 * SHA256SUMS is written; `kit` changes the kit's files before its own
 * SHA256SUMS is written, `kitSums` that text and `tamperKit` the files after;
 * `sums` changes the top-level text; `without` names files listed but left
 * out of the folder. The kit's modules.json is written over the modules as
 * they end up, so a changed module is still the one the kit names.
 */
function releaseFolder(t, { engine = (b) => b, web = (b) => b, torch = (b) => b, kit, kitSums, tamperKit, sums, without = [] } = {}) {
  const modules = new Map([
    [BUNDLE, engine(installed('zipp_wasm_bg.wasm'))],
    [WEB_BUNDLE, web(installedWeb('zipp_wasm_bg.wasm'))],
    [TORCH_BUNDLE, torch(installedTorch('zipp_torch.wasm'))],
  ]);
  const kitFiles = new Map([
    ['zipp.mjs', Buffer.from('export const ZIPP_LOADER_VERSION = "1.2.0";\n')],
    ['zipp-engine.d.ts', installed('zipp_wasm.d.ts')],
    ['LICENSE-APACHE', installed('LICENSE-APACHE')],
    ['README.md', Buffer.from('# ZIPP embed kit\n')],
    ['docs/zipp-wasm.md', Buffer.from('# zipp-wasm\n')],
    ['BUILD-INFO.txt', Buffer.from(`version=${VERSION}\ncommit=${REV}\nkit-source=${'f'.repeat(40)}\nloader=1.2.0\nhost-sdk=1.3.0\n`)],
    ['modules.json', Buffer.from(`${JSON.stringify({ version: VERSION, commit: REV, modules: [...modules].map(([file, bytes]) => ({ file, variant: VARIANT_OF[file], bytes: bytes.length, sha256: sha256(bytes) })) }, null, 2)}\n`)],
  ]);
  kit?.(kitFiles);
  let inner = [...kitFiles].map(([file, bytes]) => `${sha256(bytes)}  ${file}\n`).join('');
  if (kitSums) inner = kitSums(inner);
  kitFiles.set('SHA256SUMS', Buffer.from(inner));
  tamperKit?.(kitFiles);
  const kitZip = Buffer.from(zipSync(Object.fromEntries([...kitFiles].map(([file, bytes]) => [`${KIT.replace(/\.zip$/, '')}/${file}`, new Uint8Array(bytes)])), { level: 0 }));
  // Listed as ZIPP lists them, among files an install never takes.
  let top = [`${'1'.repeat(64)}  zipp-${VERSION}-windows-x86_64-portable.exe\n`, ...[...modules].map(([file, bytes]) => `${sha256(bytes)}  ${file}\n`), `${'2'.repeat(64)}  zipp-${VERSION}-javascript-lite.wasm\n`, `${sha256(kitZip)}  ${KIT}\n`].join('');
  if (sums) top = sums(top);
  const dir = tempDir(t, 'zipp-release-fixture-');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), top);
  for (const [file, bytes] of [...modules, [KIT, kitZip]]) if (!without.includes(file)) fs.writeFileSync(path.join(dir, file), bytes);
  return { dir, top: Buffer.from(top), modules, kitZip, kitFiles };
}

/** The release's SHA256SUMS and files a stubbed GitHub serves for a folder. */
const publishedUrls = (folder) => new Map([
  [`${REPOSITORY}/releases/download/${TAG}/SHA256SUMS`, folder.top],
  ...[...folder.modules].map(([file, bytes]) => [`${REPOSITORY}/releases/download/${TAG}/${file}`, bytes]),
  [`${REPOSITORY}/releases/download/${TAG}/${KIT}`, folder.kitZip],
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
/**
 * A module that describes itself as `profile`, standing in for the engine's
 * bindings where what it reports is the point. Loaded over the web variant's
 * bytes it answers `webProfile` (JavaScript only, by default) and its Python
 * entry points throw, as the real glue's do over that module. Its Python
 * packages behave as the base engine's do: none built in (unless
 * `torchBuiltIn`), torch listed once the loader has called addPythonPackage,
 * and an `import torch` project answering `answer` only then.
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
const PROFILE = { version: VERSION, features: ['safe-sandbox'], languages: ['javascript', 'python'], source: { sha: REV } };
/** The engine carrying a stand-in's bindings. */
const standingIn = (...args) => (bytes) => withGlue(bytes, standInGlue(...args));

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

/** Copies of an install, its variant and its package, for a case to tamper with. */
function copyInstall(t, pristine) {
  const copy = path.join(tempDir(t, 'zipp-check-'), 'wasm-zipp');
  fs.cpSync(pristine, copy, { recursive: true });
  fs.cpSync(variantDir(pristine), variantDir(copy), { recursive: true });
  fs.cpSync(packageDir(pristine), packageDir(copy), { recursive: true });
  return copy;
}

/** Each case's tamper makes checkEngine refuse with its pattern, and --check exit 1 with a refusal. */
function checkCases(t, pristine, cases) {
  for (const [what, tamper, pattern] of cases) {
    const copy = copyInstall(t, pristine);
    tamper(copy);
    assert.throws(() => checkEngine(copy), (error) => error instanceof ZippReleaseError && pattern.test(error.message), what);
    const run = cli(['--check'], { ZIPP_OUT: copy });
    assert.equal(run.status, 1, what);
    assert.doesNotMatch(run.stderr, /^\s+at /m, `${what}: a refusal, not a stack trace`);
  }
}

/** A file in an install replaced by `bytes`, and every record of its digest made to agree: what is left is the check the case is about. */
function replaceRecorded(dir, file, bytes, records) {
  fs.writeFileSync(file, bytes);
  for (const [folder, change] of records) editSource(folder, (s) => change(s, sha256(bytes)));
}

test('the fixture is built around a verified release install, with its web variant and torch package beside it', () => {
  assert.equal(checkEngine(ENGINE).release, TAG, 'packages/@softn/core/wasm-zipp checks (npm run fetch:zipp)');
  assert.deepEqual(fs.readdirSync(WEB_ENGINE).sort(), [...VARIANT_INSTALLED_FILES].sort(), 'packages/@softn/core/wasm-zipp-web is the variant install');
  assert.equal(variantDir(ENGINE), WEB_ENGINE, 'a sibling folder, never inside the install');
  assert.deepEqual(fs.readdirSync(TORCH_ENGINE).sort(), [...PACKAGE_INSTALLED_FILES].sort(), 'packages/@softn/core/wasm-zipp-torch is the package install');
  assert.equal(packageDir(ENGINE), TORCH_ENGINE, 'a sibling folder too');
  // Each module carries its record, and the engine and its variant their bindings.
  assert.deepEqual([metaOf(installed('zipp_wasm_bg.wasm')).variant, metaOf(installedWeb('zipp_wasm_bg.wasm')).variant, metaOf(installedTorch('zipp_torch.wasm')).variant], ['javascript-python-base', 'javascript', 'torch-package']);
  assert.ok(moduleGlue(installed('zipp_wasm_bg.wasm'), 'engine').equals(installed('zipp_wasm.js')));
  assert.equal(moduleGlue(installedTorch('zipp_torch.wasm'), 'torch'), null, 'the package carries no bindings');
});

test('a release that checks all the way down installs exactly the install set, and --check passes', (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, new RegExp(`Taking ${escaped(BUNDLE)}, ${escaped(WEB_BUNDLE)}, ${escaped(TORCH_BUNDLE)} and ${escaped(KIT)} from ZIPP`));
  assert.deepEqual(fs.readdirSync(out).sort(), [...INSTALLED_FILES].sort(), 'nothing else of the kit (zipp.mjs, README.md, docs/) is installed');
  const record = JSON.parse(fs.readFileSync(path.join(out, 'SOURCE.json'), 'utf8'));
  const engine = folder.modules.get(BUNDLE);
  assert.deepEqual(
    { release: record.release, version: record.version, revision: record.revision, build: record.build, bundle: record.bundle, bundleSha256: record.bundleSha256, sumsSha256: record.sumsSha256, variant: record.variant, languages: record.languages, stackBytes: record.stackBytes, sha256: record.sha256, glueSha256: record.glueSha256 },
    { release: TAG, version: VERSION, revision: REV, build: 'release', bundle: BUNDLE, bundleSha256: sha256(engine), sumsSha256: sha256(folder.top), variant: 'javascript-python-base', languages: ['javascript', 'python'], stackBytes: 16777216, sha256: sha256(engine), glueSha256: sha256(installed('zipp_wasm.js')) },
  );
  assert.ok(fs.readFileSync(path.join(out, 'RELEASE-SHA256SUMS')).equals(folder.top), 'ZIPP\'s SHA256SUMS, verbatim');
  assert.ok(fs.readFileSync(path.join(out, 'zipp_wasm_bg.wasm')).equals(engine), 'the module as published, its record and bindings included');
  assert.ok(fs.readFileSync(path.join(out, 'zipp_wasm.js')).equals(moduleGlue(engine, BUNDLE)), 'the glue is the module\'s own zipp.glue section, byte for byte');
  assert.ok(fs.readFileSync(path.join(out, 'zipp_wasm.d.ts')).equals(folder.kitFiles.get('zipp-engine.d.ts')), 'the kit\'s engine declarations');
  assert.ok(fs.readFileSync(path.join(out, 'LICENSE-APACHE')).equals(folder.kitFiles.get('LICENSE-APACHE')));
  assert.deepEqual(record.kit, {
    bundle: KIT,
    bundleSha256: sha256(folder.kitZip),
    files: { 'zipp_wasm.d.ts': { from: 'zipp-engine.d.ts', sha256: sha256(folder.kitFiles.get('zipp-engine.d.ts')) }, 'LICENSE-APACHE': { from: 'LICENSE-APACHE', sha256: sha256(folder.kitFiles.get('LICENSE-APACHE')) } },
  });
  // The release ships no notices, so the curated copy is installed and says so.
  assert.equal(record.notices.source, 'softn-curated');
  assert.ok(fs.readFileSync(path.join(out, 'THIRD_PARTY_LICENSES.txt')).equals(fs.readFileSync(CURATED_NOTICES)));
  assert.equal(record.notices.sha256, sha256(fs.readFileSync(CURATED_NOTICES)));
  const check = cli(['--check'], { ZIPP_OUT: out });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
  assert.match(check.stdout, /checks, with its web variant \([0-9a-f]{12}\) in .* and its torch package \([0-9a-f]{12}\) in /);
  assert.deepEqual(fs.readdirSync(path.dirname(out)).sort(), BOTH, 'the install, its variant and its package, and no staging folder');
  // `variants` and `packages` are the last two keys, as they always were.
  assert.deepEqual(Object.keys(record), ['repository', 'release', 'version', 'revision', 'build', 'bundle', 'bundleSha256', 'sumsSha256', 'variant', 'languages', 'stackBytes', 'license', 'artifact', 'sha256', 'glueSha256', 'kit', 'notices', 'variants', 'packages']);
});

test('a release from before 0.0.26, published as zip bundles, is refused before anything is read', (t) => {
  const folder = releaseFolder(t);
  refused(install(t, folder, { args: ['v0.0.25'] }), /^fetch-zipp-release: ZIPP v0\.0\.25 was published as zip bundles, which this script no longer reads; Softn installs v0\.0\.26 or later/);
});

test('the engine\'s record must name the release, the javascript-python-base engine, both languages, a full commit and the bindings it carries', (t) => {
  const meta = (change) => ({ engine: (b) => withMeta(b, change) });
  const prefix = `${escaped(BUNDLE)} is not the ZIPP ${escaped(TAG)} javascript-python-base engine:\\n {2}- `;
  refused(install(t, releaseFolder(t, meta((m) => void (m.version = '9.9.9')))), new RegExp(`${prefix}zipp\\.meta says version 9\\.9\\.9, not ${escaped(VERSION)}$`, 'm'));
  refused(install(t, releaseFolder(t, meta((m) => void (m.variant = 'javascript-python')))), /zipp\.meta variant is javascript-python, not javascript-python-base \(the engine is the javascript-python-base module/);
  refused(install(t, releaseFolder(t, meta((m) => void (m.languages = ['javascript'])))), /zipp\.meta languages are \["javascript"\], not \["javascript","python"\]/);
  refused(install(t, releaseFolder(t, meta((m) => void (m.commit = REV.slice(0, 8))))), /zipp\.meta commit "[0-9a-f]{8}" is not a full 40-hex commit/);
  refused(install(t, releaseFolder(t, meta((m) => void (m.format = 2)))), /zipp\.meta format is 2, not 1/);
  // Bindings the record does not name, and none at all.
  refused(install(t, releaseFolder(t, meta((m) => void (m.glueSha256 = E64)))), /its zipp\.glue section has sha256 [0-9a-f]{64}; zipp\.meta says glueSha256 e{64}/);
  refused(install(t, releaseFolder(t, { engine: (b) => withSections(b, { 'zipp.glue': null }) })), /zipp\.meta names bindings \(glueSha256 [0-9a-f]{64}\) the module does not carry$/m);
  refused(install(t, releaseFolder(t, { engine: (b) => withSections(withMeta(b, (m) => void delete m.glueSha256), { 'zipp.glue': null }) })), /- the module carries no zipp\.glue section, so no bindings$/m);
  // One record and one set of bindings, or the module is not one ZIPP published.
  refused(install(t, releaseFolder(t, { engine: (b) => withSections(b, { 'zipp.meta': null }) })), new RegExp(`${escaped(BUNDLE)} carries 0 zipp\\.meta records, not one`));
  refused(install(t, releaseFolder(t, { engine: (b) => Buffer.concat([b, withSections(Buffer.from('0061736d01000000', 'hex'), { 'zipp.meta': JSON.stringify(metaOf(b)) }).subarray(8)]) })), /carries 2 zipp\.meta records, not one/);
  refused(install(t, releaseFolder(t, { engine: (b) => withSections(b, { 'zipp.meta': '{"format":' }) })), /zipp\.meta record is not a JSON object/);
  refused(install(t, releaseFolder(t, { engine: (b) => Buffer.concat([b, withSections(Buffer.from('0061736d01000000', 'hex'), { 'zipp.glue': installed('zipp_wasm.js') }).subarray(8)]) })), /carries 2 zipp\.glue sections, not one/);
});

test('the JavaScript-only module is refused as the engine by what its record and its stack say, whatever the file is called', (t) => {
  refused(install(t, releaseFolder(t, { engine: () => installedWeb('zipp_wasm_bg.wasm') })), /zipp\.meta variant is javascript, not javascript-python-base[^]*zipp\.meta languages are \["javascript"\][^]*its stack is 1048576 bytes, not 16777216/);
  // The stack alone: the engine's record, its stack pointer starting at 1 MiB.
  // 16777216 and 1048576 are both four bytes of signed LEB128 (80 80 80 08, 80 80 c0 00).
  const smallStack = (b) => {
    const copy = Buffer.from(b);
    const at = copy.indexOf(Buffer.from([0x7f, 0x01, 0x41, 0x80, 0x80, 0x80, 0x08]));
    assert.ok(at > 0, 'the stack pointer global is there to rewrite');
    Buffer.from([0x7f, 0x01, 0x41, 0x80, 0x80, 0xc0, 0x00]).copy(copy, at);
    return copy;
  };
  assert.equal(wasmStackBytes(smallStack(installed('zipp_wasm_bg.wasm'))), 1048576, 'the global the reader reads is the one rewritten');
  refused(install(t, releaseFolder(t, { engine: smallStack })), /- its stack is 1048576 bytes, not 16777216$/m);
});

test('the module has to describe itself as the release under its own bindings: its version, both languages, the safe sandbox, its commit', (t) => {
  const saying = (change) => releaseFolder(t, { engine: standingIn({ ...PROFILE, ...change }) });
  // The stand-in is taken when it says the right things, so each refusal below is about the one thing it changes.
  const accepted = install(t, saying({}));
  assert.equal(accepted.run.status, 0, accepted.run.stderr);
  refused(install(t, saying({ version: '9.9.9' })), /zippProfile\(\) version is 9\.9\.9, not /);
  refused(install(t, saying({ languages: ['javascript'] })), /zippProfile\(\) languages are \["javascript"\], not \["javascript","python"\]/);
  refused(install(t, saying({ features: ['meter-only'] })), /zippProfile\(\) lacks the safe-sandbox feature/);
  refused(install(t, saying({ source: { sha: 'b'.repeat(40) } })), new RegExp(`zippProfile\\(\\) source\\.sha is b{40}, not the zipp\\.meta commit ${REV}`));
  // Bindings that do not load at all.
  refused(install(t, releaseFolder(t, { engine: (b) => withGlue(b, Buffer.from('export function initSync() { throw new Error("no"); }\n')) })), new RegExp(`the ${escaped(BUNDLE)} engine does not load under its own bindings: no`));
});

test('a module that disagrees with the release\'s SHA256SUMS is refused, even one carrying the very same record and bindings', async (t) => {
  const folder = releaseFolder(t);
  const other = withSections(folder.modules.get(BUNDLE), { name: 'another build' });
  assert.deepEqual(metaOf(other), metaOf(folder.modules.get(BUNDLE)));
  fs.writeFileSync(path.join(folder.dir, BUNDLE), other);
  refused(install(t, folder), new RegExp(`${escaped(BUNDLE)} has sha256 [0-9a-f]{64}; the ${escaped(TAG)} SHA256SUMS says [0-9a-f]{64}`));
  // verifyRelease holds the module to the SHA256SUMS itself, whoever loaded it.
  await assert.rejects(verifyRelease({ release: TAG, sums: folder.top, wasm: other, kit: folder.kitZip }), (error) => error instanceof ZippReleaseError && new RegExp(`^${escaped(BUNDLE)} does not match the ${escaped(TAG)} SHA256SUMS$`).test(error.message));
  await assert.rejects(verifyRelease({ release: 'v0.0.25', sums: folder.top, wasm: other, kit: folder.kitZip }), /was published as zip bundles/);
});

test('the kit must be the release\'s: SHA256SUMS, its own SHA256SUMS, the release and the engine\'s commit, every module\'s digest', (t) => {
  refused(install(t, releaseFolder(t, { without: [KIT] })), new RegExp(`holds no ${escaped(KIT)}`));
  refused(install(t, releaseFolder(t, { sums: (s) => s.split('\n').filter((line) => !line.endsWith(`  ${KIT}`)).join('\n') })), new RegExp(`SHA256SUMS in .* does not list ${escaped(KIT)}`));
  // Files that disagree with the kit's SHA256SUMS, or that it does not list or carry.
  refused(install(t, releaseFolder(t, { tamperKit: (files) => files.set('zipp-engine.d.ts', Buffer.concat([files.get('zipp-engine.d.ts'), Buffer.from(' ')])) })), new RegExp(`zipp-engine\\.d\\.ts in ${escaped(KIT)} does not match the kit's SHA256SUMS`));
  refused(install(t, releaseFolder(t, { kitSums: (s) => s.split('\n').filter((line) => !line.endsWith('  LICENSE-APACHE')).join('\n') })), new RegExp(`LICENSE-APACHE in ${escaped(KIT)} is not listed in the kit's SHA256SUMS`));
  refused(install(t, releaseFolder(t, { kit: (files) => files.delete('zipp-engine.d.ts') })), new RegExp(`${escaped(KIT)} has no zipp-engine\\.d\\.ts`));
  refused(install(t, releaseFolder(t, { tamperKit: (files) => files.delete('README.md') })), new RegExp(`${escaped(KIT)} lists README\\.md in its SHA256SUMS but does not carry it`));
  refused(install(t, releaseFolder(t, { kit: (files) => files.set('THIRD_PARTY_LICENSES.txt', Buffer.from('n\n')), kitSums: (s) => s.split('\n').filter((line) => !line.endsWith('  THIRD_PARTY_LICENSES.txt')).join('\n') })), /THIRD_PARTY_LICENSES\.txt in .* is not listed in the kit's SHA256SUMS/);
  // What it says of the release.
  const kitPrefix = `${escaped(KIT)} is not the ZIPP ${escaped(TAG)} embed kit of commit ${REV}:\\n {2}- `;
  const buildInfo = (key, value) => ({ kit: (files) => files.set('BUILD-INFO.txt', Buffer.from(files.get('BUILD-INFO.txt').toString('utf8').replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`))) });
  refused(install(t, releaseFolder(t, buildInfo('commit', E40))), new RegExp(`${kitPrefix}BUILD-INFO\\.txt commit e{40} is not the engine's commit ${REV}$`, 'm'));
  refused(install(t, releaseFolder(t, buildInfo('version', '9.9.9'))), /BUILD-INFO\.txt says version 9\.9\.9, not /);
  const modules = (change) => ({ kit: (files) => {
    const record = JSON.parse(files.get('modules.json').toString('utf8'));
    change(record);
    files.set('modules.json', Buffer.from(JSON.stringify(record)));
  } });
  refused(install(t, releaseFolder(t, modules((m) => void (m.modules.find((x) => x.file === BUNDLE).sha256 = E64)))), new RegExp(`modules\\.json gives ${escaped(BUNDLE)} sha256 e{64}; the ${escaped(TAG)} SHA256SUMS says [0-9a-f]{64}`));
  refused(install(t, releaseFolder(t, modules((m) => void (m.modules = m.modules.filter((x) => x.file !== TORCH_BUNDLE))))), new RegExp(`modules\\.json does not list ${escaped(TORCH_BUNDLE)}`));
  refused(install(t, releaseFolder(t, modules((m) => void (m.commit = E40)))), /modules\.json commit e{40} is not the engine's commit/);
  refused(install(t, releaseFolder(t, modules((m) => void (m.version = '9.9.9')))), /modules\.json says version 9\.9\.9/);
  refused(install(t, releaseFolder(t, { kit: (files) => files.set('modules.json', Buffer.from('{')) })), /modules\.json is not JSON/);
  // A kit whose bytes are not the ones listed, however good its contents.
  const folder = releaseFolder(t);
  fs.copyFileSync(path.join(releaseFolder(t, { kit: (files) => files.set('README.md', Buffer.from('# again\n')) }).dir, KIT), path.join(folder.dir, KIT));
  refused(install(t, folder), new RegExp(`${escaped(KIT)} has sha256 [0-9a-f]{64}; the ${escaped(TAG)} SHA256SUMS says [0-9a-f]{64}`));
});

test('notices the kit ships itself are taken from it and recorded as the release\'s', async (t) => {
  const folder = releaseFolder(t, { kit: (files) => files.set('THIRD_PARTY_LICENSES.txt', Buffer.from('ZIPP\'s own notices\n')) });
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.doesNotMatch(run.stdout, /the curated copy/);
  const record = JSON.parse(fs.readFileSync(path.join(out, 'SOURCE.json'), 'utf8'));
  assert.deepEqual(record.notices, { file: 'THIRD_PARTY_LICENSES.txt', source: 'zipp-release', sha256: sha256(Buffer.from('ZIPP\'s own notices\n')) });
  assert.equal(cli(['--check'], { ZIPP_OUT: out }).status, 0);
  // Online, they are the kit's as published.
  const published = publishedUrls(folder);
  const fetch = async (url) => (published.has(url) ? new Response(published.get(url)) : new Response('', { status: 404 }));
  assert.equal((await checkEngineOnline(out, { fetch })).release, TAG);
  fs.appendFileSync(path.join(out, 'THIRD_PARTY_LICENSES.txt'), 'more\n');
  editSource(out, (s) => void (s.notices.sha256 = sha256(fs.readFileSync(path.join(out, 'THIRD_PARTY_LICENSES.txt')))));
  assert.equal(checkEngine(out).release, TAG, 'recorded as edited, it checks offline');
  await assert.rejects(checkEngineOnline(out, { fetch }), new RegExp(`THIRD_PARTY_LICENSES\\.txt is not THIRD_PARTY_LICENSES\\.txt in the published ${escaped(KIT)}`));
});

test('ZIPP_SUMS_SHA256 pins the release\'s SHA256SUMS', (t) => {
  refused(install(t, releaseFolder(t), { env: { ZIPP_SUMS_SHA256: '0'.repeat(64) } }), /ZIPP_SUMS_SHA256 says 0{64}/);
  const folder = releaseFolder(t);
  assert.equal(install(t, folder, { env: { ZIPP_SUMS_SHA256: sha256(folder.top) } }).run.status, 0);
});

test('a folder without the engine is refused', (t) => {
  refused(install(t, releaseFolder(t, { without: [BUNDLE] })), new RegExp(`holds no ${escaped(BUNDLE)}`));
  refused(install(t, releaseFolder(t, { sums: (s) => s.split('\n').filter((line) => !line.endsWith(`  ${BUNDLE}`)).join('\n') })), new RegExp(`SHA256SUMS in .* does not list ${escaped(BUNDLE)}`));
});

test('an install replaces the whole folder, the variant\'s and the package\'s, so a stale file does not survive', (t) => {
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  fs.mkdirSync(out);
  // What a 0.0.25 install held that 0.0.26's does not.
  for (const name of ['BUILD-INFO.txt', 'PROFILE.json', 'SHA256SUMS', 'zipp_wasm_bg.wasm.d.ts']) fs.writeFileSync(path.join(out, name), 'stale');
  fs.writeFileSync(path.join(out, 'SOURCE.json'), '{"build":"release"}');
  fs.mkdirSync(variantDir(out));
  fs.writeFileSync(path.join(variantDir(out), 'zipp_wasm.js'), 'a glue a variant never ships');
  fs.mkdirSync(packageDir(out));
  fs.writeFileSync(path.join(packageDir(out), 'BUILD-INFO.txt'), 'stale');
  const { run } = install(t, releaseFolder(t), { out });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(fs.readdirSync(out).sort(), [...INSTALLED_FILES].sort());
  assert.deepEqual(fs.readdirSync(variantDir(out)).sort(), [...VARIANT_INSTALLED_FILES].sort());
  assert.deepEqual(fs.readdirSync(packageDir(out)).sort(), [...PACKAGE_INSTALLED_FILES].sort());
  assert.deepEqual(fs.readdirSync(path.dirname(out)).sort(), BOTH, 'neither the stage nor the previous install is left behind');
});

test('--check holds an install to everything its SOURCE.json records, one invariant at a time', (t) => {
  const { out: pristine, run } = install(t, releaseFolder(t));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(checkEngine(pristine).release, TAG);
  const cases = [
    ['ZIPP\'s SHA256SUMS edited', (dir) => fs.appendFileSync(path.join(dir, 'RELEASE-SHA256SUMS'), '\n'), /RELEASE-SHA256SUMS has sha256 [0-9a-f]{64}, not the recorded [0-9a-f]{64}/],
    ['a recorded SHA256SUMS digest', (dir) => editSource(dir, (s) => void (s.sumsSha256 = E64)), /RELEASE-SHA256SUMS has sha256 [0-9a-f]{64}, not the recorded e{64}/],
    ['a recorded bundle digest', (dir) => editSource(dir, (s) => void (s.bundleSha256 = E64)), new RegExp(`RELEASE-SHA256SUMS does not list ${escaped(BUNDLE)} with the recorded e{64}`)],
    ['a recorded bundle digest that is not the installed module\'s', (dir) => editSource(dir, (s) => void (s.bundleSha256 = E64)), /SOURCE\.json sha256 [0-9a-f]{64} is not the bundleSha256 e{64}; the engine is installed as published/],
    ['a recorded revision', (dir) => editSource(dir, (s) => void (s.revision = E40)), /zipp_wasm_bg\.wasm: zipp\.meta commit [0-9a-f]{40} is not e{40}/],
    ['a recorded stack', (dir) => editSource(dir, (s) => void (s.stackBytes = 1048576)), /SOURCE\.json records javascript-python-base \["javascript","python"\] with a 1048576-byte stack, not the javascript-python-base engine/],
    ['a recorded engine digest', (dir) => editSource(dir, (s) => void (s.sha256 = E64)), /zipp_wasm_bg\.wasm is not the recorded e{64}/],
    ['a recorded glue digest', (dir) => editSource(dir, (s) => void (s.glueSha256 = E64)), /zipp_wasm\.js is not the recorded e{64}/],
    ['a recorded kit digest', (dir) => editSource(dir, (s) => void (s.kit.bundleSha256 = E64)), new RegExp(`RELEASE-SHA256SUMS does not list ${escaped(KIT)} with the recorded e{64}`)],
    ['a recorded kit file digest', (dir) => editSource(dir, (s) => void (s.kit.files['zipp_wasm.d.ts'].sha256 = E64)), /zipp_wasm\.d\.ts is not the kit's zipp-engine\.d\.ts recorded \(e{64}\)/],
    ['a kit file of unknown origin', (dir) => editSource(dir, (s) => void (s.kit.files['LICENSE-APACHE'].from = 'LICENSE')), /SOURCE\.json kit\.files records LICENSE-APACHE as .*, not the kit's LICENSE-APACHE with its sha256/],
    ['no kit recorded', (dir) => editSource(dir, (s) => void delete s.kit), /SOURCE\.json kit undefined is not the release's embed kit/],
    ['a recorded notices digest', (dir) => editSource(dir, (s) => void (s.notices.sha256 = E64)), /THIRD_PARTY_LICENSES\.txt is not the recorded e{64}/],
    ['notices of unknown origin', (dir) => editSource(dir, (s) => void (s.notices.source = 'elsewhere')), /SOURCE\.json notices .* are not recorded/],
    ['another repository', (dir) => editSource(dir, (s) => void (s.repository = 'https://example.com/zipp')), /SOURCE\.json repository is https:\/\/example\.com\/zipp/],
    ['a release that is not the version', (dir) => editSource(dir, (s) => void (s.release = 'v9.9.9')), /SOURCE\.json release v9\.9\.9 and version \S+ do not agree/],
    ['the javascript module recorded', (dir) => editSource(dir, (s) => void (s.bundle = WEB_BUNDLE)), new RegExp(`SOURCE\\.json bundle ${escaped(WEB_BUNDLE)} is not the javascript-python-base engine`)],
    ['another engine, recorded everywhere', (dir) => replaceRecorded(dir, path.join(dir, 'zipp_wasm_bg.wasm'), flipCode(installed('zipp_wasm_bg.wasm')), [[dir, (s, digest) => {
      s.sha256 = digest;
      s.bundleSha256 = digest;
    }]]), new RegExp(`RELEASE-SHA256SUMS does not list ${escaped(BUNDLE)} with the recorded [0-9a-f]{64}`)],
    ['another engine', (dir) => fs.writeFileSync(path.join(dir, 'zipp_wasm_bg.wasm'), flipCode(installed('zipp_wasm_bg.wasm'))), /zipp_wasm_bg\.wasm is not the recorded [0-9a-f]{64}/],
    ['an engine whose record names another commit', (dir) => fs.writeFileSync(path.join(dir, 'zipp_wasm_bg.wasm'), withMeta(installed('zipp_wasm_bg.wasm'), (m) => void (m.commit = E40))), /zipp_wasm_bg\.wasm: zipp\.meta commit e{40} is not [0-9a-f]{40}/],
    ['other glue, recorded', (dir) => {
      fs.appendFileSync(path.join(dir, 'zipp_wasm.js'), '\n');
      editSource(dir, (s) => void (s.glueSha256 = sha256(fs.readFileSync(path.join(dir, 'zipp_wasm.js')))));
    }, /zipp_wasm\.js is not the bindings zipp_wasm_bg\.wasm carries \(its zipp\.glue section\)/],
    ['edited declarations', (dir) => fs.appendFileSync(path.join(dir, 'zipp_wasm.d.ts'), '\n'), /zipp_wasm\.d\.ts is not the kit's zipp-engine\.d\.ts recorded/],
    ['edited notices, recorded', (dir) => {
      fs.appendFileSync(path.join(dir, 'THIRD_PARTY_LICENSES.txt'), 'and one more\n');
      editSource(dir, (s) => void (s.notices.sha256 = sha256(fs.readFileSync(path.join(dir, 'THIRD_PARTY_LICENSES.txt')))));
    }, /THIRD_PARTY_LICENSES\.txt is not the curated copy in /],
    ['a file a 0.0.25 install had', (dir) => fs.writeFileSync(path.join(dir, 'BUILD-INFO.txt'), 'version=0.0.25\n'), /BUILD-INFO\.txt is not part of an install/],
    ['a stray file', (dir) => fs.writeFileSync(path.join(dir, '.DS_Store'), ''), /\.DS_Store is not part of an install/],
    ['a folder', (dir) => fs.mkdirSync(path.join(dir, 'docs')), /docs is not a plain file/],
    ['a missing file', (dir) => fs.rmSync(path.join(dir, 'LICENSE-APACHE')), /LICENSE-APACHE is missing/],
  ];
  checkCases(t, pristine, cases);
  // The curated copy the install is held to is the one in zipp-notices/, not whatever the install says.
  const otherCurated = path.join(tempDir(t, 'zipp-curated-'), 'THIRD_PARTY_LICENSES.txt');
  fs.writeFileSync(otherCurated, 'a different curated copy\n');
  assert.throws(() => checkEngine(pristine, { curatedNotices: otherCurated }), /THIRD_PARTY_LICENSES\.txt is not the curated copy in /);
  // An install of 0.0.25's layout: what --ensure finds the first time 0.0.26 is declared.
  const old = path.join(tempDir(t, 'zipp-old-'), 'wasm-zipp');
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, 'SOURCE.json'), JSON.stringify({ build: 'release', release: 'v0.0.25', version: '0.0.25', bundle: 'zipp-wasm-0.0.25-web-python-base.zip' }));
  assert.throws(() => checkEngine(old), (error) => error instanceof ZippReleaseError && /SOURCE\.json bundle zipp-wasm-0\.0\.25-web-python-base\.zip is not the javascript-python-base engine \(zipp-0\.0\.25-javascript-python-base\.wasm\)/.test(error.message));
});

test('the javascript module installs beside the engine as a verified variant, recorded on both sides', (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /web variant sha256 [0-9a-f]{64} into /);
  const web = variantDir(out);
  assert.equal(web, path.join(path.dirname(out), 'wasm-zipp-web'), 'a sibling, never inside wasm-zipp/');
  assert.deepEqual(fs.readdirSync(web).sort(), [...VARIANT_INSTALLED_FILES].sort(), 'the module and SOURCE.json; no glue');
  const module = folder.modules.get(WEB_BUNDLE);
  assert.ok(fs.readFileSync(path.join(web, 'zipp_wasm_bg.wasm')).equals(module), 'the module as published');
  assert.notEqual(sha256(module), source.sha256, 'another build');
  // The primary record gains exactly the eight-key variants.web FormLogic compares by key.
  const record = JSON.parse(fs.readFileSync(path.join(out, 'SOURCE.json'), 'utf8'));
  assert.deepEqual(record.variants, {
    web: { bundle: WEB_BUNDLE, bundleSha256: sha256(module), sha256: sha256(module), glueSha256: sha256(moduleGlue(module, WEB_BUNDLE)), variant: 'javascript', languages: ['javascript'], stackBytes: 1048576, commit: REV },
  });
  assert.notEqual(record.variants.web.glueSha256, record.glueSha256, 'its own bindings, recorded and not shipped');
  // The variant's own record: the same eight fields, and the release and the engine it runs under.
  const variant = JSON.parse(fs.readFileSync(path.join(web, 'SOURCE.json'), 'utf8'));
  for (const [k, v] of Object.entries(record.variants.web)) assert.deepEqual(variant[k], v, `variant SOURCE.json ${k}`);
  assert.deepEqual(
    { repository: variant.repository, release: variant.release, version: variant.version, revision: variant.revision, build: variant.build, sumsSha256: variant.sumsSha256, artifact: variant.artifact, license: variant.license, primary: variant.primary },
    { repository: REPOSITORY, release: TAG, version: VERSION, revision: REV, build: 'release', sumsSha256: sha256(folder.top), artifact: 'zipp_wasm_bg.wasm', license: 'Apache-2.0', primary: { bundle: BUNDLE, sha256: source.sha256, glueSha256: source.glueSha256 } },
  );
  assert.equal(WEB_VARIANT.id, 'web');
});

test('the javascript module, and its line in the release\'s SHA256SUMS, are required: one release, all of it, or nothing', (t) => {
  refused(install(t, releaseFolder(t, { without: [WEB_BUNDLE] })), new RegExp(`holds no ${escaped(WEB_BUNDLE)}`));
  refused(install(t, releaseFolder(t, { sums: (s) => s.split('\n').filter((line) => !line.endsWith(`  ${WEB_BUNDLE}`)).join('\n') })), new RegExp(`SHA256SUMS in .* does not list ${escaped(WEB_BUNDLE)}`));
  // A module whose bytes are not the ones listed, however good its record.
  const folder = releaseFolder(t);
  fs.writeFileSync(path.join(folder.dir, WEB_BUNDLE), withSections(folder.modules.get(WEB_BUNDLE), { name: 'another build' }));
  refused(install(t, folder), new RegExp(`${escaped(WEB_BUNDLE)} has sha256 [0-9a-f]{64}; the ${escaped(TAG)} SHA256SUMS says [0-9a-f]{64}`));
});

test('the variant is the same source built again, and its record and stack are the javascript engine\'s', (t) => {
  const meta = (change) => ({ web: (b) => withMeta(b, change) });
  // Refused for the commit itself, before anything else is asked.
  refused(install(t, releaseFolder(t, meta((m) => void (m.commit = 'b'.repeat(40))))), new RegExp(`${escaped(WEB_BUNDLE)} is built from commit b{40}, not ${REV} like ${escaped(BUNDLE)}; a variant ships only from the release's own commit`));
  const prefix = `${escaped(WEB_BUNDLE)} is not the ZIPP ${escaped(TAG)} javascript engine:\\n {2}- `;
  refused(install(t, releaseFolder(t, meta((m) => void (m.variant = 'javascript-lite')))), new RegExp(`${prefix}zipp\\.meta variant is javascript-lite, not javascript$`, 'm'));
  refused(install(t, releaseFolder(t, meta((m) => void (m.languages = ['javascript', 'python'])))), /zipp\.meta languages are \["javascript","python"\], not \["javascript"\]/);
  refused(install(t, releaseFolder(t, meta((m) => void (m.version = '9.9.9')))), /zipp\.meta says version 9\.9\.9, not /);
  refused(install(t, releaseFolder(t, meta((m) => void (m.glueSha256 = E64)))), /its zipp\.glue section has sha256 [0-9a-f]{64}; zipp\.meta says glueSha256 e{64}/);
  // The engine module put in its place says it is the engine, and has the big stack.
  refused(install(t, releaseFolder(t, { web: () => installed('zipp_wasm_bg.wasm') })), /zipp\.meta variant is javascript-python-base, not javascript[^]*its stack is 16777216 bytes, not 1048576/);
});

test('the web module may ask the host for nothing the engine does not, and export nothing the engine lacks', async (t) => {
  const engine = installed('zipp_wasm_bg.wasm');
  const web = installedWeb('zipp_wasm_bg.wasm');
  assert.deepEqual(variantModuleProblems(web, engine), [], 'the installed pair fits');
  const extraImport = withExtraImport(web);
  assert.deepEqual(wasmImportNames(extraImport), [...wasmImportNames(web), './zipp_wasm_bg.js.__wbg_extra_0000:function'], 'the splice added one import');
  assert.deepEqual(variantModuleProblems(extraImport, engine, { bundle: 'web.wasm', primary: 'wp.wasm' }), ['web.wasm imports ./zipp_wasm_bg.js.__wbg_extra_0000:function, which wp.wasm does not, so the engine\'s glue cannot be known to bind it']);
  // Importing less is not a problem: instantiation reads only what a module
  // declares, and the glue's extra import (the torch kernel hook) goes unread.
  assert.deepEqual(variantModuleProblems(web, withExtraImport(engine)), [], 'a variant may import less than the engine');
  const extraExport = withExtraExport(web);
  assert.deepEqual(wasmExportNames(extraExport), [...wasmExportNames(web), 'engine_extra'], 'the splice added one export');
  assert.deepEqual(variantModuleProblems(extraExport, engine, { bundle: 'web.wasm', primary: 'wp.wasm' }), ['web.wasm exports engine_extra, which wp.wasm does not; a variant runs under the engine\'s glue and may export nothing that engine lacks']);
  // The primary module as its own variant fits; a module that is not the engine at all does not.
  assert.deepEqual(variantModuleProblems(engine, engine), []);
  assert.match(variantModuleProblems(Buffer.from('not wasm'), engine)[0], /does not export what a ZIPP engine exports \(not a WebAssembly module\)/);
  // Through the install, each refused before the module is ever loaded — a spliced module may not instantiate.
  refused(install(t, releaseFolder(t, { web: withExtraImport })), new RegExp(`cannot run under the engine's glue:\\n {2}- ${escaped(WEB_BUNDLE)} imports \\./zipp_wasm_bg\\.js\\.__wbg_extra_0000:function, which ${escaped(BUNDLE)} does not`));
  refused(install(t, releaseFolder(t, { web: withExtraExport })), new RegExp(`${escaped(WEB_BUNDLE)} exports engine_extra, which ${escaped(BUNDLE)} does not`));
  // verifyVariant holds the module to the SHA256SUMS itself, whoever loaded it, and to the primary it is given.
  const folder = releaseFolder(t);
  const primary = await verifyRelease({ release: TAG, sums: folder.top, wasm: folder.modules.get(BUNDLE), kit: folder.kitZip });
  const variant = await verifyVariant({ release: TAG, sums: folder.top, wasm: folder.modules.get(WEB_BUNDLE), primary });
  assert.equal(variant.record.sha256, sha256(web));
  assert.deepEqual([...variant.files.keys()].sort(), [...VARIANT_INSTALLED_FILES].sort());
  await assert.rejects(verifyVariant({ release: TAG, sums: folder.top, wasm: folder.modules.get(BUNDLE), primary }), (error) => error instanceof ZippReleaseError && new RegExp(`^${escaped(WEB_BUNDLE)} does not match the ${escaped(TAG)} SHA256SUMS$`).test(error.message));
  await assert.rejects(verifyVariant({ release: TAG, sums: folder.top, wasm: folder.modules.get(WEB_BUNDLE), primary: { ...primary, source: { ...primary.source, revision: 'd'.repeat(40) } } }), /is built from commit [0-9a-f]{40}, not d{40}/);
});

test('loaded under the engine\'s glue, the web module must say JavaScript alone and refuse Python', (t) => {
  const saying = (webProfile) => releaseFolder(t, { engine: standingIn(PROFILE, webProfile) });
  // The stand-in is taken when it says the right things of both modules.
  const accepted = install(t, saying(undefined));
  assert.equal(accepted.run.status, 0, accepted.run.stderr);
  refused(install(t, saying({ ...PROFILE })), new RegExp(`the ${escaped(WEB_BUNDLE)} engine does not describe itself as the ZIPP ${escaped(TAG)} javascript engine:\\n {2}- zippProfile\\(\\) languages are \\["javascript","python"\\], not \\["javascript"\\]`));
  refused(install(t, saying({ ...PROFILE, languages: ['javascript'], version: '9.9.9' })), /zippProfile\(\) version is 9\.9\.9, not /);
  refused(install(t, saying({ ...PROFILE, languages: ['javascript'], features: [] })), /zippProfile\(\) lacks the safe-sandbox feature/);
  refused(install(t, saying({ ...PROFILE, languages: ['javascript'], source: { sha: E40 } })), /zippProfile\(\) source\.sha is e{40}, not the zipp\.meta commit/);
  // A glue whose Python entry points run over the web module: not the JavaScript-only build, whatever the profile says.
  const permissive = Buffer.from(standInGlue(PROFILE).toString('utf8').replace('if (language === "python" && web) throw new Error("Python support is not built");', '').replace('if (web) throw new TypeError("not a function");', ''));
  refused(install(t, releaseFolder(t, { engine: (b) => withGlue(b, permissive) })), new RegExp(`- initSource\\(source, "python"\\) runs on the ${escaped(WEB_BUNDLE)} engine, so it is not the JavaScript-only build\\n {2}- pythonHas\\(name\\) runs on the ${escaped(WEB_BUNDLE)} engine`));
});

test('--check holds the variant install to the primary\'s record, its own, the release\'s SHA256SUMS and the engine, one invariant at a time', (t) => {
  const { out: pristine, run } = install(t, releaseFolder(t));
  assert.equal(run.status, 0, run.stderr);
  const webOf = (dir) => variantDir(dir);
  const webModule = (dir) => path.join(webOf(dir), 'zipp_wasm_bg.wasm');
  const editWebSource = (dir, change) => editSource(webOf(dir), change);
  /** The variant's module replaced, and its digest recorded on both sides. */
  const replaced = (bytes) => (dir) => replaceRecorded(dir, webModule(dir), bytes, [[webOf(dir), (s, d) => void (s.sha256 = d)], [dir, (s, d) => void (s.variants.web.sha256 = d)]]);
  const cases = [
    ['a tampered variant module', (dir) => fs.writeFileSync(webModule(dir), flipCode(installedWeb('zipp_wasm_bg.wasm'))), /^the ZIPP web variant install in .* does not check .*:\n {2}- zipp_wasm_bg\.wasm is not the recorded [0-9a-f]{64}$/],
    ['a tampered variant module, re-recorded on its own side', (dir) => {
      const bytes = flipCode(installedWeb('zipp_wasm_bg.wasm'));
      fs.writeFileSync(webModule(dir), bytes);
      editWebSource(dir, (s) => void (s.sha256 = sha256(bytes)));
    }, /SOURCE\.json sha256 is "[0-9a-f]{64}"; the primary install's variants\.web records "[0-9a-f]{64}"/],
    // Every record agrees on the digest, and the check still refuses.
    ['a tampered variant module, re-recorded on both sides', replaced(flipCode(installedWeb('zipp_wasm_bg.wasm'))), /^the ZIPP web variant install in .* does not check .*:\n {2}- SOURCE\.json sha256 [0-9a-f]{64} is not the bundleSha256 [0-9a-f]{64}; the variant is installed as published$/],
    ['a tampered variant module, re-recorded as published too', (dir) => {
      replaced(flipCode(installedWeb('zipp_wasm_bg.wasm')))(dir);
      const digest = sha256(fs.readFileSync(webModule(dir)));
      editSource(dir, (s) => void (s.variants.web.bundleSha256 = digest));
      editWebSource(dir, (s) => void (s.bundleSha256 = digest));
    }, new RegExp(`^the ZIPP web variant install in .* does not check .*:\\n {2}- RELEASE-SHA256SUMS does not list ${escaped(WEB_BUNDLE)} with the recorded [0-9a-f]{64}$`)],
    ['the engine module in the variant\'s place, re-recorded on both sides', replaced(installed('zipp_wasm_bg.wasm')), /zipp_wasm_bg\.wasm is the primary install's module itself \([0-9a-f]{12}\), not a variant of it/],
    ['a variant module exporting what the engine does not', replaced(withExtraExport(installedWeb('zipp_wasm_bg.wasm'))), /exports engine_extra, which .* does not; a variant runs under the engine's glue/],
    ['a variant module importing what the engine does not', replaced(withExtraImport(installedWeb('zipp_wasm_bg.wasm'))), /imports \.\/zipp_wasm_bg\.js\.__wbg_extra_0000:function, which .* does not/],
    ['a variant module whose record names another commit', replaced(withMeta(installedWeb('zipp_wasm_bg.wasm'), (m) => void (m.commit = E40))), /zipp_wasm_bg\.wasm: zipp\.meta commit e{40} is not [0-9a-f]{40}/],
    ['a variant module carrying other bindings, its record agreeing', replaced(withGlue(installedWeb('zipp_wasm_bg.wasm'), Buffer.from('export {};\n'))), /zipp_wasm_bg\.wasm carries bindings [0-9a-f]{64}, not the recorded [0-9a-f]{64}/],
    ['a primary record without the variant', (dir) => editSource(dir, (s) => void delete s.variants), /^the ZIPP install in .* does not check .*:\n {2}- SOURCE\.json records no web variant of the engine \(variants\.web\)/],
    ['a primary record whose variant digest disagrees', (dir) => editSource(dir, (s) => void (s.variants.web.sha256 = E64)), /SOURCE\.json sha256 is "[0-9a-f]{64}"; the primary install's variants\.web records "e{64}"/],
    ['a primary record whose variant commit disagrees', (dir) => editSource(dir, (s) => void (s.variants.web.commit = E40)), /SOURCE\.json commit is "[0-9a-f]{40}"; the primary install's variants\.web records "e{40}"/],
    ['a variant record of another commit, agreed on both sides', (dir) => {
      editSource(dir, (s) => void (s.variants.web.commit = E40));
      editWebSource(dir, (s) => void (s.commit = E40));
    }, /SOURCE\.json commit e{40} is not the primary install's revision [0-9a-f]{40}; a variant is the same source built again/],
    ['a variant record from another SHA256SUMS', (dir) => editWebSource(dir, (s) => void (s.sumsSha256 = E64)), /SOURCE\.json sumsSha256 e{64} is not the primary install's/],
    ['a variant record of another engine', (dir) => editWebSource(dir, (s) => void (s.primary.sha256 = E64)), /SOURCE\.json primary \{.*\} is not the primary install/],
    ['a variant record recorded as a local build', (dir) => editWebSource(dir, (s) => void (s.build = 'local')), /SOURCE\.json build is 'local'/],
    ['a variant record naming the engine', (dir) => {
      editSource(dir, (s) => void (s.variants.web.bundle = BUNDLE));
      editWebSource(dir, (s) => void (s.bundle = BUNDLE));
    }, new RegExp(`SOURCE\\.json bundle ${escaped(BUNDLE)} is not the javascript engine`)],
    ['a variant digest the release\'s SHA256SUMS does not carry', (dir) => {
      editSource(dir, (s) => void (s.variants.web.bundleSha256 = E64));
      editWebSource(dir, (s) => void (s.bundleSha256 = E64));
    }, new RegExp(`RELEASE-SHA256SUMS does not list ${escaped(WEB_BUNDLE)} with the recorded e{64}`)],
    ['a variant record of the big stack, agreed on both sides', (dir) => {
      editSource(dir, (s) => void (s.variants.web.stackBytes = 16777216));
      editWebSource(dir, (s) => void (s.stackBytes = 16777216));
    }, /SOURCE\.json records javascript \["javascript"\] with a 16777216-byte stack, not the javascript engine/],
    ['a glue in the variant folder', (dir) => fs.copyFileSync(path.join(dir, 'zipp_wasm.js'), path.join(webOf(dir), 'zipp_wasm.js')), /zipp_wasm\.js is not part of a variant install/],
    ['a missing variant module', (dir) => fs.rmSync(webModule(dir)), /zipp_wasm_bg\.wasm is missing/],
    ['no variant folder at all', (dir) => fs.rmSync(webOf(dir), { recursive: true }), /holds no ZIPP web variant install \(no SOURCE\.json\); run npm run fetch:zipp/],
  ];
  checkCases(t, pristine, cases);
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
  fs.appendFileSync(path.join(variantDir(out), 'zipp_wasm_bg.wasm'), Buffer.from([0]));
  const logs = [];
  assert.equal((await ensureEngine({ dir: out, fetch, releaseDir: folder.dir, log: (line) => logs.push(line) })).action, 'installed');
  assert.match(logs.join('\n'), /web variant install .* does not check/);
  assert.equal((await ensureEngine({ dir: out, fetch, log: quiet })).action, 'none');
  assert.deepEqual(calls, [], 'the folder was the source');
  // A local build has no variant: the release's does not stay beside it as if it were this build's.
  await installLocal(localBuild(t), out, { log: quiet, warn: quiet });
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['wasm-zipp'], 'the variant and package folders are gone with the release install');
});

/** A build-zipp-wasm.mjs output folder, made of the installed engine. */
function localBuild(t, fields = {}) {
  const from = tempDir(t, 'zipp-local-build-');
  for (const name of ['zipp_wasm.js', 'zipp_wasm.d.ts', 'zipp_wasm_bg.wasm', 'LICENSE-APACHE']) fs.copyFileSync(path.join(ENGINE, name), path.join(from, name));
  // wasm-bindgen writes the module's raw declarations beside it; a release ships none.
  fs.writeFileSync(path.join(from, 'zipp_wasm_bg.wasm.d.ts'), 'export const memory: WebAssembly.Memory;\n');
  const local = { repository: REPOSITORY, revision: 'c'.repeat(40), version: VERSION, build: 'local', variant: 'all', languages: ['javascript', 'python'], license: 'Apache-2.0', artifact: 'zipp_wasm_bg.wasm', sha256: source.sha256, ...fields };
  fs.writeFileSync(path.join(from, 'SOURCE.json'), JSON.stringify(local));
  return from;
}

test('the torch package installs beside the engine, with the loader Softn generates, recorded on both sides', (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /torch package sha256 [0-9a-f]{64} into /);
  const torch = packageDir(out);
  assert.equal(torch, path.join(path.dirname(out), 'wasm-zipp-torch'), 'a sibling, never inside wasm-zipp/');
  assert.deepEqual(fs.readdirSync(torch).sort(), [...PACKAGE_INSTALLED_FILES].sort(), 'the module, the generated loader and declarations, and SOURCE.json');
  const module = folder.modules.get(TORCH_BUNDLE);
  assert.ok(fs.readFileSync(path.join(torch, 'zipp_torch.wasm')).equals(module), 'the module as published');
  assert.equal(fs.readFileSync(path.join(torch, 'zipp_torch.js'), 'utf8'), TORCH_LOADER, 'the loader is generated, and exactly that text');
  assert.equal(fs.readFileSync(path.join(torch, 'zipp_torch.d.ts'), 'utf8'), TORCH_DECLARATIONS, 'the declarations too');
  const record = JSON.parse(fs.readFileSync(path.join(out, 'SOURCE.json'), 'utf8'));
  // The ABI the real engine reported when the package was added to it at install.
  const engineAbi = JSON.parse(installedTorch('SOURCE.json')).engineAbi;
  assert.match(engineAbi, /^[0-9a-f]+$/);
  assert.deepEqual(record.packages, {
    torch: { bundle: TORCH_BUNDLE, bundleSha256: sha256(module), sha256: sha256(module), loaderSha256: sha256(Buffer.from(TORCH_LOADER)), variant: 'torch-package', pairsWith: BUNDLE, commit: REV, engineAbi },
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(torch, 'SOURCE.json'), 'utf8'));
  // Every key of the record, loaderSha256 included, is the package's own, as FormLogic compares them.
  for (const [k, v] of Object.entries(record.packages.torch)) assert.deepEqual(pkg[k], v, `package SOURCE.json ${k}`);
  assert.deepEqual(
    { repository: pkg.repository, release: pkg.release, version: pkg.version, revision: pkg.revision, build: pkg.build, sumsSha256: pkg.sumsSha256, languages: pkg.languages, artifact: pkg.artifact, license: pkg.license, loader: pkg.loader, loaderSource: pkg.loaderSource, declarations: pkg.declarations, primary: pkg.primary },
    { repository: REPOSITORY, release: TAG, version: VERSION, revision: REV, build: 'release', sumsSha256: sha256(folder.top), languages: ['python'], artifact: 'zipp_torch.wasm', license: 'Apache-2.0', loader: 'zipp_torch.js', loaderSource: 'softn-generated', declarations: { file: 'zipp_torch.d.ts', source: 'softn-generated', sha256: sha256(Buffer.from(TORCH_DECLARATIONS)) }, primary: { bundle: BUNDLE, sha256: source.sha256, glueSha256: source.glueSha256 } },
  );
  assert.equal(TORCH_PACKAGE.id, 'torch');
});

test('the torch module, its line in the release\'s SHA256SUMS and its record of the engine\'s commit are required', (t) => {
  refused(install(t, releaseFolder(t, { without: [TORCH_BUNDLE] })), new RegExp(`holds no ${escaped(TORCH_BUNDLE)}`));
  refused(install(t, releaseFolder(t, { sums: (s) => s.split('\n').filter((line) => !line.endsWith(`  ${TORCH_BUNDLE}`)).join('\n') })), new RegExp(`SHA256SUMS in .* does not list ${escaped(TORCH_BUNDLE)}`));
  const folder = releaseFolder(t);
  fs.writeFileSync(path.join(folder.dir, TORCH_BUNDLE), withSections(folder.modules.get(TORCH_BUNDLE), { name: 'another build' }));
  refused(install(t, folder), new RegExp(`${escaped(TORCH_BUNDLE)} has sha256 [0-9a-f]{64}; the ${escaped(TAG)} SHA256SUMS says [0-9a-f]{64}`));
  const meta = (change) => ({ torch: (b) => withMeta(b, change) });
  refused(install(t, releaseFolder(t, meta((m) => void (m.commit = 'b'.repeat(40))))), new RegExp(`${escaped(TORCH_BUNDLE)} is built from commit b{40}, not ${REV} like ${escaped(BUNDLE)}; a package ships only from the release's own commit`));
  const prefix = `${escaped(TORCH_BUNDLE)} is not the ZIPP ${escaped(TAG)} torch package:\\n {2}- `;
  refused(install(t, releaseFolder(t, meta((m) => void (m.commit = 'b'.repeat(8))))), new RegExp(`${prefix}zipp\\.meta commit "b{8}" is not a full 40-hex commit$`, 'm'));
  refused(install(t, releaseFolder(t, meta((m) => void (m.variant = 'javascript-python-base')))), /zipp\.meta variant is javascript-python-base, not torch-package/);
  refused(install(t, releaseFolder(t, meta((m) => void (m.version = '9.9.9')))), /zipp\.meta says version 9\.9\.9, not /);
  refused(install(t, releaseFolder(t, meta((m) => void (m.languages = ['javascript'])))), /zipp\.meta languages are \["javascript"\], not \["python"\]/);
  // A package names no bindings, and carries none.
  refused(install(t, releaseFolder(t, meta((m) => void (m.glueSha256 = E64)))), /zipp\.meta names bindings \(glueSha256 e{64}\) the module does not carry/);
  refused(install(t, releaseFolder(t, { torch: (b) => withSections(b, { 'zipp.glue': 'export {};' }) })), /its zipp\.glue section has sha256 [0-9a-f]{64}; zipp\.meta says glueSha256 undefined/);
});

test('the torch module has the package\'s shape, and the loader Softn ships really adds it to the engine', async (t) => {
  assert.deepEqual(packageModuleProblems(installedTorch('zipp_torch.wasm')), [], 'the installed package fits');
  // The engine itself is not a package: it imports the host's functions and exports no archive.
  const asEngine = packageModuleProblems(installed('zipp_wasm_bg.wasm'), { bundle: 'torch.wasm' });
  assert.match(asEngine[0], /^torch\.wasm does not export zipp_package_ptr, zipp_package_len, zipp_kernel, zipp_alloc, zipp_free, which its loader reads$/);
  assert.match(asEngine[1], /^torch\.wasm imports \.\/zipp_wasm_bg\.js\..*; the package module imports nothing/);
  assert.deepEqual(packageModuleProblems(Buffer.from('not wasm'), { bundle: 'torch.wasm' }), ['torch.wasm is not a WebAssembly module']);
  // Through the install, the web engine's code under a package's record.
  const posing = (b) => withSections(withMeta(installedWeb('zipp_wasm_bg.wasm'), (m) => {
    Object.assign(m, metaOf(b));
    delete m.glueSha256;
  }), { 'zipp.glue': null });
  refused(install(t, releaseFolder(t, { torch: posing })), new RegExp(`${escaped(TORCH_BUNDLE)} is not a torch package module:\\n {2}- .*does not export zipp_package_ptr`));
  const folder = releaseFolder(t);
  const primary = await verifyRelease({ release: TAG, sums: folder.top, wasm: folder.modules.get(BUNDLE), kit: folder.kitZip });
  const wasm = folder.modules.get(TORCH_BUNDLE);
  // A loader that says it added torch and did not: the engine is asked, not the loader.
  const liar = `export function addTorchSync() { return { name: "torch", version: "${VERSION}" }; }\nexport async function addTorch() { return addTorchSync(); }\n`;
  await assert.rejects(verifyPackage({ release: TAG, sums: folder.top, wasm, primary, loader: liar }), /does not give the .* engine torch:\n {2}- pythonPackages\(\) does not list torch as installed after addTorchSync\(\)\n {2}- an `import torch` project does not run on the engine with the package added: /);
  await assert.rejects(verifyPackage({ release: TAG, sums: folder.top, wasm, primary, loader: 'export const nothing = 1;\n' }), /zipp_torch\.js does not export addTorch and addTorchSync/);
  // verifyPackage holds the module to the SHA256SUMS itself, and to the primary it is given.
  const pkg = await verifyPackage({ release: TAG, sums: folder.top, wasm, primary });
  assert.equal(pkg.record.sha256, sha256(installedTorch('zipp_torch.wasm')));
  assert.deepEqual([...pkg.files.keys()].sort(), [...PACKAGE_INSTALLED_FILES].sort());
  await assert.rejects(verifyPackage({ release: TAG, sums: folder.top, wasm: folder.modules.get(WEB_BUNDLE), primary }), (error) => error instanceof ZippReleaseError && new RegExp(`^${escaped(TORCH_BUNDLE)} does not match the ${escaped(TAG)} SHA256SUMS$`).test(error.message));
  await assert.rejects(verifyPackage({ release: TAG, sums: folder.top, wasm, primary: { ...primary, source: { ...primary.source, revision: 'd'.repeat(40) } } }), /is built from commit [0-9a-f]{40}, not d{40}/);
  // The engine refusing the package (its ABI or file check), a primary with torch already built in, a torch that answers wrong.
  const glue = (options) => ({ engine: standingIn(PROFILE, undefined, options) });
  const accepted = install(t, releaseFolder(t, glue({})));
  assert.equal(accepted.run.status, 0, `the stand-in is taken when it behaves: ${accepted.run.stderr}`);
  refused(install(t, releaseFolder(t, glue({ refusePackage: 'the package was built for engine ABI 0000' }))), new RegExp(`the ${escaped(BUNDLE)} engine refuses the ${escaped(TORCH_BUNDLE)} package: the package was built for engine ABI 0000`));
  refused(install(t, releaseFolder(t, glue({ torchBuiltIn: true }))), new RegExp(`the ${escaped(BUNDLE)} engine does not describe itself as ZIPP ${escaped(TAG)}:\\n {2}- pythonPackages\\(\\) torchBuiltIn is true, not false; the engine is the build without torch`));
  refused(install(t, releaseFolder(t, glue({ answer: 8 }))), /- an `import torch` project answers 8, not 9/);
});

test('the generated loader is the one the runtime imports, and the one --check holds the install to', async () => {
  // What core's loader imports by path, and its types: the generated text, not anything ZIPP published.
  assert.equal(installedTorch('zipp_torch.js').toString('utf8'), TORCH_LOADER);
  assert.equal(installedTorch('zipp_torch.d.ts').toString('utf8'), TORCH_DECLARATIONS);
  const loader = await import(pathToFileURL(path.join(TORCH_ENGINE, 'zipp_torch.js')).href);
  assert.deepEqual(Object.keys(loader).sort(), ['addTorch', 'addTorchSync']);
  for (const name of ['addTorch', 'addTorchSync']) assert.match(TORCH_DECLARATIONS, new RegExp(`export function ${name}\\(`), `${name} is declared`);
});

test('--check holds the torch package install to the primary\'s record, its own, the release\'s SHA256SUMS and its shape, one invariant at a time', (t) => {
  const { out: pristine, run } = install(t, releaseFolder(t));
  assert.equal(run.status, 0, run.stderr);
  const pkgOf = (dir) => packageDir(dir);
  const pkgModule = (dir) => path.join(pkgOf(dir), 'zipp_torch.wasm');
  const editPkgSource = (dir, change) => editSource(pkgOf(dir), change);
  const replaced = (bytes) => (dir) => replaceRecorded(dir, pkgModule(dir), bytes, [[pkgOf(dir), (s, d) => void (s.sha256 = d)], [dir, (s, d) => void (s.packages.torch.sha256 = d)]]);
  const cases = [
    ['a tampered package module', (dir) => fs.writeFileSync(pkgModule(dir), flipCode(installedTorch('zipp_torch.wasm'))), /^the ZIPP torch package install in .* does not check .*:\n {2}- zipp_torch\.wasm is not the recorded [0-9a-f]{64}$/],
    ['a tampered package module, re-recorded on its own side', (dir) => {
      const bytes = flipCode(installedTorch('zipp_torch.wasm'));
      fs.writeFileSync(pkgModule(dir), bytes);
      editPkgSource(dir, (s) => void (s.sha256 = sha256(bytes)));
    }, /SOURCE\.json sha256 is "[0-9a-f]{64}"; the primary install's packages\.torch records "[0-9a-f]{64}"/],
    ['a tampered package module, re-recorded on both sides', replaced(flipCode(installedTorch('zipp_torch.wasm'))), /^the ZIPP torch package install in .* does not check .*:\n {2}- SOURCE\.json sha256 [0-9a-f]{64} is not the bundleSha256 [0-9a-f]{64}; the package is installed as published$/],
    ['a tampered package module, re-recorded as published too', (dir) => {
      replaced(flipCode(installedTorch('zipp_torch.wasm')))(dir);
      const digest = sha256(fs.readFileSync(pkgModule(dir)));
      editSource(dir, (s) => void (s.packages.torch.bundleSha256 = digest));
      editPkgSource(dir, (s) => void (s.bundleSha256 = digest));
    }, new RegExp(`^the ZIPP torch package install in .* does not check .*:\\n {2}- RELEASE-SHA256SUMS does not list ${escaped(TORCH_BUNDLE)} with the recorded [0-9a-f]{64}$`)],
    // Every record agrees, and the check still refuses: the engine is not a package.
    ['the engine module in the package\'s place, re-recorded on both sides', replaced(installed('zipp_wasm_bg.wasm')), /zipp_torch\.wasm does not export zipp_package_ptr, .*which its loader reads\n {2}- zipp_torch\.wasm imports /],
    ['a package module whose record names another commit', replaced(withMeta(installedTorch('zipp_torch.wasm'), (m) => void (m.commit = E40))), /zipp_torch\.wasm: zipp\.meta commit e{40} is not [0-9a-f]{40}/],
    ['an edited loader', (dir) => fs.appendFileSync(path.join(pkgOf(dir), 'zipp_torch.js'), '\n'), /zipp_torch\.js is not the text this script generates/],
    ['edited declarations', (dir) => fs.appendFileSync(path.join(pkgOf(dir), 'zipp_torch.d.ts'), 'export const extra: 1;\n'), /zipp_torch\.d\.ts is not the text this script generates/],
    ['the loader recorded as another digest, agreed on both sides', (dir) => {
      editPkgSource(dir, (s) => void (s.loaderSha256 = E64));
      editSource(dir, (s) => void (s.packages.torch.loaderSha256 = E64));
    }, /SOURCE\.json loader \{"file":"zipp_torch\.js","source":"softn-generated","sha256":"e{64}"\} is not the generated zipp_torch\.js/],
    ['the loader recorded as the release\'s', (dir) => editPkgSource(dir, (s) => void (s.loaderSource = 'zipp-release')), /SOURCE\.json loader \{"file":"zipp_torch\.js","source":"zipp-release",.*\} is not the generated zipp_torch\.js/],
    ['declarations recorded as another digest', (dir) => editPkgSource(dir, (s) => void (s.declarations.sha256 = E64)), /SOURCE\.json declarations .* is not the generated zipp_torch\.d\.ts/],
    ['a primary record without the package', (dir) => editSource(dir, (s) => void delete s.packages), /^the ZIPP install in .* does not check .*:\n {2}- SOURCE\.json records no torch package of the engine \(packages\.torch\)/],
    ['a primary record whose package digest disagrees', (dir) => editSource(dir, (s) => void (s.packages.torch.sha256 = E64)), /SOURCE\.json sha256 is "[0-9a-f]{64}"; the primary install's packages\.torch records "e{64}"/],
    ['a primary record whose loader digest disagrees', (dir) => editSource(dir, (s) => void (s.packages.torch.loaderSha256 = E64)), /SOURCE\.json loaderSha256 is "[0-9a-f]{64}"; the primary install's packages\.torch records "e{64}"/],
    ['a package record paired with the complete engine, agreed on both sides', (dir) => {
      editSource(dir, (s) => void (s.packages.torch.pairsWith = `zipp-${VERSION}-javascript-python.wasm`));
      editPkgSource(dir, (s) => void (s.pairsWith = `zipp-${VERSION}-javascript-python.wasm`));
    }, new RegExp(`SOURCE\\.json pairsWith zipp-${escaped(VERSION)}-javascript-python\\.wasm is not the primary install's engine ${escaped(BUNDLE)}$`, 'm')],
    ['a package record of another commit, agreed on both sides', (dir) => {
      editSource(dir, (s) => void (s.packages.torch.commit = E40));
      editPkgSource(dir, (s) => void (s.commit = E40));
    }, /SOURCE\.json commit e{40} is not the primary install's revision [0-9a-f]{40}; a package is built from the engine's own source/],
    ['a package record from another SHA256SUMS', (dir) => editPkgSource(dir, (s) => void (s.sumsSha256 = E64)), /SOURCE\.json sumsSha256 e{64} is not the primary install's/],
    ['a package record of another engine', (dir) => editPkgSource(dir, (s) => void (s.primary.sha256 = E64)), /SOURCE\.json primary \{.*\} is not the primary install/],
    ['a package record recorded as a local build', (dir) => editPkgSource(dir, (s) => void (s.build = 'local')), /SOURCE\.json build is 'local'/],
    ['a package record without an engine ABI, agreed on both sides', (dir) => {
      editSource(dir, (s) => void delete s.packages.torch.engineAbi);
      editPkgSource(dir, (s) => void delete s.engineAbi);
    }, /SOURCE\.json engineAbi undefined is not recorded/],
    ['a package digest the release\'s SHA256SUMS does not carry', (dir) => {
      editSource(dir, (s) => void (s.packages.torch.bundleSha256 = E64));
      editPkgSource(dir, (s) => void (s.bundleSha256 = E64));
    }, new RegExp(`RELEASE-SHA256SUMS does not list ${escaped(TORCH_BUNDLE)} with the recorded e{64}`)],
    ['a stray file in the package folder', (dir) => fs.copyFileSync(path.join(dir, 'zipp_wasm.js'), path.join(pkgOf(dir), 'zipp_wasm.js')), /zipp_wasm\.js is not part of a package install/],
    ['a file a 0.0.25 package install had', (dir) => fs.writeFileSync(path.join(pkgOf(dir), 'BUILD-INFO.txt'), 'variant=torch\n'), /BUILD-INFO\.txt is not part of a package install/],
    ['a missing package file', (dir) => fs.rmSync(path.join(pkgOf(dir), 'zipp_torch.d.ts')), /zipp_torch\.d\.ts is missing/],
    ['no package folder at all', (dir) => fs.rmSync(pkgOf(dir), { recursive: true }), /holds no ZIPP torch package install \(no SOURCE\.json\); run npm run fetch:zipp/],
  ];
  checkCases(t, pristine, cases);
  assert.equal(checkEngine(pristine).packages.torch.sha256, sha256(installedTorch('zipp_torch.wasm')), 'the pristine copy still checks');
});

test('--ensure reinstalls when the torch package is gone or tampered, and --check --online compares it with the published module', async (t) => {
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
  // Online: the package as published, byte for byte; one published again under the tag is not the one installed.
  const published = publishedUrls(folder);
  const fetch = async (url) => (published.has(url) ? new Response(published.get(url)) : new Response('', { status: 404 }));
  assert.equal((await checkEngineOnline(out, { fetch })).release, TAG);
  published.set(`${REPOSITORY}/releases/download/${TAG}/${TORCH_BUNDLE}`, withSections(folder.modules.get(TORCH_BUNDLE), { name: 'again' }));
  await assert.rejects(checkEngineOnline(out, { fetch }), new RegExp(`wasm-zipp-torch/zipp_torch\\.wasm is not the published ${escaped(TORCH_BUNDLE)}`));
});

test('--resolve-only names the declared release and its SHA256SUMS digest without installing', (t) => {
  const folder = releaseFolder(t);
  const run = cli(['--resolve-only'], { ZIPP_RELEASE_DIR: folder.dir });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { release: TAG, sumsSha256: sha256(folder.top) }, 'apps/softn-host-rust/Cargo.toml declares the installed release (engine-pin.test.mjs)');
});

const declaring = (file, tag) => fs.writeFileSync(file, `[dependencies]\nzipp-vm = { git = "${REPOSITORY}", tag = "${tag}", features = ["instrument"] }\n`);
/** A SHA256SUMS listing what an install takes of `version`, leaving out `omit`. */
const listing = (version, digit, omit) => Buffer.from(['javascript.wasm', 'javascript-python-base.wasm', 'torch-package.wasm', 'wasm-embed-kit.zip'].filter((file) => file !== omit).map((file) => `${digit.repeat(64)}  zipp-${version}-${file}\n`).join(''));

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
  refused({ run: copy(['--resolve-only'], { ZIPP_RELEASE_DIR: folder.dir }) }, /SHA256SUMS in .* does not list zipp-99\.0\.0-javascript-python-base\.wasm/);
  declaring(cargo, 'v0.0.25');
  refused({ run: copy(['--resolve-only'], { ZIPP_RELEASE_DIR: folder.dir }) }, /ZIPP v0\.0\.25 was published as zip bundles/);
  assert.equal(JSON.parse(copy(['--resolve-only'], { ZIPP_RELEASE_DIR: folder.dir, ZIPP_RELEASE: TAG }).stdout).release, TAG, 'ZIPP_RELEASE comes before the declaration');
  fs.rmSync(cargo);
  refused({ run: copy(['--resolve-only'], { ZIPP_RELEASE_DIR: folder.dir }) }, /cannot read the declared ZIPP release from .*Cargo\.toml/);

  const check = copy(['--check'], { ZIPP_OUT: ENGINE });
  assert.equal(check.status, 0, `--check reads no Cargo.toml and no fflate:\n${check.stderr}`);
  assert.match(check.stdout, /with its web variant .* and its torch package/, '--check covers wasm-zipp-web/ and wasm-zipp-torch/ too');

  // --latest, with GitHub stubbed before the script loads. The latest release's SHA256SUMS must list everything an install takes as well.
  const latestSums = listing('0.0.27', '3');
  const stub = path.join(tree, 'stub-fetch.mjs');
  fs.writeFileSync(stub, `const sums = Buffer.from(${JSON.stringify(latestSums.toString('base64'))}, 'base64');\nconst served = new Set([${JSON.stringify(`${REPOSITORY}/releases/latest/download/SHA256SUMS`)}, ${JSON.stringify(`${REPOSITORY}/releases/download/v0.0.27/SHA256SUMS`)}]);\nglobalThis.fetch = async (url) => (served.has(url) ? new Response(sums) : new Response('', { status: 404 }));\n`);
  const latest = copy(['--resolve-only', '--latest'], {}, ['--import', pathToFileURL(stub).href]);
  assert.equal(latest.status, 0, latest.stderr);
  assert.deepEqual(JSON.parse(latest.stdout), { release: 'v0.0.27', sumsSha256: sha256(latestSums) });
  // A latest release published without its javascript engine is not one this can install.
  const noWeb = listing('0.0.27', '4', 'javascript.wasm');
  fs.writeFileSync(stub, fs.readFileSync(stub, 'utf8').replace(latestSums.toString('base64'), noWeb.toString('base64')));
  refused({ run: copy(['--resolve-only', '--latest'], {}, ['--import', pathToFileURL(stub).href]) }, /SHA256SUMS published under v0\.0\.27 does not list zipp-0\.0\.27-javascript\.wasm/);
});

test('--ensure replaces an install of a release other than the declared one', async (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, run.stderr);
  const cargo = path.join(tempDir(t, 'zipp-cargo-'), 'Cargo.toml');
  declaring(cargo, 'v99.0.0');
  const logs = [];
  const warnings = [];
  await assert.rejects(ensureEngine({ dir: out, cargoToml: cargo, releaseDir: folder.dir, log: (line) => logs.push(line), warn: (line) => warnings.push(line) }), /does not list zipp-99\.0\.0-javascript-python-base\.wasm/);
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
  // The same release published again with another kit, so another SHA256SUMS.
  const second = releaseFolder(t, { kit: (files) => files.set('README.md', Buffer.from('# ZIPP embed kit, published again\n')) });
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
  const tagUrl = `${REPOSITORY}/releases/download/v0.0.27/SHA256SUMS`;
  const serve = (responses) => {
    const calls = [];
    return { calls, fetch: async (url) => (calls.push(url), responses.has(url) ? new Response(responses.get(url)) : new Response('', { status: 404 })) };
  };
  const same = serve(new Map([[latestUrl, listing('0.0.27', '1')], [tagUrl, listing('0.0.27', '1')]]));
  const resolved = await resolveRelease({ latest: true, fetch: same.fetch });
  assert.equal(resolved.release, 'v0.0.27');
  assert.ok(resolved.sums.equals(listing('0.0.27', '1')));
  assert.deepEqual(same.calls, [latestUrl, tagUrl], 'no API call: the latest redirect, then the tag\'s own asset');
  const moved = serve(new Map([[latestUrl, listing('0.0.27', '1')], [tagUrl, listing('0.0.27', '2')]]));
  await assert.rejects(resolveRelease({ latest: true, fetch: moved.fetch }), (error) => error instanceof ZippReleaseError && /try again/.test(error.message));
  // A latest release that publishes zip bundles names no engine this reads.
  const zips = serve(new Map([[latestUrl, Buffer.from(`${'1'.repeat(64)}  zipp-wasm-0.0.25-web-python-base.zip\n`)]]));
  await assert.rejects(resolveRelease({ latest: true, fetch: zips.fetch }), /SHA256SUMS lists 0 javascript-python-base engines; expected exactly one/);
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
  fs.appendFileSync(path.join(out, 'zipp_wasm.d.ts'), ' ');
  const repaired = await ensureEngine({ dir: out, fetch, releaseDir: folder.dir, log: quiet });
  assert.equal(repaired.action, 'installed');
  assert.equal(checkEngine(out).release, TAG);
  assert.deepEqual(calls, [], 'the folder was the source');
});

test('a local build installs only on purpose, never passes --check, and --ensure keeps it (refusing under CI)', async (t) => {
  const from = localBuild(t);
  fs.copyFileSync(CURATED_NOTICES, path.join(from, 'THIRD_PARTY_LICENSES.txt'));
  const local = JSON.parse(fs.readFileSync(path.join(from, 'SOURCE.json'), 'utf8'));
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

test('--check --online compares every module taken and the kit\'s files with what is published, byte for byte', async (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, run.stderr);
  const url = (file) => `${REPOSITORY}/releases/download/${TAG}/${file}`;
  const published = publishedUrls(folder);
  const fetch = async (address) => (published.has(address) ? new Response(published.get(address)) : new Response('', { status: 404 }));
  // Each module published again under the tag: not the one installed, though it checks offline.
  for (const [file, installedAt] of [[BUNDLE, 'wasm-zipp/zipp_wasm_bg.wasm'], [WEB_BUNDLE, 'wasm-zipp-web/zipp_wasm_bg.wasm']]) {
    published.set(url(file), withSections(folder.modules.get(file), { name: 'again' }));
    assert.equal(checkEngine(out).release, TAG);
    await assert.rejects(checkEngineOnline(out, { fetch }), new RegExp(`${escaped(installedAt)} is not the published ${escaped(file)}`));
    published.set(url(file), folder.modules.get(file));
  }
  // The kit published again: not the one recorded.
  published.set(url(KIT), releaseFolder(t, { kit: (files) => files.set('README.md', Buffer.from('# again\n')) }).kitZip);
  await assert.rejects(checkEngineOnline(out, { fetch }), new RegExp(`the published ${escaped(KIT)} is not the recorded [0-9a-f]{64}`));
  published.set(url(KIT), folder.kitZip);
  // A kit file edited and recorded as edited passes offline, and not against the kit as published.
  fs.appendFileSync(path.join(out, 'zipp_wasm.d.ts'), '\n');
  editSource(out, (s) => void (s.kit.files['zipp_wasm.d.ts'].sha256 = sha256(fs.readFileSync(path.join(out, 'zipp_wasm.d.ts')))));
  assert.equal(checkEngine(out).release, TAG);
  await assert.rejects(checkEngineOnline(out, { fetch }), new RegExp(`\\n {2}- zipp_wasm\\.d\\.ts is not zipp-engine\\.d\\.ts in the published ${escaped(KIT)}`));
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
  // Taken over while the release's files download (the kit is the last): refused before any folder is written.
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
  const from = localBuild(t);
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
  for (const name of ['SHA256SUMS', BUNDLE]) fs.copyFileSync(path.join(folder.dir, name), path.join(cached, name));
  // Part of a release (no javascript module, then no torch package, then no kit) is not named: it could not be installed.
  for (const name of [WEB_BUNDLE, TORCH_BUNDLE, KIT]) {
    await assert.rejects(resolveRelease({ tag: TAG, cacheDir, fetch: offline }), (error) => /could not fetch .*: fetch failed$/.test(error.message), `without ${name}`);
    fs.copyFileSync(path.join(folder.dir, name), path.join(cached, name));
  }
  await assert.rejects(resolveRelease({ tag: TAG, cacheDir, fetch: offline }), new RegExp(`: fetch failed; to install the ${escaped(TAG)} downloaded earlier without the network, set ZIPP_RELEASE_DIR=${escaped(cached)}$`));
  // GitHub answering that there is no such release is not a network failure: no copy stands in for it.
  const missing = async () => new Response('', { status: 404 });
  await assert.rejects(resolveRelease({ tag: TAG, cacheDir, fetch: missing }), (error) => /answered 404$/.test(error.message));
  // The folder named is a release folder as it is.
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  const run = cli(['--ensure'], { ZIPP_OUT: out, ZIPP_RELEASE_DIR: cached });
  assert.equal(run.status, 0, run.stderr);
});

test('downloads are cached per tag, whole files only, and a cached file that no longer matches is fetched again', async (t) => {
  const folder = releaseFolder(t);
  const cacheDir = tempDir(t, 'zipp-cache-');
  const published = publishedUrls(folder);
  const calls = [];
  const fetch = async (url) => (calls.push(url), published.has(url) ? new Response(published.get(url)) : new Response('', { status: 404 }));
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  await installRelease({ dir: out, tag: TAG, cacheDir, fetch, log: quiet, warn: quiet });
  assert.deepEqual(fs.readdirSync(path.join(cacheDir, TAG)).sort(), ['SHA256SUMS', BUNDLE, WEB_BUNDLE, TORCH_BUNDLE, KIT].sort(), 'no partial file is left');
  assert.equal(calls.length, 5, 'SHA256SUMS, three modules and the kit');
  // A second install asks only for SHA256SUMS, then for the one cached file that was spoiled.
  calls.length = 0;
  fs.appendFileSync(path.join(cacheDir, TAG, WEB_BUNDLE), Buffer.from([0]));
  fs.rmSync(out, { recursive: true });
  await installRelease({ dir: out, tag: TAG, cacheDir, fetch, log: quiet, warn: quiet });
  assert.deepEqual(calls, [`${REPOSITORY}/releases/download/${TAG}/SHA256SUMS`, `${REPOSITORY}/releases/download/${TAG}/${WEB_BUNDLE}`]);
  assert.equal(checkEngine(out).release, TAG);
});
