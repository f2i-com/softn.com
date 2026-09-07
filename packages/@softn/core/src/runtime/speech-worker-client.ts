export interface SpeechPCM { pcm: Float32Array; sampleRate: number }
export interface SpeechProgress { phase: string; loadedBytes: number; totalBytes: number }
export interface NeuralSpeechBackend {
  load(progress: (value: SpeechProgress) => void): Promise<void>;
  generate(text: string, voice: string, rate: number): Promise<SpeechPCM>;
  dispose(): void;
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The fixed local worker owns its own Kokoro/Transformers version and model. */
export class SpeechWorkerClient implements NeuralSpeechBackend {
  private worker: Worker | null = null;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private progress: ((value: SpeechProgress) => void) | null = null;
  private disposed = false;

  private ensureWorker(): Worker {
    if(this.disposed)throw new Error('speech-worker-closed');
    if(this.worker)return this.worker;
    // A variable deliberately avoids Vite rewriting only this file to a hashed
    // asset without its adjacent WASM and voice files. Matches script-worker.
    const workerPath = './core-runtime/runtime/neural-speech-worker.js';
    const worker = new Worker(new URL(workerPath, import.meta.url), {type:'module'});
    this.worker = worker;
    worker.onmessage = (event: MessageEvent) => {
      const value=event.data;
      if(!value || typeof value!=='object')return;
      if(value.type==='progress') {
        const bytes=(number:unknown)=>typeof number==='number' && Number.isFinite(number)?Math.min(200*1024*1024,Math.max(0,number)):0;
        this.progress?.({phase:typeof value.phase==='string'?value.phase.slice(0,40):'loading',loadedBytes:bytes(value.loadedBytes),totalBytes:bytes(value.totalBytes)});
        return;
      }
      const request=this.pending.get(value.id);
      if(!request)return;
      this.pending.delete(value.id);clearTimeout(request.timer);
      if(value.error)request.reject(new Error(String(value.error).slice(0,100)));
      else request.resolve(value);
    };
    worker.onerror=()=>this.failAll('speech-worker-failed');
    worker.onmessageerror=()=>this.failAll('speech-worker-message-failed');
    return worker;
  }
  private failAll(reason: string): void {
    this.worker?.terminate();this.worker=null;
    for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error(reason));}
    this.pending.clear();
  }
  private request(type: string, payload: Record<string, unknown>, timeout: number): Promise<unknown> {
    const worker=this.ensureWorker();const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.failAll(type==='load'?'speech-download-timeout':'speech-generation-timeout'),timeout);
      this.pending.set(id,{resolve,reject,timer});worker.postMessage({id,type,...payload});
    });
  }
  async load(progress: (value: SpeechProgress)=>void): Promise<void> {
    this.progress=progress;await this.request('load',{},240000);
  }
  async generate(text: string, voice: string, rate: number): Promise<SpeechPCM> {
    const value=await this.request('generate',{text,voice,rate},60000) as SpeechPCM;
    if(!(value.pcm instanceof Float32Array) || value.sampleRate!==24000 || value.pcm.length<1 || value.pcm.length>24000*35)throw new Error('invalid-speech-pcm');
    return {pcm:value.pcm,sampleRate:value.sampleRate};
  }
  dispose(): void { this.disposed=true;this.progress=null;this.failAll('speech-worker-closed'); }
}
