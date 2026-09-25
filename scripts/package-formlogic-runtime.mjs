#!/usr/bin/env node
/**
 * Package what FormLogic takes from a SoftN release, so FormLogic can use the
 * release instead of building SoftN from source:
 *
 *   node scripts/package-formlogic-runtime.mjs --tag v0.0.13 [--commit <sha>] [--out release] [--allow-dirty] [--no-build-packages]
 *
 * The archive is `softn-formlogic-runtime-<tag>.zip` (`release-packages.mjs`,
 * id `formlogic-runtime`), laid out exactly as FormLogic's own build scripts
 * lay their outputs out, so its existing checks apply unchanged:
 *
 *   hosted-runtime/    apps/formlogic-host built the way
 *                      formlogic/ui/scripts/build-hosted-runtime.mjs builds it
 *                      (no source maps, LICENSE, NOTICE, README.txt,
 *                      runtime-manifest.json over every file, which also names
 *                      the engine ids that shell serves and its features).
 *                      Two entry documents: index.html for the ZIPP engines and
 *                      host.html for the one that runs the author's code as the
 *                      document's own JavaScript, which needs a weaker policy
 *                      than a meta policy could ever be relaxed to.
 *   app-editors/       Builder and Studio built as hosted editors the way
 *                      formlogic/ui/scripts/build-app-editors.mjs builds them
 *                      (VITE_BASE=/app-editors/<kind>/, VITE_FORMLOGIC_EDITOR=1),
 *                      manifest.json, LICENSE, NOTICE, a runtime-manifest.json
 *                      per editor and one over the whole folder.
 *   native-runtime/    apps/softn-host-php/runtime/* byte for byte, the ZIPP
 *                      engine, licences and provenance.json, as
 *                      formlogic/scripts/prepare-native-runtime.mjs writes them.
 *   zipp/              packages/@softn/core/wasm-zipp/ byte for byte: the
 *                      verified ZIPP web-python-base release install FormLogic
 *                      takes its browser engine from (fetch-zipp-release.mjs):
 *                      JavaScript and Python, torch not built in.
 *   zipp-web/          packages/@softn/core/wasm-zipp-web/ byte for byte: the
 *                      same release's JavaScript-only web build, verified as
 *                      a variant of zipp/ (same commit, same imports, exports a
 *                      subset, runs under zipp/'s glue), for a FormLogic that
 *                      offers the `zipp-web` engine. A tree of its own at the
 *                      top level, so zipp/ is exactly the install it always was.
 *   zipp-torch/        packages/@softn/core/wasm-zipp-torch/ byte for byte: the
 *                      same release's torch package for that engine
 *                      (zipp_torch.wasm, ZIPP's zipp_torch.js loader, its
 *                      BUILD-INFO.txt and SHA256SUMS, generated declarations,
 *                      SOURCE.json), verified at install by adding it to the
 *                      engine and running torch; zipp/SOURCE.json names it
 *                      under packages.torch. The hosted runtime and the
 *                      editors carry the same bytes in assets/core-runtime/,
 *                      where the runtime fetches it for an app that declares
 *                      torch, so FormLogic apps can declare it too.
 *   adapter/           packages/@softn/core/src/integrations/formlogic.ts (LF)
 *                      with the provenance FormLogic's sync-softn.mjs records.
 *   softn-release.json the tag, the commit, the engine (the install's whole
 *                      SOURCE.json, `variants.web` included), the protocols,
 *                      the adapter digest and a digest of every other file.
 *   README.md          the plain-language explainer; INTEGRATION.md the guide.
 *
 * Every copy of the engine in the archive, found by its exports rather than
 * its name, must be the installed release — at zipp-web/zipp_wasm_bg.wasm the
 * web variant, everywhere else the primary — and each place FormLogic takes a
 * copy from must have one. Every copy of the torch package, found the same
 * way, must be the one the install records, and each place it is known to be
 * must have one.
 *
 * Deterministic apart from the two `builtAt` stamps over one build of the
 * packages: packaging it again (--no-build-packages) gives the same file
 * digests. A fresh build of @softn/core now and then orders its cross-chunk
 * imports differently and so names its chunks differently, which changes
 * digests under hosted-runtime/ and app-editors/ (never zipp/,
 * native-runtime/ or adapter/).
 * Refuses a dirty tree unless --allow-dirty, like package-site.mjs; the
 * release workflow runs it from a clean tag.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeArchive } from './lib/archive.mjs';
import { KNOWN_TORCH_COPIES, PACKAGE_TREES, VARIANT_ENGINE_COPIES, archiveEngineProblems } from './lib/zipp-engine-copy.mjs';
import { archiveName, root } from './release-packages.mjs';
import { TORCH_PACKAGE, WEB_VARIANT, ensureReleaseEngine, packageDir, releaseOptions, variantDir } from '../packages/@softn/core/scripts/fetch-zipp-release.mjs';
import { FRONT_DOOR, startHere } from './release-explainers.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const tag = opt('--tag');
const outDir = path.resolve(root, opt('--out') ?? 'release');
const allowDirty = args.includes('--allow-dirty');
const buildPackages = !args.includes('--no-build-packages');

function fail(message) {
  console.error(`package-formlogic-runtime: ${message}`);
  process.exit(1);
}
if (!tag || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) fail('pass --tag vX.Y.Z (the release tag)');

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const commit = opt('--commit') ?? git('rev-parse', 'HEAD');
if (!/^[0-9a-f]{40}$/.test(commit)) fail(`--commit must be a 40-character sha, not "${commit}"`);
const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
if (dirty && !allowDirty) fail('the working tree has uncommitted changes. A release is built from a clean checkout; pass --allow-dirty for a local trial.');
// Entry timestamps: the commit's own time, so two archives of one commit agree.
const stamp = new Date(git('log', '-1', '--format=%cI', commit));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// ---------------------------------------------------------------------------
// What the tree says: the engine, the protocols, the adapter
// ---------------------------------------------------------------------------
const wasmDir = path.join(root, 'packages/@softn/core/wasm-zipp');
// wasm-zipp/ is generated: install the declared release (or ZIPP_RELEASE /
// ZIPP_SUMS_SHA256) before anything reads it; the package build comes later.
// Only a verified release install ships: every file matches the release's
// SHA256SUMS chain, and the check covers the web variant and the torch package
// beside it, so an
// install that passes here has all three trees. A local build (--install-local) is
// refused here.
const wasmWebDir = variantDir(wasmDir);
// The variant's tree is the one place the content scan allows its digest, so
// the tree is named from that declaration rather than spelt again here.
const variantTree = path.posix.dirname(VARIANT_ENGINE_COPIES[WEB_VARIANT.id]);
if (!variantTree || variantTree === '.') fail(`scripts/lib/zipp-engine-copy.mjs names no place for the ${WEB_VARIANT.id} variant`);
// The torch package's tree, likewise named from the place the content scan expects it.
const wasmTorchDir = packageDir(wasmDir);
const torchTree = PACKAGE_TREES[TORCH_PACKAGE.id];
if (!torchTree || !KNOWN_TORCH_COPIES.some((pattern) => pattern.test(`${torchTree}/${TORCH_PACKAGE.artifact}`))) fail(`scripts/lib/zipp-engine-copy.mjs names no top-level place for the ${TORCH_PACKAGE.id} package`);
let zippSource;
try {
  zippSource = await ensureReleaseEngine({ ...releaseOptions(), dir: wasmDir });
} catch (error) {
  fail(error.message);
}
const wasmBytes = fs.readFileSync(path.join(wasmDir, zippSource.artifact));
const zipp = { version: zippSource.version, sha256: zippSource.sha256 };
// runtime-manifest.json: FormLogic compares version and sha256; release and revision say which build.
const manifestZipp = { ...zipp, release: zippSource.release, revision: zippSource.revision };

const runtimeDir = path.join(root, 'apps/softn-host-php/runtime');
const hostProtocol = readJson(path.join(runtimeDir, 'host-protocol.json'));
const NATIVE_MODULES = ['runner.mjs', 'request-worker.mjs', 'request-hook.mjs', 'wasm-host.mjs', 'migrations.mjs', 'crypto.mjs', 'time.mjs', 'host-protocol.json', 'record-events.mjs'];

// The editor bridge protocol is the `protocol: 1` the hosted editors send in
// `formlogic-editor-ready` (packages/@softn/editor-shared/src/hostedEditor.ts).
const hostedEditorSource = fs.readFileSync(path.join(root, 'packages/@softn/editor-shared/src/hostedEditor.ts'), 'utf8');
const bridge = hostedEditorSource.match(/kind: 'formlogic-editor-ready', protocol: (\d+)/);
if (!bridge) fail('could not read the editor bridge protocol from packages/@softn/editor-shared/src/hostedEditor.ts');
// The engines hosted-runtime/runtime-manifest.json names, read from the shell's
// own RUNTIME_ENGINES so the manifest and the `formlogic:ready` announcement
// cannot name different sets (the same way the editor bridge protocol above is
// read from the editor's own source rather than repeated here). The engine ids
// themselves are deliberately not written anywhere in this file.
const engineInitSource = fs.readFileSync(path.join(root, 'apps/formlogic-host/src/engineInit.ts'), 'utf8');
const enginesDecl = engineInitSource.match(/export const RUNTIME_ENGINES[^=]*=\s*\[([^\]]*)\]/);
if (!enginesDecl) fail('could not read RUNTIME_ENGINES from apps/formlogic-host/src/engineInit.ts');
const hostedEngines = [...enginesDecl[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
if (!hostedEngines.length) fail('apps/formlogic-host/src/engineInit.ts names no runtime engines');
// How many hosted-runtime entry documents a FormLogic has to understand, from
// the same file. An archive whose shell serves more than one document declares
// it, so a FormLogic that only knows how to mount index.html refuses the
// archive by protocol rather than by silently never offering the rest.
const hostedProtocol = engineInitSource.match(/export const HOSTED_ENGINES_PROTOCOL\s*=\s*(\d+)/);
if (!hostedProtocol) fail('could not read HOSTED_ENGINES_PROTOCOL from apps/formlogic-host/src/engineInit.ts');
// And how a reader has to understand an app's logic languages, from the same
// file. The shell derives them from client file names and refuses an engine
// that cannot run them; an archive that declares this is one whose runtime
// follows that rule, so a FormLogic learns the rule before it installs it.
const languagesProtocol = engineInitSource.match(/export const LOGIC_LANGUAGES_PROTOCOL\s*=\s*(\d+)/);
if (!languagesProtocol) fail('could not read LOGIC_LANGUAGES_PROTOCOL from apps/formlogic-host/src/engineInit.ts');

const protocols = {
  nativeProtocol: hostProtocol.nativeProtocol,
  recordEvents: hostProtocol.recordEvents,
  editorBridge: Number(bridge[1]),
  hostedEngines: Number(hostedProtocol[1]),
  logicLanguages: Number(languagesProtocol[1]),
};
for (const [k, v] of Object.entries(protocols)) if (!Number.isInteger(v)) fail(`protocol ${k} is not an integer`);
// Optional runtime capabilities beyond the engines, for FormLogic to switch
// on. Read from the shell's own RUNTIME_FEATURES, like the engine list above,
// so what the manifest offers and what the shell implements are one
// declaration. The key is always present, so a reader never has to tell "this
// build has none" from "this build is older than the idea".
const featuresDecl = engineInitSource.match(/export const RUNTIME_FEATURES[^=]*=\s*\[([^\]]*)\]/);
if (!featuresDecl) fail('could not read RUNTIME_FEATURES from apps/formlogic-host/src/engineInit.ts');
const hostedFeatures = [...featuresDecl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

const adapterBytes = Buffer.from(fs.readFileSync(path.join(root, 'packages/@softn/core/src/integrations/formlogic.ts'), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
const adapter = { path: 'adapter/formlogic.ts', sha256: sha256(adapterBytes) };

// ---------------------------------------------------------------------------
// Build: the shared packages, the host frame, the two hosted editors
// ---------------------------------------------------------------------------
const vite = path.join(root, 'node_modules/vite/bin/vite.js');
if (!fs.existsSync(vite)) fail('node_modules/vite is missing; run npm ci first');
const run = (label, cmd, cmdArgs, options = {}) => {
  console.log(`> ${label}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...options });
  if (r.status !== 0) fail(`${label} failed (exit ${r.status ?? r.signal})`);
};
// npm without a shell: the npm-cli.js that `npm run` names, else the one
// beside the node binary (a plain install), else whatever `npm` is on PATH.
const npmCli = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.join(path.dirname(process.execPath), 'lib/node_modules/npm/bin/npm-cli.js')].find((p) => p && fs.existsSync(p));
if (buildPackages) {
  const npmArgs = ['run', 'build', '-w', '@softn/core', '-w', '@softn/components'];
  if (npmCli) run('build @softn/core and @softn/components', process.execPath, [npmCli, ...npmArgs], { cwd: root });
  else run('build @softn/core and @softn/components', 'npm', npmArgs, { cwd: root, shell: true });
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-formlogic-runtime-'));
const entries = new Map();
const add = (name, data, mode) => {
  if (entries.has(name)) fail(`${name} listed twice`);
  entries.set(name, mode ? { data, mode } : data);
};
const addTree = (dir, prefix, { skip = () => false } = {}) => {
  const walk = (d, rel) => {
    for (const item of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const p = path.join(d, item.name);
      const r = rel ? `${rel}/${item.name}` : item.name;
      if (item.isSymbolicLink()) fail(`${p}: generated output must not contain links`);
      if (item.isDirectory()) walk(p, r);
      else if (item.isFile() && !skip(r)) add(`${prefix}/${r}`, fs.readFileSync(p));
    }
  };
  walk(dir, '');
};
/**
 * FormLogic's runtime-manifest.json: every file under `prefix` except itself,
 * digested. `extra` is merged in between `zipp` and `files`; the hosted runtime
 * uses it to say which engines it serves. formatVersion stays 1 — a reader that
 * knows only the old keys ignores the new ones.
 */
