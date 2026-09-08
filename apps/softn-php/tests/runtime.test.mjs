import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
const root=resolve(process.env.SOFTN_PHP_TEST_BACKEND||'');
if(!process.env.SOFTN_PHP_TEST_BACKEND)throw new Error('Set SOFTN_PHP_TEST_BACKEND to an extracted backend directory');
const {createWasmHost}=await import(pathToFileURL(join(root,'wasm-host.mjs')));
const {applyMigration}=await import(pathToFileURL(join(root,'migrations.mjs')));
const {parseZoned}=await import(pathToFileURL(join(root,'time.mjs')));
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
    for(const sql of ["ATTACH DATABASE '/tmp/escape.sqlite' AS other",'PRAGMA writable_schema=ON','BEGIN','DROP TABLE _private','CREATE TABLE _stolen(value TEXT)',"INSERT INTO _private VALUES('changed')"]){assert.throws(()=>applyMigration(db,sql));}
  } finally {db.close();}
});
test('time host supports non-Australian zones and rejects ambiguous dates',()=>{
  assert.equal(parseZoned('2026-07-01','12:00','America/New_York'),Date.parse('2026-07-01T16:00:00Z')/1000);
  assert.throws(()=>parseZoned('2026-11-01','01:30','America/New_York'));
});
