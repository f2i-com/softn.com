import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { coreWorkerAssetPlugin } from '../../scripts/core-worker-assets.mjs';
export default defineConfig({
  base: './',
  plugins: [react(), coreWorkerAssetPlugin()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { sourcemap: false },
  server: { host: '127.0.0.1', port: 1454, strictPort: true },
});
