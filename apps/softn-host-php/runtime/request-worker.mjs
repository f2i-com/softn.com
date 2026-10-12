import {DatabaseSync} from 'node:sqlite';
import {workerData,parentPort} from 'node:worker_threads';
import {readFileSync,lstatSync,realpathSync,chmodSync,mkdirSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join,dirname,relative,isAbsolute,basename} from 'node:path';
import {createWasmHost,validateWasmSource,logFailure} from './wasm-host.mjs';
import {applyMigration,setupDeadlineMs} from './migrations.mjs';
import {SQL_LIMITS} from './sql.mjs';
import {configureRecordEvents} from './record-events.mjs';
import {invokeWithHook} from './request-hook.mjs';
// The operator may select an isolated app installation while sharing the trusted
// runtime and WASM. This value is never taken from guest code or request JSON.
const root=realpathSync(process.env.SOFTN_BACKEND_ROOT || dirname(fileURLToPath(import.meta.url)));
const contained=(parent,child)=>{const path=relative(parent,child);return path!==''&&!isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+(process.platform==='win32'?'\\':'/'));};
let db;
/** How many times the runner's deadline may stop one migration before it is not started again. */
const MIGRATION_ATTEMPTS=3;
/**
 * Note that a rate bucket is over its limit for this minute, where http.php
 * looks before it does anything else (request.php softn_rate_marker): one
 * directory a minute, one empty file a bucket. A 429 used to cost what a 200
 * costs, a worker slot, a Node process and on a photo route the decode, so a
 * client past its limit could keep every slot busy being refused. The
 * directories of earlier minutes are removed here, so there is never more
 * than one. Without the marker the limit still holds: this goes on counting.
 */
