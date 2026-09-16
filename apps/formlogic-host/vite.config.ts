import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { coreWorkerAssetPlugin } from '../../scripts/core-worker-assets.mjs';
const entry = (name: string) => fileURLToPath(new URL(`./${name}.html`, import.meta.url));
export default defineConfig({
  base: './', plugins: [react(), coreWorkerAssetPlugin()],
  resolve: { dedupe: ['react', 'react-dom'] },
  // Two documents, one shell. `host.html` is `index.html` with one attribute,
  // and the attribute is why it is a separate file: it serves the `host-js`
  // engine, whose Content-Security-Policy has to be weaker, and a meta policy
  // cannot be relaxed once written. See src/framePolicy.ts.
  build: { sourcemap: false, rollupOptions: { input: { index: entry('index'), host: entry('host') } } },
});
