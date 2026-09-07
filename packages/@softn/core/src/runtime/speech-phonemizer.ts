/** Optional published engine: downloaded only by explicit speech-model load.
 * The hosting distribution contains this verifier, not the embedded eSpeak binary.
 * The upstream wrapper declares Apache-2.0; its embedded eSpeak component is GPL-3.0-or-later.
 */
export const PHONEMIZER_URL='https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist/phonemizer.js';
export const PHONEMIZER_SHA256='193481f474f7c1ea81df3195d18b45df8ef7254dbdccb3f193d60215c4897bec';
export const PHONEMIZER_BYTES=1322380;
interface Engine {phonemize(text:string,language?:string):Promise<string[]>}
let engine:Engine|null=null;

export async function verifyPhonemizerBytes(bytes:ArrayBuffer):Promise<void> {
  if(bytes.byteLength!==PHONEMIZER_BYTES)throw new Error('speech-engine-size-mismatch');
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const hash=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
  if(hash!==PHONEMIZER_SHA256)throw new Error('speech-engine-integrity-failed');
}
export async function loadPhonemizer():Promise<void> {
  if(engine)return;
  let cache:Cache|null=null;let bytes:ArrayBuffer|null=null;
  try{cache=await caches.open('softn-speech-engine-v1');const stored=await cache.match(PHONEMIZER_URL);if(stored)bytes=await stored.arrayBuffer();}catch{/* Cache can be unavailable in private browsing. */}
  if(bytes){try{await verifyPhonemizerBytes(bytes);}catch{bytes=null;await cache?.delete(PHONEMIZER_URL);}}
  if(!bytes) {
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),45000);
    try {
      const response=await fetch(PHONEMIZER_URL,{credentials:'omit',redirect:'error',signal:controller.signal});
      if(!response.ok)throw new Error('speech-engine-download-failed');
      const length=Number(response.headers.get('content-length'));
      if(length>PHONEMIZER_BYTES)throw new Error('speech-engine-size-mismatch');
      if(!response.body)throw new Error('speech-engine-download-failed');
      const reader=response.body.getReader();const chunks:Uint8Array[]=[];let total=0;
      for(;;){const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.byteLength;if(total>PHONEMIZER_BYTES){await reader.cancel();throw new Error('speech-engine-size-mismatch');}chunks.push(chunk.value);}
      const joined=new Uint8Array(total);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}
      bytes=joined.buffer;await verifyPhonemizerBytes(bytes);
      try{await cache?.put(PHONEMIZER_URL,new Response(bytes,{headers:{'Content-Type':'application/javascript'}}));}catch{/* In-memory use remains available. */}
    } finally {clearTimeout(timer);}
  }
  const url=URL.createObjectURL(new Blob([bytes],{type:'application/javascript'}));
  try{const loaded=await import(/* @vite-ignore */ url) as Engine;if(typeof loaded.phonemize!=='function')throw new Error('speech-engine-interface-missing');engine=loaded;}
  finally{URL.revokeObjectURL(url);}
}
export async function phonemize(text:string,language?:string):Promise<string[]> {
  if(!engine)throw new Error('speech-engine-not-loaded');
  return engine.phonemize(text,language);
}
