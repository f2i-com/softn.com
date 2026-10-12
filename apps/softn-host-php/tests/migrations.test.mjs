/** Memory-only migration grammar/authority tests; no WASM, service or provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,constants as C} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {applyMigration,setupDeadlineMs} from '../runtime/migrations.mjs';
import {createSql,migrationAuthorizer,SQL_LIMITS} from '../runtime/sql.mjs';

const hashes={
  '001_initial.sql':'f39ed9648542220e9ecbf86328ce1db0afa33064489f35fbea52f6268a169dcf',
  '002_activity_and_photo_order.sql':'1abe42c3f75d3e0560a1d31df7a5d3d84c9d2b4613ff56064473a51856d51207',
  '003_virtual_cafe.sql':'0c2fde3859c4b517c55a12a6872cb139d452d908f9250f1d5fe268b248e2e775',
  '004_opt_in_intentions.sql':'f44a208aa75cb25215dc7da126df0fe99c539a54704ef00683e8c7f9c605b886',
};
const coffee=Object.entries(hashes).map(([name,sha256])=>({name,sha256,
  bytes:readFileSync(new URL('./fixtures/coffee-migrations/'+name,import.meta.url))}));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const rows=(db,sql,...params)=>db.prepare(sql).all(...params).map(row=>({...row}));
function database(sql='CREATE TABLE items(id INTEGER PRIMARY KEY,note TEXT CHECK(length(note)<=160)) STRICT;') {
  const db=new DatabaseSync(':memory:',{limits:SQL_LIMITS});
  db.exec("CREATE TABLE _private(secret TEXT) STRICT; INSERT INTO _private VALUES('kept');"+sql);
  return db;
}
function snapshot(db) {
  return {schema:rows(db,'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name'),
    private:rows(db,'SELECT * FROM _private'),
    ledger:db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='_migrations'").get().n?rows(db,'SELECT * FROM _migrations ORDER BY name'):null};
}
function refusesWithoutMutation(db,sql) {
  const before=snapshot(db);db.exec('BEGIN IMMEDIATE');
  try{assert.throws(()=>applyMigration(db,sql),undefined,sql);}
  finally{db.exec('ROLLBACK');}
  assert.deepEqual(snapshot(db),before,sql);
  assert.throws(()=>applyMigration(db,'PRAGMA main.quick_check(items)'),undefined,'later guest PRAGMA remains denied');
}
function tracked(db,{fault=null,inspect=null}={}) {
  const callbacks=[],executed=[],set=[];let current=null,inCallback=false;
  const proxy={
    prepare(sql){assert.equal(inCallback,false,'no SQL prepared from authorizer');return db.prepare(sql);},
    setAuthorizer(callback){
      set.push(callback);current=callback;
      db.setAuthorizer(callback?(...args)=>{
        inCallback=true;
        try {if(fault==='callback'&&args[0]===C.SQLITE_PRAGMA)throw new Error('synthetic callback fault');return callback(...args);}
        finally{inCallback=false;}
      }:null);
      if(callback)callbacks.push(callback);
      if(fault==='set'&&callback)throw new Error('synthetic set fault');
    },
    exec(sql){
      assert.equal(inCallback,false,'no SQL executed from authorizer');
      executed.push(sql);if(inspect)inspect(current,'before');
      if(fault==='exec')throw new Error('synthetic exec fault');
      const result=db.exec(sql);if(inspect)inspect(current,'after');return result;
    },
  };
  return {proxy,callbacks,executed,set,get current(){return current;}};
}

test('record the exact runtime engine used by the focused suite',()=>{
  const db=new DatabaseSync(':memory:');try{assert.equal(typeof db.setAuthorizer,'function');}finally{db.close();}
  console.log('migration acceptance engine: '+JSON.stringify({node:process.version,sqlite:process.versions.sqlite}));
});

test('the current setup deadline parser remains strict and exported',()=>{
  for(const [value,expected] of [['1',1],['1000',1000],['86400000',86400000]])assert.equal(setupDeadlineMs({SOFTN_SETUP_DEADLINE_MS:value}),expected);
  for(const value of [undefined,null,1,true,'','0','01','-1','1.5',' 1','1 ','1e3','86400001','100000000'])assert.equal(setupDeadlineMs({SOFTN_SETUP_DEADLINE_MS:value}),null);
});

test('the request opcode budget is restored after ADD success and every authorizer cleanup path',()=>{
  for(const fault of [null,'set','exec','post','reset']) {
    const db=database();
    const limits=db.limits,held=limits.vdbeOp;
    const proxy={
      limits,
      prepare:sql=>db.prepare(sql),
      setAuthorizer(callback){
        db.setAuthorizer(callback);
        if((fault==='set'&&callback)||(fault==='reset'&&callback===null))throw new Error('synthetic authorizer fault');
      },
      exec(sql){
        assert.equal(limits.vdbeOp,250_000_000,'only migration execution receives the larger budget');
        if(fault==='exec')throw new Error('synthetic execution fault');
        return db.exec(sql);
      },
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      const sql=fault==='post'?'ALTER TABLE items ADD label TEXT; ALTER TABLE items RENAME TO _items;':'ALTER TABLE items ADD label TEXT;';
      if(fault)assert.throws(()=>applyMigration(proxy,sql));else applyMigration(proxy,sql);
      assert.equal(limits.vdbeOp,held,'request limit restored after '+(fault??'success'));
    } finally {db.setAuthorizer(null);db.exec('ROLLBACK');db.close();}
  }
});

test('nullable TEXT ADD resolves CREATE and REFERENCES per slice, preserving the public return and caller transaction',()=>{
  const db=database();
  try {
    db.exec('BEGIN IMMEDIATE');
    assert.equal(applyMigration(db,'CREATE TABLE scope(id TEXT PRIMARY KEY) STRICT; ALTER TABLE main.items ADD COLUMN scope_id TEXT REFERENCES scope(id); ALTER TABLE items ADD label TEXT;'),undefined);
    assert.equal(db.isTransaction,true);
    assert.deepEqual(rows(db,'PRAGMA main.table_info(items)').slice(-2).map(r=>[r.name,r.type,r.notnull,r.dflt_value]),[['scope_id','TEXT',0,null],['label','TEXT',0,null]]);
    assert.equal(rows(db,'PRAGMA main.foreign_key_list(items)')[0].table,'scope');
    db.exec('ROLLBACK');assert.equal(rows(db,'PRAGMA main.table_info(items)').length,2);
  } finally{db.close();}
});

test('BOM, comments, ASCII case and each identifier quote preserve exact execution slices',()=>{
  const names=['semi;colon','double"quote','back`tick','bracket name'];
  const quotes=[name=>'"'+name.replaceAll('"','""')+'"',name=>'`'+name.replaceAll('`','``')+'`',name=>'['+name+']'];
  for(const name of names)for(const quote of quotes) {
    const db=database('CREATE TABLE '+quote(name)+'(id INTEGER PRIMARY KEY) STRICT;');
    const trace=tracked(db);
    try {
      const sql='\ufeff/* lead; */ aLtEr\fTaBlE '+quote('MAIN')+'.'+quote(name.toUpperCase())+' /* middle; */ ADD -- line;\r\n COLUMN '+quote('new;column')+' TEXT; -- trailing;';
      applyMigration(trace.proxy,sql);
      assert.equal(rows(db,'PRAGMA main.table_info('+quote(name)+')').at(-1).name,'new;column');
      assert.deepEqual(trace.executed,[sql.slice(0,sql.indexOf('; -- trailing')+1)]);
      assert.equal(trace.current,null);
    } finally{db.close();}
  }
});

