import {migrationAuthorizer} from './sql.mjs';
const hostNames=db=>new Set(db.prepare("SELECT name FROM sqlite_master WHERE substr(name,1,1)='_'").all().map(r=>r.name));
// Schema scripts are guest bundle input too. The authorizer (sql.mjs, the Rust
// host's rules) denies ATTACH/PRAGMA/transactions, extension loading, virtual
// tables, views/triggers and host-private tables.
export function applyMigration(db,sql) {
  if(typeof sql!=='string'||Buffer.byteLength(sql)>1_000_000)throw new Error('Migration size');
  const before=hostNames(db);
  // A request's statement is held to 100,000 opcodes (sql.mjs SQL_LIMITS). A
  // migration is not, on this host: one INSERT of fifteen thousand seed rows
  // compiles to more, this host has always applied one, and with the limit
  // an app that ships such a list did not start on a fresh install (SQLite
  // calls it "out of memory"). The file is held to the bytes above. SQLite's
  // own ceiling stands in for none, and the request's limit is put back.
  const limits=db.limits,held=limits?.vdbeOp;
  if(held!==undefined)limits.vdbeOp=250_000_000;
  db.setAuthorizer(migrationAuthorizer);
  try{db.exec(sql);}finally{db.setAuthorizer(null);if(held!==undefined)limits.vdbeOp=held;}
  // The authorizer sees the old name of `ALTER TABLE t RENAME TO x`, never x:
  // a migration may not move anything into the host's `_` namespace that way.
  for(const name of hostNames(db))if(!before.has(name))throw new Error('Migration named a host-reserved table');
}
