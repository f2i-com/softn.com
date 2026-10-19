import {validateProgram, check, checkFiniteOutput, ComputeError, DEFAULT_LIMITS} from './graph.mjs';
import {Session} from './session.mjs';
import {execution} from './fusion.mjs';
import {CPUBackend} from './backends/cpu.mjs';
import {WasmBackend} from './backends/wasm.mjs';
import {WebGPUBackend} from './backends/webgpu.mjs';
import {WebGL2Backend} from './backends/webgl2.mjs';
const clock=()=>globalThis.performance?.now()??Date.now();

/**
 * `debug` re-enables the per-dispatch driver error and framebuffer checks the
 * GPU backends otherwise make once per execution.
 */
export async function createRuntime({backend='auto', limits={}, wasmBytes, wasmUrl, debug=false}={}) {
  check(['auto','webgpu','webgl2','wasm','cpu-js'].includes(backend),'BACKEND','Unknown backend');
  const candidates=backend==='auto'?['webgpu','webgl2','wasm','cpu-js']:[backend],attempts=[];
  for(const name of candidates){
    try {
      const implementation=name==='webgpu'?await WebGPUBackend.create({debug}):name==='webgl2'?await WebGL2Backend.create({debug}):
        name==='wasm'?await WasmBackend.create({wasmBytes,wasmUrl}):new CPUBackend();
      return new ComputeRuntime(implementation,limits,attempts);
    }catch(error){attempts.push({backend:name,error:String(error.message||error)});}
  }
  throw new ComputeError('UNAVAILABLE',`Requested backend unavailable: ${attempts.map(a=>`${a.backend}: ${a.error}`).join('; ')}`);
}

/**
 * Refuses a graph a backend has no kernel for, before anything is uploaded.
 *
 * Without this an operation with no case in a backend's switch leaves its
 * output buffer at zero and returns a plausible tensor of nothing. Every
 * backend used to implement every operation, so the question never arose;
 * `matmul_fixed` is the first that two of them cannot do, and a silent wrong
 * answer is the one failure a protocol built to be checkable must not have.
 */
function refuseUnsupported(plan, impl) {
  const unsupported = impl.unsupported?.();
  if (!unsupported?.size) return;
  for (const n of plan.nodes) check(!unsupported.has(n.op), 'UNSUPPORTED',
    `The ${impl.name} backend has no ${n.op} kernel`);
}