test('literal/comment semicolons and Tcl variable suffixes are never split as SQL',()=>{
  const db=database('CREATE TABLE items(id INTEGER PRIMARY KEY,note TEXT);');
  const trace=tracked(db);
  try {
    const first="/* a;b */ INSERT INTO items(note) VALUES('a;''b');";
    const second='\r\nSELECT $name::scope(a;b;c);';
    const third='\n-- x;y\nUPDATE items SET note=note||\';z\';';
    applyMigration(trace.proxy,first+second+third);
    assert.deepEqual(trace.executed,[first,second,third]);
    assert.equal(db.prepare('SELECT note FROM items').get().note,"a;'b;z");
  } finally{db.close();}
});

test('all lexical faults are rejected before any SQL in the file executes',()=>{
  for(const tail of ["SELECT 'unclosed",'SELECT "unclosed','SELECT `unclosed','SELECT [unclosed','/* unclosed','SELECT $name(unclosed','SELECT \0']) {
    const db=database(),trace=tracked(db);
    try {const before=snapshot(db);assert.throws(()=>applyMigration(trace.proxy,'ALTER TABLE items ADD label TEXT; '+tail));assert.deepEqual(trace.executed,[]);assert.deepEqual(trace.set,[]);assert.deepEqual(snapshot(db),before);}
    finally{db.close();}
  }
});

