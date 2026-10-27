import test from 'node:test';
import assert from 'node:assert/strict';
import {deploymentConfig,packagePhp,RUNNER_BINARY,RUNNER_NOTICES} from '../package.mjs';
import {readArchive} from '../../../scripts/lib/archive.mjs';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Each directive of an .htaccess with the `<IfModule …>` blocks it sits in. */
function directives(rules) {
  const inside=[],out=[];
  for(const line of rules.replace(/\r\n/g,'\n').split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'))) {
    const open=line.match(/^<(\w+)\s*([^>]*)>$/),close=line.match(/^<\/(\w+)>$/);
    if(close){inside.pop();continue;}
    if(open){inside.push(open[1]==='IfModule'?open[2]:open[1]);continue;}
    out.push({directive:line.split(/\s+/)[0],line,inside:[...inside]});
  }
  assert.deepEqual(inside,[],'every block is closed');
  return out;
}

test('the app still loads on an Apache without mod_rewrite or mod_headers: only what needs a module asks for it',()=>{
  // The archive is the app with an optional backend. Its rewrite rules stood
  // outside any <IfModule>, so on a server without mod_rewrite every request
  // was a 500, the app that needs no backend included. The privately served
  // variant's rules (apps/softn-single-private/htaccess-backend) already asked.
  for(const file of ['../htaccess','../../softn-single-private/htaccess-backend']) {
    const rules=directives(readFileSync(new URL(file,import.meta.url),'utf8'));
    const rewrites=rules.filter(r=>r.directive.startsWith('Rewrite'));
    assert.ok(rewrites.some(r=>/^RewriteRule \^api\(\?:\/\.\*\)\?\$ api\.php \[END\]$/.test(r.line)),file+': /api/ still goes to api.php');
    assert.ok(rewrites.some(r=>r.line.includes('E=HTTP_AUTHORIZATION')),file+': and Authorization still reaches PHP');
    for(const r of rewrites)assert.ok(r.inside.includes('mod_rewrite.c'),file+': '+r.line);
    for(const r of rules.filter(r=>r.directive==='Header'))assert.ok(r.inside.includes('mod_headers.c'),file+': '+r.line);
    // What is left needs only what Apache always has (core, mod_dir, mod_mime, mod_authz_core).
    for(const r of rules.filter(r=>!r.inside.some(name=>name.endsWith('.c'))))assert.match(r.directive,/^(Options|DirectoryIndex|Require|AddType)$/,file+': '+r.line);
  }
});
test('reverse-domain bundle IDs produce valid, stable deployment namespaces',()=>{
  const bytes=Buffer.from('bundle');
  for(const id of ['org.example.app','a'.repeat(150),'Example App','valid-app']) {
    const config=deploymentConfig({id,name:'Example'},bytes);
    assert.match(config.id,/^[a-z0-9][a-z0-9_-]{0,63}$/);
    assert.deepEqual(config,deploymentConfig({id,name:'Example'},bytes));
    assert.equal(config.sha256,createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal(deploymentConfig({id:'valid-app',name:'Example'},bytes).id,'valid-app');
  assert.notEqual(deploymentConfig({id:'org.example.app',name:'Example'},bytes).id,deploymentConfig({id:'org-example-app',name:'Example'},bytes).id);
});
const wasmDir=fileURLToPath(new URL('../../../packages/@softn/core/wasm-zipp/',import.meta.url));
test('a backend packaged with softn-runner carries it executable, licensed and recorded, beside Node',{skip:existsSync(join(wasmDir,'zipp_wasm_bg.wasm'))?false:'packages/@softn/core/wasm-zipp is not installed (npm run fetch:zipp)'},t=>{
  const dir=mkdtempSync(join(tmpdir(),'softn-package-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  // An ELF header saying x86-64 is all the packager reads of either binary.
  const elf=machine=>{const b=Buffer.alloc(64);b.write('7f454c46','hex');b.writeUInt16LE(machine,18);return b;};
  const runtime=join(dir,'runtime'),node=join(dir,'node'),runner=join(dir,'runner'),notices=join(dir,'notices');
  for(const d of [runtime,join(node,'bin'),runner,notices])mkdirSync(d,{recursive:true});
  for(const name of ['index.html','app.softn','runtime.config.json','LICENSE','NOTICE','THIRD-PARTY-NOTICES.txt'])writeFileSync(join(runtime,name),name);
  writeFileSync(join(node,'bin/node'),elf(62));writeFileSync(join(node,'LICENSE'),'node licence');writeFileSync(join(notices,'ZIPP-LICENSE-APACHE'),'zipp licence');
  writeFileSync(join(runner,RUNNER_BINARY),elf(62));writeFileSync(join(runner,RUNNER_NOTICES),'runner licences');
  const pack=(name,extra={})=>{
    const out=join(dir,name);packagePhp({runtime,nodeDir:node,wasmDir,notices,out,template:true,templateClient:true,...extra});
    const {entries,problems}=readArchive(readFileSync(out));assert.deepEqual(problems,[]);return entries;
  };
  const without=pack('without.zip'),withRunner=pack('with.zip',{runnerDir:runner});
  // Without it, as before: Node alone, and nothing recorded.
  assert.equal(without.has('backend/bin/'+RUNNER_BINARY),false);
  assert.equal(JSON.parse(without.get('BUILD-INFO.json').data).softnRunner,null);
  // With it: executable as Node is, its licences, and its digest and memory setting in BUILD-INFO.
  assert.equal(withRunner.get('backend/bin/'+RUNNER_BINARY).mode,0o100755);
  assert.equal(withRunner.get('backend/bin/node').mode,0o100755);
  assert.equal(withRunner.get('backend/licenses/'+RUNNER_NOTICES).data.toString(),'runner licences');
  const info=JSON.parse(withRunner.get('BUILD-INFO.json').data);
  assert.deepEqual(info.softnRunner,{file:'backend/bin/'+RUNNER_BINARY,sha256:createHash('sha256').update(elf(62)).digest('hex'),requestMemoryMb:{default:256,min:128,max:1024}});
  // The default is the one request.php gives a runner.
  assert.match(readFileSync(new URL('../runtime/request.php',import.meta.url),'utf8'),/const SOFTN_REQUEST_MEMORY_MB=256;/);
  assert.ok(withRunner.get('SHA256SUMS.txt').data.toString().includes('  backend/bin/'+RUNNER_BINARY+'\n'));
  // A build for another machine is refused, as Node's is.
  writeFileSync(join(runner,RUNNER_BINARY),elf(183));
  assert.throws(()=>pack('arm.zip',{runnerDir:runner}),/Expected Linux x86-64 softn-runner/);
});
test('preapproval is explicit and the bundle remains hash-pinned',()=>{
  const manifest={id:'example',name:'Example'},bytes=Buffer.from('bundle');
  assert.equal(deploymentConfig(manifest,bytes).permissionMode,undefined);
  const config=deploymentConfig(manifest,bytes,'preapproved');
  assert.equal(config.permissionMode,'preapproved');assert.match(config.sha256,/^[a-f0-9]{64}$/);
  assert.throws(()=>deploymentConfig(manifest,bytes,'unknown'));
});
