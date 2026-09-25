import {DatabaseSync} from 'node:sqlite';
import {workerData} from 'node:worker_threads';
import {readFileSync,lstatSync,realpathSync,chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join,dirname,relative,isAbsolute} from 'node:path';
import {createWasmHost,validateWasmSource} from './wasm-host.mjs';
import {applyMigration} from './migrations.mjs';
import {configureRecordEvents} from './record-events.mjs';
import {invokeWithHook} from './request-hook.mjs';
// The operator may select an isolated app installation while sharing the trusted
// runtime and WASM. This value is never taken from guest code or request JSON.
const root=realpathSync(process.env.SOFTN_BACKEND_ROOT || dirname(fileURLToPath(import.meta.url)));
const contained=(parent,child)=>{const path=relative(parent,child);return path!==''&&!isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+(process.platform==='win32'?'\\':'/'));};
let db;
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
  validateWasmSource(readFileSync(inside(manifest.server.entry),'utf8'),manifest.config?.app||{},config.development,declared);
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
  db=new DatabaseSync(file,{allowExtension:false});chmodSync(file,0o600);
  // Lock waits are three seconds, as on the Rust host.
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=131072;');
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
    for(const name of migrations) {
      const sql=readFileSync(inside(name),'utf8'),hash=createHash('sha256').update(sql).digest('hex');
      const old=db.prepare('SELECT sha256 FROM _migrations WHERE name=?').get(name);
      if(old){if(old.sha256!==hash)throw new Error('Migration mismatch');continue;}
      applyMigration(db,sql);db.prepare('INSERT INTO _migrations VALUES(?,?,?)').run(name,hash,Math.floor(Date.now()/1000));
    }
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
    if(count>120){emit({status:429,body:{error:'Too many requests.',code:'rate_limited'}});process.exit(0);}
  } catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
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
  emit(busy(e)?{status:503,body:{error:'The server is busy. Please retry.',code:'database_busy'}}
    :{status:503,body:{error:'The backend is unavailable. Check its private configuration.',code:'backend_unavailable',diagnostic:startupStage}});
} finally {try{db?.close();}catch{}}
