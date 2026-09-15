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
import { isZippEngineWasm } from './lib/zipp-engine-copy.mjs';
import { PACKAGES, archiveName, packageById, root } from './release-packages.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const NATIVE_MODULES = ['runner.mjs', 'request-worker.mjs', 'request-hook.mjs', 'wasm-host.mjs', 'migrations.mjs', 'crypto.mjs', 'time.mjs', 'host-protocol.json', 'record-events.mjs'];

test('the FormLogic runtime package is described like the others and named for FormLogic', () => {
  const pkg = packageById('formlogic-runtime');
  assert.equal(archiveName('formlogic-runtime', { tag: 'v1.2.3' }), 'softn-formlogic-runtime-v1.2.3.zip');
  assert.ok(pkg.inside.some((i) => i.path === 'softn-release.json'));
  for (const folder of ['hosted-runtime/', 'app-editors/', 'native-runtime/', 'zipp/', 'adapter/']) assert.ok(pkg.inside.some((i) => i.path === folder), folder);
  assert.ok(PACKAGES.every((p) => p.id !== 'formlogic-runtime' || p.previousName === ''), 'it never had another name');
});

test('the workflow builds, checks and attaches the archive', () => {
  const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  assert.ok(release.includes('npm run package:formlogic-runtime -- --tag "$RELEASE_TAG"'));
  for (const entry of ['softn-release.json', 'hosted-runtime/index.html', 'native-runtime/host-protocol.json', 'adapter/formlogic.ts']) assert.ok(release.includes(entry), entry);
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

    // zipp/: exactly the install, byte for byte; its glue is the native runtime's.
    const installed = fs.readdirSync(wasmZipp).sort();
    assert.deepEqual([...entries.keys()].filter((n) => n.startsWith('zipp/')).map((n) => n.slice('zipp/'.length)).sort(), installed);
    for (const n of installed) assert.equal(sha256(bytes(`zipp/${n}`)), sha256(fs.readFileSync(path.join(wasmZipp, n))), `zipp/${n}`);
    assert.ok(bytes('zipp/zipp_wasm.js').equals(bytes('native-runtime/wasm/zipp_wasm.mjs')));

    // Every engine copy, found by its exports, is the installed release, and all eight known ones are there.
    const copies = [...entries.keys()].filter((n) => isZippEngineWasm(bytes(n))).sort();
    for (const n of copies) assert.equal(sha256(bytes(n)), source.sha256, `${n} is the installed engine`);
    const known = [
      /^zipp\/zipp_wasm_bg\.wasm$/,
      /^native-runtime\/wasm\/zipp_wasm_bg\.wasm$/,
      /^hosted-runtime\/assets\/zipp_wasm_bg-[^/]+\.wasm$/,
      /^hosted-runtime\/assets\/core-runtime\/zipp_wasm_bg\.wasm$/,
      /^app-editors\/builder\/assets\/zipp_wasm_bg-[^/]+\.wasm$/,
      /^app-editors\/builder\/assets\/core-runtime\/zipp_wasm_bg\.wasm$/,
      /^app-editors\/studio\/assets\/zipp_wasm_bg-[^/]+\.wasm$/,
      /^app-editors\/studio\/assets\/core-runtime\/zipp_wasm_bg\.wasm$/,
    ];
    for (const pattern of known) assert.equal(copies.filter((n) => pattern.test(n)).length, 1, `one engine at ${pattern}`);
    assert.equal(copies.length, known.length, `no engine copy outside the known places: ${copies.join(', ')}`);

    // The protocols: what the PHP host's runtime declares, and the editor bridge.
    const hostProtocol = readJson(path.join(root, 'apps/softn-host-php/runtime/host-protocol.json'));
    assert.deepEqual(release.protocols, { nativeProtocol: hostProtocol.nativeProtocol, recordEvents: hostProtocol.recordEvents, editorBridge: 1 });
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
    assert.ok('index.html' in manifestOf('hosted-runtime').files);
    for (const n of ['hosted-runtime/LICENSE', 'hosted-runtime/NOTICE', 'hosted-runtime/README.txt']) bytes(n);
    for (const kind of ['builder', 'studio']) {
      const m = manifestOf(`app-editors/${kind}`);
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
