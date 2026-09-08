import {constants} from 'node:sqlite';
const ddl=new Set([constants.SQLITE_CREATE_TABLE,constants.SQLITE_CREATE_INDEX,constants.SQLITE_DROP_TABLE,constants.SQLITE_DROP_INDEX,constants.SQLITE_ALTER_TABLE,constants.SQLITE_REINDEX]);
const data=new Set([constants.SQLITE_READ,constants.SQLITE_INSERT,constants.SQLITE_UPDATE,constants.SQLITE_DELETE]);
const safeFunctions=new Set(['count','coalesce','min','max','sum','avg','lower','upper','length','substr','replace','abs','datetime','date','time','strftime','julianday','unixepoch']);
// Schema scripts are guest bundle input too. Deny ATTACH/PRAGMA/transactions,
// extension loading, virtual tables, views/triggers and host-private tables.
export function applyMigration(db,sql) {
  if(typeof sql!=='string'||Buffer.byteLength(sql)>1_000_000)throw new Error('Migration size');
  db.setAuthorizer((action,a,b,database)=>{
    if(database&&database!=='main')return constants.SQLITE_DENY;
    if(action===constants.SQLITE_SELECT)return constants.SQLITE_OK;
    if(action===constants.SQLITE_FUNCTION)return safeFunctions.has(String(b).toLowerCase())?constants.SQLITE_OK:constants.SQLITE_DENY;
    if(ddl.has(action))return (action===constants.SQLITE_ALTER_TABLE?a==='main'&&b&&!b.startsWith('_'):a&&!a.startsWith('_'))?constants.SQLITE_OK:constants.SQLITE_DENY;
    if(data.has(action))return a&&!a.startsWith('_')?constants.SQLITE_OK:constants.SQLITE_DENY;
    return constants.SQLITE_DENY;
  });
  try{db.exec(sql);}finally{db.setAuthorizer(null);}
}
