import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const kokoroRoot=path.resolve(path.dirname(require.resolve('kokoro-js')),'..');
const kokoroRequire=createRequire(path.join(kokoroRoot,'package.json'));
const tfRoot=path.resolve(path.dirname(kokoroRequire.resolve('@huggingface/transformers')),'..');
const tfRequire=createRequire(path.join(tfRoot,'package.json'));
const ortRoot=path.resolve(path.dirname(tfRequire.resolve('onnxruntime-web')));
const runtime=path.resolve('dist/runtime');
fs.mkdirSync(runtime,{recursive:true});
await build({entryPoints:['src/runtime/neural-speech-worker.ts'],outfile:path.join(runtime,'neural-speech-worker.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,
  alias:{'@huggingface/transformers':path.join(tfRoot,'dist/transformers.web.js'),'phonemizer':path.resolve('src/runtime/speech-phonemizer.ts')},
  define:{'process.env.NODE_ENV':'"production"'},logLevel:'warning'});
// Refuse to accidentally redistribute the upstream embedded engine blob.
const workerCode=fs.readFileSync(path.join(runtime,'neural-speech-worker.js'),'utf8');
if(workerCode.includes('expectedDataFileDownloads') || workerCode.includes('espeakng.worker.data') || workerCode.includes('AGFzbQEAAAAB'))throw Error('Embedded phonemizer binary must not be bundled');
const voiceOut=path.join(runtime,'speech/voices');const ortOut=path.join(runtime,'speech/ort');
fs.mkdirSync(voiceOut,{recursive:true});fs.mkdirSync(ortOut,{recursive:true});
for(const name of ['af_heart','af_bella','af_sarah','bf_emma','am_michael','bm_george'])fs.copyFileSync(path.join(kokoroRoot,'voices',name+'.bin'),path.join(voiceOut,name+'.bin'));
for(const name of ['ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm','ort-wasm-simd-threaded.jsep.mjs','ort-wasm-simd-threaded.jsep.wasm'])fs.copyFileSync(path.join(ortRoot,name),path.join(ortOut,name));
fs.copyFileSync(path.join(kokoroRoot,'LICENSE'),path.join(runtime,'speech/Kokoro-LICENSE.txt'));
for(const name of fs.readdirSync('speech-notices'))fs.copyFileSync(path.join('speech-notices',name),path.join(runtime,'speech',name));
console.log('[speech] Built optional local speech worker, WASM and six preset voices');
