import {readFileSync} from 'node:fs';
import {createCrypto} from './crypto.mjs';
import {createSql} from './sql.mjs';
import {parseZoned,formatZoned} from './time.mjs';
import {initSync,Engine,zippProfile} from './wasm/zipp_wasm.mjs';

let initialized=false;
/** What one host call may carry: 2 MiB of arguments and a statement's 20 KB (sql.mjs). */
const MAX_CALL_BYTES=2*1024*1024+20_000;
const SHIM=`
var softn={serverApiVersion:1,config:{development:false},sql:{},crypto:{},time:{}};
function __softnCall(op,args){var r=db.query(op,args);if(r!==null&&typeof r==='object'&&r.__softnHostError===true)throw new Error(r.message);return r;}
softn.sql.query=function(s,p){return __softnCall('sql.query',[s,p||[]]);};
softn.sql.first=function(s,p){return __softnCall('sql.first',[s,p||[]]);};
softn.sql.execute=function(s,p){return __softnCall('sql.execute',[s,p||[]]);};
softn.crypto.sha256=function(s){return __softnCall('crypto.sha256',[s]);};
softn.crypto.hmac=function(s){return __softnCall('crypto.hmac',[s]);};
softn.crypto.randomHex=function(n){return __softnCall('crypto.randomHex',[n]);};
softn.crypto.randomInt=function(n){return __softnCall('crypto.randomInt',[n]);};
softn.crypto.equal=function(a,b){return __softnCall('crypto.equal',[a,b]);};
softn.crypto.seal=function(s){return __softnCall('crypto.seal',[s]);};
softn.time.now=function(){return __softnCall('time.now',[]);};
softn.time.parseZoned=function(d,t,z){return __softnCall('time.parseZoned',[d,t,z]);};
softn.time.format=function(t,z){return __softnCall('time.format',[t,z]);};
softn.time.age=function(d,z){return __softnCall('time.age',[d,z]);};
function __softnNoTimer(name){throw new Error(name+' is not available in server logic: nothing runs after the handler returns.');}
function setTimeout(){__softnNoTimer('setTimeout');}
function setInterval(){__softnNoTimer('setInterval');}
function clearTimeout(){__softnNoTimer('clearTimeout');}
function clearInterval(){__softnNoTimer('clearInterval');}
`;
// The timers above are errors that say what is wrong. A handler runs once
// and the request ends when it returns, so nothing a timer would call ever
// runs. The engine's own setTimeout kept the callback for ever inside a
// function, and at the top level stopped the engine ("can't sleep"); the
// other three were not defined. The Rust host's preamble.js says the same.
// An app's own function of one of these names comes later and is its own.

function initialize() {
  if(!initialized){
    initSync({module:readFileSync(new URL('./wasm/zipp_wasm_bg.wasm',import.meta.url))});
    if(!JSON.parse(zippProfile()).features.includes('safe-sandbox'))throw new Error('Sandbox profile missing');
    initialized=true;
  }
}

/** Compile declarations before a deployment's migrations touch its database. */
/**
 * One line on stderr for the operator's log (http.php hands it to PHP's
 * error_log): what failed, and the reason as the exception gave it. Never a
 * stack or a bind value; anything shaped like a path is replaced, control
 * characters are removed, and the reason stops at 300 characters. The client
 * is still told only `host_error` or a static stage label.
 */
