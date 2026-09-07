import { LocalSystemSpeechHost } from './local-system-speech.mjs';
import { SpeechWorkerClient, type NeuralSpeechBackend, type SpeechPCM, type SpeechProgress } from './speech-worker-client';

const clamp=(value:unknown,lo:number,hi:number,fallback:number):number=>typeof value==='number' && Number.isFinite(value)?Math.min(hi,Math.max(lo,value)):fallback;
// Intentionally remove C0 controls while preserving tabs and line breaks.
// eslint-disable-next-line no-control-regex
const clean=(value:unknown,max:number):string=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim().slice(0,max):'';
export const NEURAL_SPEECH_VOICES=[
  {voiceURI:'af_heart',name:'Heart',lang:'en-US',local:true},
  {voiceURI:'af_bella',name:'Bella',lang:'en-US',local:true},
  {voiceURI:'af_sarah',name:'Sarah',lang:'en-US',local:true},
  {voiceURI:'bf_emma',name:'Emma',lang:'en-GB',local:true},
  {voiceURI:'am_michael',name:'Michael',lang:'en-US',local:true},
  {voiceURI:'bm_george',name:'George',lang:'en-GB',local:true},
] as const;
interface Outcome {handle:string;status:string;provider:'kokoro';durationMs:number;reason?:string}
interface Chunk extends SpeechPCM {source:AudioBufferSourceNode;start:number;end:number}
interface Utterance {
  handle:string;chunks:Chunk[];startedAt:number|null;createdAt:number;settled:boolean;synthesisDone:boolean;
  started:boolean;endPromise:Promise<Outcome>;resolveEnd:(value:Outcome)=>void;resolveStart:(value:Record<string,unknown>)=>void;
  startTimer:ReturnType<typeof setTimeout>|null;durationTimer:ReturnType<typeof setTimeout>|null;startCheck:ReturnType<typeof setTimeout>|null;
}
export interface LocalSpeechOptions {
  system?:LocalSystemSpeechHost;
  backendFactory?:()=>NeuralSpeechBackend;
  createAudioContext?:()=>AudioContext;
  now?:()=>number;
  supported?:boolean;
}

/** Bounded sentence chunks keep first audio responsive and avoid tokenizer truncation. */
export function splitSpeechText(text:string):string[] {
  const sentences=text.match(/[^.!?\n]+(?:[.!?]+|$)/g) || [text];
  const result:string[]=[];
  for(const sentence of sentences) {
    let rest=sentence.trim();
    while(rest.length>240) {
      let end=rest.lastIndexOf(' ',240);if(end<80)end=240;
      result.push(rest.slice(0,end).trim());rest=rest.slice(end).trim();
    }
    if(rest)result.push(rest);
  }
  return result;
}

/** RMS follows the PCM clock, including silence and gaps; it is not a viseme. */
export function speechAmplitude(pcm:Float32Array,sampleRate:number,positionSeconds:number):number {
  const at=Math.floor(positionSeconds*sampleRate);
  if(at<0 || at>=pcm.length)return 0;
  const radius=Math.round(sampleRate*.014);let energy=0;let count=0;
  for(let i=Math.max(0,at-radius);i<Math.min(pcm.length,at+radius);i++){energy+=pcm[i]*pcm[i];count++;}
  return Math.min(1,Math.max(0,(Math.sqrt(energy/Math.max(1,count))-.004)*9));
}

/** One runtime owns every handle, audio buffer, pending generation and download. */
export class LocalSpeechHost {
  private readonly system:LocalSystemSpeechHost;
  private readonly backendFactory:()=>NeuralSpeechBackend;
  private readonly createAudioContext:()=>AudioContext;
  private readonly now:()=>number;
  private readonly supported:boolean;
  private backend:NeuralSpeechBackend|null=null;
  private audio:AudioContext|null=null;
  private gain:GainNode|null=null;
  private active:Utterance|null=null;
  private outcomes=new Map<string,Outcome>();
  private disposed=false;
  private loaded=false;
  private loading=false;
  private generating=false;
  private epoch=0;
  private sequence=0;
  private progress:SpeechProgress={phase:'not-loaded',loadedBytes:0,totalBytes:0};
  private loadPromise:Promise<Record<string,unknown>>|null=null;