test('the exception requires expected ALTER first and only its exact main table quick_check',()=>{
  const db=database();
  const probe=(callback,when)=>{
    if(callback===migrationAuthorizer)return;
    const expected=[C.SQLITE_PRAGMA,'quick_check','items','main',null];
    assert.equal(callback(...expected),when==='before'?C.SQLITE_DENY:C.SQLITE_OK);
    for(const args of [[C.SQLITE_PRAGMA,'quick_check','other','main',null],
      [C.SQLITE_PRAGMA,'quick_check',null,'main',null],[C.SQLITE_PRAGMA,'quick_check','items',null,null],
      [C.SQLITE_PRAGMA,'quick_check','items','temp',null],[C.SQLITE_PRAGMA,'quick_check','items','main','trigger'],
      [C.SQLITE_PRAGMA,'integrity_check','items','main',null],[C.SQLITE_PRAGMA,'writable_schema','ON','main',null]])assert.equal(callback(...args),C.SQLITE_DENY);
  };
  const trace=tracked(db,{inspect:probe});
  try {
    applyMigration(trace.proxy,'ALTER TABLE items ADD label TEXT;');
    for(const callback of trace.callbacks)assert.equal(callback(C.SQLITE_PRAGMA,'quick_check','items','main',null),C.SQLITE_DENY,'retained callback expired');
    assert.equal(trace.current,null);
    assert.throws(()=>applyMigration(db,'PRAGMA main.quick_check(items)'));
  } finally{db.close();}
});

test('finally cleanup survives callback, set, execution and host-namespace post-check faults',()=>{
  for(const fault of ['callback','set','exec','post']) {
    const db=database(),trace=tracked(db,{fault});db.exec('BEGIN IMMEDIATE');
    try {
      assert.throws(()=>applyMigration(trace.proxy,fault==='post'?'ALTER TABLE items ADD label TEXT; ALTER TABLE items RENAME TO _items;':'ALTER TABLE items ADD label TEXT;'));
      assert.equal(trace.current,null);assert.equal(trace.set.at(-1),null);
      for(const callback of trace.callbacks)assert.equal(callback(C.SQLITE_PRAGMA,'quick_check','items','main',null),C.SQLITE_DENY);
      db.exec('ROLLBACK');assert.throws(()=>applyMigration(db,'PRAGMA main.quick_check(items)'));
      applyMigration(db,'ALTER TABLE items ADD later TEXT;');
    } finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
  }
});

test('consecutive calls and independent connections share no exception state',()=>{
  const first=database(),second=database();
  try {applyMigration(first,'ALTER TABLE items ADD a TEXT');assert.throws(()=>applyMigration(first,'PRAGMA main.quick_check(items)'));assert.throws(()=>applyMigration(second,'PRAGMA main.quick_check(items)'));applyMigration(second,'ALTER TABLE items ADD b TEXT');assert.throws(()=>applyMigration(first,'PRAGMA main.quick_check(items)'));}
  finally{first.close();second.close();}
});

