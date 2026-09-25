import {readFileSync} from 'node:fs';
import {createCrypto} from './crypto.mjs';
import {createSql} from './sql.mjs';
import {parseZoned,formatZoned} from './time.mjs';
import {initSync,Engine,zippProfile} from './wasm/zipp_wasm.mjs';

let initialized=false;
const SHIM=`
var softn={serverApiVersion:1,config:{development:false},sql:{},crypto:{},time:{}};
function __softnCall(op,args){return db.query(op,args);}
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
`;

function initialize() {
  if(!initialized){
    initSync({module:readFileSync(new URL('./wasm/zipp_wasm_bg.wasm',import.meta.url))});
    if(!JSON.parse(zippProfile()).features.includes('safe-sandbox'))throw new Error('Sandbox profile missing');
    initialized=true;
  }
}

/** Compile declarations before a deployment's migrations touch its database. */
export function validateWasmSource(source, appConfig = {}, development = false, routes = []) {
  initialize();
  const engine = new Engine();
  try {
    engine.setInstructionBudget(5_000_000);
    // No host bridge: validation cannot perform database, filesystem or network IO.
    engine.initScript(SHIM+'\nsoftn.config='+JSON.stringify({...appConfig,development})+';\n'+source);
    for (const route of routes) {
      if (!/^[$A-Z_a-z][$\w]*$/.test(route.handler) || engine.evalInContext('typeof '+route.handler+' === "function"') !== true) throw new Error('Missing route handler');
    }
  } finally { try { engine.dispose(); } finally { engine.free(); } }
}

export function createWasmHost(db,{key,cryptoDomains,development=false,source,steps=5_000_000,capabilities=[],appConfig={},authorizeRecordEvent=()=>false}={}) {
  initialize();
  const now=()=>Math.floor(Date.now()/1000);
  const services={crypto:createCrypto(key,cryptoDomains),time:{now,parseZoned,format:formatZoned,
    age:(birth,zone='UTC')=>{
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
    let engine,transaction=false,calls=0;
    try {
      writable=route.transaction!=='read';
      db.exec(writable?'BEGIN IMMEDIATE':'BEGIN');transaction=true;
      engine=new Engine();engine.setInstructionBudget(steps);engine.setSyncHostCapabilities(['db.query']);
      engine.setDbBridge({query:(op,args)=>{
        if(++calls>512||!Object.hasOwn(operations,op)||!capabilities.includes(op.split('.')[0])||!Array.isArray(args)||args.length>4||Buffer.byteLength(JSON.stringify(args))>1_000_000)throw new Error('Host capability denied');
        if(route.transaction==='read'&&op==='sql.execute')throw new Error('Read-only transaction');
        return operations[op](...args);
      }});
      engine.initScript(SHIM+'\nsoftn.config='+JSON.stringify({...appConfig,development})+';\n'+source);
      engine.evalInContext('typeof onStart === "function" ? onStart() : null');
      const result=engine.callFunction(route.handler,[{...request,context}]);
      if(!result||!Number.isInteger(result.status)||result.status<200||result.status>599||!Object.hasOwn(result,'body')||Buffer.byteLength(JSON.stringify(result))>3*1024*1024)throw new Error('Invalid response');
      db.exec(result.rollback?'ROLLBACK':'COMMIT');transaction=false;
      delete result.rollback;return result;
    } catch {
      if(transaction)try{db.exec('ROLLBACK');}catch{}
      return {status:transaction?500:503,body:{error:'The request could not be completed.',code:transaction?'host_error':'database_busy'}};
    } finally { if (engine) { try { engine.dispose(); } finally { engine.free(); } } }
  }
  return {invoke,crypto:services.crypto};
}
