// Built as a self-contained optional worker. The build aliases Transformers to
// Kokoro's own pinned dependency, not the chat runtime's independently versioned API.
import { KokoroTTS } from 'kokoro-js';
import { env as inferenceEnv } from '@huggingface/transformers';
import { loadPhonemizer, PHONEMIZER_URL } from './speech-phonemizer';

const MODEL='onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICES=new Set(['af_heart','af_bella','af_sarah','bf_emma','am_michael','bm_george']);
const nativeFetch=globalThis.fetch.bind(globalThis);
const workerRoot=new URL('.',globalThis.location.href);
let downloadsAllowed=false;
let model: KokoroTTS | null=null;
let busy=false;

// Weight requests contain only fixed model filenames, never speech text. Voice
// data and WASM are shipped with the runtime and never require a remote voice API.
globalThis.fetch=async(input: RequestInfo | URL,init?: RequestInit): Promise<Response>=>{
  const raw=input instanceof Request?input.url:String(input);
  const url=new URL(raw,workerRoot);
  if(downloadsAllowed && url.href===PHONEMIZER_URL)return nativeFetch(url,{...init,credentials:'omit',redirect:'error'});
  if(url.origin==='https://huggingface.co' && url.pathname.startsWith('/'+MODEL+'/resolve/main/voices/')) {
    const name=url.pathname.split('/').pop() || '';
    if(!VOICES.has(name.replace(/\.bin$/,'')))throw new Error('speech-voice-not-allowed');
    return nativeFetch(new URL('speech/voices/'+name,workerRoot));
  }
  if(url.origin===workerRoot.origin && url.pathname.startsWith(new URL('speech/',workerRoot).pathname))return nativeFetch(url,init);
  if(!downloadsAllowed || url.origin!=='https://huggingface.co' || !url.pathname.startsWith('/'+MODEL+'/resolve/main/'))throw new Error('speech-network-destination-denied');
  return nativeFetch(url,{...init,credentials:'omit'});
};

// WASM and its companion JS use the same package version as this isolated worker.
inferenceEnv.allowLocalModels=false;
inferenceEnv.useBrowserCache=true;
inferenceEnv.backends.onnx.wasm!.wasmPaths=new URL('speech/ort/',workerRoot).href;
inferenceEnv.backends.onnx.wasm!.numThreads=1;
inferenceEnv.backends.onnx.wasm!.proxy=false;

globalThis.onmessage=async(event: MessageEvent)=>{
  const request=event.data;
  if(!request || typeof request!=='object' || !Number.isSafeInteger(request.id))return;
  const id=request.id;
  if(busy){globalThis.postMessage({id,error:'speech-worker-busy'});return;}
  busy=true;
  try {
    if(request.type==='load') {
      downloadsAllowed=true;
      await loadPhonemizer();
      if(!model)model=await KokoroTTS.from_pretrained(MODEL,{dtype:'q8',device:'wasm',progress_callback:(value: unknown)=>{
        const p=value as {status?:string;loaded?:number;total?:number};
        globalThis.postMessage({type:'progress',phase:p.status || 'loading',loadedBytes:p.loaded || 0,totalBytes:p.total || 0});
      }});
      downloadsAllowed=false;
      globalThis.postMessage({id,loaded:true});
    } else if(request.type==='generate') {
      if(!model)throw new Error('speech-model-not-loaded');
      if(typeof request.text!=='string' || !request.text.trim() || request.text.length>240 || !VOICES.has(request.voice))throw new Error('invalid-speech-chunk');
      const rate=Number(request.rate);
      if(!Number.isFinite(rate) || rate<.75 || rate>1.3)throw new Error('invalid-speech-rate');
      const audio=await model.generate(request.text,{voice:request.voice,speed:rate});
      const pcm=new Float32Array(audio.audio);
      if(pcm.length>24000*35 || pcm.some(value=>!Number.isFinite(value)))throw new Error('invalid-speech-output');
      globalThis.postMessage({id,pcm,sampleRate:audio.sampling_rate},{transfer:[pcm.buffer]});
    } else throw new Error('unsupported-speech-worker-call');
  } catch(error) {
    downloadsAllowed=false;
    const message=error instanceof Error?error.message:'';
    // Never forward stack traces, text input or arbitrary model exceptions.
    globalThis.postMessage({id,error:/^(speech-|invalid-speech-|unsupported-speech-)/.test(message)?message.slice(0,100):'speech-model-operation-failed'});
  } finally {busy=false;}
};