test('scoped authorizer survives execution-time reauthorization of a prepared ADD',()=>{
  const db=database();let current=null,alterCallbacks=0,pragmaCallbacks=0,phase='prepare';const quickPhases=[];
  const proxy={
    prepare:sql=>db.prepare(sql),
    setAuthorizer(callback){current=callback;db.setAuthorizer(callback?(...args)=>{if(args[0]===C.SQLITE_ALTER_TABLE)alterCallbacks++;if(args[0]===C.SQLITE_PRAGMA){pragmaCallbacks++;quickPhases.push(phase);}return callback(...args);}:null);},
    exec(sql){
      const prepared=db.prepare(sql),authorizer=current;
      // Trusted instrumentation changes schema and authorizer between
      // prepare/run; SQLite reauthorizes the same ADD at execution time.
      db.setAuthorizer(null);db.exec('CREATE TABLE reprepare_probe(value TEXT)');
      phase='run';db.setAuthorizer((...args)=>{if(args[0]===C.SQLITE_ALTER_TABLE)alterCallbacks++;if(args[0]===C.SQLITE_PRAGMA){pragmaCallbacks++;quickPhases.push(phase);}return authorizer(...args);});
      prepared.run();
    },
  };
  try {
    applyMigration(proxy,'ALTER TABLE items ADD label TEXT;');
    assert.ok(alterCallbacks>=2,alterCallbacks);assert.ok(pragmaCallbacks>=1,pragmaCallbacks);assert.ok(quickPhases.includes('run'));
    assert.equal(current,null);assert.equal(rows(db,'PRAGMA table_info(items)').at(-1).name,'label');
    assert.throws(()=>applyMigration(db,'PRAGMA main.quick_check(items)'));
  } finally{db.close();}
});

test('guest PRAGMA, transactions, functions and private objects stay denied around a supported ADD',()=>{
  const hostile=['PRAGMA main.quick_check(items)','PRAGMA quick_check(items)','PRAGMA "MAIN"."QUICK_CHECK"("items")',
    "PRAGMA main.quick_check='items'",'PRAGMA quick_check','PRAGMA main.quick_check(_private)',
    'PRAGMA temp.quick_check(items)','PRAGMA main.integrity_check(items)','PRAGMA foreign_key_check',
    'PRAGMA writable_schema=ON','PRAGMA foreign_keys=OFF','PRAGMA ignore_check_constraints=ON',
    'PRAGMA journal_mode=OFF','PRAGMA user_version=7',"SELECT * FROM pragma_quick_check('items','main')",
    "ATTACH ':memory:' AS other",'BEGIN','COMMIT','ROLLBACK','SAVEPOINT guest',
    "SELECT load_extension('absent')","SELECT readfile('absent')","SELECT writefile('absent','x')",
    'ALTER TABLE _private ADD x TEXT','ALTER TABLE sqlite_schema ADD x TEXT',
    "UPDATE _private SET secret='changed'",'CREATE TEMP TABLE escaped(x)','CREATE VIEW escaped AS SELECT 1',
    'CREATE TRIGGER escaped AFTER INSERT ON items BEGIN DELETE FROM _private; END',
    'ALTER TABLE items RENAME TO _items'];
  for(const attack of hostile)for(const after of [true,false]) {
    const db=database();
    try{refusesWithoutMutation(db,after?'ALTER TABLE items ADD label TEXT; '+attack+';':attack+'; ALTER TABLE items ADD label TEXT;');}
    finally{db.close();}
  }
});

