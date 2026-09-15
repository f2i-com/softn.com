/**
 * The ZIPP install takes a release only when every layer checks: the bundle
 * against ZIPP's SHA256SUMS, each file against the bundle's own, BUILD-INFO.txt
 * and the module itself against the web-python build of that release.
 *
 * The fixture release is built around the installed engine (a real glue and
 * module, so the install's zippProfile() check really runs), with the inner
 * and top-level SHA256SUMS rebuilt per case, so a case trips only the refusal
 * it is about. Releases come from a folder (ZIPP_RELEASE_DIR) through the
 * command line, or from a stubbed fetch in process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { CURATED_NOTICES, INSTALLED_FILES, REPOSITORY, ZippReleaseError, checkEngine, checkEngineOnline, ensureEngine, ensureReleaseEngine, resolveRelease, sha256, verifyRelease, writeInstall } from './fetch-zipp-release.mjs';

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(CORE, 'wasm-zipp');
const SCRIPT = path.join(CORE, 'scripts/fetch-zipp-release.mjs');
const installed = (name) => fs.readFileSync(path.join(ENGINE, name));
const source = JSON.parse(installed('SOURCE.json'));
const TAG = source.release;
const VERSION = source.version;
const BUNDLE = `zipp-wasm-${VERSION}-web-python`;
const quiet = () => {};

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const setBuildInfo = (files, key, value) => files.set('BUILD-INFO.txt', Buffer.from(files.get('BUILD-INFO.txt').toString('utf8').replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)));

/**
 * A release folder holding SHA256SUMS and the web-python zip. `edit` changes
 * the bundle before its SHA256SUMS is written, `innerSums` that text, `tamper`
 * the bundle after it; `repack` packs the same files again after the top-level
 * sums are written, a valid zip whose bytes are not the ones listed.
 */
function releaseFolder(t, { edit, innerSums, tamper, repack = false } = {}) {
  const files = new Map([
    ...['zipp_wasm.js', 'zipp_wasm.d.ts', 'zipp_wasm_bg.wasm', 'zipp_wasm_bg.wasm.d.ts', 'LICENSE-APACHE', 'BUILD-INFO.txt', 'PROFILE.json'].map((n) => [n, installed(n)]),
    // Listed by the bundle's SHA256SUMS, never installed.
    ['README.md', Buffer.from('# zipp-wasm\n')],
    ['docs/TORCH_COMPATIBILITY.md', Buffer.from('torch\n')],
    ['gpu-lab/LICENSE', Buffer.from('gpu-lab licence\n')],
    ['host-sdk/zipp-host.mjs', Buffer.from('export {};\n')],
  ]);
  edit?.(files);
  let sums = `${[...files].map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join('\n')}\n`;
  if (innerSums) sums = innerSums(sums);
  files.set('SHA256SUMS', Buffer.from(sums));
  tamper?.(files);
  const entries = Object.fromEntries([...files].map(([name, bytes]) => [`${BUNDLE}/${name}`, new Uint8Array(bytes)]));
  let zip = Buffer.from(zipSync(entries, { level: 0 }));
  const top = Buffer.from(`${'a'.repeat(64)}  zipp-wasm-${VERSION}-web.zip\n${sha256(zip)}  ${BUNDLE}.zip\n`);
  if (repack) zip = Buffer.from(zipSync(entries, { level: 1 }));
  const dir = tempDir(t, 'zipp-release-fixture-');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), top);
  fs.writeFileSync(path.join(dir, `${BUNDLE}.zip`), zip);
  return { dir, top, zip, files };
}

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
  if (out) assert.ok(!fs.existsSync(out), 'nothing is installed');
}

