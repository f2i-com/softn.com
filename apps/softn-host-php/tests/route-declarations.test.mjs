/**
 * The route schema is one schema for every host. A manifest written against
 * the Rust host's defaults (no `transaction`, no `authorization`, `none`) runs
 * here; a route this host cannot serve is set aside and named by /api/meta,
 * not a reason to refuse the whole app; a declaration this host does not
 * understand is still refused, with its static diagnostic.
 *
 * Runs against a backend assembled from this checkout: the runtime files,
 * the ZIPP release installed in packages/@softn/core/wasm-zipp, and the
 * Node this test runs under (the packaged backend pins its own). Skipped,
 * visibly, when the engine or node:sqlite is not available.
 */
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync,copyFileSync,writeFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const here=dirname(fileURLToPath(import.meta.url));
const runtime=join(here,'../runtime');
const wasmDir=join(here,'../../../packages/@softn/core/wasm-zipp');
const [major,minor]=process.versions.node.split('.').map(Number);
const skip=!existsSync(join(wasmDir,'zipp_wasm_bg.wasm'))?'packages/@softn/core/wasm-zipp is not installed (npm run fetch:zipp)':major<24||major===24&&minor<19?'Node 24.19 or newer (node:sqlite)':false;
const test=(name,...rest)=>{const fn=rest.pop();return nodeTest(name,{...(rest[0]??{}),skip},fn);};

const SOURCE=`
function ping(req){return {status:200,body:{ok:true,path:req.path}};}
function echo(req){return {status:200,body:req.body};}
function count(req){softn.sql.execute("UPDATE counter SET value=value+1",[]);return {status:200,body:softn.sql.first("SELECT value FROM counter",[])};}
`;

/** A backend root holding this checkout's runtime and the given manifest. */
function backend(manifest){
  const root=mkdtempSync(join(tmpdir(),'softn-routes-'));
  for(const name of readdirSync(runtime))if(name.endsWith('.mjs'))copyFileSync(join(runtime,name),join(root,name));
  mkdirSync(join(root,'wasm'));
  copyFileSync(join(wasmDir,'zipp_wasm.js'),join(root,'wasm/zipp_wasm.mjs'));
  copyFileSync(join(wasmDir,'zipp_wasm_bg.wasm'),join(root,'wasm/zipp_wasm_bg.wasm'));
  mkdirSync(join(root,'app/server/migrations'),{recursive:true});
  mkdirSync(join(root,'private/data'),{recursive:true});
  writeFileSync(join(root,'app/manifest.json'),JSON.stringify(manifest));
  writeFileSync(join(root,'app/server/main.logic'),SOURCE);
  writeFileSync(join(root,'app/server/migrations/001.sql'),'CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0);');
  writeFileSync(join(root,'private/config.json'),JSON.stringify({appId:manifest.id,development:false,keyHex:'ab'.repeat(32),capabilities:['sql'],cryptoDomains:{hmac:'t:hmac:v1',seal:'t:seal:v1'}}));
  const invoke=(request)=>{
    const r=spawnSync(process.execPath,['--disable-proto=throw',join(root,'runner.mjs')],{input:JSON.stringify({query:{},headers:{},body:null,client_ip:'127.0.0.1',photos:false,...request}),encoding:'utf8',timeout:30000,env:{...process.env,SOFTN_BACKEND_ROOT:root,NODE_NO_WARNINGS:'1'}});
    assert.equal(r.status,0,r.stderr);
    return JSON.parse(r.stdout);
  };
  return {root,invoke,close:()=>rmSync(root,{recursive:true,force:true})};
}

const manifest=(routes,extra={})=>({id:'route-schema',version:'1.0.0',main:'ui/main.ui',server:{entry:'server/main.logic',requires:{apiVersion:1,capabilities:['sql']},database:{kind:'private-sqlite',migrations:['server/migrations/001.sql']},routes},...extra});