test('unsupported ADD suffixes and misleading tokens do not acquire an exception',()=>{
  const suffixes=["label TEXT DEFAULT 'PRAGMA main.quick_check(items);'",'label TEXT NOT NULL',
    'label TEXT CHECK(length(label)<10)','label TEXT UNIQUE','label TEXT COLLATE NOCASE',
    'label TEXT GENERATED ALWAYS AS(note) VIRTUAL','label INTEGER','label TEXT REFERENCES _private(secret)',
    'label TEXT REFERENCES missing(id)','label TEXT REFERENCES scope(id) ON DELETE CASCADE',
    'label TEXT REFERENCES main.scope(id)','label TEXT REFERENCES scope(id,other)',
    "label TEXT DEFAULT (load_extension('x'))",'label TEXT CHECK((SELECT 1 FROM pragma_quick_check()))'];
  for(const suffix of suffixes) {
    const db=database('CREATE TABLE items(id INTEGER PRIMARY KEY,note TEXT) STRICT; CREATE TABLE scope(id TEXT PRIMARY KEY) STRICT;');
    const trace=tracked(db);
    try{refusesWithoutMutation(db,'ALTER TABLE items ADD '+suffix+';');assert.throws(()=>applyMigration(trace.proxy,'ALTER TABLE items ADD '+suffix+';'));assert.ok(trace.callbacks.every(callback=>callback===migrationAuthorizer),'unsupported suffix has base authorizer only: '+suffix);}finally{db.close();}
  }
  for(const sql of ["ALTER TABLE 'items' ADD label TEXT",'ALTER TABLE items ADD COLUMN "label" "TEXT"',
    'ALTER TABLE items ADD label TEXT; SELECT 1; PRAGMA main.quick_check(items)',
    'ALTERTABLE items ADD label TEXT','ALTER TABLE items ADDITION label TEXT','ALTER TABLE items ADD label TЕXT',
    'ALTER\vTABLE items ADD label TEXT','ALTER TABLE other.items ADD label TEXT','ALTER TABLE items ADD label TEXT /* good */ NOT NULL']) {
    const db=database();try{refusesWithoutMutation(db,sql);}finally{db.close();}
  }
});

test('non-ASCII target, reference and column identifiers cannot acquire the ASCII-only exception',()=>{
  for(const statement of ['ALTER TABLE "café" ADD label TEXT','ALTER TABLE items ADD "étiquette" TEXT','ALTER TABLE items ADD label TEXT REFERENCES "café"(id)']) {
    const db=database('CREATE TABLE items(id INTEGER PRIMARY KEY) STRICT; CREATE TABLE "café"(id TEXT PRIMARY KEY) STRICT;'),trace=tracked(db);
    try{assert.throws(()=>applyMigration(trace.proxy,statement));assert.ok(trace.callbacks.every(callback=>callback===migrationAuthorizer));}
    finally{db.close();}
  }
});

test('main schema resolution ignores forged pragma-table metadata and refuses shadow/virtual/temp authority',()=>{
  const db=database();
  try {
    db.exec('CREATE TEMP TABLE items(id INTEGER PRIMARY KEY) STRICT;');
    refusesWithoutMutation(db,'ALTER TABLE items ADD label TEXT;');
    applyMigration(db,'ALTER TABLE main.items ADD label TEXT;');
    assert.equal(rows(db,'PRAGMA temp.table_info(items)').length,1);
    db.exec('CREATE VIRTUAL TABLE docs USING fts5(body); CREATE TABLE pragma_table_list(schema TEXT,name TEXT,type TEXT); INSERT INTO pragma_table_list VALUES(\'main\',\'docs_data\',\'table\');');
    const trace=tracked(db);
    // Legacy base rules may allow an ordinary ADD on a non-STRICT shadow;
    // this repair must never give it the additional quick_check authority.
    try{applyMigration(trace.proxy,'ALTER TABLE docs_data ADD label TEXT;');}catch{}
    assert.ok(trace.callbacks.every(callback=>callback===migrationAuthorizer));
    assert.throws(()=>applyMigration(db,'ALTER TABLE docs ADD label TEXT;'));
    refusesWithoutMutation(db,'ALTER TABLE main.items ADD ref TEXT REFERENCES docs_data(id);');
  } finally{db.close();}
});

test('request-time SQL still refuses guest PRAGMA and host metadata after supported migration',()=>{
  const db=database();
  try {
    applyMigration(db,'ALTER TABLE items ADD label TEXT');const sql=createSql(db);
    for(const statement of ['PRAGMA main.quick_check(items)',"SELECT * FROM pragma_quick_check('items','main')",'SELECT * FROM _private'])assert.throws(()=>sql('query',statement));
    assert.deepEqual(sql('query','SELECT label FROM items'),[]);
  } finally{db.close();}
});

