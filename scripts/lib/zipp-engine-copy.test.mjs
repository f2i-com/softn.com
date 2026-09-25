import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { KNOWN_ENGINE_COPIES, KNOWN_TORCH_COPIES, VARIANT_ENGINE_COPIES, ZIPP_ENGINE_EXPORTS, ZIPP_TORCH_EXPORTS, archiveEngineProblems, isZippEngineWasm, isZippTorchPackageWasm, wasmExportNames, wasmImportNames } from './zipp-engine-copy.mjs';

/** A valid module exporting one function under each name: (type () -> ()), one body, one export per name. */
function moduleExporting(names) {
  const u32 = (n) => {
    const out = [];
    do {
      let byte = n & 0x7f;
      n >>>= 7;
      if (n) byte |= 0x80;
      out.push(byte);
    } while (n);
    return out;
  };
  const section = (id, payload) => [id, ...u32(payload.length), ...payload];
  const text = (s) => [...u32(Buffer.byteLength(s)), ...Buffer.from(s)];
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(3, [1, 0]),
    ...section(7, [...u32(names.length), ...names.flatMap((name) => [...text(name), 0x00, 0])]),
    ...section(10, [1, 2, 0, 0x0b]),
  ]);
}

test('a module exporting the three engine names is the engine, whatever else it exports', () => {
  const engine = moduleExporting(['memory_like', ...ZIPP_ENGINE_EXPORTS, 'other']);
  assert.ok(WebAssembly.validate(engine), 'the fixture is a real module');
  assert.deepEqual(wasmExportNames(engine), ['memory_like', ...ZIPP_ENGINE_EXPORTS, 'other']);
  assert.equal(isZippEngineWasm(engine), true);
  assert.equal(isZippEngineWasm(new Uint8Array(engine)), true, 'fflate hands out Uint8Arrays');
});

test('any other module, and anything that is not a module, is not', () => {
  const kernels = moduleExporting(['relu', 'matmul', 'zippProfile']);
  assert.ok(WebAssembly.validate(kernels));
  assert.equal(isZippEngineWasm(kernels), false, 'two of the three names are not enough');
  assert.equal(isZippEngineWasm(moduleExporting([])), false);
  assert.equal(isZippEngineWasm(Buffer.from('<!doctype html>')), false);
  assert.equal(isZippEngineWasm(Buffer.alloc(0)), false);
  const truncated = moduleExporting(ZIPP_ENGINE_EXPORTS).subarray(0, 20);
  assert.equal(wasmExportNames(truncated), null, 'a truncated module is not read past its end');
  assert.equal(isZippEngineWasm(truncated), false);
});

/** An archive's entries with the engine at every place FormLogic takes it from, the glue twice, and a kernel module beside them. */
function archive() {
  const engine = moduleExporting(ZIPP_ENGINE_EXPORTS);
  const source = { release: 'v0.0.18', sha256: createHash('sha256').update(engine).digest('hex') };
  const glue = Buffer.from('export function initSync() {}\n');
  const entries = new Map([
    ['zipp/zipp_wasm_bg.wasm', engine],
    ['zipp/zipp_wasm.js', glue],
    ['native-runtime/wasm/zipp_wasm_bg.wasm', { data: engine, mode: 0o644 }],
    ['native-runtime/wasm/zipp_wasm.mjs', Buffer.from(glue)],
    ['hosted-runtime/assets/kernels-1a2b.wasm', moduleExporting(['relu', 'zippProfile'])],
    ['hosted-runtime/index.html', Buffer.from('<!doctype html>')],
  ]);
  for (const prefix of ['hosted-runtime', 'app-editors/builder', 'app-editors/studio']) {
    entries.set(`${prefix}/assets/zipp_wasm_bg-C4f3.wasm`, new Uint8Array(engine));
    entries.set(`${prefix}/assets/core-runtime/zipp_wasm_bg.wasm`, engine);
  }
  return { engine, source, entries };
}

test('an archive whose every engine copy is the installed release, at every known place, has no problems', () => {
  const { source, entries } = archive();
  const { copies, problems } = archiveEngineProblems(entries, source);
  assert.deepEqual(problems, []);
  assert.equal(copies.length, 8);
  assert.equal(KNOWN_ENGINE_COPIES.length, 8, 'the primary set: the variant is not one of them');
  assert.deepEqual(VARIANT_ENGINE_COPIES, { web: 'zipp-web/zipp_wasm_bg.wasm' }, 'a top-level tree of its own, never inside zipp/');
  for (const pattern of KNOWN_ENGINE_COPIES) assert.equal(copies.filter((name) => pattern.test(name)).length, 1, `${pattern}`);
});