  constructor(options:LocalSpeechOptions={}) {
    this.system=options.system || new LocalSystemSpeechHost();
    this.backendFactory=options.backendFactory || (()=>new SpeechWorkerClient());
    this.createAudioContext=options.createAudioContext || (()=>new AudioContext());
    this.now=options.now || Date.now;
    this.supported=options.supported ?? (typeof Worker!=='undefined' && typeof AudioContext!=='undefined');
  }
  capabilities():Record<string,unknown> {
    return {...this.system.capabilities(),neural:{supported:this.supported && !this.disposed,loaded:this.loaded,loading:this.loading,
      provider:'kokoro',model:'onnx-community/Kokoro-82M-v1.0-ONNX',dtype:'q8',device:'wasm',modelBytes:92400000,
      engineBytes:1322380,engineLicense:'Apache-2.0 wrapper; GPL-3.0-or-later embedded eSpeak',voices:NEURAL_SPEECH_VOICES.map(voice=>({...voice})),...this.progress}};
  }
  async load():Promise<Record<string,unknown>> {
    if(this.disposed || !this.supported)return {loaded:false,reason:'neural-speech-unavailable'};
    if(this.loaded)return {loaded:true,provider:'kokoro'};
    if(this.loadPromise)return this.loadPromise;
    const ticket=++this.epoch;this.loading=true;this.progress={phase:'loading',loadedBytes:0,totalBytes:0};
    const backend=this.backendFactory();this.backend=backend;
    const pending=(async()=>{
      try {
        await backend.load(value=>{if(ticket===this.epoch)this.progress=value;});
        if(ticket!==this.epoch || this.disposed)return {loaded:false,reason:'speech-load-cancelled'};
        this.loaded=true;this.progress={...this.progress,phase:'ready'};
        return {loaded:true,provider:'kokoro'};
      } catch {
        if(ticket===this.epoch){this.loaded=false;this.backend=null;this.progress={phase:'load-failed',loadedBytes:0,totalBytes:0};backend.dispose();}
        return {loaded:false,reason:'speech-model-load-failed'};
      } finally {if(ticket===this.epoch){this.loading=false;this.loadPromise=null;}}
    })();
    this.loadPromise=pending;return pending;
  }
  release():Record<string,unknown> {
    this.epoch++;this.loading=false;this.loaded=false;this.loadPromise=null;this.generating=false;
    if(this.active)this.finish(this.active,'stopped','model-released');
    this.backend?.dispose();this.backend=null;this.progress={phase:'not-loaded',loadedBytes:0,totalBytes:0};
    return {released:true};
  }
  async handle(kind:string,args:string[]=[]):Promise<unknown> {
    if(!Array.isArray(args) || args.length>1 || args.some(value=>typeof value!=='string'))return {error:'invalid-speech-arguments'};
    switch(kind) {
      case 'audio.speechCapabilities':return this.capabilities();
      case 'audio.loadSpeechModel': {
        let value:unknown={provider:'kokoro'};
        try{if(args[0])value=JSON.parse(args[0]);}catch{return {loaded:false,reason:'invalid-speech-options'};}
        if(!value || typeof value!=='object' || (value as {provider?:unknown}).provider!=='kokoro')return {loaded:false,reason:'unsupported-speech-provider'};
        return this.load();
      }
      case 'audio.releaseSpeechModel':return this.release();
      case 'audio.speak': {
        if(!args[0] || args[0].length>20000)return {started:false,reason:'invalid-speech-payload'};
        let value:unknown;try{value=JSON.parse(args[0]);}catch{return {started:false,reason:'invalid-speech-json'};}
        return this.speak(value);
      }
      case 'audio.speechState':return this.state(args[0] || '');
      case 'audio.whenSpeechEnded':return this.whenEnded(args[0] || '');
      case 'audio.stopSpeech':return this.stop(args[0] || '');
      default:return {error:'unsupported-speech-call'};
    }
  }
  speak(value:unknown):Promise<Record<string,unknown>> {
    if(this.disposed)return Promise.resolve({started:false,reason:'runtime-closed'});
    if(!value || typeof value!=='object' || Array.isArray(value))return Promise.resolve({started:false,reason:'invalid-speech-options'});
    const options=value as Record<string,unknown>;const provider=options.provider === undefined ? 'system' : options.provider;
    if(provider==='system') {
      if(this.active)return Promise.resolve({started:false,reason:'speech-busy'});
      return this.system.speak(options);
    }
    if(provider!=='kokoro')return Promise.resolve({started:false,reason:'unsupported-speech-provider'});
    if(!this.loaded || !this.backend)return Promise.resolve({started:false,reason:'speech-model-not-loaded'});
    if(this.active || this.system.active || this.generating)return Promise.resolve({started:false,reason:'speech-busy'});
    if(typeof options.text!=='string' || options.text.length>2800)return Promise.resolve({started:false,reason:'invalid-speech-text'});
    const text=clean(options.text,2800);const chunks=splitSpeechText(text);
    if(!text || chunks.length>32)return Promise.resolve({started:false,reason:'invalid-speech-text'});
    const voice=typeof options.voiceURI==='string'?options.voiceURI:'af_heart';
    if(!NEURAL_SPEECH_VOICES.some(item=>item.voiceURI===voice))return Promise.resolve({started:false,reason:'no-matching-neural-voice'});
    try {
      if(!this.audio){this.audio=this.createAudioContext();this.gain=this.audio.createGain();this.gain.connect(this.audio.destination);}
      this.gain!.gain.value=clamp(options.volume,0,1,.72);
    } catch{return Promise.resolve({started:false,reason:'audio-context-unavailable'});}
    let resolveStart!:(value:Record<string,unknown>)=>void;let resolveEnd!:(value:Outcome)=>void;
    const startPromise=new Promise<Record<string,unknown>>(resolve=>{resolveStart=resolve;});
    const endPromise=new Promise<Outcome>(resolve=>{resolveEnd=resolve;});
    const record:Utterance={handle:`softn-neural-${++this.sequence}`,chunks:[],startedAt:null,createdAt:this.now(),settled:false,synthesisDone:false,started:false,
      endPromise,resolveStart,resolveEnd,startTimer:null,durationTimer:null,startCheck:null};
    this.active=record;
    record.startTimer=setTimeout(()=>this.finish(record,'error','speech-start-timeout'),70000);
    // Resume is initiated before inference while the initiating gesture is fresh.
    const resumed=this.audio!.resume();
    void this.synthesize(record,chunks,voice,clamp(options.rate,.75,1.3,1),resumed);
    return startPromise;
  }
  private async synthesize(record:Utterance,texts:string[],voice:string,rate:number,resumed:Promise<void>):Promise<void> {
    const backend=this.backend!;const ticket=this.epoch;
    try {
      // Do not leave an utterance pending behind a browser autoplay block.
      await Promise.race([resumed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('audio-start-blocked')),3000))]);
      if(!this.audio || this.audio.state!=='running')throw new Error('audio-start-blocked');
      for(const text of texts) {
        if(record.settled || ticket!==this.epoch)return;
        this.generating=true;
        let result:SpeechPCM;
        try{result=await backend.generate(text,voice,rate);}finally{if(ticket===this.epoch)this.generating=false;}
        if(record.settled || ticket!==this.epoch || !this.audio)return;
        if(result.sampleRate!==24000 || !(result.pcm instanceof Float32Array) || !result.pcm.length || result.pcm.length>24000*35 || result.pcm.some(sample=>!Number.isFinite(sample)))throw new Error('invalid-speech-pcm');
        const duration=result.pcm.length/result.sampleRate;
        const previous=record.chunks.at(-1);
        const start=Math.max(this.audio.currentTime+.025,previous?.end || 0);
        if(record.chunks.reduce((sum,chunk)=>sum+chunk.pcm.length/chunk.sampleRate,0)+duration>115)throw new Error('speech-duration-limit');
        const buffer=this.audio.createBuffer(1,result.pcm.length,result.sampleRate);buffer.copyToChannel(new Float32Array(result.pcm),0);
        const source=this.audio.createBufferSource();source.buffer=buffer;source.connect(this.gain!);
        const chunk={...result,source,start,end:start+duration};record.chunks.push(chunk);
        source.onended=()=>{source.disconnect();if(!record.settled && record.synthesisDone && record.chunks.every(item=>this.audio && item.end<=this.audio.currentTime+.015))this.finish(record,'ended');};
        source.start(start);
        if(!record.started && !record.startCheck)this.waitForStart(record,voice);
      }
      record.synthesisDone=true;
      if(!record.settled && record.chunks.every(chunk=>this.audio && chunk.end<=this.audio.currentTime))this.finish(record,'ended');
    } catch(error) {
      if(ticket===this.epoch && error instanceof Error && /worker|timeout|not-loaded/.test(error.message)) {
        this.loaded=false;this.backend?.dispose();this.backend=null;this.progress={phase:'generation-failed',loadedBytes:0,totalBytes:0};
      }
      const reason=error instanceof Error && error.message==='audio-start-blocked'?'audio-start-blocked':'speech-generation-failed';
      this.finish(record,'error',reason);
    }
  }
  private waitForStart(record:Utterance,voice:string):void {
    if(record.settled || !this.audio)return;
    const first=record.chunks[0];
    if(this.audio.state==='running' && this.audio.currentTime>=first.start) {
      record.started=true;record.startedAt=first.start;record.startCheck=null;
      if(record.startTimer)clearTimeout(record.startTimer);
      record.resolveStart({started:true,handle:record.handle,local:true,provider:'kokoro',voiceURI:voice});
      record.durationTimer=setTimeout(()=>this.finish(record,'error','speech-duration-limit'),120000);
    } else record.startCheck=setTimeout(()=>this.waitForStart(record,voice),15);
  }
  private finish(record:Utterance,status:string,reason?:string):void {
    if(record.settled)return;record.settled=true;
    if(record.startTimer)clearTimeout(record.startTimer);if(record.durationTimer)clearTimeout(record.durationTimer);if(record.startCheck)clearTimeout(record.startCheck);
    for(const chunk of record.chunks){chunk.source.onended=null;try{chunk.source.stop();chunk.source.disconnect();}catch{/* Already ended. */}}
    const durationMs=record.startedAt===null?0:Math.max(0,((this.audio?.currentTime || record.startedAt)-record.startedAt)*1000);
    const outcome:Outcome={handle:record.handle,status,provider:'kokoro',durationMs,...(reason?{reason}:{})};
    this.outcomes.set(record.handle,outcome);while(this.outcomes.size>32)this.outcomes.delete(this.outcomes.keys().next().value!);
    if(this.active===record)this.active=null;
    if(!record.started)record.resolveStart({started:false,handle:record.handle,reason:reason || status});
    record.resolveEnd(outcome);record.chunks=[];
  }
  state(handle:string):Record<string,unknown> {
    const record=this.active;
    if(record && record.handle===handle && this.audio) {
      const clock=this.audio.currentTime;const chunk=record.chunks.find(item=>clock>=item.start && clock<item.end);
      return {handle,provider:'kokoro',status:record.started?'playing':'pending',amplitude:chunk && this.audio.state==='running'?speechAmplitude(chunk.pcm,chunk.sampleRate,clock-chunk.start):0,
        positionMs:record.startedAt===null?0:Math.max(0,(clock-record.startedAt)*1000),durationMs:record.chunks.reduce((sum,item)=>sum+(item.end-item.start)*1000,0)};
    }
    const outcome=this.outcomes.get(handle);if(outcome)return {...outcome,amplitude:0,positionMs:outcome.durationMs};
    if(this.system.active?.handle===handle)return {handle,provider:'system',status:this.system.active.startedAt===null?'pending':'playing',amplitude:0,positionMs:this.system.active.startedAt===null?0:this.now()-this.system.active.startedAt,durationMs:0};
    const system=this.system.outcomes.get(handle);if(system)return {...system,provider:'system',amplitude:0,positionMs:system.durationMs};
    return {handle,status:'error',reason:'unknown-speech-handle',amplitude:0,positionMs:0,durationMs:0};
  }
  whenEnded(handle:string):Promise<unknown> {
    if(this.active?.handle===handle)return this.active.endPromise;
    if(this.outcomes.has(handle))return Promise.resolve(this.outcomes.get(handle));
    return this.system.whenEnded(handle);
  }
  stop(handle=''):Record<string,unknown> {
    if(this.active && (!handle || this.active.handle===handle)){const current=this.active;this.finish(current,'stopped','requested');return {stopped:true,handle:current.handle};}
    return this.system.stop(handle);
  }
  dispose():void {
    if(this.disposed)return;this.disposed=true;this.release();this.system.dispose();
    this.audio?.close().catch(()=>{});this.audio=null;this.gain=null;this.outcomes.clear();
  }
}
