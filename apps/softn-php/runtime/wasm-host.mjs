import {readFileSync} from 'node:fs';
import {constants} from 'node:sqlite';
import {createCrypto} from './crypto.mjs';
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

export function createWasmHost(db,{key,cryptoDomains,development=false,source,steps=5_000_000,capabilities=[],appConfig={}}={}) {
  if(!initialized){
    initSync({module:readFileSync(new URL('./wasm/zipp_wasm_bg.wasm',import.meta.url))});
    if(!JSON.parse(zippProfile()).features.includes('safe-sandbox'))throw new Error('Sandbox profile missing');
    initialized=true;
  }
  const now=()=>Math.floor(Date.now()/1000);
  const services={crypto:createCrypto(key,cryptoDomains),time:{now,parseZoned,format:formatZoned,
    age:(birth,zone='UTC')=>{
      if(typeof birth!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(birth))return -1;
      const d=new Date(birth+'T00:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==birth)return -1;
      const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now()*1000).map(v=>[v.type,v.value]));
      const [y,m,day]=birth.split('-').map(Number);return Number(p.year)-y-(Number(p.month)<m||Number(p.month)===m&&Number(p.day)<day?1:0);
    }}};
  const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'").all().map(r=>r.name));
  const functions=new Set(['count','coalesce','min','max','sum','avg','lower','upper','length','substr','replace','abs']);
  function authorize(action,a,b,database) {
    if(database&&database!=='main')return constants.SQLITE_DENY;
    if(action===constants.SQLITE_SELECT)return constants.SQLITE_OK;
    if(action===constants.SQLITE_FUNCTION)return functions.has(String(b).toLowerCase())?constants.SQLITE_OK:constants.SQLITE_DENY;
    if([constants.SQLITE_READ,constants.SQLITE_INSERT,constants.SQLITE_UPDATE,constants.SQLITE_DELETE].includes(action))return tables.has(a)?constants.SQLITE_OK:constants.SQLITE_DENY;
    return constants.SQLITE_DENY;
  }
  const sql=(kind,text,params=[])=>{
    if(typeof text!=='string'||text.length>20000||!Array.isArray(params)||params.length>100)throw new Error('Invalid query');
    if(!(kind==='execute'?/^\s*(INSERT|UPDATE|DELETE)\b/i:/^\s*SELECT\b/i).test(text)||text.includes(';'))throw new Error('Only one app query is allowed');
    for(const p of params)if(p!==null&&typeof p!=='string'&&!(typeof p==='number'&&Number.isFinite(p)))throw new Error('Invalid parameter');
    db.setAuthorizer(authorize);
    try {
      const statement=db.prepare(text);
      if(kind==='execute') {const r=statement.run(...params);return {changes:Number(r.changes),lastInsertRowid:Number(r.lastInsertRowid)};}
      const rows=[];let bytes=0;
      for(const row of statement.iterate(...params)) {
        bytes+=Buffer.byteLength(JSON.stringify(row));
        if(bytes>2*1024*1024||rows.length>=1000)throw new Error('Query result limit');
        rows.push(row);if(kind==='first')break;
      }
      return kind==='first'?(rows[0]||null):rows;
    } finally {db.setAuthorizer(null);}
  };
  const operations=Object.freeze({
    'sql.query':(s,p)=>sql('query',s,p),'sql.first':(s,p)=>sql('first',s,p),'sql.execute':(s,p)=>sql('execute',s,p),
    ...Object.fromEntries(['sha256','hmac','randomHex','randomInt','equal','seal'].map(k=>['crypto.'+k,services.crypto[k]])),
    ...Object.fromEntries(['now','parseZoned','format','age'].map(k=>['time.'+k,services.time[k]]))
  });
  function invoke(request,route,context={}) {
    let engine,transaction=false,calls=0;
    try {
      db.exec(route.transaction==='read'?'BEGIN':'BEGIN IMMEDIATE');transaction=true;
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
    } finally {engine?.free();}
  }
  return {invoke,crypto:services.crypto};
}