test('an engine of another build anywhere in the archive is a problem, whatever it is called', () => {
  const { source, entries } = archive();
  entries.set('hosted-runtime/assets/other-abc.wasm', moduleExporting([...ZIPP_ENGINE_EXPORTS, 'debug_dump']));
  entries.set('app-editors/studio/assets/core-runtime/zipp_wasm_bg.wasm', { data: moduleExporting([...ZIPP_ENGINE_EXPORTS, 'older']), mode: 0o644 });
  assert.deepEqual(archiveEngineProblems(entries, source).problems.sort(), [
    `app-editors/studio/assets/core-runtime/zipp_wasm_bg.wasm is a ZIPP engine, but not ZIPP v0.0.18 (${source.sha256.slice(0, 12)})`,
    `hosted-runtime/assets/other-abc.wasm is a ZIPP engine, but not ZIPP v0.0.18 (${source.sha256.slice(0, 12)})`,
  ]);
});

test('a known place without an engine is a problem, even when a file of that name is there', () => {
  const { source, entries } = archive();
  entries.delete('app-editors/builder/assets/core-runtime/zipp_wasm_bg.wasm');
  entries.set('native-runtime/wasm/zipp_wasm_bg.wasm', Buffer.from('not a module'));
  const { problems } = archiveEngineProblems(entries, source);
  assert.deepEqual(problems, [
    `no ZIPP engine matches ${KNOWN_ENGINE_COPIES[1]}; FormLogic takes a copy from there`,
    `no ZIPP engine matches ${KNOWN_ENGINE_COPIES[5]}; FormLogic takes a copy from there`,
  ]);
  assert.match(problems[1], /app-editors\\\/builder\\\/assets\\\/core-runtime/);
});

test('the native runtime\'s glue has to be zipp/\'s, byte for byte', () => {
  const { source, entries } = archive();
  entries.set('native-runtime/wasm/zipp_wasm.mjs', Buffer.from('export function initSync() { }\n'));
  assert.deepEqual(archiveEngineProblems(entries, source).problems, ['native-runtime/wasm/zipp_wasm.mjs is not zipp/zipp_wasm.js']);
  entries.delete('native-runtime/wasm/zipp_wasm.mjs');
  assert.deepEqual(archiveEngineProblems(entries, source).problems, ['native-runtime/wasm/zipp_wasm.mjs is not zipp/zipp_wasm.js']);
});

test('the installed engine is recognised by its exports', { skip: !fs.existsSync(new URL('../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm', import.meta.url)) && 'no engine installed' }, () => {
  const bytes = fs.readFileSync(new URL('../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm', import.meta.url));
  assert.equal(isZippEngineWasm(bytes), true);
  const compiled = WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((e) => e.name);
  assert.deepEqual(wasmExportNames(bytes), compiled, 'the parser reads what the compiler reads');
});

/** The engine's import section as a compiled module reads it, in the same `module.name:kind` spelling. */
const compiledImports = (bytes) => WebAssembly.Module.imports(new WebAssembly.Module(bytes)).map((i) => `${i.module}.${i.name}:${i.kind}`);

/** A module importing `imports` ([module, name] pairs, all functions of type () -> ()) and exporting `names`. */
function moduleImporting(imports, names = []) {
  const u32 = (n) => {
    const out = [];
    do {
      let byte = n & 0x7f;
      n >>>= 7;
      if (n) byte |= 0x80;
      out.push(byte);
    } while (n);
    return out;
  };
  const section = (id, payload) => [id, ...u32(payload.length), ...payload];
  const text = (s) => [...u32(Buffer.byteLength(s)), ...Buffer.from(s)];
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(2, [...u32(imports.length), ...imports.flatMap(([module, name]) => [...text(module), ...text(name), 0x00, 0])]),
    ...section(3, [1, 0]),
    ...section(7, [...u32(names.length), ...names.flatMap((name) => [...text(name), 0x00, ...u32(imports.length)])]),
    ...section(10, [1, 2, 0, 0x0b]),
  ]);
}

test('the imports of a module are read as the compiler reads them, and anything else is not a module', () => {
  const module = moduleImporting([['env', 'log'], ['wbg', '__wbg_new_abc123']], ['run']);
  assert.ok(WebAssembly.validate(module), 'the fixture is a real module');
  assert.deepEqual(wasmImportNames(module), ['env.log:function', 'wbg.__wbg_new_abc123:function']);
  assert.deepEqual(wasmImportNames(module), compiledImports(module));
  assert.deepEqual(wasmImportNames(moduleImporting([])), [], 'a module importing nothing');
  assert.deepEqual(wasmImportNames(moduleExporting(['a'])), [], 'a module without an import section');
  assert.equal(wasmImportNames(Buffer.from('not wasm')), null);
  assert.equal(wasmImportNames(module.subarray(0, 24)), null, 'a truncated module is not read past its end');
});

