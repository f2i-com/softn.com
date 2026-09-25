import {constants as C} from 'node:sqlite';
// The SQL rules a bundle's server/ code and migrations meet on this host. They
// are the Rust host's (apps/softn-host-rust/src/bridges/sql.rs `authorize` and
// `single_statement`), so an app behaves the same on either;
// tests/sql-parity.json is the shared list both can be checked against.

/** Functions app SQL may call, at request time and in migrations. */
export const RUNTIME_FUNCTIONS=new Set(['count','min','max','sum','avg','total','coalesce','ifnull','nullif','length','lower','upper',
  'trim','ltrim','rtrim','substr','substring','replace','instr','abs','round','like','glob','typeof','unicode','char','hex','quote']);
/**
 * Migrations may also read the clock (defaults, backfills), and ALTER TABLE
 * rewrites the schema with SQL of SQLite's own that calls printf/format and the
 * sqlite_rename_* / sqlite_drop_column helpers (app SQL cannot call those).
 */
export const MIGRATION_FUNCTIONS=new Set([...RUNTIME_FUNCTIONS,'datetime','date','time','strftime','julianday','unixepoch',
  'printf','format','sqlite_rename_column','sqlite_rename_table','sqlite_rename_test','sqlite_rename_quotefix','sqlite_drop_column']);
const MAX_SAFE=Number.MAX_SAFE_INTEGER;
/**
 * What a request-time query may read, by name as the Rust host decides: an
 * app table, a CTE (`count(*) FROM cte` reads it by name), json_each/json_tree.
 * The pragma_* and dbstat table-valued functions also arrive as reads by name;
 * they fail on the PRAGMA or sqlite_master access they make next, on both
 * hosts, and are refused here by name as well.
 */
const readable=name=>appTable(name)&&!/^pragma_|^dbstat$/i.test(name);

/** An app's own table: not SQLite's and not in the host's `_` namespace. */
export const appTable=name=>typeof name==='string'&&name!==''&&!name.toLowerCase().startsWith('sqlite_')&&!name.startsWith('_');
const fn=name=>String(name).toLowerCase();

/**
 * The migration authorizer: DDL and DML on the app's own tables, the functions
 * above, nothing that leaves the main database (ATTACH, PRAGMA, transactions,
 * extensions, views, triggers, virtual and temp tables are all denied).
 */
export function migrationAuthorizer(action,a,b,database) {
  // ALTER TABLE names (database, table); DROP COLUMN passes the column where
  // other actions pass the database, so this comes before the database check.
  if(action===C.SQLITE_ALTER_TABLE)return a==='main'&&appTable(b)?C.SQLITE_OK:C.SQLITE_DENY;
  if(database&&database!=='main') {
    // RENAME COLUMN/TABLE also rewrites temp triggers and views naming the
    // table (a migration's connection has none): that schema table is all it may touch there.
    return database==='temp'&&(action===C.SQLITE_READ||action===C.SQLITE_UPDATE)&&(a==='sqlite_temp_master'||a==='sqlite_temp_schema')?C.SQLITE_OK:C.SQLITE_DENY;
  }
  switch(action) {
    case C.SQLITE_SELECT:case C.SQLITE_RECURSIVE:return C.SQLITE_OK;
    case C.SQLITE_READ:case C.SQLITE_INSERT:case C.SQLITE_UPDATE:case C.SQLITE_DELETE:
      return appTable(a)||typeof a==='string'&&a.startsWith('sqlite_')?C.SQLITE_OK:C.SQLITE_DENY;
    case C.SQLITE_CREATE_TABLE:return appTable(a)||a==='sqlite_sequence'?C.SQLITE_OK:C.SQLITE_DENY;
    case C.SQLITE_DROP_TABLE:case C.SQLITE_REINDEX:return appTable(a)?C.SQLITE_OK:C.SQLITE_DENY;
    // (index, table): the table must be the app's, and the index may not take a
    // host-reserved `_` name either, as the Rust host also refuses.
    case C.SQLITE_CREATE_INDEX:case C.SQLITE_DROP_INDEX:return appTable(b)&&!String(a).startsWith('_')?C.SQLITE_OK:C.SQLITE_DENY;
    case C.SQLITE_FUNCTION:return MIGRATION_FUNCTIONS.has(fn(b))?C.SQLITE_OK:C.SQLITE_DENY;
  }
  return C.SQLITE_DENY;
}

