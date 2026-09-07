import {describe,it,expect,vi,afterEach} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {verifyPhonemizerBytes} from '../src/runtime/speech-phonemizer';
import {SpeechWorkerClient} from '../src/runtime/speech-worker-client';
const require=createRequire(import.meta.url);

it('accepts only the exact pinned optional speech engine bytes',async()=>{
 const source=fs.readFileSync(path.join(path.dirname(require.resolve('phonemizer')),'phonemizer.js'));
 const bytes=new Uint8Array(source).buffer;await expect(verifyPhonemizerBytes(bytes)).resolves.toBeUndefined();
 const changed=new Uint8Array(bytes.slice(0));changed[changed.length-1]^=1;await expect(verifyPhonemizerBytes(changed.buffer)).rejects.toThrow('integrity');
 await expect(verifyPhonemizerBytes(new ArrayBuffer(100))).rejects.toThrow('size');
});
it('the compiled worker excludes the optional engine executable and names its pinned verifier',()=>{
 const filename=path.resolve(import.meta.dirname,'../dist/runtime/neural-speech-worker.js');
 const code=fs.readFileSync(filename,'utf8');expect(code).not.toContain('expectedDataFileDownloads');expect(code).not.toContain('espeakng.worker.data');expect(code).toContain('193481f474f7c1ea81df3195d18b45df8ef7254dbdccb3f193d60215c4897bec');
});

describe('speech worker request lifecycle',()=>{
 afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
 function setup(){
  class FakeWorker {
    static instance:FakeWorker;
    onmessage:((event:{data:unknown})=>void)|null=null;onerror:(()=>void)|null=null;onmessageerror:(()=>void)|null=null;sent:Array<{id:number,type:string}>=[];terminated=false;
    constructor(){FakeWorker.instance=this;}postMessage(value:{id:number,type:string}){this.sent.push(value);}terminate(){this.terminated=true;}
  }
  vi.stubGlobal('Worker',FakeWorker);const client=new SpeechWorkerClient();return {client,getWorker:()=>FakeWorker.instance};
 }
 it('bounds progress and terminates owned pending work on dispose',async()=>{
  const {client,getWorker}=setup();const progress=vi.fn();const load=client.load(progress);const worker=getWorker();
  worker.onmessage?.({data:{type:'progress',phase:'x'.repeat(100),loadedBytes:Infinity,totalBytes:-5}});
  expect(progress).toHaveBeenCalledWith({phase:'x'.repeat(40),loadedBytes:0,totalBytes:0});
  const failed=expect(load).rejects.toThrow('closed');client.dispose();await failed;expect(worker.terminated).toBe(true);
 });
 it('settles generation timeout and rejects late responses',async()=>{
  vi.useFakeTimers();const {client,getWorker}=setup();const load=client.load(()=>{});const worker=getWorker();worker.onmessage?.({data:{id:worker.sent[0].id,loaded:true}});await load;
  const generate=client.generate('Hello','af_heart',1);const failed=expect(generate).rejects.toThrow('timeout');await vi.advanceTimersByTimeAsync(60001);await failed;expect(worker.terminated).toBe(true);
  worker.onmessage?.({data:{id:2,pcm:new Float32Array(100),sampleRate:24000}});client.dispose();
 });
});
