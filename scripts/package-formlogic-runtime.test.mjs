/**
 * The FormLogic runtime archive keeps its contract: FormLogic fetches it from
 * the release instead of building SoftN, and verifies it with the checks it
 * already has (`checkRuntimeArtifact` over the runtime manifests, the engine
 * identity, the protocol numbers, the adapter digest). The build takes a few
 * minutes, so the assembler is run once here against the real tree and the
 * archive it produces is read back and checked entry by entry; set
 * SOFTN_SKIP_FORMLOGIC_RUNTIME_BUILD=1 to skip the build and check only what
 * needs no build.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readArchive } from './lib/archive.mjs';
import { isZippEngineWasm, wasmExportNames, wasmImportNames } from './lib/zipp-engine-copy.mjs';
import { PACKAGES, archiveName, packageById, root } from './release-packages.mjs';
import { HOSTED_ENGINES_PROTOCOL, LOGIC_LANGUAGES_PROTOCOL, RUNTIME_ENGINES, RUNTIME_FEATURES } from '../apps/formlogic-host/src/engineInit.ts';
import { INSTALLED_FILES, VARIANT_INSTALLED_FILES } from '../packages/@softn/core/scripts/fetch-zipp-release.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
// Read rather than imported: the adapter imports acorn and the rest of core,
// and this file only needs the one string it puts in a build. The scan below is
// the whole reason the constant exists, so a rename here is a failure, not a
// silently empty search.
const HOST_JS_ENGINE_MARK = fs
  .readFileSync(path.join(root, 'packages/@softn/core/src/runtime/host-js/host-js-adapter.ts'), 'utf8')
  .match(/export const HOST_JS_ENGINE_MARK = '([^']+)'/)?.[1];
const NATIVE_MODULES = ['runner.mjs', 'request-worker.mjs', 'request-hook.mjs', 'wasm-host.mjs', 'migrations.mjs', 'crypto.mjs', 'time.mjs', 'host-protocol.json', 'record-events.mjs'];

test('the FormLogic runtime package is described like the others and named for FormLogic', () => {
  const pkg = packageById('formlogic-runtime');
  assert.equal(archiveName('formlogic-runtime', { tag: 'v1.2.3' }), 'softn-formlogic-runtime-v1.2.3.zip');
  assert.ok(pkg.inside.some((i) => i.path === 'softn-release.json'));
  for (const folder of ['hosted-runtime/', 'app-editors/', 'native-runtime/', 'zipp/', 'zipp-web/', 'adapter/']) assert.ok(pkg.inside.some((i) => i.path === folder), folder);
  assert.ok(PACKAGES.every((p) => p.id !== 'formlogic-runtime' || p.previousName === ''), 'it never had another name');
});

test('the hosted runtime manifest gets its engines and features from the shell, not a list of its own', () => {
  const packager = fs.readFileSync(path.join(root, 'scripts/package-formlogic-runtime.mjs'), 'utf8');
  assert.ok(packager.includes('apps/formlogic-host/src/engineInit.ts'), 'it reads the shell’s declaration');
  // A second list would be one the handshake could drift away from silently.
  for (const id of RUNTIME_ENGINES) assert.ok(!packager.includes(`'${id}'`), `${id} is not repeated in the packager`);
  assert.ok(RUNTIME_ENGINES.length > 0 && RUNTIME_ENGINES.every((id) => typeof id === 'string'));
  // The same for the capabilities the manifest offers: a build that says it
  // has `python-logic/1` says so because the shell's own declaration does.
  for (const f of RUNTIME_FEATURES) assert.ok(!packager.includes(`'${f}'`), `${f} is not repeated in the packager`);
  assert.ok(RUNTIME_FEATURES.length > 0 && RUNTIME_FEATURES.every((f) => typeof f === 'string'));
  for (const name of ['RUNTIME_FEATURES', 'LOGIC_LANGUAGES_PROTOCOL']) {
    assert.ok(packager.includes(name), `the packager reads ${name}`);
  }
});

test('the packager refuses a shell that stopped declaring what it offers', () => {
  // The one-source-of-truth idiom is only worth anything if the read is
  // required: a rename that made the regex miss must stop the build, not
  // quietly ship an archive that offers nothing.
  const packager = fs.readFileSync(path.join(root, 'scripts/package-formlogic-runtime.mjs'), 'utf8');
  for (const name of ['RUNTIME_ENGINES', 'HOSTED_ENGINES_PROTOCOL', 'RUNTIME_FEATURES', 'LOGIC_LANGUAGES_PROTOCOL']) {
    // Each value is read out of the shell's source, and a read that found
    // nothing stops the build rather than falling back to a number or a list
    // the packager kept of its own.
    assert.ok(
      new RegExp(`engineInitSource\\.match\\(/export const ${name}`).test(packager),
      `${name} is read from the shell's own declaration`
    );
    assert.ok(
      new RegExp(`could not read ${name} from apps/formlogic-host/src/engineInit\\.ts`).test(packager),
      `${name} is a failure, not a default`
    );
  }
});

test('the workflow builds, checks and attaches the archive', () => {
  const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  assert.ok(release.includes('npm run package:formlogic-runtime -- --tag "$RELEASE_TAG"'));
  for (const entry of ['softn-release.json', 'hosted-runtime/index.html', 'hosted-runtime/host.html', 'native-runtime/host-protocol.json', 'zipp/SOURCE.json', 'zipp-web/SOURCE.json', 'zipp-web/zipp_wasm_bg.wasm', 'adapter/formlogic.ts']) assert.ok(release.includes(entry), entry);
  assert.ok(release.includes('softn-formlogic-runtime-${{ env.RELEASE_TAG }}.zip'));
  assert.ok(release.includes('sha256sum -c "softn-formlogic-runtime-$RELEASE_TAG.zip.sha256"'));
  assert.ok(fs.readFileSync(path.join(root, '.github/workflows/build.yml'), 'utf8').includes('release/softn-formlogic-runtime-v*.zip'));
});

test('the archive the assembler writes keeps the contract', { skip: process.env.SOFTN_SKIP_FORMLOGIC_RUNTIME_BUILD === '1' ? 'SOFTN_SKIP_FORMLOGIC_RUNTIME_BUILD=1' : false, timeout: 15 * 60 * 1000 }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-formlogic-runtime-test-'));
  try {
    const tag = 'v9.9.9';
    const run = spawnSync(process.execPath, [path.join(root, 'scripts/package-formlogic-runtime.mjs'), '--tag', tag, '--out', out, '--allow-dirty', '--no-build-packages'], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const name = archiveName('formlogic-runtime', { tag });
    const zip = fs.readFileSync(path.join(out, name));
    assert.equal(fs.readFileSync(path.join(out, `${name}.sha256`), 'utf8').trim(), `${sha256(zip)}  ${name}`, 'the sidecar names the archive and its digest');
    const { entries, problems } = readArchive(zip);
    assert.deepEqual(problems, []);
    const bytes = (n) => {
      const e = entries.get(n);
      assert.ok(e, `${n} is in the archive`);
      return Buffer.isBuffer(e) ? e : e.data;
    };

    // softn-release.json: the tag, the commit, the engine, the protocols, and every other file.
    const release = JSON.parse(bytes('softn-release.json').toString('utf8'));
    assert.equal(release.formatVersion, 1);
    assert.equal(release.tag, tag);
    assert.equal(release.version, '9.9.9');
    assert.match(release.commit, /^[0-9a-f]{40}$/);
    const others = [...entries.keys()].filter((n) => n !== 'softn-release.json').sort();
    assert.deepEqual(Object.keys(release.files).sort(), others, 'files lists every entry but itself');
    for (const n of others) assert.equal(release.files[n], sha256(bytes(n)), `${n} digest`);

    // The engine: the install's SOURCE.json is the record, and the bytes shipped under native-runtime/wasm.
    const wasmZipp = path.join(root, 'packages/@softn/core/wasm-zipp');
    const source = readJson(path.join(wasmZipp, 'SOURCE.json'));
    assert.equal(source.build, 'release');
    assert.deepEqual(release.zipp, source);
    for (const field of ['version', 'sha256', 'revision', 'release', 'bundle', 'bundleSha256', 'sumsSha256', 'variant', 'languages', 'build', 'glueSha256']) assert.ok(release.zipp[field] !== undefined, `release.zipp.${field}`);
    assert.equal(sha256(bytes('native-runtime/wasm/zipp_wasm_bg.wasm')), source.sha256);
    assert.deepEqual(JSON.parse(bytes('native-runtime/wasm/SOURCE.json').toString('utf8')), source);
    assert.ok(bytes('native-runtime/ZIPP-THIRD-PARTY-LICENSES.txt').equals(fs.readFileSync(path.join(wasmZipp, source.notices.file))));

    // zipp/: exactly the install, byte for byte — the eleven files an install
    // has always been, so a reader that knows nothing of variants sees what it
    // always saw; its glue is the native runtime's.
    const installed = fs.readdirSync(wasmZipp).sort();
    assert.deepEqual(installed, [...INSTALLED_FILES].sort(), 'the install is exactly the primary set');
    assert.equal(installed.length, 11);
    assert.deepEqual([...entries.keys()].filter((n) => n.startsWith('zipp/')).map((n) => n.slice('zipp/'.length)).sort(), installed);
    for (const n of installed) assert.equal(sha256(bytes(`zipp/${n}`)), sha256(fs.readFileSync(path.join(wasmZipp, n))), `zipp/${n}`);
    assert.ok(bytes('zipp/zipp_wasm.js').equals(bytes('native-runtime/wasm/zipp_wasm.mjs')));

    // zipp-web/: the web variant's install, byte for byte, a tree of its own
    // at the top level. Its SOURCE.json is the record zipp/SOURCE.json names.
    const wasmZippWeb = path.join(root, 'packages/@softn/core/wasm-zipp-web');
    const variantInstalled = fs.readdirSync(wasmZippWeb).sort();
    assert.deepEqual(variantInstalled, [...VARIANT_INSTALLED_FILES].sort());
    assert.deepEqual([...entries.keys()].filter((n) => n.startsWith('zipp-web/')).map((n) => n.slice('zipp-web/'.length)).sort(), variantInstalled, 'the archive lists exactly the variant install');
    for (const n of variantInstalled) assert.equal(sha256(bytes(`zipp-web/${n}`)), sha256(fs.readFileSync(path.join(wasmZippWeb, n))), `zipp-web/${n}`);
    const web = source.variants.web;
    assert.deepEqual(Object.keys(web).sort(), ['bundle', 'bundleSha256', 'commit', 'glueSha256', 'languages', 'sha256', 'stackBytes', 'variant'], 'the variants.web record FormLogic compares by key');
    assert.deepEqual(release.zipp.variants.web, web, 'softn-release.json carries the variant record');
    assert.equal(sha256(bytes('zipp-web/zipp_wasm_bg.wasm')), web.sha256);
    assert.notEqual(web.sha256, source.sha256, 'the variant is another build');
    assert.equal(web.commit, source.revision, 'of the same source');
    assert.deepEqual(web.languages, ['javascript']);
    assert.equal(web.variant, 'javascript');
    assert.equal(web.stackBytes, 1048576);
    const variantSource = JSON.parse(bytes('zipp-web/SOURCE.json').toString('utf8'));
    for (const [k, v] of Object.entries(web)) assert.deepEqual(variantSource[k], v, `zipp-web/SOURCE.json ${k}`);
    assert.deepEqual(variantSource.primary, { bundle: source.bundle, sha256: source.sha256, glueSha256: source.glueSha256 });
    assert.ok(!('zipp-web/zipp_wasm.js' in Object.fromEntries(entries)), 'no second glue ships; the variant runs under zipp/zipp_wasm.js');
    // The record's other keys are the ones an S1 install always had, unchanged in shape.
    for (const field of ['version', 'sha256', 'revision', 'release', 'bundle', 'bundleSha256', 'sumsSha256', 'variant', 'languages', 'build', 'glueSha256', 'notices']) assert.ok(release.zipp[field] !== undefined, `release.zipp.${field}`);

    // Every engine copy, found by its exports, is the installed release: the
    // web variant at zipp-web/, the primary at all eight known places and
    // nowhere else. The variant asks the host for what the primary asks and
    // exports a subset, which is what lets one glue run both.
    const copies = [...entries.keys()].filter((n) => isZippEngineWasm(bytes(n))).sort();
    const VARIANT_AT = 'zipp-web/zipp_wasm_bg.wasm';
    for (const n of copies) assert.equal(sha256(bytes(n)), n === VARIANT_AT ? web.sha256 : source.sha256, `${n} is the installed ${n === VARIANT_AT ? 'variant' : 'engine'}`);
    assert.equal(copies.filter((n) => sha256(bytes(n)) === web.sha256).length, 1, 'the variant digest appears once');
    assert.equal(copies.filter((n) => sha256(bytes(n)) === source.sha256).length, 8, 'the primary digest appears eight times');
    assert.deepEqual(wasmImportNames(bytes(VARIANT_AT)), wasmImportNames(bytes('zipp/zipp_wasm_bg.wasm')));
    assert.deepEqual(wasmExportNames(bytes(VARIANT_AT)).filter((e) => !wasmExportNames(bytes('zipp/zipp_wasm_bg.wasm')).includes(e)), []);
    const known = [
      /^zipp\/zipp_wasm_bg\.wasm$/,
      /^native-runtime\/wasm\/zipp_wasm_bg\.wasm$/,
      /^hosted-runtime\/assets\/zipp_wasm_bg-[^/]+\.wasm$/,
      /^hosted-runtime\/assets\/core-runtime\/zipp_wasm_bg\.wasm$/,
      /^app-editors\/builder\/assets\/zipp_wasm_bg-[^/]+\.wasm$/,
      /^app-editors\/builder\/assets\/core-runtime\/zipp_wasm_bg\.wasm$/,
      /^app-editors\/studio\/assets\/zipp_wasm_bg-[^/]+\.wasm$/,
      /^app-editors\/studio\/assets\/core-runtime\/zipp_wasm_bg\.wasm$/,
      /^zipp-web\/zipp_wasm_bg\.wasm$/,
    ];
    for (const pattern of known) assert.equal(copies.filter((n) => pattern.test(n)).length, 1, `one engine at ${pattern}`);
    assert.equal(copies.length, known.length, `no engine copy outside the known places: ${copies.join(', ')}`);
    // Neither hosted document nor either editor carries the variant: the
    // package build copies only the primary, and the PWA engine cap is about it.
    for (const n of [...entries.keys()]) {
      if (n.startsWith('zipp-web/')) continue;
      if (n.endsWith('.wasm')) assert.notEqual(sha256(bytes(n)), web.sha256, `${n} is not the variant`);
    }

    // The protocols: what the PHP host's runtime declares, the editor bridge,
    // and how many hosted-runtime entry documents a reader has to understand.
    // A FormLogic that knows only index.html refuses an archive that declares
    // hostedEngines, rather than installing one whose manifest offers an engine
    // it would never mount.
    const hostProtocol = readJson(path.join(root, 'apps/softn-host-php/runtime/host-protocol.json'));
    assert.deepEqual(release.protocols, {
      nativeProtocol: hostProtocol.nativeProtocol,
      recordEvents: hostProtocol.recordEvents,
      editorBridge: 1,
      hostedEngines: HOSTED_ENGINES_PROTOCOL,
      // And how an app's logic languages are read: from its client file names,
      // with an engine that cannot run one of them refused by name.
      logicLanguages: LOGIC_LANGUAGES_PROTOCOL,
    });
    assert.equal(release.protocols.hostedEngines, 1);
    assert.equal(release.protocols.logicLanguages, 1);
    assert.equal(JSON.parse(bytes('app-editors/manifest.json').toString('utf8')).protocol, 1);
    assert.deepEqual(JSON.parse(bytes('app-editors/manifest.json').toString('utf8')).editors, ['builder', 'studio']);

    // native-runtime/: byte-identical copies of the PHP host's runtime, and the provenance FormLogic writes.
    for (const m of NATIVE_MODULES) assert.ok(bytes(`native-runtime/${m}`).equals(fs.readFileSync(path.join(root, 'apps/softn-host-php/runtime', m))), `${m} byte for byte`);
    const provenance = JSON.parse(bytes('native-runtime/provenance.json').toString('utf8'));
    assert.equal(provenance.source, 'softn.com/apps/softn-host-php/runtime');
    assert.equal(provenance.nativeProtocol, hostProtocol.nativeProtocol);
    for (const m of NATIVE_MODULES) assert.equal(provenance.modules[m], sha256(bytes(`native-runtime/${m}`)));
    for (const n of ['native-runtime/wasm/zipp_wasm.mjs', 'native-runtime/LICENSE', 'native-runtime/NOTICE', 'native-runtime/ZIPP-THIRD-PARTY-LICENSES.txt']) bytes(n);

    // adapter/: LF bytes of the canonical adapter, digested the way sync-softn.mjs digests them.
    const adapter = Buffer.from(fs.readFileSync(path.join(root, 'packages/@softn/core/src/integrations/formlogic.ts'), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
    assert.ok(bytes('adapter/formlogic.ts').equals(adapter));
    assert.deepEqual(release.adapter, { path: 'adapter/formlogic.ts', sha256: sha256(adapter) });
    assert.equal(JSON.parse(bytes('adapter/provenance.json').toString('utf8')).sha256, sha256(adapter));

    // The runtime manifests: FormLogic's format, every file but themselves, index.html present.
    const manifestOf = (prefix) => {
      const m = JSON.parse(bytes(`${prefix}/runtime-manifest.json`).toString('utf8'));
      assert.equal(m.formatVersion, 1);
      assert.deepEqual(m.zipp, { version: source.version, sha256: source.sha256, release: source.release, revision: source.revision });
      const expected = [...entries.keys()].filter((n) => n.startsWith(`${prefix}/`) && n !== `${prefix}/runtime-manifest.json`).map((n) => n.slice(prefix.length + 1)).sort();
      assert.deepEqual(Object.keys(m.files).sort(), expected, `${prefix}: manifest lists every file`);
      for (const [rel, digest] of Object.entries(m.files)) assert.equal(digest, sha256(bytes(`${prefix}/${rel}`)), `${prefix}/${rel}`);
      return m;
    };
    const hosted = manifestOf('hosted-runtime');
    assert.ok('index.html' in hosted.files);
    // The hosted runtime says which engines it can be asked to run, read from
    // the shell's own declaration so the manifest and the `formlogic:ready`
    // announcement cannot name different sets. `features` is read the same way
    // and says what else this build can be asked for.
    assert.deepEqual(hosted.engines, [...RUNTIME_ENGINES]);
    assert.deepEqual(hosted.engines, ['host-js', 'zipp-web', 'zipp-web-python']);
    assert.deepEqual(hosted.features, [...RUNTIME_FEATURES]);
    assert.deepEqual(hosted.features, ['python-logic/1']);
    for (const n of ['hosted-runtime/LICENSE', 'hosted-runtime/NOTICE', 'hosted-runtime/README.txt']) bytes(n);

    // The second entry document, and the one thing that differs between it and
    // the first. An engine in the manifest with no document to run it in is an
    // offer FormLogic could only discover was empty at mount time.
    assert.ok('host.html' in hosted.files, 'host.html is in the manifest');
    const indexHtml = bytes('hosted-runtime/index.html').toString('utf8');
    const hostHtml = bytes('hosted-runtime/host.html').toString('utf8');
    assert.equal(
      hostHtml.replace(' data-softn-logic-engine="host-js"', ''),
      indexHtml,
      'the built host.html is the built index.html with one attribute'
    );

    // Where the host-JavaScript engine is, and everywhere it is not. It runs the
    // app author's code as the document's own JavaScript, so a build that was
    // never meant to offer it must not carry it at all: not the editors, which
    // stay on ZIPP, and not the chunks index.html loads.
    assert.match(HOST_JS_ENGINE_MARK ?? '', /^softn\./, 'the adapter still declares its mark');
    const carriers = [...entries.keys()].filter((n) => /\.js$/.test(n) && bytes(n).includes(HOST_JS_ENGINE_MARK));
    assert.equal(carriers.length, 1, `exactly one chunk carries the host engine: ${carriers.join(', ')}`);
    assert.ok(carriers[0].startsWith('hosted-runtime/assets/'), carriers[0]);
    for (const n of [...entries.keys()]) {
      if (!n.startsWith('app-editors/')) continue;
      assert.ok(!bytes(n).includes(HOST_JS_ENGINE_MARK), `${n} is an editor and stays on ZIPP`);
    }
    // index.html loads its entry chunk and preloads the rest of its static
    // graph; the host engine is in none of them, so the document without
    // 'unsafe-eval' never even fetches it.
    const staticGraph = [...indexHtml.matchAll(/(?:src|href)="\.\/([^"]+\.js)"/g)].map((m) => `hosted-runtime/${m[1]}`);
    assert.ok(staticGraph.length > 0, 'index.html names the chunks it loads');
    for (const n of staticGraph) assert.ok(!bytes(n).includes(HOST_JS_ENGINE_MARK), `${n} is in index.html's graph`);
    assert.ok(!staticGraph.includes(carriers[0]), 'the host engine is loaded on demand, by host.html alone');

    // Compiling code at runtime is the host engine's whole method, so the app
    // runtime is worth a census: the only other place `new Function` or `eval`
    // belongs there is the accelerator host, which compiles the numeric
    // functions a bundle generates. (The editors are excluded deliberately:
    // Monaco ships the TypeScript compiler, which compiles at runtime, and they
    // are a same-origin document family of their own.)
    const ACCEL_MARK = 'accel: remade function is not a function';
    for (const n of [...entries.keys()]) {
      if (!n.startsWith('hosted-runtime/') || !n.endsWith('.js')) continue;
      const text = bytes(n).toString('utf8');
      if (!/new Function\(|[^.\w]eval\(/.test(text)) continue;
      assert.ok(
        text.includes(HOST_JS_ENGINE_MARK) || text.includes(ACCEL_MARK),
        `${n} compiles code at runtime and is neither the host engine nor the accelerator host`
      );
    }
    for (const kind of ['builder', 'studio']) {
      const m = manifestOf(`app-editors/${kind}`);
      assert.equal(m.engines, undefined, `${kind} is an editor, not an app runtime`);
      assert.ok('index.html' in m.files, `${kind} index`);
      const wasm = Object.entries(m.files).filter(([p]) => /zipp_wasm_bg(?:-[^/]+)?\.wasm$/.test(p));
      assert.ok(wasm.length > 0 && wasm.every(([, h]) => h === source.sha256), `${kind} carries the installed engine`);
    }
    manifestOf('app-editors');
    assert.ok(![...entries.keys()].some((n) => n.endsWith('.map')), 'no source maps');

    // The front door and the guide.
    const readme = bytes('README.md').toString('utf8');
    assert.ok(readme.startsWith('# Start here: The SoftN runtime for FormLogic\n'));
    assert.ok(readme.includes(`\`${name}\``) && readme.includes('`INTEGRATION.md` in this folder'));
    assert.ok(bytes('INTEGRATION.md').toString('utf8').includes('FormLogic takes the release, not the source'));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