/**
 * One statement, as the Rust host's `single_statement` reads it: a `;` inside
 * a quoted literal or identifier ('…', "…", `…`, […]) or a comment is text, a
 * trailing `;` and comments after it are allowed, anything else after it is a
 * second statement. Returns the leading keyword (upper case) and how many
 * parameters the statement takes, counted as SQLite numbers them (`?` is the
 * next number, `?N` is N, each distinct :name/@name/$name the next number).
 */
export function scanStatement(sql) {
  if(typeof sql!=='string'||sql===''||Buffer.byteLength(sql)>20_000||sql.includes('\0'))throw new Error('SQL text exceeds host limits');
  const n=sql.length,space=c=>c===' '||c==='\t'||c==='\n'||c==='\f'||c==='\r';
  const idChar=c=>c!==undefined&&(/[A-Za-z0-9_$]/.test(c)||c.charCodeAt(0)>=0x80);
  const named=new Map(),names=[];
  let i=0,ended=false,parameters=0,keyword=null;
  while(i<n) {
    const c=sql[i];
    if(space(c)){i++;continue;}
    if(sql.startsWith('--',i)){const end=sql.indexOf('\n',i+2);i=end<0?n:end+1;continue;}
    if(sql.startsWith('/*',i)){const end=sql.indexOf('*/',i+2);if(end<0)throw new Error('Unterminated SQL comment');i=end+2;continue;}
    if(ended)throw new Error('Only one SQL statement is allowed');
    if(c===';'){ended=true;i++;continue;}
    if(c==="'"||c==='"'||c==='`'||c==='[') {
      const close=c==='['?']':c;i++;
      while(i<n){if(sql[i]===close){i++;if(close!==']'&&sql[i]===close){i++;continue;}break;}i++;}
      continue;
    }
    if(c==='?') {
      let j=i+1;while(j<n&&sql[j]>='0'&&sql[j]<='9')j++;
      parameters=j>i+1?Math.max(parameters,Number(sql.slice(i+1,j))):parameters+1;i=j;continue;
    }
    if(c===':'||c==='@'||c==='$') {
      // SQLite's variable token: identifier characters, `::`, and one `(…)` suffix after at least one of them.
      let j=i+1,chars=0;
      for(;;) {
        if(idChar(sql[j])){j++;chars++;}
        else if(sql.startsWith('::',j))j+=2;
        else if(sql[j]==='('&&chars>0){while(j<n&&sql[j]!==')'&&!space(sql[j]))j++;if(sql[j]===')')j++;break;}
        else break;
      }
      // Without an identifier character it is no parameter; SQLite refuses it when preparing.
      if(chars>0){const name=sql.slice(i,j);if(!named.has(name)){named.set(name,++parameters);names[parameters]=name;}}
      i=Math.max(j,i+1);continue;
    }
    if(idChar(c)){const start=i;while(i<n&&idChar(sql[i]))i++;keyword??=sql.slice(start,i).toUpperCase();continue;}
    keyword??='';i++;
  }
  if(parameters>100)throw new Error('SQL allows at most 100 binds');
  return {keyword:keyword??'',parameters,names};
}

/**
 * Arguments for node:sqlite that bind value i to parameter i, as the Rust host
 * binds them. node:sqlite binds its positional arguments in order but skips
 * :name/@name/$name parameters, so those go by name instead.
 */
function bindArguments(values,names) {
  const byName={},positional=[];
  values.forEach((value,i)=>{if(names[i+1])byName[names[i+1]]=value;else positional.push(value);});
  return Object.keys(byName).length?[byName,...positional]:positional;
}