test('routes declared against the Rust host\'s defaults are served, with reads and writes as that host would run them',t=>{
  const b=backend(manifest([
    {method:'GET',path:'/api/ping',handler:'ping'},
    {method:'POST',path:'/api/echo',handler:'echo',transaction:'none'},
    {method:'POST',path:'/api/count',handler:'count'},
    {method:'GET',path:'/api/legacy',handler:'ping',transaction:'read',authorization:'anonymous'},
  ]));
  t.after(b.close);
  const meta=b.invoke({method:'GET',path:'/api/meta'});
  assert.equal(meta.status,200,JSON.stringify(meta));
  assert.equal(meta.body.unservedRoutes,undefined,'every route is served, so nothing is listed');
  assert.deepEqual(b.invoke({method:'GET',path:'/api/ping'}),{status:200,body:{ok:true,path:'/api/ping'}});
  assert.deepEqual(b.invoke({method:'POST',path:'/api/echo',body:{a:1}}).body,{a:1});
  // A POST with no transaction declared may write, as it may on the Rust host.
  assert.equal(b.invoke({method:'POST',path:'/api/count'}).body.value,1);
  assert.equal(b.invoke({method:'POST',path:'/api/count'}).body.value,2);
  assert.equal(b.invoke({method:'GET',path:'/api/legacy'}).status,200);
  assert.equal(b.invoke({method:'GET',path:'/api/nothing'}).status,404);
});

test('routes this host cannot serve are set aside and named, and the rest of the app runs',t=>{
  const b=backend(manifest([
    {method:'GET',path:'/api/ping',handler:'ping'},
    {method:'POST',path:'/hooks/incoming',handler:'ping'},
    {method:'PATCH',path:'/api/patchy',handler:'ping'},
    {method:'GET',path:'/api/secret',handler:'ping',authorization:'hosttoken'},
  ]));
  t.after(b.close);
  const meta=b.invoke({method:'GET',path:'/api/meta'});
  assert.equal(meta.status,200,JSON.stringify(meta));
  assert.deepEqual(meta.body.unservedRoutes.map(u=>`${u.method} ${u.path}`),['POST /hooks/incoming','PATCH /api/patchy','GET /api/secret']);
  for(const u of meta.body.unservedRoutes)assert.match(u.reason,/outside \/api\/|method not served|hosttoken/);
  assert.equal(b.invoke({method:'GET',path:'/api/ping'}).status,200);
  // A host-token route answers as the Rust host answers it without a token.
  assert.deepEqual(b.invoke({method:'GET',path:'/api/secret'}),{status:401,body:{error:'Authorization required'}});
  assert.equal(b.invoke({method:'GET',path:'/api/patchy'}).status,404);
});

test('a declaration this host does not understand is still refused with the static diagnostic',t=>{
  for(const routes of [
    [{method:'GET',path:'/api/ping',handler:'ping',transaction:'maybe'}],
    [{method:'GET',path:'/api/ping',handler:'ping',authorization:'nobody'}],
    [{method:'GET',path:'/api/ping',handler:'ping'},{method:'GET',path:'/api/ping',handler:'echo'}],
    [{method:'GET',path:'/api/ping',handler:'not a name'}],
    [{method:'GET',path:'/api/poll',handler:'ping',poll:true,transaction:'write'}],
  ]) {
    const b=backend(manifest(routes));
    try {
      const r=b.invoke({method:'GET',path:'/api/meta'});
      assert.equal(r.status,503,JSON.stringify(routes));
      assert.equal(r.body.diagnostic,'route_configuration');
    } finally {b.close();}
  }
  // A handler the source does not define is the source's fault, served route or not.
  const b=backend(manifest([{method:'POST',path:'/hooks/x',handler:'missing'}]));
  t.after(b.close);
  assert.equal(b.invoke({method:'GET',path:'/api/meta'}).body.diagnostic,'application_source');
});
