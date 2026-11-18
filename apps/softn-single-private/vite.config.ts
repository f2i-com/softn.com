import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { coreWorkerAssetPlugin } from '../../scripts/build/core-worker-assets.mjs';
import { containerRuntimeAssetPlugin } from '../../scripts/build/container-runtime-assets.mjs';
import { woff2OnlyFontsPlugin } from '../../scripts/build/shared-assets.mjs';
import { vendorThreeGroup } from '../../scripts/build/on-demand-chunks.mjs';
// The same build as apps/softn-single, emitted into dist/webroot: the PHP
// host serves that folder and keeps everything else in dist/private.
export default defineConfig({
  base: './',
  plugins: [woff2OnlyFontsPlugin(), react(), coreWorkerAssetPlugin(), containerRuntimeAssetPlugin()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    target: 'es2022',
    outDir: 'dist/webroot',
    sourcemap: false,
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [vendorThreeGroup],
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 1456, strictPort: true },
});
