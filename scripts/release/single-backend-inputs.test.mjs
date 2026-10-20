import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, realpathSync} from 'node:fs';
import {join, dirname, basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {prepareZippNotices, requireStandaloneBuild, unpackPinned} from './single-backend-inputs.mjs';

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
  // fetch-zipp-release.mjs's record: LICENSE-APACHE is in the install, so the release's kit is not downloaded.
  const source={repository:'https://github.com/f2i-com/zipp.org',release:'v0.0.26',version:'0.0.26',revision:'f'.repeat(40),build:'release',bundle:'zipp-0.0.26-javascript-python-base.wasm',bundleSha256:wasmSha,sumsSha256:'1'.repeat(64),variant:'javascript-python-base',languages:['javascript','python'],stackBytes:16777216,license:'Apache-2.0',artifact:'zipp_wasm_bg.wasm',sha256:wasmSha,glueSha256:'2'.repeat(64),kit:{bundle:'zipp-0.0.26-wasm-embed-kit.zip',bundleSha256:'0'.repeat(64),files:{}},notices:{file:'THIRD_PARTY_LICENSES.txt',source:'softn-curated',sha256:sha('curated-notices')}};
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

test('notices an earlier engine left in the cache are not packaged with the next one',async t=>{
  // The notices directory is kept between runs and everything in it goes into
  // the archive (backend/licenses/native/). It was only ever added to, so an
  // engine that carries no notices file shipped the previous engine's.
  const {wasm,notices}=fixture(t);
  writeFileSync(join(wasm,'LICENSE-APACHE'),'upstream-license');
  writeFileSync(join(wasm,'THIRD_PARTY_LICENSES.txt'),'notices of the first engine');
  await prepareZippNotices(wasm,notices);
  assert.equal(readFileSync(join(notices,'ZIPP-THIRD-PARTY-LICENSES.txt'),'utf8'),'notices of the first engine');
  rmSync(join(wasm,'THIRD_PARTY_LICENSES.txt'));
  await prepareZippNotices(wasm,notices);
  assert.deepEqual(readdirSync(notices).sort(),['ZIPP-LICENSE-APACHE','ZIPP-SOURCE.json']);
});

test('a pinned archive is unpacked into a directory emptied first',t=>{
  // The ws package is unpacked into one cache directory whatever its version,
  // and the whole directory is packaged (backend/vendor/ws/): a file an earlier
  // version shipped and the pinned one does not must not ride along.
  const parent=realpathSync(tmpdir()),cache=mkdtempSync(join(parent,'softn-backend-unpack-'));
  t.after(()=>{
    assert.equal(dirname(realpathSync(cache)),parent);
    rmSync(cache,{recursive:true,force:true});
  });
  mkdirSync(join(cache,'stage/package'),{recursive:true});
  writeFileSync(join(cache,'stage/package/index.js'),'current');
  execFileSync('tar',['-czf','../pinned.tgz','package'],{cwd:join(cache,'stage')});
  mkdirSync(join(cache,'ws/package/lib'),{recursive:true});
  writeFileSync(join(cache,'ws/package/lib/removed-upstream.js'),'from an earlier version');
  writeFileSync(join(cache,'ws/package/index.js'),'earlier');
  unpackPinned(cache,'pinned.tgz','ws');
  assert.deepEqual(readdirSync(join(cache,'ws/package')),['index.js']);
  assert.equal(readFileSync(join(cache,'ws/package/index.js'),'utf8'),'current');
});

test('a single-app build made for the site\'s /play/ is not packaged as the standalone runtime',t=>{
  // build:site builds apps/softn-single with VITE_BASE=/play/ into the same
  // dist/ the standalone archives are packaged from. That build loads its
  // scripts from /play/assets/, so it works nowhere else, and the packagers
  // only checked that index.html was there.
  const parent=realpathSync(tmpdir()),dist=mkdtempSync(join(parent,'softn-single-dist-'));
  t.after(()=>{
    assert.equal(dirname(realpathSync(dist)),parent);
    rmSync(dist,{recursive:true,force:true});
  });
  const page=(base)=>'<!doctype html><link rel="icon" href="data:image/svg+xml,%3Csvg/%3E"><script type="module" crossorigin src="'+base+'assets/index-DEDJ8RC1.js"></script><link rel="stylesheet" crossorigin href="'+base+'assets/index-DmbxlckZ.css">';
  writeFileSync(join(dist,'index.html'),page('./'));
  assert.doesNotThrow(()=>requireStandaloneBuild(dist));
  writeFileSync(join(dist,'index.html'),page('/play/'));
  assert.throws(()=>requireStandaloneBuild(dist),/built for \/play\/assets\/index-DEDJ8RC1\.js.*npm run build -w @softn\/single/s);
  rmSync(join(dist,'index.html'));
  assert.throws(()=>requireStandaloneBuild(dist),/Build the single-app runtime first/);
});

test('local builds require their upstream license and retain the checksum gate',async t=>{
  const {wasm,notices}=fixture(t);
  await assert.rejects(prepareZippNotices(wasm,notices),/missing LICENSE-APACHE/);
  writeFileSync(join(wasm,'LICENSE-APACHE'),'upstream-license');
  writeFileSync(join(wasm,'zipp_wasm_bg.wasm'),'changed');
  await assert.rejects(prepareZippNotices(wasm,notices),/provenance mismatch/);
});
