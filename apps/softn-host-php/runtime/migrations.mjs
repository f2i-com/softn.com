import {constants as C} from 'node:sqlite';
import {appTable,migrationAuthorizer} from './sql.mjs';
/**
 * The deadline setup.php's own run of the runner was given for migrations
 * (`php setup.php --migration-deadline=SECONDS`), in milliseconds, or null.
 * Only setup.php sets this variable, and http.php starts the runner with an
 * environment of its own, so no request ever carries it. A whole number of
 * milliseconds from 1 to a day; anything else is none.
 */
export function setupDeadlineMs(env) {
  const text=env.SOFTN_SETUP_DEADLINE_MS;
  return typeof text==='string'&&/^[1-9][0-9]{0,7}$/.test(text)&&Number(text)<=86_400_000?Number(text):null;
}
const hostNames=db=>new Set(db.prepare("SELECT name FROM sqlite_master WHERE substr(name,1,1)='_'").all().map(r=>r.name));

const fold=value=>typeof value==='string'?value.replace(/[A-Z]/g,c=>c.toLowerCase()):null;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&fold(a)===fold(b);
const word=(token,value)=>token?.kind==='word'&&same(token.value,value);
const identifier=token=>token&&(token.kind==='identifier'||token.kind==='word')&&
  /^[\x20-\x7e]+$/.test(token.value)&&
  (token.kind==='identifier'||/^[A-Za-z_][A-Za-z0-9_$]*$/.test(token.value))?token.value:null;

/**
 * Lex the whole file before executing any SQL. Keep original slices; ';' in
 * quotes/comments is text. Only the first 16 tokens can match the finite ADD
 * grammar, so a near-1MB statement does not build an unbounded token array.
 * Deliberate preflight policy: reject NUL and unterminated quotes/comments,
 * including a block comment at EOF that SQLite itself would accept.
 */
function* statements(sql,collect=true) {
  if(sql.includes('\0'))throw new Error('Migration contains NUL');
  let i=0,start=0,tokens=[],count=0;
  const add=(kind,value)=>{if(++count<=16&&collect)tokens.push({kind,value});};
  const finish=end=>{
    const slice=count?{start,end,tokens:collect&&count<=16?tokens:null}:null;
    start=end;tokens=[];count=0;
    return slice;
  };
  const nameChar=c=>c!==undefined&&(/[A-Za-z0-9_$]/.test(c)||c.charCodeAt(0)>=128);
  while(i<sql.length) {
    const c=sql[i];
    if(c===' '||c==='\t'||c==='\n'||c==='\r'||c==='\f'||c==='\ufeff'){i++;continue;}
    if(sql.startsWith('--',i)) {const end=sql.indexOf('\n',i+2);i=end<0?sql.length:end+1;continue;}
    if(sql.startsWith('/*',i)) {
      const end=sql.indexOf('*/',i+2);
      if(end<0)throw new Error('Unterminated migration comment');
      i=end+2;continue;
    }
    if(c===';'){i++;const slice=finish(i);if(slice)yield slice;continue;}
    if(c==='$'||c===':'||c==='@') {
      // SQLite variable tokens can include Tcl's :: and (suffix), whose
      // semicolons are not statement delimiters. Variables never match ADD.
      let j=i+1,chars=0;
      for(;;) {
        if(nameChar(sql[j])){j++;chars++;}
        else if(sql.startsWith('::',j))j+=2;
        else if(sql[j]==='('&&chars>0) {
          while(j<sql.length&&sql[j]!==')'&&!/[ \t\n\r\f]/.test(sql[j]))j++;
          if(sql[j]!==')')throw new Error('Unterminated migration variable');
          j++;break;
        } else break;
      }
      add('variable','');i=Math.max(j,i+1);continue;
    }
    if(c==="'"||c==='"'||c==='`'||c==='[') {
      const begin=i,close=c==='['?']':c;
      let closed=false;i++;
      while(i<sql.length) {
        if(sql[i]===close) {
          i++;
          if(close!==']'&&sql[i]===close){i++;continue;}
          closed=true;break;
        }
        i++;
      }
      if(!closed)throw new Error('Unterminated migration quote');
      if(c==="'")add('string','');
      else {
        // Decode only a token that can still be part of the small grammar.
        let value='';
        if(collect&&count<16){value=sql.slice(begin+1,i-1);if(close!==']')value=value.split(close+close).join(close);}
        add('identifier',value);
      }
      continue;
    }
    if(nameChar(c)) {
      const begin=i;while(nameChar(sql[i]))i++;
      add('word',collect&&count<16?sql.slice(begin,i):'');continue;
    }
    add('punctuation',c);i++;
  }
  const tail=finish(sql.length);if(tail)yield tail;
}

