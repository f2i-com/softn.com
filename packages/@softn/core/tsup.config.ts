import { defineConfig } from 'tsup';
import { cpSync } from 'fs';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/parser/index.ts',
    'src/renderer/index.ts',
    'src/runtime/index.ts',
    'src/runtime/formlogic-worker.ts',
    'src/loader/index.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['react', 'react-dom'],
  treeshake: true,
  onSuccess: async () => {
    // Copy WASM binaries to dist/ — tsup inlines the WASM glue JS into a chunk,
    // and the glue uses `new URL('<name>_bg.wasm', import.meta.url)`, so the
    // .wasm file must be next to the chunk in dist/.
    cpSync('wasm-zipp/zipp_wasm_bg.wasm', 'dist/zipp_wasm_bg.wasm');
    cpSync('wasm/formlogic_wasm_bg.wasm', 'dist/formlogic_wasm_bg.wasm');
    console.log('[tsup] Copied WASM binaries to dist/');
  },
});