function markLimited(minute,bucket) {
  try {
    const all=join(root,'private/limited'),now=join(all,String(minute));
    mkdirSync(now,{recursive:true,mode:0o700});
    writeFileSync(join(now,bucket),'',{mode:0o600});
    for(const name of readdirSync(all))if(name!==String(minute))rmSync(join(all,name),{recursive:true,force:true});
  } catch { /* see above */ }
}
// The answer PHP reads: exactly `{"status":N,"body":...}`, status first and
// body last, so http.php passes the body's JSON text through untouched
// (runtime/request.php softn_runner_result). Anything else is a host error.
function emit(result) {
  const valid=result&&typeof result==='object'&&Number.isInteger(result.status)&&result.status>=200&&result.status<=599&&Object.hasOwn(result,'body');
  const status=valid?result.status:500,body=valid?result.body:{error:'The request could not be completed.',code:'host_error'};
  process.stdout.write('{"status":'+status+',"body":'+(JSON.stringify(body)??'null')+'}');
}
// SQLite's "database is busy/locked": another request holds the write lock
// past busy_timeout. Transient, so answered as the retryable busy response,
// not as a configuration fault.
const busy=e=>e?.errcode===5||e?.errcode===6||/database is (locked|busy)/i.test(String(e?.message));
// Static diagnostic labels identify the failed check without exposing values,
// paths, SQL, provider responses, or exception messages to clients.
let startupStage='configuration_read';
try {
  const config=JSON.parse(readFileSync(join(root,'private/config.json'),'utf8'));
  startupStage='configuration_values';
  if(!/^[a-f0-9]{64}$/.test(config.keyHex)||typeof config.development!=='boolean')throw new Error('Invalid configuration');
  startupStage='bundle_directory';
  const bundle=realpathSync(join(root,'app'));
  if(lstatSync(join(root,'app')).isSymbolicLink()||!contained(root,bundle))throw new Error('Invalid bundle directory');
  const inside=relative=>{
    if(typeof relative!=='string'||relative.startsWith('/')||relative.includes('\\')||relative.split('/').some(s=>s==='..'||s==='.'))throw new Error('Invalid bundle path');
    const file=realpathSync(join(bundle,relative));if(!contained(bundle,file))throw new Error('Bundle path escaped');return file;
  };
  startupStage='manifest_read';
  const manifest=JSON.parse(readFileSync(inside('manifest.json'),'utf8'));
  startupStage='application_identity';
  if(config.appId!==manifest.id)throw new Error('Operator configuration belongs to another app');
  const supported=['sql','crypto','time','trusted-client-ip','transaction-scope','photos'];
  const required=manifest.server?.requires;
  startupStage='application_capabilities';
  if(!required||required.apiVersion!==1||!Array.isArray(required.capabilities)||required.capabilities.some(c=>!supported.includes(c)||!config.capabilities?.includes(c))||manifest.server.sync?.enabled)throw new Error('Unsupported application capabilities');
  startupStage='crypto_domains';
  if(!config.cryptoDomains||!['hmac','seal'].every(k=>typeof config.cryptoDomains[k]==='string'&&/^[!-~]{1,128}$/.test(config.cryptoDomains[k]))||config.cryptoDomains.hmac===config.cryptoDomains.seal)throw new Error('Invalid crypto domains');
  startupStage='route_configuration';
  const declared=manifest.server.routes;
  if(!Array.isArray(declared)||declared.length>256)throw new Error('Unsupported route declaration');
  // One route schema for every host (apps/softn-rust/src/bundle.rs is the other reader):
  // `transaction` and `authorization` are optional there, so they are optional here.
  // A route this host cannot serve — a path outside /api/ (Apache routes only those
  // to api.php), a method PHP does not route, `hosttoken` authorization when this
  // host holds no token — is set aside with its reason, answered as such and listed
  // by /api/meta, rather than a reason to refuse the whole app. A route that says
  // something this host does not understand is still refused, as before.
  const unserved=[];
  const routes=[];
  for(const r of declared) {
    if(!r||typeof r!=='object'||typeof r.path!=='string'||typeof r.method!=='string'||!/^[$A-Z_a-z][$\w]*$/.test(r.handler))throw new Error('Unsupported route declaration');
    // No transaction declared (or the Rust host's `none`): a read for a GET,
    // a write for anything else, so a handler written against that host's
    // defaults keeps its writes.
    const transaction=r.transaction===undefined||r.transaction==='none'?(r.method==='GET'?'read':'write'):r.transaction;
    // `host-token` is the Rust host's spelling (bundle.rs, kebab-case); `hosttoken` is this host's older one.
    const authorization=r.authorization===undefined?'application':r.authorization==='host-token'?'hosttoken':r.authorization;
    if(!['read','write'].includes(transaction)||!['application','anonymous','hosttoken'].includes(authorization))throw new Error('Unsupported route declaration');
    let reason=null;
    if(!/^\/api\/[a-zA-Z0-9/_-]+$/.test(r.path))reason='path outside /api/ is not routed to this host';
    else if(!['GET','POST','PUT','DELETE'].includes(r.method))reason='method not served by this host';
    else if(authorization==='hosttoken')reason='hosttoken authorization: this host holds no token';
    if(reason){unserved.push({method:r.method,path:r.path,reason});continue;}
    routes.push({...r,transaction,authorization});
  }
  if(declared.some(r=>r.upload!==undefined&&(r.upload!=='photo'||!required.capabilities.includes('photos')||r.method!=='POST')))throw new Error('Unsupported upload capability');
  if(new Set(declared.map(r=>r.method+' '+r.path)).size!==declared.length)throw new Error('Duplicate route');
  if(routes.some(r=>r.poll!==undefined&&(typeof r.poll!=='boolean'||r.poll&&(r.method!=='GET'||r.transaction!=='read'))))throw new Error('Invalid polling route');
  startupStage='application_source';
  validateWasmSource(readFileSync(inside(manifest.server.entry),'utf8'),manifest.config?.app||{},config.development,declared,required.capabilities.includes('photos'));
  startupStage='data_directory';
  const data=realpathSync(join(root,'private/data'));
  if(lstatSync(join(root,'private/data')).isSymbolicLink()||!contained(realpathSync(join(root,'private')),data))throw new Error('Invalid data path');
  startupStage='request_input';
  const input=workerData;if(typeof input!=='string'||Buffer.byteLength(input)>6_000_000)throw new Error('Input limit');
  const request=JSON.parse(input);
  if(!request||typeof request.path!=='string'||!request.path.startsWith('/api/')||!['GET','POST','PUT','DELETE'].includes(request.method)||typeof request.client_ip!=='string')throw new Error('Invalid request');
  startupStage='database_open';
  const file=join(data,'application.sqlite');
  try{if(lstatSync(file).isSymbolicLink())throw new Error('Invalid database');}catch(e){if(e.code!=='ENOENT')throw e;}
  db=new DatabaseSync(file,{allowExtension:false,limits:SQL_LIMITS});chmodSync(file,0o600);
  // Lock waits are three seconds, as on the Rust host, and the wait is set
  // before anything that can meet a lock: with journal_mode first, a request
  // opening the database while another was closing its connection failed at
  // once with database_busy instead of waiting.
  db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=131072;');
  startupStage='database_lock';
  db.exec('BEGIN IMMEDIATE');
  try {
    startupStage='database_migrations';
    db.exec('CREATE TABLE IF NOT EXISTS _migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT');
    // In sorted order, as the Rust host applies them (private_backend.rs), not
    // in the order listed: `["002.sql","001.sql"]` builds the same schema on
    // both. A path listed twice, or one applied before and no longer listed,
    // stops startup there too: the ledger must describe this deployment.
    const migrations=[...(manifest.server.database?.migrations||[])];
    if(migrations.some(name=>typeof name!=='string'))throw new Error('Invalid migration list');
    migrations.sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
    if(migrations.some((name,i)=>i>0&&name===migrations[i-1]))throw new Error('Duplicate migration path');
    // A migration the runner's deadline stopped (runner.mjs) is written down
    // there, and the runner is told which one is running before each starts.
    // Each stop rolled it back, and every request after started it again and
    // held the write lock until it was stopped too; after three it is not
    // started again until its file changes or the note is removed, or
    // setup.php is run with a deadline of its own for it
    // (--migration-deadline), whose run starts it whatever the note says.
    const stoppedNote=join(data,'migration-stopped.json');
    const operatorRun=setupDeadlineMs(process.env)!==null;
    let stopped=null;try{stopped=JSON.parse(readFileSync(stoppedNote,'utf8'));}catch{}
    for(const name of migrations) {
      const sql=readFileSync(inside(name),'utf8'),hash=createHash('sha256').update(sql).digest('hex');
      const old=db.prepare('SELECT sha256 FROM _migrations WHERE name=?').get(name);
      if(old){if(old.sha256!==hash)throw new Error('Migration mismatch');continue;}
      const fileName=basename(name);
      // Answered under a label of its own. As `database_migrations` it read
      // as a migration that failed or does not match the ledger, and the
      // one place that said otherwise was the log: the app stays down until
      // somebody acts, so /api/meta and setup.php have to say what on.
      if(!operatorRun&&stopped?.name===name&&stopped.sha256===hash&&stopped.stops>=MIGRATION_ATTEMPTS) {
        startupStage='migration_stopped';
        throw new Error(`Migration ${fileName} was stopped at the deadline ${stopped.stops} times and is not started again until it changes or migration-stopped.json is removed from the private data folder, or setup.php is run with --migration-deadline=SECONDS to apply it`);
      }
      parentPort?.postMessage({migration:{name,file:fileName,sha256:hash,marker:stoppedNote,attempts:MIGRATION_ATTEMPTS}});
      applyMigration(db,sql);db.prepare('INSERT INTO _migrations VALUES(?,?,?)').run(name,hash,Math.floor(Date.now()/1000));
      parentPort?.postMessage({migration:null});
    }
    if(stopped)rmSync(stoppedNote,{force:true});
    const listed=new Set(migrations);
    if(db.prepare('SELECT name FROM _migrations').all().some(row=>!listed.has(row.name)))throw new Error('Deployment removed a previously applied migration');
    startupStage='request_limits';
    db.exec('CREATE TABLE IF NOT EXISTS _request_limits(ip TEXT PRIMARY KEY, minute INTEGER NOT NULL, count INTEGER NOT NULL) STRICT');
    // http.php supplies the bucket (an IPv6 client's /64); older callers only the address.
    const rateKey=typeof request.rate_key==='string'&&request.rate_key?request.rate_key:request.client_ip;
    const minute=Math.floor(Date.now()/60000),ip=createHash('sha256').update(rateKey).digest('hex');
    db.prepare('DELETE FROM _request_limits WHERE minute<?').run(minute-1);
    db.prepare('INSERT INTO _request_limits VALUES(?,?,1) ON CONFLICT(ip) DO UPDATE SET count=CASE WHEN minute=excluded.minute THEN count+1 ELSE 1 END,minute=excluded.minute').run(ip,minute);
    const count=db.prepare('SELECT count FROM _request_limits WHERE ip=?').get(ip).count;
    db.exec('COMMIT');
    // config.server.requestsPerMinute, as the Rust host reads it: a whole
    // number, 0 for no limit, 120 when it is not set. It used to be 120
    // whatever the manifest said.
    const declaredLimit=manifest.config?.server?.requestsPerMinute;
    const perMinute=Number.isInteger(declaredLimit)&&declaredLimit>=0?declaredLimit:120;
    if(perMinute>0&&count>perMinute){markLimited(minute,ip);emit({status:429,body:{error:'Too many requests.',code:'rate_limited'}});process.exit(0);}
  } catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
  // An upload http.php would not take (photos.php) comes here only to be
  // counted, which has just been done, and to be answered: no handler runs.
  // http.php used to answer it itself and no runner was started, so a refused
  // upload was never counted, however many a client sent. The flag is
  // http.php's own, never the caller's: it builds this request field by field.
  // The answer and its code are the Rust host's for a bad photo (http.rs).
  if(request.refused==='photo'){emit({status:400,body:{error:'Photo rejected. Use a still JPEG, PNG or WebP under 4 MB, 16 megapixels and 8192 pixels a side.',code:'photo_rejected'}});process.exit(0);}
  startupStage='record_events';
  const recordSubscriptions=config.enableHostContext===true?JSON.parse(process.env.SOFTN_RECORD_EVENTS||'[]'):[];
  const authorizeRecordEvent=configureRecordEvents(db,recordSubscriptions);
  startupStage='wasm_initialization';
  const host=createWasmHost(db,{authorizeRecordEvent,key:Buffer.from(config.keyHex,'hex'),cryptoDomains:config.cryptoDomains,development:config.development,capabilities:required.capabilities,appConfig:manifest.config?.app||{},source:readFileSync(inside(manifest.server.entry),'utf8')});
  let result;
  const route=routes.find(r=>r.path===request.path&&r.method===request.method);
  if(request.path==='/api/meta'&&request.method==='GET')result={status:200,body:{development:config.development,photos:required.capabilities.includes('photos')&&request.photos===true,version:manifest.version,runtime:'zipp-wasm-on-demand',appId:manifest.id,...(unserved.length?{unservedRoutes:unserved}:{})}};
  else if(!route) {
    // A declared route that needs the host token is refused as the Rust host refuses it without one; anything else undeclared is not found.
    const aside=unserved.find(u=>u.path===request.path&&u.method===request.method);
    result=aside&&aside.reason.startsWith('hosttoken')?{status:401,body:{error:'Authorization required'}}:{status:404,body:{error:'Endpoint not found.'}};
  }
  else {
    // The rate bucket is the host's; the address only for an app granted trusted-client-ip.
    delete request.rate_key;
    if(!required.capabilities.includes('trusted-client-ip'))delete request.client_ip;
    if(route.upload!=='photo')delete request.upload;
    startupStage='request_integration';
    const hostContext=config.enableHostContext===true?JSON.parse(process.env.SOFTN_HOST_CONTEXT||'{}'):{};
    result=await invokeWithHook({request,route,host,config,db,hostContext,loadHook:()=>import(pathToFileURL(join(root,'operator/request.mjs')).href)});
  }
  // Optional operator-installed adapter, never selected by a request or bundle.
  // This is trusted host code, not part of the WASM guest's authority.
  if(config.enableAfterRequestHook===true) {
    try {const hook=await import(pathToFileURL(join(root,'operator/after-request.mjs')).href);await hook.afterRequest({db,crypto:host.crypto,config});}catch{ /* Adapter owns durable retries. */ }
  }
  emit(result);
} catch(e) {
  // A busy database is a moment's load, not something to look into.
  if(!busy(e))logFailure('startup stage '+startupStage,e);
  emit(busy(e)?{status:503,body:{error:'The server is busy. Please retry.',code:'database_busy'}}
    :{status:503,body:{error:'The backend is unavailable. Check its private configuration.',code:'backend_unavailable',diagnostic:startupStage}});
} finally {try{db?.close();}catch{}}