const editText = (dir, name, change) => fs.writeFileSync(path.join(dir, name), change(fs.readFileSync(path.join(dir, name), 'utf8')));
const editSource = (dir, change) => editText(dir, 'SOURCE.json', (text) => {
  const record = JSON.parse(text);
  change(record);
  return `${JSON.stringify(record, null, 2)}\n`;
});
/** Brings the install's own SHA256SUMS line for `name` in step with the file, so only the check a case is about can trip. */
const resum = (dir, name) => editText(dir, 'SHA256SUMS', (text) => text.replace(new RegExp(`^[0-9a-f]{64}(  ${escaped(name)})$`, 'm'), `${sha256(fs.readFileSync(path.join(dir, name)))}$1`));
/** A module that describes itself as `profile`, standing in for the engine where what it reports is the point. */
const standInGlue = (profile) => Buffer.from(`export function initSync() {}\nexport function zippProfile() { return ${JSON.stringify(JSON.stringify(profile))}; }\n`);

function spawnCli(args, env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ZIPP_|CI$)/i.test(key)));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...clean, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('the fixture is built around a verified release install', () => {
  assert.equal(checkEngine(ENGINE).release, TAG, 'packages/@softn/core/wasm-zipp checks (npm run fetch:zipp)');
});

test('a release that checks all the way down installs exactly the install set, and --check passes', (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(fs.readdirSync(out).sort(), [...INSTALLED_FILES].sort(), 'unshipped SHA256SUMS entries (README.md, docs/, gpu-lab/, host-sdk/) stay behind');
  const record = JSON.parse(fs.readFileSync(path.join(out, 'SOURCE.json'), 'utf8'));
  assert.deepEqual(
    { release: record.release, version: record.version, revision: record.revision, build: record.build, bundle: record.bundle, bundleSha256: record.bundleSha256, sumsSha256: record.sumsSha256, variant: record.variant, languages: record.languages, stackBytes: record.stackBytes, sha256: record.sha256, glueSha256: record.glueSha256 },
    { release: TAG, version: VERSION, revision: source.revision, build: 'release', bundle: `${BUNDLE}.zip`, bundleSha256: sha256(folder.zip), sumsSha256: sha256(folder.top), variant: 'javascript-python', languages: ['javascript', 'python'], stackBytes: 16777216, sha256: source.sha256, glueSha256: sha256(installed('zipp_wasm.js')) },
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
  assert.equal(fs.readdirSync(path.dirname(out)).length, 1, 'no staging folder is left behind');
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
  refused(install(t, releaseFolder(t, { edit })), /variant is javascript, not javascript-python/);
});

test('BUILD-INFO.txt has to name the web-python languages and stack, each on its own', (t) => {
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

test('a folder without the web-python bundle is refused', (t) => {
  const folder = releaseFolder(t);
  fs.rmSync(path.join(folder.dir, `${BUNDLE}.zip`));
  refused(install(t, folder), new RegExp(`holds no ${BUNDLE}\\.zip`));
});

test('an install replaces the whole folder, so a stale file does not survive', (t) => {
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'zipp_wasm_bg.wasm.old'), 'stale');
  fs.writeFileSync(path.join(out, 'SOURCE.json'), '{"build":"release"}');
  const { run } = install(t, releaseFolder(t), { out });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(fs.readdirSync(out).sort(), [...INSTALLED_FILES].sort());
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['wasm-zipp'], 'neither the stage nor the previous install is left behind');
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
    ['a recorded stack', (dir) => editSource(dir, (s) => void (s.stackBytes = 1048576)), /SOURCE\.json records javascript-python \["javascript","python"\] with a 1048576-byte stack, not the web-python build/],
    ['a recorded engine digest', (dir) => editSource(dir, (s) => void (s.sha256 = E64)), /zipp_wasm_bg\.wasm is not the recorded e{64}/],
    ['a recorded glue digest', (dir) => editSource(dir, (s) => void (s.glueSha256 = E64)), /zipp_wasm\.js is not the recorded e{64}/],
    ['a recorded notices digest', (dir) => editSource(dir, (s) => void (s.notices.sha256 = E64)), /THIRD_PARTY_LICENSES\.txt is not the recorded e{64}/],
    ['notices of unknown origin', (dir) => editSource(dir, (s) => void (s.notices.source = 'elsewhere')), /SOURCE\.json notices .* are not recorded/],
    ['curated notices recorded as the release\'s', (dir) => editSource(dir, (s) => void (s.notices.source = 'zipp-release')), /THIRD_PARTY_LICENSES\.txt is not listed in the bundle's SHA256SUMS/],
    ['another repository', (dir) => editSource(dir, (s) => void (s.repository = 'https://example.com/zipp')), /SOURCE\.json repository is https:\/\/example\.com\/zipp/],
    ['a release that is not the version', (dir) => editSource(dir, (s) => void (s.release = 'v9.9.9')), /SOURCE\.json release v9\.9\.9 and version \S+ do not agree/],
    ['the web bundle recorded', (dir) => editSource(dir, (s) => void (s.bundle = `zipp-wasm-${VERSION}-web.zip`)), /SOURCE\.json bundle \S+-web\.zip is not the web-python bundle/],
    ['BUILD-INFO.txt of another commit', buildInfo('commit', E40), /BUILD-INFO\.txt commit e{40} is not the recorded revision [0-9a-f]{40}/],
    ['BUILD-INFO.txt of another version', buildInfo('version', '9.9.9'), /BUILD-INFO\.txt says version 9\.9\.9, not /],
    ['BUILD-INFO.txt of another variant', buildInfo('variant', 'javascript'), /BUILD-INFO\.txt variant is javascript, not javascript-python/],
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
  for (const dir of [path.dirname(script), path.dirname(cargo), path.join(tree, 'packages/@softn/core/zipp-notices')]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SCRIPT, script);
  fs.copyFileSync(CURATED_NOTICES, path.join(tree, 'packages/@softn/core/zipp-notices/THIRD_PARTY_LICENSES.txt'));
  assert.notEqual(spawnSync(process.execPath, ['--input-type=module', '-e', "await import('fflate')"], { cwd: tree }).status, 0, 'no node_modules is reachable from the copy');
  const copy = (args, env = {}, preload = []) => spawnSync(process.execPath, [...preload, script, ...args], { cwd: tree, encoding: 'utf8', env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...env } });
  const folder = releaseFolder(t);

  declaring(cargo, TAG);
  const resolved = copy(['--resolve-only'], { ZIPP_RELEASE_DIR: folder.dir });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.deepEqual(JSON.parse(resolved.stdout), { release: TAG, sumsSha256: sha256(folder.top) });
  declaring(cargo, 'v99.0.0');
  refused({ run: copy(['--resolve-only'], { ZIPP_RELEASE_DIR: folder.dir }) }, /SHA256SUMS in .* does not list zipp-wasm-99\.0\.0-web-python\.zip/);
  assert.equal(JSON.parse(copy(['--resolve-only'], { ZIPP_RELEASE_DIR: folder.dir, ZIPP_RELEASE: TAG }).stdout).release, TAG, 'ZIPP_RELEASE comes before the declaration');
  fs.rmSync(cargo);
  refused({ run: copy(['--resolve-only'], { ZIPP_RELEASE_DIR: folder.dir }) }, /cannot read the declared ZIPP release from .*Cargo\.toml/);

  const check = copy(['--check'], { ZIPP_OUT: ENGINE });
  assert.equal(check.status, 0, `--check reads no Cargo.toml and no fflate:\n${check.stderr}`);

  // --latest, with GitHub stubbed before the script loads.
  const latestSums = Buffer.from(`${'3'.repeat(64)}  zipp-wasm-0.0.19-web-python.zip\n`);
  const stub = path.join(tree, 'stub-fetch.mjs');
  fs.writeFileSync(stub, `const sums = Buffer.from(${JSON.stringify(latestSums.toString('base64'))}, 'base64');\nconst served = new Set([${JSON.stringify(`${REPOSITORY}/releases/latest/download/SHA256SUMS`)}, ${JSON.stringify(`${REPOSITORY}/releases/download/v0.0.19/SHA256SUMS`)}]);\nglobalThis.fetch = async (url) => (served.has(url) ? new Response(sums) : new Response('', { status: 404 }));\n`);
  const latest = copy(['--resolve-only', '--latest'], {}, ['--import', pathToFileURL(stub).href]);
  assert.equal(latest.status, 0, latest.stderr);
  assert.deepEqual(JSON.parse(latest.stdout), { release: 'v0.0.19', sumsSha256: sha256(latestSums) });
});

