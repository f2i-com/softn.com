import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=resolve(process.env.SOFTN_PHP_TEST_BACKEND||'');
const skip=process.env.SOFTN_PHP_TEST_BACKEND?false:'Set SOFTN_PHP_TEST_BACKEND to an extracted backend directory';
// Without the backend fixture these tests are SKIPPED, visibly, not thrown
// out of: the suite runs in every checkout and CI, and the fixture-bound
// cases report why they did not run.
if(skip)console.warn(`WARNING: tests/runtime.test.mjs skipped: ${skip}. See apps/softn-host-php/README.md, Validation.`);
const test=(name,...rest)=>{const fn=rest.pop();return nodeTest(name,{...(rest[0]??{}),skip},fn);};
const {createWasmHost}=skip?{}:await import(pathToFileURL(join(root,'wasm-host.mjs')));
const {applyMigration}=skip?{}:await import(pathToFileURL(join(root,'migrations.mjs')));
const {parseZoned}=skip?{}:await import(pathToFileURL(join(root,'time.mjs')));
const key=Buffer.alloc(32,7),cryptoDomains={hmac:'test:hmac:v1',seal:'test:seal:v1'};
function fixture(source,capabilities=['sql','crypto','time'],steps=100000) {
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0); CREATE TABLE _private(secret TEXT); INSERT INTO _private VALUES(\'host-only\')');
  const host=createWasmHost(db,{key,cryptoDomains,source,capabilities,steps});
  return {db,run:(body={},transaction='write')=>host.invoke({body},{handler:'handle',transaction})};
}
test('generic handler runs a second app and persists SQL across fresh VMs',()=>{
  const f=fixture('function handle(req){softn.sql.execute("UPDATE counter SET value=value+?",[req.body.by]);return {status:200,body:softn.sql.first("SELECT value FROM counter",[])};}');
  try{assert.deepEqual(f.run({by:2}),{status:200,body:{value:2}});assert.equal(f.run({by:3}).body.value,5);}finally{f.db.close();}
});
// The engine reads a directive off the start of what it compiles, and that
// starts with the shim: strict logic ran sloppy until the host put the
// logic's directive first. The shim's own bridges run strict with it.
test('the logic\'s "use strict" is in force, and its absence too',()=>{
  const probe='function handle(){var plainThis=(function(){return this===undefined;})();var assigned;try{undeclaredName=1;assigned="made a global";}catch(e){assigned=e.name;}return {status:200,body:{plainThis:plainThis,assigned:assigned,value:softn.sql.first("SELECT value FROM counter",[]).value}};}';
  for(const [prefix,strict] of [['"use strict";\n',true],["// The app.\n'use strict'\n",true],['',false],['var first=1;\n"use strict";\n',false]]){
    const f=fixture(prefix+probe);
    try{assert.deepEqual(f.run().body,{plainThis:strict,assigned:strict?'ReferenceError':'made a global',value:0},JSON.stringify(prefix));}finally{f.db.close();}
  }
});
test('guest has no host process, require, filesystem or decryption authority',()=>{
  const f=fixture('function handle(){return {status:200,body:{process:typeof process,require:typeof require,unseal:typeof softn.crypto.unseal}};}');
  try{assert.deepEqual(f.run().body,{process:'undefined',require:'undefined',unseal:'undefined'});}finally{f.db.close();}
});
test('missing capability and direct capability dispatcher bypass are denied',()=>{
  for(const source of ['function handle(){return {status:200,body:softn.crypto.randomHex(4)};}','function handle(){return {status:200,body:db.query("crypto.unseal",["secret"])};}']){
    const f=fixture(source,[]);try{assert.equal(f.run().status,500);}finally{f.db.close();}
  }
});
test('SQL host-private tables, filesystem functions and write-through-query are denied',()=>{
  for(const call of ['softn.sql.first("SELECT secret FROM _private",[])','softn.sql.first("SELECT load_extension(?)",["/tmp/a"])','softn.sql.query("INSERT INTO counter VALUES(99) RETURNING value",[])','softn.sql.execute("ATTACH DATABASE ? AS other",["/tmp/no"])']) {
    const f=fixture('function handle(){return {status:200,body:'+call+'};}');
    try{assert.equal(f.run().status,500);assert.equal(f.db.prepare('SELECT count(*) n FROM counter').get().n,1);}finally{f.db.close();}
  }
});
test('read transactions reject writes and explicit rollback restores data',()=>{
  const f=fixture('function handle(){softn.sql.execute("UPDATE counter SET value=3",[]);return {status:409,body:{error:"cancel"},rollback:true};}');
  try{assert.equal(f.run({},'read').status,500);assert.equal(f.run().status,409);assert.equal(f.db.prepare('SELECT value FROM counter').get().value,0);}finally{f.db.close();}
});
test('instruction exhaustion rolls back prior writes',()=>{
  const f=fixture('function handle(){softn.sql.execute("UPDATE counter SET value=99",[]);while(true){}return {status:200,body:{}};}', ['sql'],20000);
  try{assert.equal(f.run().status,500);assert.equal(f.db.prepare('SELECT value FROM counter').get().value,0);}finally{f.db.close();}
});
test('migrations cannot escape database or mutate private host tables',()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE _private(value TEXT)');
  try {
    applyMigration(db,'CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT); CREATE INDEX items_name ON items(name);');
    for(const sql of ["ATTACH DATABASE '/tmp/escape.sqlite' AS other",'PRAGMA writable_schema=ON','BEGIN','DROP TABLE _private','CREATE TABLE _stolen(value TEXT)',"INSERT INTO _private VALUES('changed')",'CREATE INDEX stolen ON _private(value)','ALTER TABLE items RENAME TO _items']){assert.throws(()=>applyMigration(db,sql));}
  } finally {db.close();}
});

