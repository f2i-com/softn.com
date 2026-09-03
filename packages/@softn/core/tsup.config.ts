import { defineConfig } from 'tsup';
import { cpSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import path from 'path';

function copyDirRecursive(src: string, dest: string) {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'core-runtime') continue;
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
    cpSync('wasm-zipp/zipp_wasm_bg.wasm', 'dist/zipp_wasm_bg.wasm');
    console.log('[tsup] Copied the zipp engine to dist/');
    // Mirror dist/ into dist/core-runtime/ so static worker URL resolution (./core-runtime/runtime/script-worker.js) succeeds on disk
    copyDirRecursive('dist', 'dist/core-runtime');
    console.log('[tsup] Mirrored dist/ to dist/core-runtime/ for worker resolution');
  },
});