test('a variant of the engine may carry its own digest at its one place, and nowhere else', () => {
  const { engine, entries } = archive();
  const web = moduleExporting(ZIPP_ENGINE_EXPORTS.slice().reverse());
  assert.notEqual(createHash('sha256').update(web).digest('hex'), createHash('sha256').update(engine).digest('hex'));
  const source = { release: 'v0.0.18', sha256: createHash('sha256').update(engine).digest('hex'), variants: { web: { sha256: createHash('sha256').update(web).digest('hex') } } };
  // Recorded but absent: a problem naming the place.
  assert.deepEqual(archiveEngineProblems(entries, source).problems, ['no ZIPP engine at zipp-web/zipp_wasm_bg.wasm; SOURCE.json records the web variant there']);
  // At its place: accepted, and counted among the copies.
  entries.set('zipp-web/zipp_wasm_bg.wasm', web);
  const ok = archiveEngineProblems(entries, source);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.copies.length, 9);
  // The primary at the variant's place is as wrong as the variant anywhere else.
  entries.set('zipp-web/zipp_wasm_bg.wasm', engine);
  assert.deepEqual(archiveEngineProblems(entries, source).problems, [`zipp-web/zipp_wasm_bg.wasm is a ZIPP engine, but not the web variant of ZIPP v0.0.18 (${source.variants.web.sha256.slice(0, 12)})`]);
  entries.set('zipp-web/zipp_wasm_bg.wasm', web);
  for (const elsewhere of ['zipp/zipp_wasm_bg.wasm', 'hosted-runtime/assets/zipp_wasm_bg-C4f3.wasm', 'zipp-web/other.wasm', 'app-editors/studio/assets/core-runtime/zipp_wasm_bg.wasm']) {
    const copy = new Map(entries);
    copy.set(elsewhere, web);
    const { problems } = archiveEngineProblems(copy, source);
    assert.ok(problems.some((p) => p.startsWith(`${elsewhere} is a ZIPP engine, but not ZIPP v0.0.18 (${source.sha256.slice(0, 12)})`)), `${elsewhere}: ${problems.join(' | ')}`);
  }
  // No variant recorded: the web digest at zipp-web/ is just another engine the release does not ship.
  const { variants, ...unrecorded } = source;
  assert.deepEqual(archiveEngineProblems(entries, unrecorded).problems, [`zipp-web/zipp_wasm_bg.wasm is a ZIPP engine, but not ZIPP v0.0.18 (${source.sha256.slice(0, 12)})`]);
  // A variant the archive has no place for, or one without a digest, is refused rather than looked for.
  assert.deepEqual(archiveEngineProblems(entries, { ...source, variants: { ...variants, wasi: { sha256: 'f'.repeat(64) } } }).problems, ['SOURCE.json records a wasi variant of the engine, and the archive has no place for one']);
  assert.deepEqual(archiveEngineProblems(entries, { ...source, variants: { web: {} } }).problems, ['SOURCE.json records the web variant without a sha256', `zipp-web/zipp_wasm_bg.wasm is a ZIPP engine, but not ZIPP v0.0.18 (${source.sha256.slice(0, 12)})`]);
});

test('the installed web variant imports and exports a subset of what the engine does', { skip: !fs.existsSync(new URL('../../packages/@softn/core/wasm-zipp-web/zipp_wasm_bg.wasm', import.meta.url)) && 'no web variant installed' }, () => {
  const engine = fs.readFileSync(new URL('../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm', import.meta.url));
  const web = fs.readFileSync(new URL('../../packages/@softn/core/wasm-zipp-web/zipp_wasm_bg.wasm', import.meta.url));
  assert.equal(isZippEngineWasm(web), true, 'the variant is found by the content scan');
  // Since 0.0.21 the engine alone imports the torch kernel hook; the web build has no torch.
  const [webImports, engineImports] = [wasmImportNames(web), wasmImportNames(engine)];
  assert.deepEqual(webImports.filter((name) => !engineImports.includes(name)), []);
  assert.deepEqual(engineImports.filter((name) => !webImports.includes(name)).map((name) => name.replace(/_[0-9a-f]{16}:/, ':')), ['./zipp_wasm_bg.js.__wbg_zippTorchKernel:function'], 'the engine adds exactly the torch kernel hook');
  assert.deepEqual(wasmImportNames(engine), compiledImports(engine), 'the parser reads what the compiler reads');
  const [webExports, engineExports] = [wasmExportNames(web), wasmExportNames(engine)];
  assert.deepEqual(webExports.filter((name) => !engineExports.includes(name)), []);
  assert.deepEqual(engineExports.filter((name) => !webExports.includes(name)).sort(), ['addPythonPackage', 'engine_initPythonProject', 'engine_pythonCall', 'engine_pythonHas', 'engine_setPythonInput', 'engine_takeHostRequests', 'engine_takeUi', 'prewarmPython', 'pythonPackages'], 'the engine adds exactly its Python entry points');
});

