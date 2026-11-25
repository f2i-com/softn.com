import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { coreWorkerAssetPlugin } from '../../scripts/build/core-worker-assets.mjs';
import { containerRuntimeAssetPlugin } from '../../scripts/build/container-runtime-assets.mjs';
import { scriptPolicyPlugin } from '../../scripts/build/script-policy.mjs';
import { sharedRenderBuiltUrl, woff2OnlyFontsPlugin } from '../../scripts/build/shared-assets.mjs';
import { vendorThreeGroup } from '../../scripts/build/on-demand-chunks.mjs';
export default defineConfig({
  // Relative by default, so a standalone deployment works from any directory.
  // The site build sets VITE_BASE to where the shell lands under softn.com
  // (`/play/`), where the directory serves it for every app in the catalogue.
  base: process.env.VITE_BASE || './',
  // scriptPolicyPlugin: what runs as script is this deployment's files only (scripts/build/script-policy.mjs).
  plugins: [woff2OnlyFontsPlugin(), react(), coreWorkerAssetPlugin(), containerRuntimeAssetPlugin(), scriptPolicyPlugin()],
  resolve: { dedupe: ['react', 'react-dom'] },
  // In the site build, what this builds by its address in the site's one folder of
  // built files (scripts/build/shared-assets.mjs); elsewhere, Vite's own URLs.
  experimental: { renderBuiltUrl: sharedRenderBuiltUrl },
  build: {
    target: 'es2022',
    sourcemap: false,
    // dist/.vite/manifest.json: the entry's static import closure, which
    // test/build-graph.test.ts holds free of Three.js and the model loaders.
    manifest: true,
    rolldownOptions: {
      // The runtime's own page, and the module `softn.js` loads into a page
      // of the author's site (src/page.tsx), at a name softn.js can find
      // beside itself: its other files are named for their contents.
      // When built solely as the site's `/play/` shell (`SOFTN_PLAY_STANDALONE=1`),
      // omit the unused `page` entry so Rolldown does not split shared boot code
      // into 10+ tiny cross-entry modulepreload chunks.
      input: process.env.SOFTN_PLAY_STANDALONE === '1'
        ? { index: 'index.html' }
        : { index: 'index.html', page: 'src/page.tsx' },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'page' ? 'softn-page.js' : 'assets/[name]-[hash].js'),
        codeSplitting: {
          groups: [
            vendorThreeGroup,
            {
              name: 'vendor-react',
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 1454, strictPort: true },
});
