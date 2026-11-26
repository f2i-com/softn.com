import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readArchive, writeArchive } from './archive.mjs';
import { COPIES_FORMAT, COPY_MIN_BYTES, materializeCopies, planCopies } from './archive-copies.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const big = (seed) => Buffer.from(`${seed}:`.repeat(Math.ceil((COPY_MIN_BYTES + 10) / (seed.length + 1))));

test('each content is stored once, in the ZIPP trees first, and small, root and zipp-tools files are left as they are', () => {
  const engine = big('engine');
  const chunk = big('chunk');
  const licence = Buffer.from('small licence text');
  const entries = new Map([
    ['app-editors/builder/assets/vendor.js', chunk],
    ['app-editors/studio/assets/vendor.js', chunk],
    ['hosted-runtime/LICENSE', licence],
    ['native-runtime/LICENSE', licence],
    // Sorts before zipp/ by name; zipp/ is still the one stored.
    ['native-runtime/wasm/zipp_wasm_bg.wasm', engine],
    ['zipp/zipp_wasm_bg.wasm', engine],
    ['zipp-tools/scripts/engine.wasm', engine],
    ['README.md', chunk],
  ]);
  assert.deepEqual(planCopies(entries), {
    'app-editors/studio/assets/vendor.js': 'app-editors/builder/assets/vendor.js',
    'native-runtime/wasm/zipp_wasm_bg.wasm': 'zipp/zipp_wasm_bg.wasm',
  });
});

test('the same bytes with another mode are not one file', () => {
  const runner = big('runner');
  const entries = new Map([
    ['native-runtime/bin/runner', { data: runner, mode: 0o100755 }],
    ['native-runtime/lib/runner.txt', runner],
  ]);
  assert.deepEqual(planCopies(entries), {});
});

test('an archive written without its copies reads back, filled in, as every file it lists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-archive-copies-'));
  try {
    const engine = big('engine');
    const tool = { data: big('tool'), mode: 0o100755 };
    const all = new Map([
      ['zipp/zipp_wasm_bg.wasm', engine],
      ['native-runtime/wasm/zipp_wasm_bg.wasm', engine],
      ['native-runtime/bin/a', tool],
      ['native-runtime/bin/b', tool],
      ['hosted-runtime/index.html', Buffer.from('<!doctype html>')],
    ]);
    const files = Object.fromEntries([...all].map(([n, v]) => [n, sha256(Buffer.isBuffer(v) ? v : v.data)]));
    const copies = planCopies(all);
    assert.deepEqual(copies, { 'native-runtime/bin/b': 'native-runtime/bin/a', 'native-runtime/wasm/zipp_wasm_bg.wasm': 'zipp/zipp_wasm_bg.wasm' });
    const stored = new Map([...all].filter(([n]) => !Object.hasOwn(copies, n)));
    const out = path.join(dir, 'a.zip');
    writeArchive(stored, out, { stamp: new Date('2026-01-01T00:00:00Z'), sidecar: false });
    const { entries, problems } = readArchive(fs.readFileSync(out));
    assert.deepEqual(problems, []);
    assert.equal(entries.size, 3);
    const filled = materializeCopies(entries, { formatVersion: COPIES_FORMAT, files, copies });
    assert.deepEqual([...filled.keys()].sort(), [...all.keys()].sort());
    for (const [name, value] of all) {
      assert.equal(sha256(filled.get(name).data), files[name], name);
      assert.equal(filled.get(name).mode, Buffer.isBuffer(value) ? 0o100644 : value.mode, `${name} mode`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an archive whose copies are not sound is refused, and one from before copies is read as it is', () => {
  const engine = { data: big('engine'), mode: 0o100644 };
  const entries = new Map([['zipp/zipp_wasm_bg.wasm', engine]]);
  const files = { 'zipp/zipp_wasm_bg.wasm': sha256(engine.data), 'native-runtime/wasm/zipp_wasm_bg.wasm': sha256(engine.data) };
  const v2 = (copies, more = {}) => ({ formatVersion: COPIES_FORMAT, files, copies, ...more });

  assert.equal(materializeCopies(entries, { formatVersion: 1, files }), entries);
  assert.throws(() => materializeCopies(entries, { formatVersion: 1, files, copies: {} }), /only formatVersion 2 has them/);
  assert.throws(() => materializeCopies(entries, { formatVersion: COPIES_FORMAT, files }), /has no copies object/);
  assert.throws(() => materializeCopies(entries, v2([])), /has no copies object/);
  assert.throws(() => materializeCopies(entries, v2({ 'zipp/zipp_wasm_bg.wasm': 'zipp/zipp_wasm_bg.wasm' })), /is stored in the archive/);
  assert.throws(() => materializeCopies(entries, v2({ 'native-runtime/wasm/zipp_wasm_bg.wasm': 'zipp/missing.wasm' })), /does not store/);
  assert.throws(() => materializeCopies(entries, v2({ 'native-runtime/wasm/zipp_wasm_bg.wasm': 7 })), /from no entry/);
  assert.throws(() => materializeCopies(entries, v2({ 'native-runtime/other.wasm': 'zipp/zipp_wasm_bg.wasm' })), /does not list it/);
  assert.throws(
    () => materializeCopies(entries, v2({ 'native-runtime/wasm/zipp_wasm_bg.wasm': 'zipp/zipp_wasm_bg.wasm', 'native-runtime/x.wasm': 'native-runtime/wasm/zipp_wasm_bg.wasm' }, { files: { ...files, 'native-runtime/x.wasm': files['zipp/zipp_wasm_bg.wasm'] } })),
    /itself a copy/
  );
  for (const bad of ['../escape.wasm', '/abs.wasm', 'a\\b.wasm', 'a//b.wasm', 'a/./b.wasm']) {
    assert.throws(() => materializeCopies(entries, v2({ [bad]: 'zipp/zipp_wasm_bg.wasm' }, { files: { ...files, [bad]: files['zipp/zipp_wasm_bg.wasm'] } })), /not a name an archive entry can have/, bad);
  }
  const filled = materializeCopies(entries, v2({ 'native-runtime/wasm/zipp_wasm_bg.wasm': 'zipp/zipp_wasm_bg.wasm' }));
  assert.equal(filled.size, 2);
  assert.notEqual(filled, entries, 'the archive read stays as it was read');
  assert.equal(entries.size, 1);
});
