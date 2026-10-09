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
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync,existsSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

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
function value(req){return {status:200,body:softn.sql.first("SELECT value FROM counter",[])};}
function creditThenFail(req){softn.sql.execute("UPDATE counter SET value=value+10",[]);try{softn.sql.execute("INSERT INTO no_such_table VALUES(1)",[]);}catch(e){return {status:400,body:{error:'refused'}};}return {status:200,body:{}};}
function creditThenUndo(req){softn.sql.execute("UPDATE counter SET value=value+10",[]);try{softn.sql.execute("INSERT INTO no_such_table VALUES(1)",[]);}catch(e){return {status:409,rollback:true,body:{error:'undone'}};}return {status:200,body:{}};}
function creditThenRefuse(req){softn.sql.execute("UPDATE counter SET value=value+10",[]);return {status:422,body:{error:'counted'}};}
function settings(req){return {status:200,body:softn.config};}
function boom(req){softn.sql.execute("UPDATE counter SET value=value+5",[]);throw new Error("boom at /home/app/secret.txt with\\ttab");}
function sneak(req){softn.sql.execute("UPDATE counter SET value=value+7",[]);return {status:200,body:{ok:true}};}
function big(req){var s=new Array((req.query.n|0)+1).join("x");return {status:200,body:softn.sql.first("SELECT length(?) AS n",[s])};}
function text(req){return {status:200,body:{text:req.body.text}};}
function age(req){return {status:200,body:{plain:softn.time.age("2000-01-01"),zoned:softn.time.age("2000-01-01","UTC"),bad:softn.time.age("not a date")}};}
function bump(req){return {status:200,body:softn.sql.execute("UPDATE counter SET value=value+1",[])};}
function reasons(req){var said={};
  try{softn.time.parseZoned("2026-10-04","02:30","Australia/Melbourne");}catch(e){said.gap=e.message;said.isError=e instanceof Error;}
  try{softn.time.parseZoned("2026-04-05","02:30","Australia/Melbourne");}catch(e){said.fold=e.message;}
  try{softn.time.parseZoned("2026-01-01","12:00","Mars/Phobos");}catch(e){said.zone=e.message;}
  try{softn.sql.query("SELECT 1; SELECT 2",[]);}catch(e){said.two=e.message;}
  try{softn.sql.execute("INSERT INTO no_such_table VALUES(1)",[]);}catch(e){said.table=e.message;}
  try{softn.sql.first("SELECT value FROM _migrations",[]);}catch(e){said.host=e.message;}
  try{softn.crypto.sha256("x");}catch(e){said.denied=e.message;}
  return {status:422,rollback:true,body:said};}
