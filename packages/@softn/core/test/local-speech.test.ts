import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {LocalSpeechHost,splitSpeechText,speechAmplitude} from '../src/runtime/local-speech';
import {LocalSystemSpeechHost} from '../src/runtime/local-system-speech.mjs';
import {SoftNScriptRuntime} from '../src/runtime/script-runtime';
import type {NeuralSpeechBackend,SpeechPCM} from '../src/runtime/speech-worker-client';

class TestAudio {
  state='running';destination={};sources:Array<{stop:()=>void}>=[];
  get currentTime(){return Date.now()/1000;}
  resume(){return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
  createGain(){return {gain:{value:1},connect(){}};}
  createBuffer(_channels:number,length:number,rate:number){return {duration:length/rate,copyToChannel(){}};}
  createBufferSource(){
    let timer:ReturnType<typeof setTimeout>|undefined;
    const source={buffer:null as {duration:number}|null,onended:null as (()=>void)|null,connect(){},disconnect(){},
      start:(when:number)=>{timer=setTimeout(()=>source.onended?.(),(when+source.buffer!.duration-this.currentTime)*1000);},
      stop:()=>{if(timer)clearTimeout(timer);}};
    this.sources.push(source);return source;
  }
}
function setup(generate?:NeuralSpeechBackend['generate']) {
  const audio=new TestAudio();
  const backend={load:vi.fn(async()=>{}),generate:vi.fn(generate || (async()=>({pcm:new Float32Array(24000).fill(.08),sampleRate:24000}))),dispose:vi.fn()};
  const system=new LocalSystemSpeechHost({synthesis:undefined,Utterance:undefined});
  const host=new LocalSpeechHost({backendFactory:()=>backend,createAudioContext:()=>audio as unknown as AudioContext,supported:true,system});
  return {host,audio,backend};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(1000);});
afterEach(()=>{vi.useRealTimers();});

describe('local neural speech lifecycle',()=>{
 it('requires explicit model load and never falls back to another provider',async()=>{
  const {host,backend}=setup();expect(backend.load).not.toHaveBeenCalled();
  expect(await host.speak({provider:'kokoro',text:'Hello'})).toMatchObject({started:false,reason:'speech-model-not-loaded'});
  await host.load();expect(backend.load).toHaveBeenCalledOnce();
  expect(await host.speak({provider:'network',text:'Hello'})).toMatchObject({started:false,reason:'unsupported-speech-provider'});
  expect(await host.speak({provider:'kokoro',text:'Hello',voiceURI:'arbitrary-url'})).toMatchObject({started:false,reason:'no-matching-neural-voice'});
  expect(await host.speak({provider:'kokoro',text:'x'.repeat(2801)})).toMatchObject({started:false});host.dispose();
 });
 it('resolves start on the playback clock and reports PCM amplitude until completion',async()=>{
  const {host}=setup();await host.load();let started=false;
  const start=host.speak({provider:'kokoro',text:'Hello there.',voiceURI:'af_heart'}).then(result=>{started=true;return result;});
  await vi.advanceTimersByTimeAsync(10);expect(started).toBe(false);
  await vi.advanceTimersByTimeAsync(40);const result=await start;expect(result.started).toBe(true);
  const state=host.state(String(result.handle));expect(state.status).toBe('playing');expect(Number(state.amplitude)).toBeGreaterThan(.5);
  const ended=host.whenEnded(String(result.handle));await vi.advanceTimersByTimeAsync(1100);expect(await ended).toMatchObject({status:'ended'});expect(host.state(String(result.handle)).amplitude).toBe(0);host.dispose();
 });
 it('stop during generation settles pending start and ignores late PCM',async()=>{
  let resolve!:(value:SpeechPCM)=>void;const {host,audio}=setup(()=>new Promise(done=>{resolve=done;}));await host.load();
  const start=host.speak({provider:'kokoro',text:'Hello.'});await vi.advanceTimersByTimeAsync(1);
  expect(host.stop().stopped).toBe(true);expect(await start).toMatchObject({started:false,reason:'requested'});
  resolve({pcm:new Float32Array(24000),sampleRate:24000});await vi.advanceTimersByTimeAsync(10);expect(audio.sources).toHaveLength(0);host.dispose();
 });
 it('release cancels loading and cannot be resurrected by a late load result',async()=>{
  let finish!:()=>void;const {host,backend}=setup();backend.load.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const load=host.load();expect((host.capabilities().neural as {loading:boolean}).loading).toBe(true);host.release();finish();
  expect(await load).toMatchObject({loaded:false});expect((host.capabilities().neural as {loaded:boolean}).loaded).toBe(false);expect(backend.dispose).toHaveBeenCalledOnce();host.dispose();
 });
 it('stops owned playback, releases resources on close and rejects unknown handles',async()=>{
  const {host,backend,audio}=setup();await host.load();const start=host.speak({provider:'kokoro',text:'Hello.'});await vi.advanceTimersByTimeAsync(40);const result=await start;
  expect(host.stop('someone-else').stopped).toBe(false);const end=host.whenEnded(String(result.handle));host.dispose();
  expect(await end).toMatchObject({status:'stopped',reason:'model-released'});expect(audio.state).toBe('closed');expect(backend.dispose).toHaveBeenCalledOnce();expect(host.state(String(result.handle)).amplitude).toBe(0);
 });
 it('invalid PCM produces a recoverable failure without starting playback',async()=>{
  const {host,audio}=setup(async()=>({pcm:new Float32Array([NaN]),sampleRate:24000}));await host.load();const start=host.speak({provider:'kokoro',text:'Hi'});await vi.advanceTimersByTimeAsync(1);expect(await start).toMatchObject({started:false,reason:'speech-generation-failed'});expect(audio.sources).toHaveLength(0);host.dispose();
 });
 it('fatal worker failures invalidate loaded state for an explicit reload',async()=>{
  const {host,backend}=setup(async()=>{throw new Error('speech-worker-failed');});await host.load();const start=host.speak({provider:'kokoro',text:'Hi'});await vi.advanceTimersByTimeAsync(1);expect(await start).toMatchObject({started:false});expect((host.capabilities().neural as {loaded:boolean}).loaded).toBe(false);expect(backend.dispose).toHaveBeenCalledOnce();host.dispose();
 });
});

