// The local-model worker: src/runtime/models/model-worker.ts and ZIPP's model
// stack (vendor/zipp-models/) in one module at dist/runtime/model-worker.js,
// with the two WebAssembly modules it fetches, and their licences, beside it in
// dist/runtime/models/. The engine is core's own (dist/zipp_wasm_bg.wasm).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const vendor = path.resolve('vendor/zipp-models');
const runtime = path.resolve('dist/runtime');
const models = path.join(runtime, 'models');
fs.mkdirSync(models, { recursive: true });

// `?raw` is a file's text, as Vite reads it in the tests.
const raw = {
  name: 'raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
    b.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'text' }));
  },
};

await build({
  entryPoints: ['src/runtime/models/model-worker.ts'],
  outfile: path.join(runtime, 'model-worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  plugins: [raw],
  // gguf-module.mjs reaches for Node's module loader only when nobody hands it
  // the module, and this worker always does.
  external: ['node:*'],
  logLevel: 'warning',
});

for (const [from, to] of [
  ['gpu-lab/wasm/kernels.wasm', 'kernels.wasm'],
  ['model-plugins/wasm/gguf/gguf_wasm_bg.wasm', 'gguf_wasm_bg.wasm'],
  ['gpu-lab/LICENSE', 'ZIPP-gpu-lab-LICENSE.txt'],
  ['gpu-lab/NOTICE', 'ZIPP-gpu-lab-NOTICE.txt'],
  ['model-plugins/LICENSE', 'ZIPP-model-plugins-LICENSE.txt'],
  ['model-plugins/wasm/gguf/LICENSE-APACHE', 'gguf-wasm-LICENSE-APACHE.txt'],
  ['model-plugins/wasm/gguf/LICENSE-MIT', 'gguf-wasm-LICENSE-MIT.txt'],
]) fs.copyFileSync(path.join(vendor, from), path.join(models, to));
console.log('[models] Built the local-model worker with ZIPP\'s model stack');
