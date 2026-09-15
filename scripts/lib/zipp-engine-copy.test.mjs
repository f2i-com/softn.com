import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { KNOWN_ENGINE_COPIES, ZIPP_ENGINE_EXPORTS, archiveEngineProblems, isZippEngineWasm, wasmExportNames } from './zipp-engine-copy.mjs';

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
  assert.equal(KNOWN_ENGINE_COPIES.length, 8);
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
