import {DatabaseSync} from 'node:sqlite';
import {workerData} from 'node:worker_threads';
import {readFileSync,lstatSync,realpathSync,chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {createWasmHost} from './wasm-host.mjs';
import {applyMigration} from './migrations.mjs';
import {invokeWithHook} from './request-hook.mjs';
const root=dirname(fileURLToPath(import.meta.url));
let db;
// Static diagnostic labels identify the failed check without exposing values,
// paths, SQL, provider responses, or exception messages to clients.
let startupStage='configuration_read';
try {
  const config=JSON.parse(readFileSync(join(root,'private/config.json'),'utf8'));
  startupStage='configuration_values';
  if(!/^[a-f0-9]{64}$/.test(config.keyHex)||typeof config.development!=='boolean')throw new Error('Invalid configuration');
  startupStage='bundle_directory';
  const bundle=realpathSync(join(root,'app'));
  if(lstatSync(join(root,'app')).isSymbolicLink()||!bundle.startsWith(realpathSync(root)+'/'))throw new Error('Invalid bundle directory');
  const inside=relative=>{
    if(typeof relative!=='string'||relative.startsWith('/')||relative.includes('\\')||relative.split('/').some(s=>s==='..'||s==='.'))throw new Error('Invalid bundle path');
    const file=realpathSync(join(bundle,relative));if(!file.startsWith(bundle+'/'))throw new Error('Bundle path escaped');return file;
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
  const routes=manifest.server.routes;
  if(!Array.isArray(routes)||routes.length>256||routes.some(r=>!/^\/api\/[a-zA-Z0-9/_-]+$/.test(r.path)||!['GET','POST','PUT','DELETE'].includes(r.method)||!/^[$A-Z_a-z][$\w]*$/.test(r.handler)||!['read','write'].includes(r.transaction)||!['application','anonymous'].includes(r.authorization)))throw new Error('Unsupported route declaration');
  if(routes.some(r=>r.upload!==undefined&&(r.upload!=='photo'||!required.capabilities.includes('photos')||r.method!=='POST')))throw new Error('Unsupported upload capability');
  if(new Set(routes.map(r=>r.method+' '+r.path)).size!==routes.length)throw new Error('Duplicate route');
  startupStage='data_directory';
  const data=realpathSync(join(root,'private/data'));
  if(lstatSync(join(root,'private/data')).isSymbolicLink()||!data.startsWith(realpathSync(join(root,'private'))+'/'))throw new Error('Invalid data path');
  startupStage='request_input';
  const input=workerData;if(typeof input!=='string'||Buffer.byteLength(input)>6_000_000)throw new Error('Input limit');
  const request=JSON.parse(input);
  if(!request||typeof request.path!=='string'||!request.path.startsWith('/api/')||!['GET','POST','PUT','DELETE'].includes(request.method)||typeof request.client_ip!=='string')throw new Error('Invalid request');
  startupStage='database_open';
  const file=join(data,'application.sqlite');
  try{if(lstatSync(file).isSymbolicLink())throw new Error('Invalid database');}catch(e){if(e.code!=='ENOENT')throw e;}
  db=new DatabaseSync(file,{allowExtension:false});chmodSync(file,0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1500; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=131072;');
  startupStage='database_lock';
  db.exec('BEGIN IMMEDIATE');
  try {
    startupStage='database_migrations';
    db.exec('CREATE TABLE IF NOT EXISTS _migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT');
    for(const name of (manifest.server.database?.migrations||[])) {
      const sql=readFileSync(inside(name),'utf8'),hash=createHash('sha256').update(sql).digest('hex');
      const old=db.prepare('SELECT sha256 FROM _migrations WHERE name=?').get(name);
      if(old){if(old.sha256!==hash)throw new Error('Migration mismatch');continue;}
      applyMigration(db,sql);db.prepare('INSERT INTO _migrations VALUES(?,?,?)').run(name,hash,Math.floor(Date.now()/1000));
    }
    startupStage='request_limits';
    db.exec('CREATE TABLE IF NOT EXISTS _request_limits(ip TEXT PRIMARY KEY, minute INTEGER NOT NULL, count INTEGER NOT NULL) STRICT');
    const minute=Math.floor(Date.now()/60000),ip=createHash('sha256').update(request.client_ip).digest('hex');
    db.prepare('DELETE FROM _request_limits WHERE minute<?').run(minute-1);
    db.prepare('INSERT INTO _request_limits VALUES(?,?,1) ON CONFLICT(ip) DO UPDATE SET count=CASE WHEN minute=excluded.minute THEN count+1 ELSE 1 END,minute=excluded.minute').run(ip,minute);
    const count=db.prepare('SELECT count FROM _request_limits WHERE ip=?').get(ip).count;
    db.exec('COMMIT');
    if(count>120){process.stdout.write(JSON.stringify({status:429,body:{error:'Too many requests.'}}));process.exit(0);}
  } catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
  startupStage='wasm_initialization';
  const host=createWasmHost(db,{key:Buffer.from(config.keyHex,'hex'),cryptoDomains:config.cryptoDomains,development:config.development,capabilities:required.capabilities,appConfig:manifest.config?.app||{},source:readFileSync(inside(manifest.server.entry),'utf8')});
  let result;
  const route=routes.find(r=>r.path===request.path&&r.method===request.method);
  if(request.path==='/api/meta'&&request.method==='GET')result={status:200,body:{development:config.development,photos:required.capabilities.includes('photos')&&request.photos===true,version:manifest.version,runtime:'zipp-wasm-on-demand',appId:manifest.id}};
  else if(!route)result={status:404,body:{error:'Endpoint not found.'}};
  else {
    if(!required.capabilities.includes('trusted-client-ip'))delete request.client_ip;
    if(route.upload!=='photo')delete request.upload;
    startupStage='request_integration';
    result=await invokeWithHook({request,route,host,config,db,loadHook:()=>import('./operator/request.mjs')});
  }
  // Optional operator-installed adapter, never selected by a request or bundle.
  // This is trusted host code, not part of the WASM guest's authority.
  if(config.enableAfterRequestHook===true) {
    try {const hook=await import('./operator/after-request.mjs');await hook.afterRequest({db,crypto:host.crypto,config});}catch{ /* Adapter owns durable retries. */ }
  }
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stdout.write(JSON.stringify({status:503,body:{error:'The backend is unavailable. Check its private configuration.',code:'backend_unavailable',diagnostic:startupStage}}));
} finally {try{db?.close();}catch{}}