test('the torch package the install records is at each of its places and nowhere else under another digest', () => {
  const { source: engineSource, entries } = archive();
  const torch = moduleExporting(ZIPP_TORCH_EXPORTS);
  assert.ok(WebAssembly.validate(torch));
  assert.equal(isZippTorchPackageWasm(torch), true);
  assert.equal(isZippEngineWasm(torch), false, 'a package is not an engine');
  assert.equal(isZippTorchPackageWasm(moduleExporting(ZIPP_ENGINE_EXPORTS)), false, 'nor an engine a package');
  assert.equal(isZippTorchPackageWasm(moduleExporting(ZIPP_TORCH_EXPORTS.slice(1))), false, 'every export the loader reads');
  const digest = createHash('sha256').update(torch).digest('hex');
  const source = { ...engineSource, packages: { torch: { sha256: digest } } };
  // Recorded: every known place must hold it.
  assert.deepEqual(archiveEngineProblems(entries, source).problems, KNOWN_TORCH_COPIES.map((pattern) => `no torch package matches ${pattern}; SOURCE.json records one, and the runtime takes it from there`));
  const places = ['zipp-torch/zipp_torch.wasm', 'hosted-runtime/assets/core-runtime/zipp_torch.wasm', 'app-editors/builder/assets/core-runtime/zipp_torch.wasm', 'app-editors/studio/assets/core-runtime/zipp_torch.wasm'];
  for (const place of places) entries.set(place, torch);
  const ok = archiveEngineProblems(entries, source);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.packageCopies.sort(), [...places].sort());
  assert.equal(ok.copies.length, 8, 'the package is not counted as an engine');
  for (const pattern of KNOWN_TORCH_COPIES) assert.equal(places.filter((name) => pattern.test(name)).length, 1, `${pattern}`);
  // Another build of the package anywhere, whatever it is called.
  const other = moduleExporting([...ZIPP_TORCH_EXPORTS, 'debug']);
  const copy = new Map(entries);
  copy.set('hosted-runtime/assets/zipp_torch-9f8e.wasm', other);
  copy.set('app-editors/studio/assets/core-runtime/zipp_torch.wasm', { data: other, mode: 0o644 });
  assert.deepEqual(archiveEngineProblems(copy, source).problems.sort(), [
    `app-editors/studio/assets/core-runtime/zipp_torch.wasm is ZIPP's torch package, but not ZIPP v0.0.18's (${digest.slice(0, 12)})`,
    `hosted-runtime/assets/zipp_torch-9f8e.wasm is ZIPP's torch package, but not ZIPP v0.0.18's (${digest.slice(0, 12)})`,
  ]);
  // Not recorded: a package in the archive is one nothing vouches for.
  assert.deepEqual(archiveEngineProblems(entries, engineSource).problems, places.map((place) => `${place} is ZIPP's torch package, and SOURCE.json records none (packages.torch)`));
  assert.deepEqual(archiveEngineProblems(entries, { ...engineSource, packages: { torch: {} } }).problems, ['SOURCE.json records the torch package without a sha256']);
});

test('the installed torch package is recognised by its exports, and imports nothing', { skip: !fs.existsSync(new URL('../../packages/@softn/core/wasm-zipp-torch/zipp_torch.wasm', import.meta.url)) && 'no torch package installed' }, () => {
  const bytes = fs.readFileSync(new URL('../../packages/@softn/core/wasm-zipp-torch/zipp_torch.wasm', import.meta.url));
  assert.equal(isZippTorchPackageWasm(bytes), true);
  assert.equal(isZippEngineWasm(bytes), false);
  assert.deepEqual(wasmImportNames(bytes), []);
  assert.deepEqual(wasmExportNames(bytes), WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((e) => e.name), 'the parser reads what the compiler reads');
});