test('exact 1MB boundaries, empty delimiters and preflight memory stay bounded',()=>{
  const db=database();
  try {
    assert.equal(applyMigration(db,';'.repeat(1_000_000)),undefined);
    assert.equal(applyMigration(db,' '.repeat(1_000_000)),undefined);
    assert.equal(applyMigration(db,'--'+'x'.repeat(999_998)),undefined);
    const head='ALTER TABLE items ADD label TEXT;';applyMigration(db,head+' '.repeat(1_000_000-Buffer.byteLength(head)));
    assert.throws(()=>applyMigration(db,' '.repeat(1_000_001)),/Migration size/);
  } finally{db.close();}
  const script=`import {DatabaseSync} from 'node:sqlite'; import {applyMigration} from ${JSON.stringify(new URL('../runtime/migrations.mjs',import.meta.url).href)}; const db=new DatabaseSync(':memory:');let rejected=false;try{applyMigration(db,'0;'.repeat(500000));}catch{rejected=true;}db.close();if(!rejected)process.exit(2);`;
  const child=spawnSync(process.execPath,['--max-old-space-size=64','--input-type=module'],{input:script,encoding:'utf8',timeout:15_000,maxBuffer:100_000});
  assert.equal(child.status,0,child.stderr+String(child.error||''));
});

function ledger(db,files) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for(const file of files){applyMigration(db,file.bytes.toString('utf8'));db.prepare('INSERT INTO _migrations VALUES(?,?,?)').run(file.name,digest(file.bytes),1);}
    db.exec('COMMIT');
  } catch(error){db.exec('ROLLBACK');throw error;}
}
function coffeeDatabase() {
  return database('CREATE TABLE _migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT;');
}
function assertCoffeeSchema(db) {
  const intentionTables=['intent_preferences','intent_scopes','intent_scope_choices','intent_report_context'];
  const indexes=['intent_scope_one_live_pair','intent_scope_a','intent_scope_b','intent_scope_expiry','intent_report_expiry','cafe_invitation_intent_scope','cafe_room_intent_scope','date_intent_scope'];
  for(const name of intentionTables)assert.equal(db.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(name)?.type,'table',name);
  for(const name of indexes)assert.equal(db.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(name)?.type,'index',name);
  for(const table of ['cafe_invitations','cafe_rooms','dates']) {
    assert.equal(rows(db,'PRAGMA main.table_list').find(row=>row.name===table).strict,1,table+' stays STRICT');
    assert.deepEqual(rows(db,'PRAGMA main.table_info('+table+')').slice(-2).map(row=>[row.name,row.type,row.notnull,row.dflt_value]),[['intent_scope_id','TEXT',0,null],['intent_scope_generation','TEXT',0,null]]);
    assert.ok(rows(db,'PRAGMA main.foreign_key_list('+table+')').some(row=>row.table==='intent_scopes'&&row.from==='intent_scope_id'&&row.to==='id'));
  }
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.deepEqual(rows(db,'PRAGMA foreign_key_check'),[]);
  assert.deepEqual(rows(db,'SELECT name,sha256 FROM _migrations ORDER BY name'),coffee.map(({name,sha256})=>({name,sha256})));
}
const explicitObjects=db=>rows(db,"SELECT type,name FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name");
function assertIntentionDelta(db,before) {
  const old=new Set(before.map(row=>row.name));
  const expected={table:['intent_preferences','intent_scopes','intent_scope_choices','intent_report_context'],
    index:['intent_scope_one_live_pair','intent_scope_a','intent_scope_b','intent_scope_expiry','intent_report_expiry','cafe_invitation_intent_scope','cafe_room_intent_scope','date_intent_scope']};
  assert.deepEqual(explicitObjects(db).filter(row=>!old.has(row.name)),Object.entries(expected).flatMap(([type,names])=>names.map(name=>({type,name}))).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0));
}

test('exact immutable Coffee 001-004 fresh installation keeps all hashes/four tables/eight indexes/six columns',()=>{
  for(const file of coffee)assert.equal(digest(file.bytes),file.sha256,file.name);
  const db=coffeeDatabase(),baseline=coffeeDatabase();
  try{ledger(baseline,coffee.slice(0,3));const before=explicitObjects(baseline);ledger(db,coffee);assertCoffeeSchema(db);assertIntentionDelta(db,before);}
  finally{db.close();baseline.close();}
});

