import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // PWAPrompt registers the worker itself, so the plugin must not also
      // inject a registration script. Turning it off additionally keeps
      // Workbox from adding an unconditional skipWaiting(), which is what
      // leaves a new worker parked in `waiting` long enough to offer a reload
      // instead of yanking the canvas out from under an in-progress design.
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
        // The ONNX runtime binaries studio pulls in are ~22 MB and ~25 MB and
        // back optional AI features. Precaching them would make first load pay
        // for capabilities most sessions never touch; they are fetched on
        // demand instead.
        globIgnores: ['**/ort-*.wasm'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  base: env.VITE_BASE || '/',
  server: {
    port: env.VITE_PORT ? Number(env.VITE_PORT) : 1423,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
