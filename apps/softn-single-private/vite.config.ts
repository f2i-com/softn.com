import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { coreWorkerAssetPlugin } from '../../scripts/core-worker-assets.mjs';
// The same build as apps/softn-single, emitted into dist/webroot: the PHP
// host serves that folder and keeps everything else in dist/private.
export default defineConfig({
  base: './',
  plugins: [react(), coreWorkerAssetPlugin()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    outDir: 'dist/webroot',
    sourcemap: false,
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'vendor-three', test: /node_modules[\/]three[\/]build[\/]/ }],
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 1456, strictPort: true },
});