function depth(req){var levels=0,value=req.body;while(value!==null&&typeof value==='object'){value=value.a;levels++;}return {status:200,body:{levels:levels,leaf:value===undefined?'missing':value}};}
function ordered(req){return {status:200,body:{zebra:Object.keys(req.body),apple:Object.keys(req.query),mango:req.body,kiwi:softn.sql.first("SELECT 1 AS zz, 'b' AS aa, 3 AS mm",[])}};}
function inspect(req){var b=req.body;return {status:200,body:{body:b,keys:Object.keys(b),request:Object.keys(req),negative:1/b.z<0,negativeFloat:1/b.zf<0,types:[typeof b.one,typeof b.big,typeof b.text,typeof b.n,typeof b.list]}};}
`;

/** softn.time as both hosts answer it; its `script` is one more handler here. */
const timeParity=JSON.parse(readFileSync(join(here,'time-parity.json'),'utf8'));
/** And the arguments softn.crypto's random calls take. */
const cryptoParity=JSON.parse(readFileSync(join(here,'crypto-parity.json'),'utf8'));

/** A backend root holding this checkout's runtime and the given manifest. */
function backend(manifest,{capabilities=['sql']}={}){
  const root=mkdtempSync(join(tmpdir(),'softn-routes-'));
  for(const name of readdirSync(runtime))if(name.endsWith('.mjs'))copyFileSync(join(runtime,name),join(root,name));
  mkdirSync(join(root,'wasm'));
  copyFileSync(join(wasmDir,'zipp_wasm.js'),join(root,'wasm/zipp_wasm.mjs'));
  copyFileSync(join(wasmDir,'zipp_wasm_bg.wasm'),join(root,'wasm/zipp_wasm_bg.wasm'));
  mkdirSync(join(root,'app/server/migrations'),{recursive:true});
  mkdirSync(join(root,'private/data'),{recursive:true});
  writeFileSync(join(root,'app/manifest.json'),JSON.stringify(manifest));
  writeFileSync(join(root,'app/server/main.logic'),SOURCE+timeParity.script+'\n'+cryptoParity.script+'\n');
  writeFileSync(join(root,'app/server/migrations/001.sql'),'CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0);');
  writeFileSync(join(root,'private/config.json'),JSON.stringify({appId:manifest.id,development:false,keyHex:'ab'.repeat(32),capabilities,cryptoDomains:{hmac:'t:hmac:v1',seal:'t:seal:v1'}}));
  const run=(request)=>{
    const r=spawnSync(process.execPath,['--disable-proto=throw',join(root,'runner.mjs')],{input:JSON.stringify({query:{},headers:{},body:null,client_ip:'127.0.0.1',photos:false,...request}),encoding:'utf8',timeout:30000,env:{...process.env,SOFTN_BACKEND_ROOT:root,NODE_NO_WARNINGS:'1'}});
    assert.equal(r.status,0,r.stderr);
    return r;
  };
  const raw=request=>run(request).stdout;
  const invoke=request=>JSON.parse(raw(request));
  /** The runner fed text as it stands, with any Node flags: what http.php writes, byte for byte. */
  const fed=(input,flags=['--disable-proto=throw'])=>spawnSync(process.execPath,[...flags,join(root,'runner.mjs')],{input,encoding:'utf8',timeout:30000,maxBuffer:64*1024*1024,env:{...process.env,SOFTN_BACKEND_ROOT:root,NODE_NO_WARNINGS:'1'}});
  /** The answer, and what the runner wrote for the operator's log. */
  const logged=request=>{const r=run(request);return {...JSON.parse(r.stdout),stderr:r.stderr};};
  return {root,raw,invoke,logged,fed,close:()=>rmSync(root,{recursive:true,force:true})};
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

test('a host call that fails rolls the request back, even when the handler catches it and answers',t=>{
  const b=backend(manifest([
    {method:'POST',path:'/api/fail',handler:'creditThenFail'},
    {method:'POST',path:'/api/undo',handler:'creditThenUndo'},
    {method:'POST',path:'/api/refuse',handler:'creditThenRefuse'},
    {method:'GET',path:'/api/value',handler:'value',transaction:'read'},
  ]));
  t.after(b.close);
  const value=()=>b.invoke({method:'GET',path:'/api/value'}).body.value;
  assert.equal(value(),0);
  // The handler wrote, a later statement failed, and it caught the failure
  // and answered 400. Committing left the first write in the database: the
  // half of a transfer that worked.
  const failed=b.invoke({method:'POST',path:'/api/fail'});
  assert.deepEqual(failed,{status:500,body:{error:'The request could not be completed.',code:'host_error'}});
  assert.equal(value(),0,'the write before the failed call was committed');
  // Asking for the rollback keeps the handler's own answer.
  const undone=b.invoke({method:'POST',path:'/api/undo'});
  assert.deepEqual(undone,{status:409,body:{error:'undone'}});
  assert.equal(value(),0);
  // An error answer with no failed call still commits, as the contract says:
  // a wrong guess keeps its attempt counter.
  assert.equal(b.invoke({method:'POST',path:'/api/refuse'}).status,422);
  assert.equal(value(),10);
});

test('a body 62 levels deep reaches the handler whole, which is why http.php takes none deeper',t=>{
  // The limit softn_request_body holds a body to (request.test.mjs), and the
  // Rust host's MAX_BODY_DEPTH. One level more, which http.php used to let
  // through, and the engine hands the handler null where the innermost
  // object was, with nothing to say so.
  const b=backend(manifest([{method:'POST',path:'/api/depth',handler:'depth'}]));
  t.after(b.close);
  const nested=(levels,leaf)=>JSON.parse('{"a":'.repeat(levels)+leaf+'}'.repeat(levels));
  const seen=body=>b.invoke({method:'POST',path:'/api/depth',body}).body;
  assert.deepEqual(seen(nested(62,'"leaf"')),{levels:62,leaf:'leaf'});
  assert.deepEqual(seen(nested(61,'{}')),{levels:62,leaf:'missing'});
  assert.deepEqual(seen(nested(63,'"leaf"')),{levels:62,leaf:null},'what the runner would be handed if http.php let it through');
});

test('object keys keep their order in and out, which the Rust host is held to as well',t=>{
  // The reference for apps/softn-host-rust (http_hardening_tests.rs
  // object_keys_keep_their_order_in_and_out, bridges/sql.rs
  // a_row_keeps_the_order_of_its_columns): that host used to sort every
  // object it handed over or sent out.
  const b=backend(manifest([{method:'POST',path:'/api/ordered',handler:'ordered'}]));
  t.after(b.close);
  const raw=b.raw({method:'POST',path:'/api/ordered',body:{zebra:1,apple:{y:1,x:2},mango:3},query:{zebra:'3',apple:'2'}});
  assert.equal(raw,'{"status":200,"body":{"zebra":["zebra","apple","mango"],"apple":["zebra","apple"],"mango":{"zebra":1,"apple":{"y":1,"x":2},"mango":3},"kiwi":{"zz":1,"aa":"b","mm":3}}}');
});

test('a statement that inserts nothing has no lastInsertRowid, whatever the host itself inserted first',t=>{
  const b=backend(manifest([{method:'POST',path:'/api/bump',handler:'bump'}]));
  t.after(b.close);
  // The first request from an address has the host insert that address's row
  // in its own _request_limits table, on the connection the handler then
  // uses. SQLite keeps the last id a connection inserted, so the handler's
  // UPDATE answered with the host's row id (1, 2, 3 as addresses arrived):
  // an id the handler never made, where 0 says "nothing inserted".
  for(const [client_ip,changes] of [['10.9.9.1',1],['10.9.9.2',1],['10.9.9.3',1],['10.9.9.3',1]]) {
    assert.deepEqual(b.invoke({method:'POST',path:'/api/bump',client_ip}).body,{changes,lastInsertRowid:0},client_ip);
  }
});

test('a handler that catches a failed host call is told why, as on the Rust host',t=>{
  // Whatever failed, `e.message` was "host bridge call failed": the engine
  // replaces anything a host function throws. So the reasons written here
  // for a person ("…Choose another time.") reached only the log, and a
  // handler could not tell a time the clocks skip from a zone that does not
  // exist. A failed call now answers the script with its reason and the
  // script's own softn.* function throws it.
  const timed=manifest([{method:'POST',path:'/api/reasons',handler:'reasons'},{method:'POST',path:'/api/fail',handler:'creditThenFail'}]);
  timed.server.requires.capabilities=['sql','time'];
  const b=backend(timed,{capabilities:['sql','time']});
  t.after(b.close);
  const r=b.logged({method:'POST',path:'/api/reasons'});
  assert.equal(r.status,422,JSON.stringify(r));
  assert.deepEqual(r.body,{
    gap:'That local time does not exist during daylight saving. Choose another time.',isError:true,
    fold:'That local time occurs twice during daylight saving. Choose another time.',
    zone:'Invalid time zone',
    two:'Only one SQL statement is allowed',
    // What SQLite itself said stays in the operator's log: the script is
    // told which kind of call failed, as the Rust host tells it.
    table:'SQL write failed',host:'SQL query failed',
    denied:'Host capability denied: crypto.sha256',
  });
  // The handler dealt with them and asked for the rollback: nothing to log.
  assert.equal(r.stderr,'');
  // One it did not deal with is logged as before, in SQLite's words.
  const failed=b.logged({method:'POST',path:'/api/fail'});
  assert.equal(failed.status,500);
  assert.match(failed.stderr,/^softn: handler creditThenFail: no such table: no_such_table\n$/);
});

test('softn.time.age takes UTC when no zone is given',t=>{
  const timed=manifest([{method:'GET',path:'/api/age',handler:'age'}]);
  timed.server.requires.capabilities=['sql','time'];
  const b=backend(timed,{capabilities:['sql','time']});
  t.after(b.close);
  const r=b.invoke({method:'GET',path:'/api/age'});
  assert.equal(r.status,200,JSON.stringify(r));
  assert.ok(Number.isInteger(r.body.plain)&&r.body.plain>=26,JSON.stringify(r.body));
  assert.equal(r.body.plain,r.body.zoned);
  assert.equal(r.body.bad,-1);
});

test('softn.time answers the shared list as the Rust host does',t=>{
  // tests/time-parity.json, which apps/softn-host-rust/src/bridges/time.rs
  // runs too. The two hosts wrote format() differently ("Thu, 1 Jan, 11:00 pm
  // · Melbourne" here, "Thu, 1 Jan 2026, 11:00 PM AEDT" there), that one took
  // only a zone spelt exactly as the IANA list spells it, and age() with an
  // empty zone was a failed call here and UTC there (with a null one, the
  // other way round).
  const timed=manifest([{method:'POST',path:'/api/time',handler:'timeCases'}]);
  timed.server.requires.capabilities=['sql','time'];
  const b=backend(timed,{capabilities:['sql','time']});
  t.after(b.close);
  // A case that names `same` arguments is asked twice, the second time with those.
  const cases=timeParity.cases,asked=[...cases,...cases.filter(c=>c.same).map(c=>({call:c.call,args:c.same}))];
  const r=b.invoke({method:'POST',path:'/api/time',body:{cases:asked}});
  assert.equal(r.status,200,JSON.stringify(r));
  const wrong=[];let twin=cases.length;
  cases.forEach((c,i)=>{
    const got=r.body[i],label=`${c.call}(${JSON.stringify(c.args).slice(1,-1)})`;
    if(c.throws){if(!got.threw)wrong.push(`${label} answered ${JSON.stringify(got.ok)}`);}
    else if(got.threw)wrong.push(`${label} threw`);
    else if(c.same){const other=r.body[twin++];if(other.threw||other.ok!==got.ok)wrong.push(`${label} is ${JSON.stringify(got.ok)}, and with ${JSON.stringify(c.same)} ${JSON.stringify(other.ok)}`);}
    else if(got.ok!==c.result)wrong.push(`${label} is ${JSON.stringify(got.ok)}, not ${JSON.stringify(c.result)}`);
  });
  assert.deepEqual(wrong,[]);
});

test('softn.crypto\'s random calls take the shared list of arguments as the Rust host does',t=>{
  // tests/crypto-parity.json, which apps/softn-host-rust/src/bridges/crypto.rs
  // runs too. Here a bound had to be a number and under 2^48 (Node's own
  // rule) and a byte count a number; there text that spells a whole number
  // is that number (`softn.crypto.randomInt(req.query.sides)`) and the bound
  // goes to 2^53-1. A handler written on that host was a 500 on this one.
  const random=manifest([{method:'POST',path:'/api/random',handler:'cryptoCases'}]);
  random.server.requires.capabilities=['sql','crypto'];
  const b=backend(random,{capabilities:['sql','crypto']});
  t.after(b.close);
  const r=b.invoke({method:'POST',path:'/api/random',body:{cases:cryptoParity.cases}});
  assert.equal(r.status,200,JSON.stringify(r));
  const wrong=[];
  cryptoParity.cases.forEach((c,i)=>{
    const got=r.body[i],label=`${c.call}(${JSON.stringify(c.args).slice(1,-1)})`;
    if(c.throws){if(!got.threw)wrong.push(`${label} answered ${JSON.stringify(got.ok)}`);}
    else if(got.threw)wrong.push(`${label} threw`);
    else if(c.below!==undefined&&!(Number.isInteger(got.ok)&&got.ok>=0&&got.ok<c.below))wrong.push(`${label} is ${JSON.stringify(got.ok)}`);
    else if(c.length!==undefined&&!(typeof got.ok==='string'&&/^[0-9a-f]+$/.test(got.ok)&&got.ok.length===c.length))wrong.push(`${label} is ${JSON.stringify(got.ok)}`);
  });
  assert.deepEqual(wrong,[]);
});

test('softn.config is the app\'s settings under the two flags the host owns',t=>{
  // config.app reaches the script key for key, but `development` and
  // `photos` are the host's to say, as on the Rust host: the app's own
  // `photos: true` used to pass straight through with no grant behind it.
  const app={plan:'pro',limits:{notes:3},development:true,photos:true};
  const routes=[{method:'GET',path:'/api/settings',handler:'settings'}];
  const ungranted=backend(manifest(routes,{config:{app}}));
  t.after(ungranted.close);
  assert.deepEqual(ungranted.invoke({method:'GET',path:'/api/settings',photos:true}).body,{plan:'pro',limits:{notes:3},development:false,photos:false});
  // Granted, and GD there to do the work, which is what /api/meta reports.
  const granting=manifest(routes,{config:{app}});
  granting.server.requires.capabilities=['sql','photos'];
  const granted=backend(granting,{capabilities:['sql','photos']});
  t.after(granted.close);
  assert.equal(granted.invoke({method:'GET',path:'/api/settings',photos:true}).body.photos,true);
  assert.equal(granted.invoke({method:'GET',path:'/api/meta',photos:true}).body.photos,true);
  assert.equal(granted.invoke({method:'GET',path:'/api/settings',photos:false}).body.photos,false);
  assert.equal(granted.invoke({method:'GET',path:'/api/meta',photos:false}).body.photos,false);
});

test('a handler that throws and a read route that writes change nothing, and the log says which and why',t=>{
  const b=backend(manifest([
    {method:'POST',path:'/api/boom',handler:'boom'},
    {method:'GET',path:'/api/sneak',handler:'sneak'},
    {method:'GET',path:'/api/value',handler:'value'},
  ]));
  t.after(b.close);
  const value=()=>b.invoke({method:'GET',path:'/api/value'}).body.value;
  const thrown=b.logged({method:'POST',path:'/api/boom'});
  assert.equal(thrown.status,500);
  assert.deepEqual(thrown.body,{error:'The request could not be completed.',code:'host_error'},'the client is told nothing of the reason');
  assert.equal(value(),0,'what the handler wrote before it threw is not kept');
  // One line for whoever runs the host: the handler and the reason, with
  // anything shaped like a path replaced and control characters removed.
  assert.match(thrown.stderr,/^softn: handler boom: .*boom at <path> with tab\n$/);
  assert.doesNotMatch(thrown.stderr,/secret|\t/);
  const refused=b.logged({method:'GET',path:'/api/sneak'});
  assert.equal(refused.status,500);
  assert.equal(value(),0,'a read route cannot write');
  assert.match(refused.stderr,/^softn: handler sneak: Read-only transaction\n$/);
  // A request that works leaves nothing to log.
  assert.equal(b.logged({method:'GET',path:'/api/value'}).stderr,'');
});

test('a startup that fails names its stage on stderr, without the path that was missing',t=>{
  const b=backend(manifest([{method:'GET',path:'/api/ping',handler:'ping'}]));
  t.after(b.close);
  rmSync(join(b.root,'app/server/migrations/001.sql'));
  const r=b.logged({method:'GET',path:'/api/ping'});
  assert.equal(r.status,503);
  assert.deepEqual(r.body,{error:'The backend is unavailable. Check its private configuration.',code:'backend_unavailable',diagnostic:'database_migrations'});
  assert.match(r.stderr,/^softn: startup stage database_migrations: ENOENT.*<path>/);
  assert.ok(!r.stderr.includes(b.root)&&!r.stderr.includes('001.sql'),r.stderr);
});

test('a host call carries 2 MiB of arguments, as on the Rust host',t=>{
  const b=backend(manifest([{method:'GET',path:'/api/big',handler:'big'}]));
  t.after(b.close);
  // 1.5 MB was refused when the limit was 1 MB.
  assert.deepEqual(b.invoke({method:'GET',path:'/api/big',query:{n:'1500000'}}),{status:200,body:{n:1500000}});
  const over=b.logged({method:'GET',path:'/api/big',query:{n:'2200000'}});
  assert.equal(over.status,500);
  assert.match(over.stderr,/softn: handler big: Host call arguments exceed 2117152 bytes: sql\.first/);
});

test('text that is not ASCII reaches the handler whole, however the runner is fed',t=>{
  const b=backend(manifest([{method:'POST',path:'/api/text',handler:'text',transaction:'none'}]));
  t.after(b.close);
  // 600 KB of two-, three- and four-byte characters, sent as themselves:
  // read as raw chunks, each boundary inside a character left U+FFFD behind.
  const sent='\u00e9\u4e16\u{1F600}'.repeat(66000)+'end';
  const got=b.invoke({method:'POST',path:'/api/text',body:{text:sent}});
  assert.equal(got.status,200,JSON.stringify(got).slice(0,200));
  assert.equal(got.body.text.length,sent.length);
  assert.ok(got.body.text===sent,'the text came back as it was sent');
  assert.ok(!got.body.text.includes('\ufffd'));
});

test('config.server.requestsPerMinute sets the rate limit, and 0 turns it off',t=>{
  const limited=backend(manifest([{method:'GET',path:'/api/ping',handler:'ping'}],{config:{server:{requestsPerMinute:2}}}));
  t.after(limited.close);
  const ping=(b,ip='203.0.113.9')=>b.invoke({method:'GET',path:'/api/ping',client_ip:ip}).status;
  // The limiter counts by the wall clock's minute, and each call here is a
  // process of its own: three that straddle the turn of a minute are counted
  // in two, and the third is let through. So the three are only judged when
  // one minute held them all; otherwise they are sent again from another
  // address.
  const minute=()=>Math.floor(Date.now()/60000);
  // A note left by an earlier minute, which the next refusal clears away.
  mkdirSync(join(limited.root,'private/limited/1'),{recursive:true});
  writeFileSync(join(limited.root,'private/limited/1/stale'),'');
  let burst=null,refused=null;
  for(let attempt=0;burst===null&&attempt<3;attempt++){
    const started=minute(),ip='203.0.113.'+(20+attempt);
    const got=[ping(limited,ip),ping(limited,ip),ping(limited,ip)];
    if(minute()===started){burst=got;refused={ip,minute:started};}
  }
  assert.deepEqual(burst,[200,200,429]);
  // The refusal is noted where http.php looks before it starts anything
  // (request.php softn_rate_marker), and only this minute's notes are kept.
  const bucket=createHash('sha256').update(refused.ip).digest('hex');
  assert.ok(existsSync(join(limited.root,'private/limited',String(refused.minute),bucket)),'the refused bucket is noted');
  assert.deepEqual(readdirSync(join(limited.root,'private/limited')).filter(name=>name!==String(refused.minute)&&name!==String(refused.minute+1)),[]);
  // A bucket is counted by the minute: when the minute has turned, it starts again.
  const store=new DatabaseSync(join(limited.root,'private/data/application.sqlite'));
  try{store.exec('UPDATE _request_limits SET minute=minute-1');}finally{store.close();}
  assert.equal(ping(limited,refused.ip),200);
  // Another address has its own count.
  assert.equal(limited.invoke({method:'GET',path:'/api/ping',client_ip:'203.0.113.10'}).status,200);

  const open=backend(manifest([{method:'GET',path:'/api/ping',handler:'ping'}],{config:{server:{requestsPerMinute:0}}}));
  t.after(open.close);
  assert.deepEqual([ping(open),ping(open),ping(open),ping(open)],[200,200,200,200]);

  // Something that is not a whole number is not a limit: the default stands.
  const odd=backend(manifest([{method:'GET',path:'/api/ping',handler:'ping'}],{config:{server:{requestsPerMinute:'2'}}}));
  t.after(odd.close);
  assert.deepEqual([ping(odd),ping(odd),ping(odd)],[200,200,200]);
});

test('an upload the host refused is counted against the rate limit like any other request',t=>{
  // http.php used to answer a photo it would not take by itself, after taking
  // a worker slot and decoding the image: the runner, which is where requests
  // are counted, was never started. So refused uploads were never counted,
  // and one client sending them could keep every slot busy for as long as it
  // liked. http.php now hands the refusal to the runner (`refused`), which
  // counts it and answers it without running the handler.
  const uploads=manifest([{method:'POST',path:'/api/photo',handler:'count',upload:'photo'},{method:'GET',path:'/api/value',handler:'value'}],{config:{server:{requestsPerMinute:2}}});
  uploads.server.requires.capabilities=['sql','photos'];
  const b=backend(uploads,{capabilities:['sql','photos']});
  t.after(b.close);
  const refused=ip=>b.invoke({method:'POST',path:'/api/photo',client_ip:ip,refused:'photo'});
  const minute=()=>Math.floor(Date.now()/60000);
  // Judged only when one minute held all three, as the test above explains.
  let burst=null,last=null;
  for(let attempt=0;burst===null&&attempt<3;attempt++){
    const started=minute(),ip='203.0.113.'+(40+attempt);
    const got=[refused(ip),refused(ip),refused(ip)];
    if(minute()===started){burst=got.map(r=>r.status);last={ip,minute:started,first:got[0]};}
  }
  assert.deepEqual(burst,[400,400,429]);
  assert.match(last.first.body.error,/^Photo rejected\./);
  // With the code the Rust host answers a bad photo with, and its document
  // says both do: this host's refusal had no code at all.
  assert.equal(last.first.body.code,'photo_rejected');
  // The handler never ran for any of them.
  assert.equal(b.invoke({method:'GET',path:'/api/value',client_ip:'203.0.113.99'}).body.value,0);
  // And the refusal is noted, so http.php answers the rest of the minute
  // before it reads a body, takes a slot or decodes anything.
  assert.ok(existsSync(join(b.root,'private/limited',String(last.minute),createHash('sha256').update(last.ip).digest('hex'))),'the refused bucket is noted');
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

test('started as http.php starts it, the runner compiles nothing that outlives its answer',t=>{
  // The flags a request's Node is given, read from where the command is
  // written (request.php softn_runner_command; it was in http.php), so that
  // what is tested is what is run.
  const written=['request.php','http.php'].map(name=>readFileSync(join(runtime,name),'utf8')).join('\n').match(/\[\$backend\.'\/bin\/node',([^\]]+)\]/);
  assert.ok(written,'the command that starts the runner');
  const flags=[...written[1].matchAll(/'(--[a-z0-9=-]+)'/g)].map(m=>m[1]);
  assert.ok(flags.includes('--disable-proto=throw'),flags.join(' '));
  const b=backend(manifest([{method:'GET',path:'/api/ping',handler:'ping'}]));
  t.after(b.close);
  const input=JSON.stringify({path:'/api/ping',method:'GET',query:{},headers:{},body:{},client_ip:'127.0.0.1',photos:false});
  assert.equal(JSON.parse(b.fed(input).stdout).status,200);
  // V8 says what it compiles and with which compiler, on stdout beside the answer.
  const traced=with_=>{
    const r=b.fed(input,[...with_,'--trace-wasm-compilation-times']);
    return {answered:r.status===0&&r.stdout.includes('{"status":200,"body":{"ok":true,"path":"/api/ping"}}'),baseline:(r.stdout.match(/using Liftoff/g)??[]).length,optimized:(r.stdout.match(/using TurboFan/g)??[]).length};
  };
  const plain=traced(['--disable-proto=throw']);
  if(!plain.answered||plain.baseline===0){t.skip('this Node does not trace wasm compilation (--trace-wasm-compilation-times)');return;}
  const started=traced(flags);
  assert.ok(started.answered,'the runner answers with the flags a request is started with');
  assert.ok(started.baseline>0,'the engine is compiled by the baseline compiler');
  // The engine's dispatch loop is one function of 280 KB. Left to itself V8
  // starts optimizing it while the handler runs, which takes about 450 ms
  // and over 100 MB, and a process cannot end while that is going on: every
  // request waited a third of a second after its answer was written, for
  // code that process would never run.
  assert.equal(started.optimized,0,'no optimizing compile is started for a process that lives for one request');
  if(plain.optimized===0)t.diagnostic('this Node did not optimize the engine during a request even without the flags');
});

const phpSkip=skip||(spawnSync('php',['-v']).status===0?false:'php is not on PATH (install PHP 8.1+ to run this test)');
if(phpSkip&&!skip)console.warn('WARNING: tests/route-declarations.test.mjs body-text test skipped: '+phpSkip);
nodeTest('a body handed on as the client\'s text is the body a handler was handed before, but for the sign of -0',{skip:phpSkip},t=>{
  const b=backend(manifest([{method:'POST',path:'/api/inspect',handler:'inspect'}]));
  t.after(b.close);
  // Every spelling PHP wrote differently from the client: exponents, a
  // fraction of zero, integers past 2^53 and past 2^64, escapes it did not
  // need, a key sent twice, names a JavaScript object treats specially,
  // and as deep as a body may go.
  const deep='{"a":'.repeat(60)+'"leaf"'+'}'.repeat(60);
  const text='{"z":-0,"zf":-0.0,"one":1.0,"e":1e2,"exp":1E+2,"tiny":1e-7,"safe":9007199254740991,"big":9007199254740993,"huge":12345678901234567890,"neg":-12345678901234567890,"tenth":0.1,'
    +'"long":3.141592653589793238462643383279,"wide":1e16,"dup":1,"text":"café ☃ \\ud83d\\ude00 a\\/b \\u0041 \\\\ \\" \\n","empty":"","nul":"a\\u0000b","dup":2,'
    +'"__proto__":{"x":1},"constructor":"c","toString":"t","list":[1,[2,[3,{}]],[]],"obj":{},"t":true,"f":false,"n":null,"deep":'+deep+'}';
  JSON.parse(text);
  // Both ways of writing the runner's input, by the PHP that writes it:
  // the body decoded and written again, as http.php did, and its own text.
  const script=`require ${JSON.stringify(join(runtime,'request.php'))};$raw=stream_get_contents(STDIN);
    $request=['path'=>'/api/inspect','method'=>'POST','query'=>new stdClass(),'headers'=>new stdClass(),'body'=>null,'client_ip'=>'127.0.0.1','rate_key'=>'127.0.0.1','photos'=>false];
    $body=softn_request_body($raw);if($body===null){fwrite(STDERR,'refused');exit(1);}
    $rewritten=json_encode(array_merge($request,['body'=>$body]),JSON_THROW_ON_ERROR|JSON_INVALID_UTF8_SUBSTITUTE|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
    echo json_encode(['rewritten'=>$rewritten,'text'=>softn_runner_input($request,$raw)],JSON_UNESCAPED_UNICODE);`;
  const written=spawnSync('php',['-d','display_errors=stderr','-r',script],{input:text,encoding:'utf8'});
  assert.equal(written.status,0,written.stderr);assert.equal(written.stderr,'');
  const inputs=JSON.parse(written.stdout);
  assert.notEqual(inputs.rewritten,inputs.text);
  const answer=input=>{const r=b.fed(input);assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);assert.equal(out.status,200,r.stdout+r.stderr);return out.body;};
  const before=answer(inputs.rewritten),now=answer(inputs.text);
  // The one thing a handler can tell: PHP read `-0` as the integer 0 and
  // wrote that; the text keeps the sign, as JSON.parse and the Rust host do.
  assert.equal(before.negative,false);
  assert.equal(now.negative,true);
  assert.deepEqual({...now,negative:false},before);
  // And what that body is, so that "the same" is not "the same mistake".
  assert.deepEqual(now.keys,['z','zf','one','e','exp','tiny','safe','big','huge','neg','tenth','long','wide','dup','text','empty','nul','__proto__','constructor','toString','list','obj','t','f','n','deep']);
  assert.deepEqual(now.request,['path','method','query','headers','body','photos','context']);
  assert.equal(now.negativeFloat,true);
  assert.deepEqual(now.types,['number','number','string','object','object']);
  assert.equal(now.body.dup,2);assert.equal(now.body.text,'café ☃ \u{1F600} a/b A \\ " \n');assert.equal(now.body.nul,'a\u0000b');
  assert.equal(now.body.big,9007199254740992);assert.equal(now.body.huge,12345678901234567000);assert.equal(now.body.wide,1e16);
});
