import test from 'node:test';
import assert from 'node:assert/strict';
import {deploymentConfig} from '../package.mjs';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

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
test('preapproval is explicit and the bundle remains hash-pinned',()=>{
  const manifest={id:'example',name:'Example'},bytes=Buffer.from('bundle');
  assert.equal(deploymentConfig(manifest,bytes).permissionMode,undefined);
  const config=deploymentConfig(manifest,bytes,'preapproved');
  assert.equal(config.permissionMode,'preapproved');assert.match(config.sha256,/^[a-f0-9]{64}$/);
  assert.throws(()=>deploymentConfig(manifest,bytes,'unknown'));
});