test('populated Coffee upgrade preserves original rows and STRICT/FK/UNIQUE/CHECK/cascade constraints',()=>{
  const db=coffeeDatabase();
  try {
    ledger(db,coffee.slice(0,3));
    db.exec(`INSERT INTO users(id,phone,first_name,created_at,updated_at) VALUES(1,'fixture-a','A',1,1),(2,'fixture-b','B',1,1),(3,'fixture-c','C',1,1);
      INSERT INTO dates(id,requester_id,recipient_id,proposer_id,cafe_name,cafe_address,proposed_date,proposed_time,time_zone,meet_at,status,created_at,updated_at) VALUES(10,1,2,1,'Fixture','Local','2030-01-01','12:00','UTC',2000000000,'pending',1,1);
      INSERT INTO cafe_rooms(id,user_a,user_b,created_at,expires_at) VALUES('room',1,2,1,100);
      INSERT INTO cafe_invitations(id,sender_id,recipient_id,note,created_at,room_id) VALUES('invite',1,2,'hello',1,'room');
      INSERT INTO cafe_members(room_id,user_id,mark,appearance) VALUES('room',1,'X','fixture');`);
    const tables=['users','dates','cafe_rooms','cafe_invitations','cafe_members'];
    const before=Object.fromEntries(tables.map(table=>[table,rows(db,'SELECT * FROM '+table)]));
    const objects=explicitObjects(db);ledger(db,coffee.slice(3));assertCoffeeSchema(db);assertIntentionDelta(db,objects);
    for(const table of ['dates','cafe_rooms','cafe_invitations'])for(const row of rows(db,'SELECT intent_scope_id,intent_scope_generation FROM '+table))assert.deepEqual(row,{intent_scope_id:null,intent_scope_generation:null});
    for(const table of tables)assert.deepEqual(rows(db,'SELECT * FROM '+table).map(row=>{delete row.intent_scope_id;delete row.intent_scope_generation;return row;}),before[table],table);
    assert.throws(()=>db.exec("UPDATE cafe_invitations SET intent_scope_id='missing'"),/FOREIGN KEY/);
    assert.throws(()=>db.exec("UPDATE cafe_invitations SET note=printf('%.*c',161,'x')"),/CHECK/);
    assert.throws(()=>db.exec("UPDATE cafe_invitations SET status='invalid'"),/CHECK/);
    assert.throws(()=>db.exec("UPDATE users SET created_at='bad'"),/cannot store TEXT/);
    assert.throws(()=>db.exec("UPDATE cafe_invitations SET intent_scope_generation=X'ff'"),/cannot store BLOB/);
    assert.throws(()=>db.exec("INSERT INTO cafe_invitations(id,sender_id,recipient_id,note,created_at) VALUES('duplicate',2,1,'hi',1)"),/UNIQUE/);
    assert.throws(()=>db.exec("INSERT INTO intent_preferences(user_id,updated_at,intent_pair_matching_enabled) VALUES(1,1,1)"),/CHECK/);
    db.exec("INSERT INTO intent_preferences(user_id,updated_at) VALUES(1,1); DELETE FROM users WHERE id=1;");
    assert.equal(db.prepare('SELECT count(*) n FROM intent_preferences').get().n,0);
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.deepEqual(rows(db,'PRAGMA foreign_key_check'),[]);
  } finally{db.close();}
});

test('caller rollback of later migration failure preserves unchanged Coffee ledger/private state and allows retry',()=>{
  const db=coffeeDatabase();
  try {
    ledger(db,coffee.slice(0,3));const before=snapshot(db);
    assert.throws(()=>ledger(db,[coffee[3],{name:'005_bad.sql',bytes:Buffer.from('ALTER TABLE users ADD label TEXT; PRAGMA main.quick_check(users);')} ]));
    assert.deepEqual(snapshot(db),before);
    ledger(db,[coffee[3]]);assertCoffeeSchema(db);
  } finally{db.close();}
});
