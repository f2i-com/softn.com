import { zippEngineForWorker } from './zipp-wasm-loader';

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
      const finish=(result:unknown)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        // Warm WASM across calls; guest Engines are always fresh. Recycle on
        // errors and periodically so a large guest heap is not held forever.
        const failed=typeof result==='object'&&result!==null&&Boolean((result as {error?:unknown}).error);
        if(failed||++this.uses>=32){this.worker?.terminate();this.worker=null;this.uses=0;}
        this.pending=null;resolve(result);
      };
      this.pending=()=>finish({error:'Sandbox cancelled'});
      try {
        const fresh=!this.worker;
        if(!this.worker){const workerPath='./core-runtime/runtime/sandbox-worker.js';this.worker=new Worker(new URL(workerPath,import.meta.url),{type:'module'});}
        const worker=this.worker;
        timer=setTimeout(()=>finish({error:'Sandbox startup timed out'}),10000);
        worker.onmessage=e=>{if(e.data?.ready){clearTimeout(timer);timer=setTimeout(()=>finish({error:'Sandbox execution timed out'}),1500);}else finish(e.data);};
        worker.onerror=()=>finish({error:'Sandbox worker failed'});
        // A new or recycled worker's first message carries the engine, the
        // page's own compiled module: the worker has no copy to fetch. The
        // startup bound above covers the page compiling it the first time.
        if(!fresh){worker.postMessage({source,input});return;}
        zippEngineForWorker().then(
          zippWasm=>{if(!settled&&this.worker===worker)worker.postMessage({source,input,zippWasm});},
          error=>finish({error:`Sandbox engine unavailable: ${String(error).slice(0,400)}`}),
        );
      }catch(error){finish({error:String(error).slice(0,500)});}
    });
  }
  dispose(){this.disposed=true;this.pending?.();this.worker?.terminate();this.worker=null;}
}