/** A bind value as the Rust host binds it: text, null, or a number within JavaScript's safe range, an integer when it has no fraction. */
function bindValue(p) {
  if(p===null||typeof p==='string')return p;
  if(typeof p==='number'&&Number.isFinite(p)&&Math.abs(p)<=MAX_SAFE)return Number.isInteger(p)?BigInt(p):p;
  throw new Error('SQL binds support only strings, finite numbers and null');
}

/** A result value the guest can receive: no BLOBs (node:sqlite already refuses integers past the safe range). */
function resultRow(row) {
  for(const value of Object.values(row))if(value instanceof Uint8Array)throw new Error('Binary SQL values are not supported');
  return row;
}

const QUERY=new Set(['SELECT','WITH','VALUES']),EXECUTE=new Set(['INSERT','UPDATE','DELETE','REPLACE','WITH']);

/**
 * The request-time SQL bridge. `sql(kind, text, params, writable)`: `query`
 * and `first` run a read-only statement; `execute` runs one INSERT, UPDATE,
 * DELETE or REPLACE (optionally behind a WITH) that returns no rows, and only
 * when `writable` (the route's transaction is a write). The authorizer is the
 * boundary: the app's own tables, the functions above, nothing else.
 * `authorizeRecordEvent` lets the host's own record-event triggers through.
 */
export function createSql(db,{authorizeRecordEvent=()=>false}={}) {
  const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name).filter(appTable));
  let writes=false,wrote=false;
  function authorize(action,a,b,database,source) {
    if(authorizeRecordEvent(action,a,b,database,source))return C.SQLITE_OK;
    if(database&&database!=='main')return C.SQLITE_DENY;
    switch(action) {
      case C.SQLITE_SELECT:case C.SQLITE_RECURSIVE:return C.SQLITE_OK;
      case C.SQLITE_READ:return readable(a)?C.SQLITE_OK:C.SQLITE_DENY;
      // Writes only to the app's real tables, as they stood after migrations.
      case C.SQLITE_INSERT:case C.SQLITE_UPDATE:case C.SQLITE_DELETE:
        if(!writes||!tables.has(a))return C.SQLITE_DENY;
        wrote=true;return C.SQLITE_OK;
      case C.SQLITE_FUNCTION:return RUNTIME_FUNCTIONS.has(fn(b))?C.SQLITE_OK:C.SQLITE_DENY;
    }
    return C.SQLITE_DENY;
  }
  return function sql(kind,text,params=[],writable=false) {
    if(!['query','first','execute'].includes(kind))throw new Error('Invalid query');
    const {keyword,parameters,names}=scanStatement(text);
    if(!(kind==='execute'?EXECUTE:QUERY).has(keyword))throw new Error(kind==='execute'?'execute requires a DML statement':'query requires a read-only statement');
    if(!Array.isArray(params)||params.length>100)throw new Error('SQL allows at most 100 binds');
    if(params.length!==parameters)throw new Error('SQL bind count does not match statement');
    const values=bindArguments(params.map(bindValue),names);
    writes=kind==='execute'&&writable===true;wrote=false;
    db.setAuthorizer(authorize);
    let statement;
    try{statement=db.prepare(text);}finally{db.setAuthorizer(null);}
    // A query that would write was denied at prepare; an execute must write and return no rows.
    if(kind==='execute'&&(!wrote||statement.columns().length!==0))throw new Error('execute requires a DML statement without returned rows');
    db.setAuthorizer(authorize);
    try {
      if(kind==='execute') {
        const r=statement.run(...values);
        const id=Number(r.lastInsertRowid);
        if(Math.abs(id)>MAX_SAFE)throw new Error('SQL row ID outside safe JavaScript range');
        return {changes:Number(r.changes),lastInsertRowid:id};
      }
      const rows=[];let bytes=0;
      for(const row of statement.iterate(...values)) {
        bytes+=Buffer.byteLength(JSON.stringify(resultRow(row)));
        if(bytes>2*1024*1024||rows.length>=1000)throw new Error('Query result limit');
        rows.push(row);if(kind==='first')break;
      }
      return kind==='first'?(rows[0]||null):rows;
    } finally {db.setAuthorizer(null);writes=false;}
  };
}