it('keeps every word in bounded speech chunks and produces silence outside PCM',()=>{
 const text=('A useful sentence with several words. ').repeat(45).trim();const chunks=splitSpeechText(text);expect(chunks.every(chunk=>chunk.length<=240)).toBe(true);expect(chunks.join(' ')).toBe(text);
 const long='a'.repeat(500);expect(splitSpeechText(long).join('')).toBe(long);expect(speechAmplitude(new Float32Array(1000),24000,.01)).toBe(0);expect(speechAmplitude(new Float32Array(1000).fill(.1),24000,-1)).toBe(0);
});

it('system speech lists only local voices and does not cancel another owner',async()=>{
 const synthesis={getVoices:()=>[{voiceURI:'local',name:'Local',lang:'en',localService:true},{voiceURI:'remote',localService:false}],speaking:false,pending:false,speak:vi.fn(),cancel:vi.fn()};
 class Utterance {constructor(public text:string){}}
 const first=new LocalSystemSpeechHost({synthesis,Utterance});const second=new LocalSystemSpeechHost({synthesis,Utterance});
 expect(first.capabilities().voices).toHaveLength(1);const start=first.speak({text:'Hi'});expect(await second.speak({text:'No overlap'})).toMatchObject({started:false,reason:'speech-busy'});
 expect(second.stop('')).toMatchObject({stopped:false});expect(synthesis.cancel).not.toHaveBeenCalled();first.stop('');expect(await start).toMatchObject({started:false});expect(synthesis.cancel).toHaveBeenCalledOnce();first.dispose();second.dispose();
});

describe('speech model permission boundary',()=>{
 const call={kind:'audio.loadSpeechModel',id:1,args:['{"provider":"kokoro"}']};
 function runtime(config:unknown){const value=Object.create(SoftNScriptRuntime.prototype);value.permissionConfig=config;value.localSpeech={handle:vi.fn(async()=>({loaded:true}))};return value;}
 it('denies missing/withheld AI before any model work',async()=>{
  for(const config of [null,{permissions:{}},{permissions:{ai:{enabled:true}},consentPending:true}]){const r=runtime(config);await expect(r.executeHostCall(call)).rejects.toThrow();expect(r.localSpeech.handle).not.toHaveBeenCalled();}
 });
 it('enforces source and byte budget before model work',async()=>{
  for(const ai of [{enabled:true,allowedSources:['bundle']},{enabled:true,maxModelSizeMB:50}]){const r=runtime({permissions:{ai}});expect(await r.executeHostCall(call)).toMatchObject({loaded:false});expect(r.localSpeech.handle).not.toHaveBeenCalled();}
  const r=runtime({permissions:{ai:{enabled:true,allowedSources:['huggingface'],maxModelSizeMB:128}}});expect(await r.executeHostCall(call)).toMatchObject({loaded:true});expect(r.localSpeech.handle).toHaveBeenCalledOnce();
 });
});