test('assembled helper matches source and permits STRICT nullable TEXT while guest PRAGMA remains denied',()=>{
  const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
  assert.equal(hash(join(root,'migrations.mjs')),hash(new URL('../runtime/migrations.mjs',import.meta.url)),'assembled helper is the candidate source, not an older frozen runtime');
  const db=new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,note TEXT CHECK(length(note)<20)) STRICT; INSERT INTO items VALUES(1,'kept'); CREATE TABLE _private(secret TEXT); INSERT INTO _private VALUES('kept');");
    applyMigration(db,'CREATE TABLE scopes(id TEXT PRIMARY KEY) STRICT; ALTER TABLE items ADD scope_id TEXT REFERENCES scopes(id);');
    assert.equal(db.prepare('SELECT scope_id FROM items').get().scope_id,null);
    db.exec('BEGIN IMMEDIATE');
    try{assert.throws(()=>applyMigration(db,'ALTER TABLE items ADD rolled_back TEXT; PRAGMA main.quick_check(items);'));}
    finally{db.exec('ROLLBACK');}
    assert.equal(db.prepare('PRAGMA table_info(items)').all().some(row=>row.name==='rolled_back'),false);
    assert.equal(db.prepare('SELECT secret FROM _private').get().secret,'kept');
    const forbidden=createWasmHost(db,{key,cryptoDomains,capabilities:['sql'],source:`function handle(){softn.sql.query("SELECT * FROM pragma_quick_check('items','main')",[]);return {status:200,body:{leaked:true}};}`});
    const rejected=forbidden.invoke({body:{}},{handler:'handle',transaction:'read'});
    // Host permission failures are fatal to the request, rather than a guest
    // success with a swallowed exception. Preserve that existing boundary.
    assert.equal(rejected.status,500);
    assert.equal(rejected.body.code,'host_error');
    const allowed=createWasmHost(db,{key,cryptoDomains,capabilities:['sql'],source:'function handle(){return {status:200,body:softn.sql.first("SELECT note FROM items",[])}}'});
    assert.deepEqual(allowed.invoke({body:{}},{handler:'handle',transaction:'read'}),{status:200,body:{note:'kept'}});
    assert.equal(db.prepare('SELECT secret FROM _private').get().secret,'kept');
  } finally{db.close();}
});
test('time host supports non-Australian zones and rejects ambiguous dates',()=>{
  assert.equal(parseZoned('2026-07-01','12:00','America/New_York'),Date.parse('2026-07-01T16:00:00Z')/1000);
  assert.throws(()=>parseZoned('2026-11-01','01:30','America/New_York'));
});
