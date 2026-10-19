import {check, ComputeError} from './graph.mjs';

/** Every host-request kind the GPU adapters admit; anything else is the central dispatcher's. */
export const GPU_KINDS=Object.freeze(['gpu.execute','gpu.session.create','gpu.session.run','gpu.session.download','gpu.session.dispose']);
const SESSION_KEYS={'gpu.session.create':['program','resident','backend'],'gpu.session.run':['session','steps','readback','step'],
  'gpu.session.download':['session','names'],'gpu.session.dispose':['session']};
function fields(payload,kind){
  check(payload!==null&&typeof payload==='object'&&!Array.isArray(payload),'PROTOCOL',`${kind} expects an object`);
  for(const k of Object.keys(payload))check(SESSION_KEYS[kind].includes(k),'PROTOCOL',`Unknown field: ${k}`);
}
/** An unguessable session id: a tenant learns only the ids its own handler minted. */
function token(){
  const bytes=new Uint8Array(16);
  if(globalThis.crypto?.getRandomValues)globalThis.crypto.getRandomValues(bytes);
  else for(let i=0;i<16;i++)bytes[i]=Math.floor(Math.random()*256);
  return 's'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}

/**
 * Async host-call handler. Does not drain queues, guess tenants, or re-enter a running VM.
 *
 * Sessions (`gpu.session.*`) live in this handler's own map under opaque ids,
 * so one Engine generation can never name another's; `invalidate()` disposes
 * them all. `maxSessions` bounds the map on top of the runtime's own limit.
 */
export function createZippGPUHandler(runtime, {allowExecute=false,maxSessions=16}={}) {
  check(Number.isSafeInteger(maxSessions)&&maxSessions>0,'LIMIT','maxSessions must be a positive integer');
  let active=true;
  const sessions=new Map();
  const lookup=id=>{const s=typeof id==='string'?sessions.get(id):undefined;check(s!==undefined,'REFERENCE','Unknown session');return s;};
  return Object.freeze({
    // `options` reaches `runtime.execute` / `runtime.prepare` (`typedOutputs`).
    async handle(kind,args,options={}) {
      check(active,'DISPOSED','GPU handler has been invalidated');
      check(allowExecute===true,'DENIED','GPU compute is not granted to this tenant');
      check(GPU_KINDS.includes(kind),'DENIED','Unknown GPU operation');
      check(Array.isArray(args)&&args.length===1,'PROTOCOL',`${kind} expects exactly one argument`);
      const [payload]=args;
      let result;
      if(kind==='gpu.execute')result=await runtime.execute(payload,options);
      else if(kind==='gpu.session.create'){
        fields(payload,kind);
        check(sessions.size<maxSessions,'LIMIT',`At most ${maxSessions} sessions per tenant; dispose one first`);
        const session=await runtime.prepare(payload.program,{resident:payload.resident??[],typedOutputs:options.typedOutputs??true});
        if(!active){session.dispose();check(false,'CANCELLED','Tenant was invalidated while compute was in flight');}
        if(payload.backend!==undefined&&payload.backend!==null&&payload.backend!==session.backend){
          session.dispose();check(false,'BACKEND',`Session requires backend ${String(payload.backend)}; the runtime is ${session.backend}`);
        }
        check(sessions.size<maxSessions,'LIMIT',`At most ${maxSessions} sessions per tenant; dispose one first`);
        const id=token();sessions.set(id,session);
        return {version:1,session:id,...session.describe()};
      } else if(kind==='gpu.session.run'){
        fields(payload,kind);
        const session=lookup(payload.session);
        // `owned`: the caller's payload is its own private copy, so feeds are checked, not copied again.
        try{result=await session.run(payload.steps,{readback:payload.readback,step:payload.step,owned:options.owned===true});}
        catch(error){if(session.poisoned&&error!==null&&typeof error==='object')error.poisoned=true;throw error;}
        result.step=session.stepNumber;
      } else if(kind==='gpu.session.download'){
        fields(payload,kind);result=await lookup(payload.session).download(payload.names);
      } else {
        fields(payload,kind);const session=lookup(payload.session);
        sessions.delete(payload.session);session.dispose();result={version:1,disposed:true};
      }
      check(active,'CANCELLED','Tenant was invalidated while compute was in flight');
      return result;
    },
    get sessions(){return sessions.size;},
    invalidate(){active=false;for(const s of sessions.values())s.dispose();sessions.clear();},
  });
}

/**
 * Adapter for requests ALREADY drained by the host's one central ZIPP queue owner.
 * Each closure belongs to one immutable Engine/Worker generation. No global ID routing.
 * It serializes dispatch and rejects duplicate IDs, and never pumps/drains unrelated kinds.
 * Call invalidate before terminating a tenant; await idle, then dispose the GPU runtime.
 */
export function createZippGPUAdapter(engine,runtime,{allowExecute=false,maxRequests=4096,maxPending=64,maxSessions=16}={}) {
  check(Number.isSafeInteger(maxRequests)&&maxRequests>0&&Number.isSafeInteger(maxPending)&&maxPending>0,
    'LIMIT','Adapter request limits must be positive integers');
  const handler=createZippGPUHandler(runtime,{allowExecute,maxSessions});
  let active=true,tail=Promise.resolve(),pending=0;
  const seen=new Set();
  const live=()=>active&&!engine.disposed;
  return Object.freeze({
    accepts(kind){return GPU_KINDS.includes(kind);},
    dispatch(call) {
      if(!live())return Promise.reject(new ComputeError('DISPOSED','Adapter generation has ended'));
      if(!call||!GPU_KINDS.includes(call.kind))return Promise.reject(new ComputeError('DENIED','Use the central dispatcher for non-GPU kinds'));
      if(!Number.isSafeInteger(call.id)||call.id<1)return Promise.reject(new ComputeError('PROTOCOL','Invalid callback ID'));
      if(seen.has(call.id))return Promise.reject(new ComputeError('DUPLICATE','Duplicate callback ID'));
      if(seen.size>=maxRequests||pending>=maxPending)return Promise.reject(new ComputeError('LIMIT','GPU request allowance exceeded'));
      const id=call.id,kind=call.kind;
      // The caller is trusted host code. Drained guest args must be plain structured data.
      // Own the request snapshot so queuing cannot observe later caller mutation.
      let args;
      try{args=structuredClone(call.args);}catch(error){return Promise.reject(new ComputeError('PROTOCOL','Arguments are not cloneable data'));}
      seen.add(id);pending++;
      const run=tail.then(async()=>{
        if(!live())return {delivered:false,cancelled:true};
        let reply;
        try{reply={ok:true,value:await handler.handle(kind,args,{owned:true})};}
        catch(error){reply={ok:false,error:{code:error.code||'GPU',message:String(error.message||error).slice(0,512),...(error?.poisoned?{poisoned:true}:{})}};}
        if(!live())return {delivered:false,cancelled:true};
        // This is after asynchronous host work and outside an active Engine export.
        const delivered=engine.resolveHostCallback(id,reply);
        return {delivered:delivered!==false,cancelled:false};
      }).finally(()=>{pending--;});
      tail=run.catch(()=>{});return run;
    },
    invalidate(){active=false;handler.invalidate();},
    idle(){return tail;},
    get sessions(){return handler.sessions;},
  });
}
