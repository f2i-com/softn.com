import { defineConfig } from 'tsup';
import { cpSync, existsSync, rmSync, statSync } from 'fs';
import { execFileSync } from 'node:child_process';
import { copyWorkerFiles } from './scripts/worker-files.mjs';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/parser/index.ts',
    'src/renderer/index.ts',
    'src/runtime/index.ts',
    'src/runtime/script-worker.ts',
    'src/runtime/sandbox-worker.ts',
    'src/loader/index.ts',
    // The archive reader on its own, for a host's inflate worker. Importing it
    // from the root barrel pulls the whole of core into the worker — measured
    // at 1.35 MB for softn-web, yjs and the engine glue included, because a
    // bundler cannot tree-shake past this build's side-effectful chunks —
    // where the reader and fflate are a few kilobytes.
    'src/bundle/zip.ts',
    // The host-JavaScript engine on its own, reachable only as
    // @softn/core/host-js: no other entry imports it, so a build that does not
    // ask for it does not contain it.
    'src/runtime/host-js/index.ts',
  ],
  format: ['esm'],
  // The bundle contract (../bundle-format/src) is inlined through relative
  // shims; the declaration build must be allowed to see one directory up.
  dts: { compilerOptions: { rootDir: '..' } },
  clean: true,
  sourcemap: true,
  external: ['react', 'react-dom'],
  treeshake: true,
  // The engine's size, for the progress a host shows while it downloads
  // (zipp-wasm-loader.ts): a server that compresses it says only the
  // compressed length.
  // From this file's folder, not the working directory: a tool that loads
  // the config from the repository's root (knip) must find it too.
  define: { __SOFTN_ENGINE_BYTES__: String(statSync(new URL('./wasm-zipp/zipp_wasm_bg.wasm', import.meta.url)).size) },
  onSuccess: async () => {
    // Copy the engine's WASM to dist/ — tsup inlines the glue JS into a chunk,
    // and the glue uses `new URL('<name>_bg.wasm', import.meta.url)`, so the
    // .wasm file must sit next to the chunk.
    cpSync('wasm-zipp/zipp_wasm_bg.wasm', 'dist/zipp_wasm_bg.wasm');
    if (existsSync('wasm-zipp/THIRD_PARTY_LICENSES.txt')) cpSync('wasm-zipp/THIRD_PARTY_LICENSES.txt', 'dist/zipp-licenses.txt');
    // The torch package, which the runtime adds only for an app that declares
    // torch. Its loader (zipp_torch.js) is bundled into a chunk of its own by
    // the dynamic import in zipp-wasm-loader.ts; the .wasm is fetched from
    // `./core-runtime/zipp_torch.wasm` beside that chunk, which the mirror
    // below puts at dist/core-runtime/zipp_torch.wasm and every app's
    // coreWorkerAssetPlugin copies to assets/core-runtime/ — outside every
    // PWA's precache, since most apps never import torch.
    cpSync('wasm-zipp-torch/zipp_torch.wasm', 'dist/zipp_torch.wasm');
    console.log('[tsup] Copied the zipp engine and its torch package to dist/');
    // The local-model worker (softn.ai.model.*): ZIPP's model stack from
    // vendor/zipp-models/, at dist/runtime/model-worker.js with its two
    // modules in dist/runtime/models/, mirrored below like the script worker.
    execFileSync(process.execPath,['scripts/build-model-worker.mjs'],{stdio:'inherit'});
    // dist/core-runtime/: what the Workers reach, so the worker URLs a chunk
    // names (./core-runtime/runtime/script-worker.js) resolve on disk for a
    // consumer that loads dist/ directly, and the dev servers. Only what they
    // reach (scripts/worker-files.mjs): not the engine, which the page posts
    // them, not the host-JavaScript engine, no worker's, not core's own entry
    // chunks, declarations or source maps.
    rmSync('dist/core-runtime', { recursive: true, force: true });
    const mirrored = copyWorkerFiles('dist', 'dist/core-runtime');
    console.log(`[tsup] Mirrored the workers' ${mirrored.length} files to dist/core-runtime/`);
  },
});
