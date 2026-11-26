import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { softnPwa } from '../../scripts/build/pwa.mjs';
import { starterVendorsPlugin } from '../../scripts/build/starter-vendors.mjs';
import { coreWorkerAssetPlugin } from '../../scripts/build/core-worker-assets.mjs';
import { containerRuntimeAssetPlugin, sharedContainerPrecache } from '../../scripts/build/container-runtime-assets.mjs';
import { retireServiceWorkersPlugin } from '../../scripts/dev/dev-service-worker.mjs';
import { exampleBundlesPlugin } from '../../scripts/dev/example-bundles.mjs';
import { scriptPolicyPlugin } from '../../scripts/build/script-policy.mjs';
import { buildSourcemaps } from '../../scripts/build/sourcemaps.mjs';
import { sharedRenderBuiltUrl, woff2OnlyFontsPlugin } from '../../scripts/build/shared-assets.mjs';
import { fullEngineGlob, fullEngineRuntimeCaching, sharedChunkGroups } from '../../scripts/build/on-demand-chunks.mjs';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  plugins: [
    starterVendorsPlugin(),
    retireServiceWorkersPlugin(),
    exampleBundlesPlugin(),
    woff2OnlyFontsPlugin(),
    react(),
    coreWorkerAssetPlugin(),
    containerRuntimeAssetPlugin(env.VITE_FORMLOGIC_EDITOR === '1'
      ? { env: { SOFTN_SHARED_CONTAINER_RUNTIME: '/hosted-runtime/assets/container-runtime/' } }
      : {}),
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
        // Install the editor tools and lite previews for offline use. A preview that needs
        // the full engine fetches it once, into the same runtime cache as SoftN Web.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        globIgnores: [fullEngineGlob],
        sourceCompilers: true,
        // Full-tier web previews import this helper even when the project has
        // never used a classic component. Its JS must be available offline.
        classicSharedRoots: ['../../packages/@softn/core/dist/web-host.js'],
        classicRoots: [
          '../../packages/@softn/runtime-shell/src/ClassicPreviewRenderer.tsx',
          '../../packages/@softn/components/dist/theme.js',
          '../../packages/@softn/components/dist/lazy.js',
        ],
        runtimeCaching: [fullEngineRuntimeCaching],
        // What a web-container preview runs on (@softn/container's Worker, the engines
        // core does not carry, the vendor modules): under assets/ in a build of Studio
        // alone, where the globs find it; in the site build in the one folder all four
        // apps share, which is installed from there.
        additionalManifestEntries: env.VITE_FORMLOGIC_EDITOR === '1' ? [] : sharedContainerPrecache(),
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  base: env.VITE_BASE || '/',
  server: {
    port: env.VITE_PORT ? Number(env.VITE_PORT) : 1423,
    strictPort: true,
  },
  // In the site build, what this builds by its address in the site's one folder of
  // built files (scripts/build/shared-assets.mjs); elsewhere, Vite's own URLs.
  experimental: { renderBuiltUrl: sharedRenderBuiltUrl },
  build: {
    target: 'es2022',
    // In a development build only (scripts/build/sourcemaps.mjs).
    sourcemap: buildSourcemaps(),
    // dist/.vite/manifest.json, which scripts/build/editor-offline.test.mjs reads.
    manifest: true,
    rolldownOptions: {
      output: {
        // Three.js, React and the sync and scanner libraries under names of their own,
        // so every app's build writes the same file for each (on-demand-chunks.mjs).
        codeSplitting: {
          groups: sharedChunkGroups,
        },
      },
    },
  },
});