export class ComputeRuntime {
  constructor(backend,limits={},attempts=[]){this.impl=backend;this.limits=limits;this.attempts=attempts;this.busy=false;this.disposed=false;this.sessions=new Set();}
  get backend(){return this.impl.name;}
  info(){return {backend:this.backend,description:this.impl.description,adapter:this.impl.info??null,fallbackAttempts:this.attempts,limits:this.effectiveLimits()};}
  /**
   * Policy defaults, then what this backend and device can sustain (a GPU may
   * accept more work, a device buffer may cap tensor size), then the host's own
   * limits, which always win.
   */
  effectiveLimits(){return {...DEFAULT_LIMITS,...(this.impl.limitHints?.()??{}),...this.limits};}
  // `typedOutputs`: each output's `data` is a Float32Array of its own rather
  // than a list of numbers (a ZIPP engine takes it as tensor storage).
  async execute(program,{typedOutputs=false}={}){
    check(!this.disposed,'DISPOSED','Runtime has been disposed');
    check(!this.busy,'BUSY','Runtime supports one graph at a time; await the previous execution');
    // Validation and owned input copies happen before any asynchronous work or GPU allocation.
    const plan=validateProgram(program,{...(this.impl.limitHints?.()??{}),...this.limits});
    refuseUnsupported(plan,this.impl);this.busy=true;
    const start=clock(),handles=new Map(),root=plan.root;
    let value,error,began=false,finishError;
    // Handles belong to storage roots; a reshape shares its source's handle.
    const free=id=>{const h=handles.get(id);if(h!==undefined){this.impl.free(h);handles.delete(id);}};
    try {
      await this.impl.begin(plan);began=true;
      // The plan's live work as the backend runs it (fusion.mjs): nodes, and
      // groups of nodes it computes together.
      const exec=execution(plan,this.impl),uses=[...exec.uses];
      for(const item of exec.items){
        const hs=item.refs.map(r=>handles.get(root[r]));
        if(item.kind==='node')handles.set(item.id,await this.impl.run(item.node,hs));
        else(await this.impl.runGroup(item,hs,{stepped:n=>n})).forEach((h,i)=>handles.set(item.exposed[i],h));
        for(const r of item.refs){uses[root[r]]--;if(uses[root[r]]===0)free(root[r]);}
        for(const id of item.exposed)if(uses[id]===0)free(id);
      }
      const submitted=clock(),outputs=Object.create(null),ids=[...new Set(plan.outputs.map(o=>root[o.id]))];
      // One batched readback when the backend offers it (one GPU round trip).
      const read=this.impl.readAll?await this.impl.readAll(ids.map(id=>handles.get(id))):
        await (async()=>{const all=[];for(const id of ids)all.push(await this.impl.read(handles.get(id)));return all;})();
      const cache=new Map(ids.map((id,i)=>[id,read[i]]));
      for(const o of plan.outputs){
        // A reshape shares its source storage, so the readback is keyed by the
        // storage root; every output id is in the batch above.
        const values=cache.get(root[o.id]);
        checkFiniteOutput(values);
        // A typed output hands the caller its own Float32Array; the plain form
        // is a list of numbers.
        const data=typedOutputs?(values instanceof Float32Array?values.slice():Float32Array.from(values)):Array.from(values);
        outputs[o.name]={shape:[...plan.nodes[o.id].shape],dtype:'float32',data};
      }
      value={version:1,backend:this.backend,outputs,stats:{nodes:plan.nodes.length,estimatedWork:plan.work,
        logicalAllocationBytes:plan.logicalBytes,uploadElements:plan.inputElements,
        readbackElements:plan.outputElements,submitWallMs:submitted-start,
        readbackWallMs:clock()-submitted,totalWallMs:0,...this.impl.allocationStats?.()}};
    }catch(e){error=e;}
    finally {
      for(const id of [...handles.keys()]){try{free(id);}catch(e){error??=e;}}
      if(began)try{await this.impl.finish();}catch(e){finishError=e;}
      this.busy=false;
    }
    if(error)throw error;if(finishError)throw finishError;
    value.stats.totalWallMs=clock()-start;
    return value;
  }
  /** Device bytes every live session keeps between runs. */
  residentBytes(){let bytes=0;for(const s of this.sessions)bytes+=s.residentBytes;return bytes;}
  /**
   * Validates `program` once and returns a Session whose inputs with data are
   * uploaded now. `resident` names outputs that stay on the device (fetched by
   * `session.download`); inputs marked `carry` are resident by construction.
   * Sessions are bounded in number (`maxSessions`) and their resident bytes,
   * with the plan's own allocation, count against `maxLogicalBytes`.
   */
  async prepare(program,{resident=[],typedOutputs=true}={}){
    check(!this.disposed,'DISPOSED','Runtime has been disposed');
    check(!this.busy,'BUSY','Runtime supports one graph at a time; await the previous execution');
    const plan=validateProgram(program,{...(this.impl.limitHints?.()??{}),...this.limits},{session:true}),limits=plan.limits;
    refuseUnsupported(plan,this.impl);
    check(this.sessions.size<limits.maxSessions,'LIMIT',`At most ${limits.maxSessions} sessions per runtime; dispose one first`);
    check(Array.isArray(resident)&&resident.every(n=>typeof n==='string'),'PROTOCOL','resident must list output names');
    const names=new Set(plan.outputs.map(o=>o.name));
    for(const name of resident)check(names.has(name),'REFERENCE',`resident names no output: ${name}`);
    const session=new Session(this,plan,{resident:new Set(resident),typedOutputs:typedOutputs!==false});
    check(this.residentBytes()+session.residentBytes+plan.logicalBytes<=limits.maxLogicalBytes,'LIMIT','Resident tensors exceed the allocation budget');
    this.busy=true;
    try{await session.init();}
    catch(e){if(this.sessions.size===0)this.impl.unpin?.();throw e;}
    finally{this.busy=false;}
    this.sessions.add(session);
    return session;
  }
  dispose(){
    check(!this.busy,'BUSY','Await execution before disposing');
    if(this.disposed)return;
    for(const s of [...this.sessions])s.dispose();
    this.disposed=true;this.impl.dispose();
  }
}
