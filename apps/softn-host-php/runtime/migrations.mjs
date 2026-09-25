import {migrationAuthorizer} from './sql.mjs';
const hostNames=db=>new Set(db.prepare("SELECT name FROM sqlite_master WHERE substr(name,1,1)='_'").all().map(r=>r.name));
// Schema scripts are guest bundle input too. The authorizer (sql.mjs, the Rust
// host's rules) denies ATTACH/PRAGMA/transactions, extension loading, virtual
// tables, views/triggers and host-private tables.
export function applyMigration(db,sql) {
  if(typeof sql!=='string'||Buffer.byteLength(sql)>1_000_000)throw new Error('Migration size');
  const before=hostNames(db);
  db.setAuthorizer(migrationAuthorizer);
  try{db.exec(sql);}finally{db.setAuthorizer(null);}
  // The authorizer sees the old name of `ALTER TABLE t RENAME TO x`, never x:
  // a migration may not move anything into the host's `_` namespace that way.
  for(const name of hostNames(db))if(!before.has(name))throw new Error('Migration named a host-reserved table');
}
