import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { coreWorkerAssetPlugin } from '../../scripts/build/core-worker-assets.mjs';
import { scriptPolicyPlugin } from '../../scripts/build/script-policy.mjs';
export default defineConfig({
  // Relative by default, so a standalone deployment works from any directory.
  // The site build sets VITE_BASE to where the shell lands under softn.com
  // (`/play/`), where the directory serves it for every app in the catalogue.
  base: process.env.VITE_BASE || './',
  // scriptPolicyPlugin: what runs as script is this deployment's files only (scripts/build/script-policy.mjs).
  plugins: [react(), coreWorkerAssetPlugin(), scriptPolicyPlugin()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    sourcemap: false,
    // dist/.vite/manifest.json: the entry's static import closure, which
    // test/build-graph.test.ts holds free of Three.js and the model loaders.
    manifest: true,
    rolldownOptions: {
      // The runtime's own page, and the module `softn.js` loads into a page
      // of the author's site (src/page.tsx), at a name softn.js can find
      // beside itself: its other files are named for their contents.
      input: { index: 'index.html', page: 'src/page.tsx' },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'page' ? 'softn-page.js' : 'assets/[name]-[hash].js'),
        codeSplitting: {
          groups: [
            // Three.js itself — `three/build/` — under one name. It is reached
            // only through the scene3d feature's dynamic import, so this names
            // a chunk that is already asynchronous; it is not what makes it so
            // — registerRuntimeComponents() in main.tsx does that at the
            // source. The addons under `three/examples/jsm/` are deliberately
            // not in the group: Scene3D reaches each loader, the controls, the
            // environment and the post-processing set through its own
            // import(), so each is a chunk of its own, fetched the first time
            // a scene needs it. A test over `node_modules/three/` swept them
            // all into this chunk — measured at 740 KB against 712 KB for
            // Three.js alone — so a scene with one model and no effects
            // downloaded the bloom pass and three loaders it never used.
            { name: 'vendor-three', test: /node_modules[\\/]three[\\/]build[\\/]/ },
          ],
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 1454, strictPort: true },
});
