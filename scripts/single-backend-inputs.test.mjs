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

test('release installs package their provenance and the notices the install recorded',async t=>{
  const {wasm,notices}=fixture(t);
  const sha=b=>createHash('sha256').update(b).digest('hex');
  const wasmSha=sha(readFileSync(join(wasm,'zipp_wasm_bg.wasm')));
  // fetch-zipp-release.mjs's record: LICENSE-APACHE is in the install, so no bundle is downloaded.
  const source={repository:'https://github.com/f2i-com/zipp.org',release:'v0.0.18',version:'0.0.18',revision:'f'.repeat(40),build:'release',bundle:'zipp-wasm-0.0.18-web-python.zip',bundleSha256:'0'.repeat(64),sumsSha256:'1'.repeat(64),variant:'javascript-python',languages:['javascript','python'],stackBytes:16777216,license:'Apache-2.0',artifact:'zipp_wasm_bg.wasm',sha256:wasmSha,glueSha256:'2'.repeat(64),notices:{file:'THIRD_PARTY_LICENSES.txt',source:'softn-curated',sha256:sha('curated-notices')}};
  writeFileSync(join(wasm,'SOURCE.json'),JSON.stringify(source,null,2));
  writeFileSync(join(wasm,'LICENSE-APACHE'),'release-license');
  writeFileSync(join(wasm,'THIRD_PARTY_LICENSES.txt'),'curated-notices');
  await prepareZippNotices(wasm,notices);
  assert.equal(readFileSync(join(notices,'ZIPP-LICENSE-APACHE'),'utf8'),'release-license');
  assert.equal(readFileSync(join(notices,'ZIPP-THIRD-PARTY-LICENSES.txt'),'utf8'),'curated-notices');
  assert.deepEqual(JSON.parse(readFileSync(join(notices,'ZIPP-SOURCE.json'),'utf8')),source);
  // The recorded file is the one taken, and only with the recorded digest.
  const named={...source,notices:{...source.notices,file:'NOTICES-FROM-ZIPP.txt',sha256:sha('zipp-notices')}};
  writeFileSync(join(wasm,'SOURCE.json'),JSON.stringify(named,null,2));
  writeFileSync(join(wasm,'NOTICES-FROM-ZIPP.txt'),'zipp-notices');
  await prepareZippNotices(wasm,notices);
  assert.equal(readFileSync(join(notices,'ZIPP-THIRD-PARTY-LICENSES.txt'),'utf8'),'zipp-notices');
  writeFileSync(join(wasm,'NOTICES-FROM-ZIPP.txt'),'zipp-notices, edited');
  await assert.rejects(prepareZippNotices(wasm,notices),/notices provenance mismatch: NOTICES-FROM-ZIPP\.txt is not the recorded/);
  rmSync(join(wasm,'NOTICES-FROM-ZIPP.txt'));
  await assert.rejects(prepareZippNotices(wasm,notices),/notices provenance mismatch/);
});

test('local builds require their upstream license and retain the checksum gate',async t=>{
  const {wasm,notices}=fixture(t);
  await assert.rejects(prepareZippNotices(wasm,notices),/missing LICENSE-APACHE/);
  writeFileSync(join(wasm,'LICENSE-APACHE'),'upstream-license');
  writeFileSync(join(wasm,'zipp_wasm_bg.wasm'),'changed');
  await assert.rejects(prepareZippNotices(wasm,notices),/provenance mismatch/);
});
