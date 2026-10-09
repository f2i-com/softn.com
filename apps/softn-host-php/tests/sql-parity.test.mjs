/**
 * The SQL contract both backend hosts keep, from the shared list in
 * sql-parity.json: which migrations and which request-time softn.sql calls
 * run, and what a few of them return. This host used to refuse CTEs, any `;`
 * inside a literal, LIKE/trim/ifnull and the rest of the Rust host's function
 * list, recursive CTEs in migrations, and json_each; it bound 5 as the REAL
 * 5.0 (so `? / 2` was 2.5), bound a missing parameter as NULL, returned a
 * BLOB as an object of byte values, and ran `INSERT … RETURNING` as an
 * execute. The Rust host runs the same file (apps/softn-host-rust/src/sql_parity_tests.rs); a case whose
 * answer differs between the hosts carries a `rust` note saying what Rust answers.
 *
 * Needs only node:sqlite (Node 24.19+), not the WASM engine or a backend.
 */
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const [major,minor]=process.versions.node.split('.').map(Number);
const skip=major<24||major===24&&minor<19?'Node 24.19 or newer (node:sqlite setAuthorizer)':false;
if(skip)console.warn(`WARNING: tests/sql-parity.test.mjs skipped: ${skip}. See apps/softn-host-php/README.md, Validation.`);
const test=(name,...rest)=>{const fn=rest.pop();return nodeTest(name,{...(rest[0]??{}),skip},fn);};
const {DatabaseSync}=skip?{}:await import('node:sqlite');
const {createSql}=skip?{}:await import('../runtime/sql.mjs');
const {applyMigration}=skip?{}:await import('../runtime/migrations.mjs');
const parity=JSON.parse(readFileSync(new URL('./sql-parity.json',import.meta.url),'utf8'));

function database() {
  const db=new DatabaseSync(':memory:');
  db.exec(parity.schema);
  return db;
}
const plain=value=>value&&typeof value==='object'?{...value}:value;

test('migrations: the shared list is allowed and refused as the contract says',()=>{
  const wrong=[];
  for(const c of parity.migration) {
    const db=database();
    let error=null;
    try {
      db.exec('BEGIN IMMEDIATE');
      try{applyMigration(db,c.sql);}catch(e){error=e;}
      db.exec('ROLLBACK');
    } finally {db.close();}
    if((error===null)!==c.allow)wrong.push(`${c.allow?'refused':'allowed'}: ${c.sql}${error?` (${error.message})`:''}`);
  }
  assert.deepEqual(wrong,[]);
});

test('request-time SQL: the shared list is allowed and refused as the contract says, with the same results',()=>{
  const wrong=[];
  for(const c of parity.runtime) {
    const db=database();
    let error=null,result;
    try {
      db.exec(c.mode==='read'?'BEGIN':'BEGIN IMMEDIATE');
      // `before`: an execute the same request made first. What it inserted
      // used to be the lastInsertRowid of a later statement that inserted nothing.
      try{const sql=createSql(db);if(c.before)sql('execute',c.before,[],true);result=sql(c.kind,c.sql,c.params??[],c.mode!=='read');}catch(e){error=e;}
      db.exec('ROLLBACK');
    } finally {db.close();}
    if((error===null)!==c.allow)wrong.push(`${c.allow?'refused':'allowed'}: ${c.kind} ${JSON.stringify(c.sql)}${error?` (${error.message})`:''}`);
    else if(c.result!==undefined){try{assert.deepEqual(plain(result),c.result);}catch{wrong.push(`result of ${c.sql}: ${JSON.stringify(result)}`);}}
  }
  assert.deepEqual(wrong,[]);
});

test('a migration may be 1,000,000 bytes and no more, which the Rust host takes too',()=>{
  // The reference for apps/softn-host-rust (private_backend.rs
  // a_migration_may_be_as_large_as_the_php_host_takes): its limit was 256 KiB.
  const row="INSERT INTO seeds(note) VALUES('"+'x'.repeat(200)+"');\n";
  const seeds=bytes=>{let script='CREATE TABLE IF NOT EXISTS seeds(id INTEGER PRIMARY KEY, note TEXT);\n';while(script.length+row.length<=bytes)script+=row;return script+' '.repeat(bytes-script.length);};
  const db=database();
  try {
    db.exec('BEGIN IMMEDIATE');
    applyMigration(db,seeds(1_000_000));
    assert.ok(db.prepare('SELECT count(*) AS n FROM seeds').get().n>4000);
    assert.throws(()=>applyMigration(db,seeds(1_000_001)),/Migration size/);
    db.exec('ROLLBACK');
  } finally {db.close();}
});

test('a migration that renames into the host namespace is caught after the fact, and its transaction is the caller\'s to roll back',()=>{
  const db=database();
  try {
    db.exec('BEGIN IMMEDIATE');
    assert.throws(()=>applyMigration(db,'ALTER TABLE items RENAME TO _items;'),/host-reserved/);
    db.exec('ROLLBACK');
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='items'").get().n,1);
  } finally {db.close();}
});
