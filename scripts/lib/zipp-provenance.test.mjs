import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkZippProvenance } from './zipp-provenance.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function install(t, fields = {}, notices = 'RustPython and Unicode notices\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-zipp-provenance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wasm = Buffer.from('engine');
  fs.writeFileSync(path.join(dir, 'zipp_wasm_bg.wasm'), wasm);
  fs.writeFileSync(path.join(dir, 'THIRD_PARTY_LICENSES.txt'), notices);
  const zipp = {
    repository: 'https://github.com/f2i-com/zipp.org',
    release: 'v0.0.18',
    version: '0.0.18',
    revision: 'f'.repeat(40),
    build: 'release',
    license: 'Apache-2.0',
    artifact: 'zipp_wasm_bg.wasm',
    sha256: sha256(wasm),
    notices: { file: 'THIRD_PARTY_LICENSES.txt', source: 'zipp-release', sha256: sha256(notices) },
    ...fields,
  };
  return { dir, zipp };
}

test('a release install with its notices passes the check, and curated notices are named in a warning', (t) => {
  const { dir, zipp } = install(t);
  const warnings = [];
  const found = checkZippProvenance(zipp, dir, { check: true, warn: (m) => warnings.push(m) });
  assert.deepEqual(found, { artifact: path.join(dir, 'zipp_wasm_bg.wasm'), sha256: zipp.sha256, notices: path.join(dir, 'THIRD_PARTY_LICENSES.txt') });
  assert.deepEqual(warnings, []);
  checkZippProvenance({ ...zipp, notices: { ...zipp.notices, source: 'softn-curated' } }, dir, { check: true, warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ZIPP v0\.0\.18 ships no third-party notices; .*curated/);
});

test('the check refuses a local build and an install that records no notices; the inventory alone does not', (t) => {
  const { dir, zipp } = install(t);
  const local = { ...zipp, build: 'local', notices: undefined };
  assert.throws(() => checkZippProvenance(local, dir, { check: true }), /'local' build; a release ships only a verified ZIPP release/);
  assert.throws(() => checkZippProvenance({ ...zipp, notices: undefined }, dir, { check: true }), /records no third-party notices/);
  assert.equal(checkZippProvenance(local, dir).notices, path.join(dir, 'THIRD_PARTY_LICENSES.txt'), 'a local site build still finds the notices by their old name');
});

test('the notices are read from the file SOURCE.json names, and must be the ones it records', (t) => {
  const { dir, zipp } = install(t);
  fs.renameSync(path.join(dir, 'THIRD_PARTY_LICENSES.txt'), path.join(dir, 'NOTICES.txt'));
  assert.equal(checkZippProvenance({ ...zipp, notices: { ...zipp.notices, file: 'NOTICES.txt' } }, dir, { check: true }).notices, path.join(dir, 'NOTICES.txt'));
  assert.throws(() => checkZippProvenance(zipp, dir, { check: true }), /missing notices file: THIRD_PARTY_LICENSES\.txt/);
  fs.appendFileSync(path.join(dir, 'NOTICES.txt'), 'edited');
  assert.throws(() => checkZippProvenance({ ...zipp, notices: { ...zipp.notices, file: 'NOTICES.txt' } }, dir), /notices are stale/);
  assert.throws(() => checkZippProvenance({ ...zipp, notices: { ...zipp.notices, file: '../outside.txt' } }, dir), /unsafe notices file/);
});

test('the engine digest and the source fields are still checked', (t) => {
  const { dir, zipp } = install(t);
  assert.throws(() => checkZippProvenance({ ...zipp, sha256: '0'.repeat(64) }, dir), /hash is stale/);
  assert.throws(() => checkZippProvenance({ ...zipp, revision: 'abc' }, dir), /not a full Git commit/);
  assert.throws(() => checkZippProvenance({ ...zipp, artifact: '../zipp_wasm_bg.wasm' }, dir), /unsafe artifact/);
});