const runtimeManifest = (prefix, extra = {}) => {
  const files = {};
  for (const [name, value] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!name.startsWith(`${prefix}/`)) continue;
    const rel = name.slice(prefix.length + 1);
    if (rel === 'runtime-manifest.json') continue;
    files[rel] = sha256(Buffer.isBuffer(value) ? value : value.data);
  }
  if (!files['index.html'] && !Object.keys(files).some((f) => f.endsWith('/index.html'))) fail(`${prefix}: no index.html was built`);
  return JSON.stringify({ formatVersion: 1, zipp: manifestZipp, ...extra, files }, null, 2) + '\n';
};

try {
  // hosted-runtime/: apps/formlogic-host as FormLogic builds it.
  run('build apps/formlogic-host', process.execPath, [vite, 'build', 'apps/formlogic-host', '--config', 'apps/formlogic-host/vite.config.ts'], { cwd: root });
  addTree(path.join(root, 'apps/formlogic-host/dist'), 'hosted-runtime', { skip: (r) => r.endsWith('.map') });
  add('hosted-runtime/LICENSE', fs.readFileSync(path.join(root, 'LICENSE')));
  add('hosted-runtime/NOTICE', fs.readFileSync(path.join(root, 'NOTICE')));
  add('hosted-runtime/README.txt', Buffer.from('Generated by scripts/build-hosted-runtime.mjs from softn.com/apps/formlogic-host. Apache-2.0. Serve these static assets with Access-Control-Allow-Origin: * for the sandboxed app frame. The parent supplies matching ZIPP bytes through the private initialization channel. index.html runs the ZIPP engines; host.html runs the app author\'s code as the document\'s own JavaScript and is for owners the host has verified. Both are frames, never top-level pages. runtime-manifest.json verifies this complete build.\n'));
  if (!entries.has('hosted-runtime/index.html')) fail('apps/formlogic-host built no index.html');
  // The second entry document. It is index.html with one attribute, and the
  // attribute is why it is a file of its own: it serves the host-JavaScript
  // engine, whose policy has to be weaker, and a meta policy can be tightened
  // after it is written but never relaxed. An archive whose manifest offers
  // that engine without the document to run it in would be one FormLogic could
  // only discover was broken at mount time.
  if (!entries.has('hosted-runtime/host.html')) fail('apps/formlogic-host built no host.html');
  add('hosted-runtime/runtime-manifest.json', Buffer.from(runtimeManifest('hosted-runtime', { engines: hostedEngines, features: hostedFeatures })));

  // app-editors/: Builder and Studio as hosted editors, per editor and as one folder.
  for (const kind of ['builder', 'studio']) {
    const outDirKind = path.join(stage, 'app-editors', kind);
    run(`build apps/softn-${kind} as a hosted editor`, process.execPath, [vite, 'build', '--outDir', outDirKind], {
      cwd: path.join(root, `apps/softn-${kind}`),
      env: { ...process.env, VITE_BASE: `/app-editors/${kind}/`, VITE_FORMLOGIC_EDITOR: '1', TAURI_ENV_PLATFORM: '' },
    });
    if (!fs.existsSync(path.join(outDirKind, 'index.html'))) fail(`${kind} built no index.html`);
    addTree(outDirKind, `app-editors/${kind}`, { skip: (r) => r.endsWith('.map') });
    add(`app-editors/${kind}/runtime-manifest.json`, Buffer.from(runtimeManifest(`app-editors/${kind}`)));
  }
  const builtAt = new Date().toISOString();
  add('app-editors/manifest.json', Buffer.from(JSON.stringify({ protocol: protocols.editorBridge, editors: ['builder', 'studio'], builtAt }) + '\n'));
  add('app-editors/LICENSE', fs.readFileSync(path.join(root, 'LICENSE')));
  add('app-editors/NOTICE', fs.readFileSync(path.join(root, 'NOTICE')));
  add('app-editors/runtime-manifest.json', Buffer.from(runtimeManifest('app-editors')));

  // native-runtime/: the PHP host's runtime files, byte for byte, and the engine.
  const modules = {};
  for (const name of NATIVE_MODULES) {
    const bytes = fs.readFileSync(path.join(runtimeDir, name));
    add(`native-runtime/${name}`, bytes);
    modules[name] = sha256(bytes);
  }
  add('native-runtime/wasm/zipp_wasm.mjs', fs.readFileSync(path.join(wasmDir, 'zipp_wasm.js')));
  add('native-runtime/wasm/zipp_wasm_bg.wasm', wasmBytes);
  add('native-runtime/wasm/SOURCE.json', fs.readFileSync(path.join(wasmDir, 'SOURCE.json')));
  add('native-runtime/LICENSE', fs.readFileSync(path.join(root, 'LICENSE')));
  add('native-runtime/NOTICE', fs.readFileSync(path.join(root, 'NOTICE')));
  add('native-runtime/ZIPP-THIRD-PARTY-LICENSES.txt', fs.readFileSync(path.join(wasmDir, zippSource.notices.file)));
  add('native-runtime/provenance.json', Buffer.from(JSON.stringify({ source: 'softn.com/apps/softn-host-php/runtime', nativeProtocol: protocols.nativeProtocol, zipp: zippSource, modules }, null, 2) + '\n'));

  // zipp/: the release install as it is, so FormLogic installs its browser
  // engine from here and can check it against the SHA256SUMS it came with.
  addTree(wasmDir, 'zipp');
  // zipp-web/: the web variant's install as it is, beside zipp/ and never
  // inside it. Its SOURCE.json is the record zipp/SOURCE.json's `variants.web`
  // names, and its module is the one copy in the archive that may carry the
  // variant's digest.
  addTree(wasmWebDir, variantTree);
  // zipp-torch/: the torch package's install as it is, beside zipp/ like
  // zipp-web/. Its SOURCE.json is the record zipp/SOURCE.json's
  // `packages.torch` names; the copies the built apps carry in
  // assets/core-runtime/ are held to the same digest below.
  addTree(wasmTorchDir, torchTree);

  // adapter/: the FormLogic starter adapter FormLogic vendors.
  add('adapter/formlogic.ts', adapterBytes);
  add('adapter/provenance.json', Buffer.from(JSON.stringify({ source: 'softn.com/packages/@softn/core/src/integrations/formlogic.ts', license: 'Apache-2.0', sha256: adapter.sha256 }, null, 2) + '\n'));

  // The explainer and the guide.
  add(FRONT_DOOR, Buffer.from(startHere('formlogic-runtime', { tag })));
  add('INTEGRATION.md', fs.readFileSync(path.join(root, 'docs/engineering/FORMLOGIC_INTEGRATION.md')));

  // Every engine in the archive, whatever Vite named it, is the installed
  // release: the web variant at its one place, the primary everywhere else.
  const { copies: engineCopies, packageCopies, problems: engineProblems } = archiveEngineProblems(entries, zippSource);
  if (engineProblems.length) fail(`the archive's ZIPP engine:\n  - ${engineProblems.join('\n  - ')}`);

  // softn-release.json last: a digest of everything else.
  const files = {};
  for (const [name, value] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) files[name] = sha256(Buffer.isBuffer(value) ? value : value.data);
  const release = {
    formatVersion: 1,
    tag,
    commit,
    version: tag.replace(/^v/, ''),
    builtAt,
    // The install's whole SOURCE.json, so zipp/SOURCE.json and this record are one identity.
    zipp: zippSource,
    protocols,
    adapter,
    files,
  };
  add('softn-release.json', Buffer.from(JSON.stringify(release, null, 2) + '\n'));

  const name = archiveName('formlogic-runtime', { tag });
  const out = path.join(outDir, name);
  const result = writeArchive(entries, out, { stamp });
  console.log(`wrote ${result.path} (${result.entries.length} files, ${(result.size / 1024 / 1024).toFixed(1)} MB) and ${name}.sha256`);
  console.log(`  softn ${commit.slice(0, 7)}${dirty ? ' (dirty)' : ''} ${tag}, zipp ${zippSource.release} (${engineCopies.length} engine copies and ${packageCopies.length} torch package copies checked), protocols ${JSON.stringify(protocols)}`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
