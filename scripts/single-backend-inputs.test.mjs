import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync} from 'node:fs';
import {join, dirname, basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {prepareZippNotices} from './single-backend-inputs.mjs';

function fixture(t) {
  const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,'softn-backend-notices-'));
  t.after(()=>{
    assert.equal(dirname(realpathSync(root)),parent);
    assert.ok(basename(root).startsWith('softn-backend-notices-'));
    rmSync(root,{recursive:true,force:true});
  });
  const wasm=join(root,'wasm'),notices=join(root,'notices');mkdirSync(wasm);
  const bytes=Buffer.from('local-build-fixture');
  writeFileSync(join(wasm,'zipp_wasm_bg.wasm'),bytes);
  writeFileSync(join(wasm,'SOURCE.json'),JSON.stringify({version:'0.0.18',build:'local',artifact:'zipp_wasm_bg.wasm',sha256:createHash('sha256').update(bytes).digest('hex')}));
  return {wasm,notices};
}

test('local builds package their provenance and all notices without release archive metadata',async t=>{
  const {wasm,notices}=fixture(t);
  writeFileSync(join(wasm,'LICENSE-APACHE'),'upstream-license');
  writeFileSync(join(wasm,'THIRD_PARTY_LICENSES.txt'),'python-parser-notices');
  await prepareZippNotices(wasm,notices);
  assert.equal(readFileSync(join(notices,'ZIPP-LICENSE-APACHE'),'utf8'),'upstream-license');
  assert.equal(readFileSync(join(notices,'ZIPP-THIRD-PARTY-LICENSES.txt'),'utf8'),'python-parser-notices');
  assert.deepEqual(JSON.parse(readFileSync(join(notices,'ZIPP-SOURCE.json'),'utf8')),JSON.parse(readFileSync(join(wasm,'SOURCE.json'),'utf8')));
});

test('local builds require their upstream license and retain the checksum gate',async t=>{
  const {wasm,notices}=fixture(t);
  await assert.rejects(prepareZippNotices(wasm,notices),/missing LICENSE-APACHE/);
  writeFileSync(join(wasm,'LICENSE-APACHE'),'upstream-license');
  writeFileSync(join(wasm,'zipp_wasm_bg.wasm'),'changed');
  await assert.rejects(prepareZippNotices(wasm,notices),/provenance mismatch/);
});
