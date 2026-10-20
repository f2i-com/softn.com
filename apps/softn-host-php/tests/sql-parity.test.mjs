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
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const [major,minor]=process.versions.node.split('.').map(Number);
const skip=major<24||major===24&&minor<19?'Node 24.19 or newer (node:sqlite setAuthorizer)':false;
if(skip)console.warn(`WARNING: tests/sql-parity.test.mjs skipped: ${skip}. See apps/softn-host-php/README.md, Validation.`);
const test=(name,...rest)=>{const fn=rest.pop();return nodeTest(name,{...(rest[0]??{}),skip},fn);};
const {DatabaseSync}=skip?{}:await import('node:sqlite');
const {createSql,SQL_LIMITS}=skip?{}:await import('../runtime/sql.mjs');
const {applyMigration}=skip?{}:await import('../runtime/migrations.mjs');
const parity=JSON.parse(readFileSync(new URL('./sql-parity.json',import.meta.url),'utf8'));

function database() {
  // With the limits a request's connection has (runtime/sql.mjs), as the
  // Rust host's runs open its connection with its own.
  const db=new DatabaseSync(':memory:',{limits:SQL_LIMITS});
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

test('the request connection refuses a new statement at each of its limits, and reads every database written without them',()=>{
  // SQL_LIMITS (runtime/sql.mjs). node:sqlite takes a key it does not know
  // without a word, so each is tried at its bound: a Node that stopped
  // enforcing one would fail here, not leave it off.
  const db=new DatabaseSync(':memory:',{limits:SQL_LIMITS});
  try {
    const refused=sql=>{try{db.prepare(sql);return null;}catch(e){return e.message;}};
    // ATTACH is a function call when it is prepared; the limit is met when it runs.
    assert.throws(()=>db.prepare("ATTACH ':memory:' AS other").run(),/too many attached databases/);
    assert.equal(refused('SELECT ?100'),null);
    assert.match(refused('SELECT ?101')??'',/variable number must be between \?1 and \?100/);
    // SQLite holds the opcode count as its array of opcodes grows, a step at
    // a time, so the bound is a little under 100,000: half of it is taken,
    // twice it is not.
    const cases=n=>'SELECT CASE 0 '+Array.from({length:n},(_,i)=>`WHEN ${i} THEN ${i}`).join(' ')+' END';
    assert.equal(refused(cases(15_000)),null);
    assert.match(refused(cases(70_000))??'',/out of memory/);
  } finally {db.close();}
  // What an app may already have stored on this host stays readable: a value
  // over 2 MiB, a table of 250 columns, a CHECK 150 terms deep and a schema
  // statement of 300 KB, each written before there were limits.
  const values=Array.from({length:50_000},(_,i)=>i).join(',');
  const wide=Array.from({length:250},(_,i)=>`c${i} INTEGER`).join(',');
  const deep=Array.from({length:150},(_,i)=>`a = ${i}`).join(' OR ');
  const dir=mkdtempSync(join(tmpdir(),'softn-limits-'));
  const file=join(dir,'old.sqlite');
  const old=new DatabaseSync(file);
  old.exec(`CREATE TABLE big(v TEXT); INSERT INTO big VALUES (printf('%.*c', ${3*1024*1024}, 'x'));
    CREATE TABLE wide(${wide}); INSERT INTO wide(c0) VALUES (1);
    CREATE TABLE deep(a INTEGER CHECK (${deep})); INSERT INTO deep VALUES (3);
    CREATE TABLE listed(a INTEGER CHECK (a IN (${values}))); INSERT INTO listed VALUES (7);`);
  old.close();
  const now=new DatabaseSync(file,{limits:SQL_LIMITS});
  try {
    assert.equal(now.prepare('SELECT length(v) AS n FROM big').get().n,3*1024*1024);
    assert.equal(now.prepare('SELECT c0 FROM wide').get().c0,1);
    assert.equal(now.prepare('SELECT a FROM deep').get().a,3);
    assert.equal(now.prepare('SELECT a FROM listed').get().a,7);
  } finally {now.close(); rmSync(dir,{recursive:true,force:true});}
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

test('a migration may seed twenty thousand rows in one INSERT, as it always could on this host',()=>{
  // The request connection's 100,000 opcodes (SQL_LIMITS) are a limit on one
  // compiled statement, and a migration runs on that connection. A seed
  // table written as one INSERT is a few opcodes a row: twenty thousand
  // rows of two columns, 400 KB of the 1,000,000 bytes a migration may be,
  // were refused with SQLite's "out of memory", and an app whose first
  // migration is such a list no longer started on a fresh install.
  const rows=Array.from({length:20_000},(_,i)=>`(${i},'place ${i}')`).join(',');
  const cases=n=>'SELECT CASE 0 '+Array.from({length:n},(_,i)=>`WHEN ${i} THEN ${i}`).join(' ')+' END';
  const db=database();
  try {
    db.exec('BEGIN IMMEDIATE');
    applyMigration(db,`CREATE TABLE places(id INTEGER PRIMARY KEY, name TEXT);\nINSERT INTO places VALUES ${rows};`);
    assert.equal(db.prepare('SELECT count(*) AS n FROM places').get().n,20_000);
    // And the limit is the request's again once the migration is done, also
    // after one that failed.
    assert.throws(()=>db.prepare(cases(70_000)),/out of memory/);
    assert.throws(()=>applyMigration(db,'INSERT INTO no_such_table VALUES (1);'));
    assert.throws(()=>db.prepare(cases(70_000)),/out of memory/);
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
