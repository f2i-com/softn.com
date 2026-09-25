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
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const here=dirname(fileURLToPath(import.meta.url));
const runtime=join(here,'../runtime');
const wasmDir=join(here,'../../../packages/@softn/core/wasm-zipp');
const [major,minor]=process.versions.node.split('.').map(Number);
const skip=!existsSync(join(wasmDir,'zipp_wasm_bg.wasm'))?'packages/@softn/core/wasm-zipp is not installed (npm run fetch:zipp)':major<24||major===24&&minor<19?'Node 24.19 or newer (node:sqlite)':false;
if(skip)console.warn(`WARNING: tests/route-declarations.test.mjs skipped: ${skip}. See apps/softn-host-php/README.md, Validation.`);
const test=(name,...rest)=>{const fn=rest.pop();return nodeTest(name,{...(rest[0]??{}),skip},fn);};

const SOURCE=`
function ping(req){return {status:200,body:{ok:true,path:req.path}};}
function echo(req){return {status:200,body:req.body};}
function shapes(req){return {status:200,body:{empty:{},list:[],s:'x\\ud83d'}};}
function seen(req){return {status:200,body:{keys:Object.keys(req).sort(),body:req.body}};}
function things(req){return {status:200,body:softn.sql.query("WITH t AS (SELECT label, tag FROM things WHERE label LIKE ?) SELECT label, tag, ? / 2 AS half, 'a;b' AS s FROM t ORDER BY label",["%",5])};}
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
  const raw=(request)=>{
    const r=spawnSync(process.execPath,['--disable-proto=throw',join(root,'runner.mjs')],{input:JSON.stringify({query:{},headers:{},body:null,client_ip:'127.0.0.1',photos:false,...request}),encoding:'utf8',timeout:30000,env:{...process.env,SOFTN_BACKEND_ROOT:root,NODE_NO_WARNINGS:'1'}});
    assert.equal(r.status,0,r.stderr);
    return r.stdout;
  };
  const invoke=request=>JSON.parse(raw(request));
  return {root,raw,invoke,close:()=>rmSync(root,{recursive:true,force:true})};
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

test('the Rust host\'s `host-token` spelling is set aside like `hosttoken`, not a reason to refuse the app',t=>{
  const b=backend(manifest([
    {method:'GET',path:'/api/ping',handler:'ping'},
    {method:'GET',path:'/api/operator',handler:'ping',authorization:'host-token'},
  ]));
  t.after(b.close);
  const meta=b.invoke({method:'GET',path:'/api/meta'});
  assert.equal(meta.status,200,JSON.stringify(meta));
  assert.deepEqual(meta.body.unservedRoutes.map(u=>`${u.method} ${u.path}`),['GET /api/operator']);
  assert.deepEqual(b.invoke({method:'GET',path:'/api/operator'}),{status:401,body:{error:'Authorization required'}});
});

test('the runner writes status first and the body verbatim, so PHP never re-encodes it',t=>{
  const b=backend(manifest([
    {method:'GET',path:'/api/shapes',handler:'shapes'},
    {method:'POST',path:'/api/seen',handler:'seen'},
  ]));
  t.after(b.close);
  // `{}` stays an object and a lone surrogate stays an escape: PHP's decode
  // and re-encode made the first `[]` and failed the second with a 503.
  assert.equal(b.raw({method:'GET',path:'/api/shapes'}),'{"status":200,"body":{"empty":{},"list":[],"s":"x\\ud83d"}}');
  assert.match(b.raw({method:'GET',path:'/api/nothing'}),/^\{"status":404,"body":\{/);
  // The host's rate bucket and the client address (without trusted-client-ip) are not the app's.
  const seen=b.invoke({method:'POST',path:'/api/seen',body:{},rate_key:'2001:db8::/64'});
  assert.equal(seen.status,200);
  assert.ok(!seen.body.keys.includes('rate_key')&&!seen.body.keys.includes('client_ip'),seen.body.keys.join());
});

test('migrations run in sorted order, and a listed-twice or removed migration stops startup, as on the Rust host',t=>{
  const declared=['server/migrations/002.sql','server/migrations/001.sql'];
  const app=manifest([{method:'POST',path:'/api/count',handler:'count'}]);
  const b=backend(app);
  t.after(b.close);
  const write=migrations=>writeFileSync(join(b.root,'app/manifest.json'),JSON.stringify({...app,server:{...app.server,database:{kind:'private-sqlite',migrations}}}));
  // 002 needs the table 001 makes; listed first, it used to run first and fail.
  writeFileSync(join(b.root,'app/server/migrations/002.sql'),'CREATE TABLE history(value INTEGER); INSERT INTO history SELECT value FROM counter;');
  write(declared);
  const first=b.invoke({method:'POST',path:'/api/count'});
  assert.equal(first.body.value,1,JSON.stringify(first));
  write(['server/migrations/001.sql','server/migrations/001.sql','server/migrations/002.sql']);
  assert.equal(b.invoke({method:'GET',path:'/api/meta'}).body.diagnostic,'database_migrations');
  write(['server/migrations/001.sql']);
  assert.equal(b.invoke({method:'GET',path:'/api/meta'}).body.diagnostic,'database_migrations');
  write(declared);
  assert.equal(b.invoke({method:'POST',path:'/api/count'}).body.value,2);
});

test('a database another request holds is a retryable busy answer, not a configuration fault',async t=>{
  const {DatabaseSync}=await import('node:sqlite');
  const b=backend(manifest([{method:'GET',path:'/api/ping',handler:'ping'}]));
  t.after(b.close);
  assert.equal(b.invoke({method:'GET',path:'/api/meta'}).status,200);
  const holder=new DatabaseSync(join(b.root,'private/data/application.sqlite'));
  try {
    holder.exec('BEGIN IMMEDIATE');
    const r=b.invoke({method:'GET',path:'/api/ping'});
    assert.equal(r.status,503);
    assert.equal(r.body.code,'database_busy',JSON.stringify(r));
    assert.equal(r.body.diagnostic,undefined);
  } finally {holder.exec('ROLLBACK');holder.close();}
  assert.equal(b.invoke({method:'GET',path:'/api/ping'}).status,200);
});

test('a migration may add, rename and drop columns, and may not rename a table into the host\'s namespace',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const {applyMigration}=await import(new URL('../runtime/migrations.mjs',import.meta.url));
  const db=new DatabaseSync(':memory:');
  try {
    applyMigration(db,'CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items(name) VALUES(\'a\');');
    // ADD COLUMN rewrites the schema with printf(): it was denied, so the commonest migration failed.
    applyMigration(db,'ALTER TABLE items ADD COLUMN label TEXT;');
    applyMigration(db,'ALTER TABLE items RENAME COLUMN label TO tag;');
    applyMigration(db,'ALTER TABLE items DROP COLUMN tag;');
    applyMigration(db,'ALTER TABLE items RENAME TO things;');
    assert.deepEqual(db.prepare('SELECT * FROM things').all().map(r=>({...r})),[{id:1,name:'a'}]);
    db.exec('CREATE TABLE _host(value TEXT)');
    for(const sql of ['ALTER TABLE things RENAME TO _stolen','CREATE INDEX host_value ON _host(value)','ALTER TABLE _host ADD COLUMN x TEXT','SELECT printf(\'%s\',1)']) {
      if(sql.startsWith('SELECT')){applyMigration(db,sql);continue;} // a harmless function stays harmless
      assert.throws(()=>applyMigration(db,sql),undefined,sql);
    }
  } finally {db.close();}
});

test('a deployed app\'s migrations alter its tables, and its handlers run the Rust host\'s SQL, through the runner',t=>{
  const app=manifest([{method:'GET',path:'/api/things',handler:'things',transaction:'read'}]);
  const migrations=['server/migrations/001.sql','server/migrations/002.sql'];
  const b=backend({...app,server:{...app.server,database:{kind:'private-sqlite',migrations}}});
  t.after(b.close);
  // Every ALTER TABLE form, the clock and a recursive CTE: each one used to stop startup at database_migrations on one host or the other.
  writeFileSync(join(b.root,'app/server/migrations/002.sql'),`CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, note TEXT);
INSERT INTO items(name, note) VALUES('a', 'x');
ALTER TABLE items ADD COLUMN tag TEXT DEFAULT '';
ALTER TABLE items RENAME COLUMN name TO label;
ALTER TABLE items DROP COLUMN note;
ALTER TABLE items RENAME TO things;
UPDATE things SET tag = strftime('%Y', 'now') WHERE unixepoch() > 0;
WITH RECURSIVE n(x) AS (SELECT 2 UNION ALL SELECT x + 1 FROM n WHERE x < 3) INSERT INTO things(label) SELECT 'n' || x FROM n;`);
  const r=b.invoke({method:'GET',path:'/api/things'});
  assert.equal(r.status,200,JSON.stringify(r));
  // A CTE, a ';' in a literal, LIKE, and 5 bound as the INTEGER 5 (5 / 2 is 2, not 2.5), in a read transaction.
  const year=String(new Date().getUTCFullYear());
  assert.deepEqual(r.body,[{label:'a',tag:year,half:2,s:'a;b'},{label:'n2',tag:'',half:2,s:'a;b'},{label:'n3',tag:'',half:2,s:'a;b'}]);
});
