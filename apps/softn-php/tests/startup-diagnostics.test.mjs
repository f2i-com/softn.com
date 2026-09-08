import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const input=process.env.SOFTN_PHP_TEST_BACKEND;
if(!input)throw Error('Set SOFTN_PHP_TEST_BACKEND to a disposable initialized Linux backend fixture');
test('startup failures expose only static labels and normal startup still succeeds',t=>{
  const root=mkdtempSync(join(tmpdir(),'softn-diagnostics-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  cpSync(input,root,{recursive:true});
  cpSync(new URL('../runtime/request-worker.mjs',import.meta.url),join(root,'request-worker.mjs'));
  const file=join(root,'private/config.json'),original=readFileSync(file,'utf8'),config=JSON.parse(original);
  const run=()=>{
    const r=spawnSync(join(root,'bin/node'),[join(root,'runner.mjs')],{input:JSON.stringify({path:'/api/meta',method:'GET',client_ip:'127.0.0.1'}),encoding:'utf8',timeout:25000});
    assert.equal(r.status,0);return JSON.parse(r.stdout);
  };
  assert.equal(run().status,200);
  for(const [change,label] of [
    [{keyHex:'private-secret-marker'},'configuration_values'],
    [{development:'false'},'configuration_values'],
    [{appId:'private-secret-marker'},'application_identity'],
    [{capabilities:[]},'application_capabilities'],
    [{cryptoDomains:{hmac:'same',seal:'same'}},'crypto_domains']
  ]){
    writeFileSync(file,JSON.stringify({...config,...change}));
    const result=run();assert.equal(result.status,503);assert.equal(result.body.diagnostic,label);
    assert.ok(!JSON.stringify(result).includes('private-secret-marker'));assert.ok(!JSON.stringify(result).includes(config.keyHex));
  }
  writeFileSync(file,'{"private-secret-marker":');assert.equal(run().body.diagnostic,'configuration_read');
  writeFileSync(file,original);assert.equal(run().status,200);
});
