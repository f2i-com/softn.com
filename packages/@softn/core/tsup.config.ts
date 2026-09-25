import { defineConfig } from 'tsup';
import { cpSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';

function copyDirRecursive(src: string, dest: string) {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'core-runtime') continue;
    // The mirror exists for the script and speech Workers. The host-JavaScript
    // engine is main-thread-only and no worker can reach it, and a copy here
    // would end up in every app's assets/core-runtime/ — in the editors, which
    // stay on ZIPP, and in the ZIPP entry document, which must not contain it.
    if (entry.name === 'host-js') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath);
    }
  }
}

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
    execFileSync(process.execPath,['scripts/build-speech-worker.mjs'],{stdio:'inherit'});
    // Mirror dist/ into dist/core-runtime/ so static worker URL resolution (./core-runtime/runtime/script-worker.js) succeeds on disk
    copyDirRecursive('dist', 'dist/core-runtime');
    console.log('[tsup] Mirrored dist/ to dist/core-runtime/ for worker resolution');
  },
});
