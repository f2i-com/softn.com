import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {execFileSync} from 'node:child_process';

function leb(value) {
  const bytes=[];
  do {const next=value&127;value>>>=7;bytes.push(next|(value?128:0));} while(value);
  return Buffer.from(bytes);
}

test('hosting ZIP deflates valid raw WASM, preserves compressed twins and restores exact bytes',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'softn-zip-test-'));
  try {
    const scripts=path.join(root,'scripts'),dist=path.join(root,'dist');
    fs.mkdirSync(scripts);fs.mkdirSync(path.join(dist,'data'),{recursive:true});
    fs.copyFileSync(new URL('./package-site.mjs',import.meta.url),path.join(scripts,'package-site.mjs'));
    const payload=Buffer.concat([Buffer.from([7]),Buffer.from('fixture'),Buffer.alloc(65536)]);
    const wasm=Buffer.concat([Buffer.from([0,97,115,109,1,0,0,0,0]),leb(payload.length),payload]);
    assert.doesNotThrow(()=>new WebAssembly.Module(wasm));
    const gz=zlib.gzipSync(wasm);
    const files={
      'index.html':Buffer.from('<!doctype html><title>Test</title>'),
      '.htaccess':Buffer.from('Options -Indexes\n'),
      'data/.htaccess':Buffer.from('Require all denied\n'),
      'data/README.txt':Buffer.from('Private runtime state.\n'),
      'BUILD-INFO.json':Buffer.from(JSON.stringify({builtAt:'2026-01-01T00:00:00Z',softn:{revision:'0'.repeat(40),dirty:false},zipp:{version:'0.0.15'}})),
      'engine.wasm':wasm,
      'engine.wasm.gz':gz,
    };
    for(const [name,bytes] of Object.entries(files))fs.writeFileSync(path.join(dist,name),bytes);
    const out=path.join(root,'release');
    execFileSync(process.execPath,[path.join(scripts,'package-site.mjs'),'--tag','v0.0.0-test','--out',out],{stdio:'pipe'});
    const zip=fs.readFileSync(path.join(out,fs.readdirSync(out).find(name=>name.endsWith('.zip'))));
    const entries=new Map();let offset=0;
    while(zip.readUInt32LE(offset)===0x04034b50){
      const method=zip.readUInt16LE(offset+8),size=zip.readUInt32LE(offset+18);
      const length=zip.readUInt16LE(offset+26),extra=zip.readUInt16LE(offset+28);
      const name=zip.toString('utf8',offset+30,offset+30+length);
      const start=offset+30+length+extra,packed=zip.subarray(start,start+size);
      const bytes=method===8?zlib.inflateRawSync(packed):packed;
      assert.deepEqual(bytes,files[name],name);
      entries.set(name,{method,size});offset=start+size;
    }
    assert.equal(entries.size,Object.keys(files).length);
    assert.equal(entries.get('engine.wasm').method,8);
    assert.ok(entries.get('engine.wasm').size<wasm.length/10);
    assert.equal(entries.get('engine.wasm.gz').method,0);
    assert.equal(entries.get('engine.wasm.gz').size,gz.length);
  } finally {
    const checked=fs.realpathSync(root);
    assert.equal(path.dirname(checked),fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(checked).startsWith('softn-zip-test-'));
    fs.rmSync(checked,{recursive:true,force:true});
  }
});