test('--ensure replaces an install of a release other than the declared one', async (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, run.stderr);
  const cargo = path.join(tempDir(t, 'zipp-cargo-'), 'Cargo.toml');
  declaring(cargo, 'v99.0.0');
  const logs = [];
  const warnings = [];
  await assert.rejects(ensureEngine({ dir: out, cargoToml: cargo, releaseDir: folder.dir, log: (line) => logs.push(line), warn: (line) => warnings.push(line) }), /does not list zipp-wasm-99\.0\.0-web-python\.zip/);
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
  const sums = (digit) => Buffer.from(`${digit.repeat(64)}  zipp-wasm-0.0.19-web.zip\n${digit.repeat(64)}  zipp-wasm-0.0.19-web-python.zip\n`);
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
  const published = new Map([[sumsUrl, folder.top], [`${REPOSITORY}/releases/download/${TAG}/${BUNDLE}.zip`, folder.zip]]);
  const fetch = async (url) => (published.has(url) ? new Response(published.get(url)) : new Response('', { status: 404 }));
  assert.equal((await checkEngineOnline(out, { fetch })).release, TAG);
  published.set(sumsUrl, Buffer.concat([folder.top, Buffer.from('\n')]));
  await assert.rejects(checkEngineOnline(out, { fetch }), /RELEASE-SHA256SUMS is not the SHA256SUMS published under/);
});

