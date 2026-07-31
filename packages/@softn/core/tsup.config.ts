import { defineConfig } from 'tsup';
import { cpSync } from 'fs';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/parser/index.ts',
    'src/renderer/index.ts',
    'src/runtime/index.ts',
    'src/runtime/script-worker.ts',
    'src/loader/index.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['react', 'react-dom'],
  treeshake: true,
  onSuccess: async () => {
    // Copy the engine's WASM to dist/ — tsup inlines the glue JS into a chunk,
    // and the glue uses `new URL('<name>_bg.wasm', import.meta.url)`, so the
    // .wasm file must sit next to the chunk.
    //
    // Only zipp's. formlogic_wasm_bg.wasm was copied here too, 2.2 MB of an
    // engine nothing loads: vm-adapter.ts re-exports ZippWasmAdapter, and the
    // FormLogic adapter is reachable only by editing the two lines its own
    // comment describes. Rollup tree-shakes it out — no built chunk contains the
    // string "formlogic" — so the binary travelled in every npm tarball and into
    // every app that vendors core/dist, next to chunks that never ask for it.
    // Restore this line in the same commit that flips vm-adapter.ts back.
    cpSync('wasm-zipp/zipp_wasm_bg.wasm', 'dist/zipp_wasm_bg.wasm');
    console.log('[tsup] Copied the zipp engine to dist/');
  },
});