/** Only nullable TEXT, optionally REFERENCES an app table's one column. */
function nullableTextAdd(tokens) {
  if(!tokens||!word(tokens[0],'ALTER')||!word(tokens[1],'TABLE'))return null;
  let i=2,table=identifier(tokens[i++]),qualified=false;
  if(table===null)return null;
  if(tokens[i]?.value==='.'&&tokens[i].kind==='punctuation') {
    if(!same(table,'main'))return null;
    qualified=true;i++;table=identifier(tokens[i++]);
  }
  if(table===null||!appTable(table)||!word(tokens[i++],'ADD'))return null;
  if(word(tokens[i],'COLUMN'))i++;
  if(identifier(tokens[i++])===null||!word(tokens[i++],'TEXT'))return null;
  let references=null;
  if(i<tokens.length) {
    if(!word(tokens[i++],'REFERENCES'))return null;
    references=identifier(tokens[i++]);
    if(references===null||!appTable(references)||tokens[i]?.kind!=='punctuation'||tokens[i++].value!=='('||
       identifier(tokens[i++])===null||tokens[i]?.kind!=='punctuation'||tokens[i++].value!==')')return null;
  }
  return i===tokens.length?{table,qualified,references}:null;
}

function ordinaryMainTable(db,name,qualified) {
  // table_list distinguishes ordinary tables from virtual/shadow tables.
  // Resolution occurs per slice: an earlier CREATE may supply REFERENCES.
  // A guest may create a table named pragma_table_list. Use fixed native
  // PRAGMA, not a shadowable table-valued SELECT or interpolated identifier.
  if(!qualified&&db.prepare('PRAGMA temp.table_list').all().some(row=>same(row.name,name)))return null;
  const row=db.prepare('PRAGMA main.table_list').all().find(row=>same(row.name,name));
  return row?.type==='table'&&appTable(row.name)&&/^[\x20-\x7e]+$/.test(row.name)?row.name:null;
}

function executeStatement(db,slice,sql) {
  const add=nullableTextAdd(slice.tokens);
  let target=null;
  if(add) {
    target=ordinaryMainTable(db,add.table,add.qualified);
    // REFERENCES resolves within the altered table's main schema, not temp.
    if(target&&add.references&&!ordinaryMainTable(db,add.references,true))target=null;
  }
  let active=true,seenAlter=false;
  const authorize=target?(action,a,b,database,source)=>{
    const answer=migrationAuthorizer(action,a,b,database);
    if(active&&action===C.SQLITE_ALTER_TABLE&&answer===C.SQLITE_OK&&same(a,'main')&&same(b,target))seenAlter=true;
    // These arguments also describe guest PRAGMA. The proof of origin is
    // the independently verified single ADD slice, never source===null alone.
    if(active&&seenAlter&&action===C.SQLITE_PRAGMA&&same(a,'quick_check')&&same(b,target)&&same(database,'main')&&source===null)return C.SQLITE_OK;
    return answer;
  }:migrationAuthorizer;
  try{db.setAuthorizer(authorize);db.exec(sql.slice(slice.start,slice.end));}
  finally{active=false;seenAlter=false;db.setAuthorizer(null);}
}

// Schema scripts are guest bundle input too. The authorizer (sql.mjs, the Rust
// host's rules) denies ATTACH/PRAGMA/transactions, extension loading, virtual
// tables, views/triggers and host-private tables. A verified one-statement
// nullable TEXT ADD permits only SQLite's internal target-table quick_check.
export function applyMigration(db,sql) {
  if(typeof sql!=='string'||Buffer.byteLength(sql)>1_000_000)throw new Error('Migration size');
  // First pass rejects lexical faults anywhere before SQL; second pass
  // streams slices, rather than retaining up to 500,000 tiny statements.
  for(const unused of statements(sql,false))void unused;
  const before=hostNames(db);
  // A request's statement is held to 100,000 opcodes (sql.mjs SQL_LIMITS). A
  // migration is not, on this host: one INSERT of fifteen thousand seed rows
  // compiles to more, this host has always applied one, and with the limit
  // an app that ships such a list did not start on a fresh install (SQLite
  // calls it "out of memory"). The file is held to the bytes above. SQLite's
  // own ceiling stands in for none, and the request's limit is put back.
  const limits=db.limits,held=limits?.vdbeOp;
  if(held!==undefined)limits.vdbeOp=250_000_000;
  try {
    for(const slice of statements(sql))executeStatement(db,slice,sql);
    // The authorizer sees the old name of `ALTER TABLE t RENAME TO x`, never x:
    // a migration may not move anything into the host's `_` namespace that way.
    for(const name of hostNames(db))if(!before.has(name))throw new Error('Migration named a host-reserved table');
  } finally {
    // Restore the request budget even if authorizer cleanup itself fails.
    try{db.setAuthorizer(null);}finally{if(held!==undefined)limits.vdbeOp=held;}
  }
}
