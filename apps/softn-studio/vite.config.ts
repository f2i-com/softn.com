import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { softnPwa } from '../../scripts/build/pwa.mjs';
import { coreWorkerAssetPlugin } from '../../scripts/build/core-worker-assets.mjs';
import { retireServiceWorkersPlugin } from '../../scripts/dev/dev-service-worker.mjs';
import { scriptPolicyPlugin } from '../../scripts/build/script-policy.mjs';
import { buildSourcemaps } from '../../scripts/build/sourcemaps.mjs';
import { sharedRenderBuiltUrl } from '../../scripts/build/shared-assets.mjs';
import { vendorThreeGroup } from '../../scripts/build/on-demand-chunks.mjs';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  plugins: [
    retireServiceWorkersPlugin(),
    react(),
    coreWorkerAssetPlugin(),
    // What runs as script: this deployment's files only (scripts/build/script-policy.mjs).
    scriptPolicyPlugin(),
    softnPwa({
      disable: env.VITE_FORMLOGIC_EDITOR === '1',
      // A new build waits in `waiting` until PWAPrompt's Reload asks it to take
      // over, rather than yanking the canvas out from under a design in progress.
      registerType: 'prompt',
      // PWAPrompt registers the worker itself, through the plugin's hook, so the
      // plugin must not also inject a registration script.
      injectRegister: false,
      // The workbox globs below already sweep up everything in dist, icons
      // included, and listing them twice puts duplicate precache entries in
      // the service worker.
      includeManifestIcons: false,
      manifest: {
        name: 'SoftN Studio',
        short_name: 'Studio',
        description: 'Design and generate SoftN applications in the browser',
        display: 'standalone',
        orientation: 'any',
        // The ground the app actually paints (--studio-bg), and the same value
        // index.html declares. These used to say #09090b, left over from the
        // palette Studio had before it took softn.com's, so an installed Studio
        // flashed one near-black on the splash and then repainted in another.
        theme_color: '#101317',
        background_color: '#101317',
        // Relative, so the manifest stays correct when the app is served from
        // a subpath such as /studio/ rather than a domain root.
        start_url: '.',
        scope: '.',
        categories: ['developertools', 'productivity'],
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // `wasm` is not optional: the scripting engine is a .wasm, so without
        // it nothing the studio generates runs offline. It is also larger than
        // Workbox's 2 MiB default cap, which would silently skip the file.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        // A complete install: everything Studio ships, so an installed Studio
        // works offline with every feature. The preview still loads each one
        // (charts, editors, Scene3D with Three.js, the QR decoder, the workers'
        // files under core-runtime/) only when a page draws or asks for it, so
        // this is what installing downloads, not what a page loads.
        globIgnores: [],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  base: env.VITE_BASE || '/',
  server: {
    port: env.VITE_PORT ? Number(env.VITE_PORT) : 1423,
    strictPort: true,
  },
  // In the site build, the engine and the QR decoder by their one shared copy
  // (scripts/build/shared-assets.mjs); elsewhere, Vite's own URLs.
  experimental: { renderBuiltUrl: sharedRenderBuiltUrl },
  build: {
    target: 'es2022',
    // In a development build only (scripts/build/sourcemaps.mjs).
    sourcemap: buildSourcemaps(),
    // dist/.vite/manifest.json, which scripts/build/editor-offline.test.mjs reads.
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [vendorThreeGroup],
        },
      },
    },
  },
});