export function logFailure(what, error) {
  const reason=String(error?.message??error??'unknown').replace(/[\x00-\x1f\x7f]+/g,' ').replace(/(?:[A-Za-z]:)?[\\/][^\s'"`]+/g,'<path>').slice(0,300);
  try{process.stderr.write('softn: '+what+': '+reason+'\n');}catch{}
}

/**
 * What a script is told when a host call fails: the `e.message` its
 * `catch (e)` reads. The engine replaces whatever a host function throws
 * with "host bridge call failed", so a failed call does not throw across the
 * bridge: it answers with this reason under a mark no result can carry (SQL
 * has no `true`), and the script's own softn.* function throws it
 * (`__softnCall` in the shim). The Rust host's scripts are told the reason
 * the same way round.
 *
 * A reason the host wrote itself (a plain Error from sql.mjs, time.mjs or
 * crypto.mjs, or a refusal made here) is told as it is. What a library said
 * is not: SQLite's own words can name the host's tables, so the script is
 * told only which kind of call failed, as the Rust host tells it, and the
 * operator's log keeps the rest (logFailure).
 */
function scriptReason(op, error) {
  if(error instanceof Error&&error.constructor===Error&&error.code===undefined&&error.errcode===undefined)
    return String(error.message).replace(/[\x00-\x1f\x7f]+/g,' ').slice(0,300);
  if(op==='sql.execute')return 'SQL write failed';
  if(op==='sql.query'||op==='sql.first')return 'SQL query failed';
  return 'Host call failed';
}

/**
 * softn.config: the app's own settings (manifest config.app) under the two
 * flags the host owns. An app key named `development` or `photos` is
 * replaced, as on the Rust host: `photos` used to pass straight through, so a
 * bundle could tell its own script it had a grant the operator never gave.
 */
function scriptConfig(appConfig, development, photos) {
  return JSON.stringify({...appConfig,development:development===true,photos:photos===true});
}

export function validateWasmSource(source, appConfig = {}, development = false, routes = [], photos = false) {
  initialize();
  const engine = new Engine();
  try {
    engine.setInstructionBudget(5_000_000);
    // No host bridge: validation cannot perform database, filesystem or network IO.
    engine.initScript(SHIM+'\nsoftn.config='+scriptConfig(appConfig,development,photos)+';\n'+source);
    for (const route of routes) {
      if (!/^[$A-Z_a-z][$\w]*$/.test(route.handler) || engine.evalInContext('typeof '+route.handler+' === "function"') !== true) throw new Error('Missing route handler');
    }
  } finally { try { engine.dispose(); } finally { engine.free(); } }
}

export function createWasmHost(db,{key,cryptoDomains,development=false,source,steps=5_000_000,capabilities=[],appConfig={},authorizeRecordEvent=()=>false}={}) {
  initialize();
  const now=()=>Math.floor(Date.now()/1000);
  const services={crypto:createCrypto(key,cryptoDomains),time:{now,parseZoned,format:formatZoned,
    age:(birth,zone)=>{
      // An omitted zone crosses the bridge as null, which a default parameter
      // leaves alone: softn.time.age("2000-01-01") answered 500 here and 26
      // on the Rust host. An empty one is UTC as well, as it is there.
      if(zone==null||zone==='')zone='UTC';
      if(typeof birth!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(birth))return -1;
      const d=new Date(birth+'T00:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==birth)return -1;
      const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now()*1000).map(v=>[v.type,v.value]));
      const [y,m,day]=birth.split('-').map(Number);return Number(p.year)-y-(Number(p.month)<m||Number(p.month)===m&&Number(p.day)<day?1:0);
    }}};
  // The SQL rules are the Rust host's (sql.mjs); the route's transaction decides whether execute may write.
  const sql=createSql(db,{authorizeRecordEvent});
  let writable=false;
  const operations=Object.freeze({
    'sql.query':(s,p)=>sql('query',s,p),'sql.first':(s,p)=>sql('first',s,p),'sql.execute':(s,p)=>sql('execute',s,p,writable),
    ...Object.fromEntries(['sha256','hmac','randomHex','randomInt','equal','seal'].map(k=>['crypto.'+k,services.crypto[k]])),
    ...Object.fromEntries(['now','parseZoned','format','age'].map(k=>['time.'+k,services.time[k]]))
  });
  function invoke(request,route,context={}) {
    let engine,transaction=false,calls=0,failed=false,failure=null;
    try {
      writable=route.transaction!=='read';
      db.exec(writable?'BEGIN IMMEDIATE':'BEGIN');transaction=true;
      engine=new Engine();engine.setInstructionBudget(steps);engine.setSyncHostCapabilities(['db.query']);
      engine.setDbBridge({query:(op,args)=>{
        // A host call that fails marks the request, whatever the handler
        // does with the exception: see the commit below.
        try {
          // 2 MiB of binds or of text to hash, as the Rust host allows, and
          // the 20 KB a statement may be. It was 1 MB: a route that takes a
          // 2 MiB body could not store what it had been sent.
          if(++calls>512||!Object.hasOwn(operations,op)||!capabilities.includes(op.split('.')[0])||!Array.isArray(args)||args.length>4)throw new Error('Host capability denied: '+String(op).slice(0,40));
          if(Buffer.byteLength(JSON.stringify(args))>MAX_CALL_BYTES)throw new Error('Host call arguments exceed '+MAX_CALL_BYTES+' bytes: '+String(op).slice(0,40));
          if(route.transaction==='read'&&op==='sql.execute')throw new Error('Read-only transaction');
          return operations[op](...args);
        // Answered, not thrown: see scriptReason. The request is marked all the same.
        } catch(e){failed=true;failure??=e;return {__softnHostError:true,message:scriptReason(op,e)};}
      }});
      // The answer /api/meta gives: granted, and GD is there to do it.
      engine.initScript(SHIM+'\nsoftn.config='+scriptConfig(appConfig,development,capabilities.includes('photos')&&request.photos===true)+';\n'+source);
      engine.evalInContext('typeof onStart === "function" ? onStart() : null');
      const result=engine.callFunction(route.handler,[{...request,context}]);
      if(!result||!Number.isInteger(result.status)||result.status<200||result.status>599||!Object.hasOwn(result,'body')||Buffer.byteLength(JSON.stringify(result))>3*1024*1024)throw new Error('Invalid response');
      // "An exception, host error, … rolls back" (the hosts' contract; the
      // Rust host's sql.mark_failed). A handler that caught a failed
      // statement and answered used to commit what it had written before
      // it: a transfer that credited one account, failed to debit the other
      // and answered 400 left the credit in the database. Such a request is
      // rolled back and answers host_error, unless the handler asked for the
      // rollback itself, in which case its answer stands.
      if(failed&&!result.rollback)throw new Error('Host call failed');
      db.exec(result.rollback?'ROLLBACK':'COMMIT');transaction=false;
      delete result.rollback;return result;
    } catch(e) {
      // The first host call that failed says more than what the VM made of it.
      logFailure('handler '+route.handler,failure??e);
      if(transaction)try{db.exec('ROLLBACK');}catch{}
      return {status:transaction?500:503,body:{error:'The request could not be completed.',code:transaction?'host_error':'database_busy'}};
    } finally { if (engine) { try { engine.dispose(); } finally { engine.free(); } } }
  }
  return {invoke,crypto:services.crypto};
}
