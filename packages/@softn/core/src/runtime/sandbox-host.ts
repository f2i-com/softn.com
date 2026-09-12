import { getConfiguredZippWasmSource } from './zipp-wasm-loader';

/** Worker isolation bounds parsing/native builtins as well as VM fuel. */
export class SandboxHost {
  private pending: (() => void) | null = null;
  private worker: Worker | null = null;
  private uses=0;
  private disposed=false;
  run(source: string, inputText: string): Promise<unknown> {
    if(this.disposed)return Promise.resolve({error:'Sandbox host closed'});
    if(this.pending)return Promise.resolve({error:'Sandbox is busy'});
    if(typeof source!=='string'||source.length>65536||typeof inputText!=='string'||inputText.length>65536)return Promise.resolve({error:'Sandbox input exceeds 64 KiB'});
    let input:unknown;try{input=JSON.parse(inputText);}catch{return Promise.resolve({error:'Invalid sandbox input'});}
    return new Promise(resolve=>{
      let settled=false;let timer:ReturnType<typeof setTimeout>;
      const finish=(result:any)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        // Warm WASM across calls; guest Engines are always fresh. Recycle on
        // errors and periodically so a large guest heap is not held forever.
        if(result?.error||++this.uses>=32){this.worker?.terminate();this.worker=null;this.uses=0;}
        this.pending=null;resolve(result);
      };
      this.pending=()=>finish({error:'Sandbox cancelled'});
      try {
        let zippWasm: ReturnType<typeof getConfiguredZippWasmSource>;
        if(!this.worker){const workerPath='./core-runtime/runtime/sandbox-worker.js';this.worker=new Worker(new URL(workerPath,import.meta.url),{type:'module'});zippWasm=getConfiguredZippWasmSource();}
        timer=setTimeout(()=>finish({error:'Sandbox startup timed out'}),10000);
        this.worker.onmessage=e=>{if(e.data?.ready){clearTimeout(timer);timer=setTimeout(()=>finish({error:'Sandbox execution timed out'}),1500);}else finish(e.data);};
        this.worker.onerror=()=>finish({error:'Sandbox worker failed'});
        // Only the first message to each new/recycled worker carries a source.
        // Structured cloning preserves the host copy for later worker restarts.
        this.worker.postMessage({source,input,...(zippWasm===undefined?{}:{zippWasm})});
      }catch(error){finish({error:String(error).slice(0,500)});}
    });
  }
  dispose(){this.disposed=true;this.pending?.();this.worker?.terminate();this.worker=null;}
}