test('--check --online compares every file taken with the published bundle, byte for byte', async (t) => {
  const folder = releaseFolder(t);
  const { out, run } = install(t, folder);
  assert.equal(run.status, 0, run.stderr);
  const zipUrl = `${REPOSITORY}/releases/download/${TAG}/${BUNDLE}.zip`;
  const published = new Map([[`${REPOSITORY}/releases/download/${TAG}/SHA256SUMS`, folder.top], [zipUrl, folder.zip]]);
  const fetch = async (url) => (published.has(url) ? new Response(published.get(url)) : new Response('', { status: 404 }));
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
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['wasm-zipp'], 'no stage, previous install or lock is left');
});

test('a lock whose process is gone is taken over with what it left; a live one is waited for', async (t) => {
  const folder = releaseFolder(t);
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  const lock = path.join(path.dirname(out), '.wasm-zipp.lock');
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(lock, String(gone));
  fs.mkdirSync(path.join(path.dirname(out), `.wasm-zipp.stage-${gone}-0badf00d`));
  const taken = cli(['--ensure'], { ZIPP_OUT: out, ZIPP_RELEASE_DIR: folder.dir });
  assert.equal(taken.status, 0, taken.stderr);
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['wasm-zipp']);

  // Held by a live process (this one): nothing happens until it lets go.
  fs.rmSync(out, { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
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
  assert.match(warnings.join('\n'), new RegExp(`Waiting for the ZIPP install another process \\(${process.pid}\\) is making`));
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['wasm-zipp']);
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
  await assert.rejects(resolveRelease({ tag: TAG, cacheDir, fetch: offline }), new RegExp(`: fetch failed; to install the ${escaped(TAG)} downloaded earlier without the network, set ZIPP_RELEASE_DIR=${escaped(cached)}$`));
  // GitHub answering that there is no such release is not a network failure: no copy stands in for it.
  const missing = async () => new Response('', { status: 404 });
  await assert.rejects(resolveRelease({ tag: TAG, cacheDir, fetch: missing }), (error) => /answered 404$/.test(error.message));
  // The folder named is a release folder as it is.
  const out = path.join(tempDir(t, 'zipp-install-'), 'wasm-zipp');
  const run = cli(['--ensure'], { ZIPP_OUT: out, ZIPP_RELEASE_DIR: cached });
  assert.equal(run.status, 0, run.stderr);
});
