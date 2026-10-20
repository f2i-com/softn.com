import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { softnPwa } from '../../scripts/pwa.mjs';
import { coreWorkerAssetPlugin } from '../../scripts/core-worker-assets.mjs';
import { retireServiceWorkersPlugin } from '../../scripts/dev-service-worker.mjs';
import { scriptPolicyPlugin } from '../../scripts/script-policy.mjs';
import { onDemandGlobIgnores, onDemandRuntimeCaching, vendorThreeGroup } from '../../scripts/on-demand-chunks.mjs';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

// The browser is the primary target, so assets are served from an absolute
// base; set VITE_BASE to deploy under a sub-path such as /builder/. Tauri is
// the exception: its webview loads the bundle off disk, where only relative
// paths resolve.
const isTauri = !!env.TAURI_ENV_PLATFORM;
const base = isTauri ? './' : env.VITE_BASE || '/';

export default defineConfig({
  plugins: [
    retireServiceWorkersPlugin(),
    react(),
    coreWorkerAssetPlugin(),
    // What runs as script: this deployment's files only (scripts/script-policy.mjs). Not in
    // the desktop build, whose webview has a policy of its own, nor in FormLogic's, which is
    // drawn inside FormLogic's own document.
    ...(isTauri || env.VITE_FORMLOGIC_EDITOR === '1' ? [] : [scriptPolicyPlugin()]),
    softnPwa({
      // A service worker buys nothing inside the Tauri webview — the assets are
      // already local — and it can keep serving a previous build after the app
      // updates, so the PWA exists only for the web build. Disabling the plugin
      // rather than dropping it keeps `virtual:softn-pwa/react` resolvable,
      // which the Tauri build still has to compile.
      disable: isTauri || env.VITE_FORMLOGIC_EDITOR === '1',
      // 'prompt' is what makes PwaUpdater's toast reachable: a new worker waits
      // until the toast's Reload asks it to take over, rather than taking the
      // page at once and throwing away the canvas mid-edit.
      registerType: 'prompt',
      // PwaUpdater registers the worker through `virtual:softn-pwa/react`, so
      // the build writes no registration script of its own.
      injectRegister: false,
      // The workbox globs below already sweep up everything in dist, icons
      // included, and listing them twice puts duplicate precache entries in
      // the service worker.
      includeManifestIcons: false,
      manifest: {
        name: 'SoftN Builder',
        short_name: 'Builder',
        description: 'Visual editor for SoftN applications',
        display: 'standalone',
        theme_color: '#0c0a09',
        background_color: '#0c0a09',
        // Relative so the installed app follows whatever sub-path VITE_BASE
        // deployed it under.
        start_url: '.',
        scope: '.',
        categories: ['developertools'],
        // No `file_handlers` claim on .softn to mirror the desktop shell's file
        // association: nothing in the app reads window.launchQueue, so an OS
        // that honoured the claim would just open an empty editor.
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // `wasm` matters here: @softn/core runs bundles through a wasm engine,
        // so leaving it out would break preview offline.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        // core-runtime/ holds the workers' files (the script and local-model
        // workers), fetched by the apps that start one rather than by every
        // install. The canvas and preview register components as the runtimes
        // do, so a feature (charts, editors, Scene3D with Three.js, the QR
        // decoder) and core's optional modules are fetched the first time a
        // page draws or asks for one, and kept by the runtime routes below for
        // offline use after (scripts/on-demand-chunks.mjs).
        globIgnores: ['**/core-runtime/**', ...onDemandGlobIgnores],
        runtimeCaching: onDemandRuntimeCaching,
        // Everything left after that ignore fits inside 8 MiB — the largest
        // is the ZIPP engine at ~6.1 MiB (javascript-python-base: torch is a package
        // under core-runtime/, fetched only for apps that declare it). Raise this rather than let
        // Workbox skip a file, because a skipped precache entry fails only
        // offline.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  clearScreen: false,
  base,
  server: {
    port: env.VITE_PORT ? Number(env.VITE_PORT) : 1422,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    outDir: isTauri ? 'dist-desktop' : 'dist',
    // Tauri ships a known webview with each platform, so that build compiles
    // straight for the engine it will run on. The web build names no target and
    // takes Vite's default baseline instead: raising it drops Safari 15.0-15.3,
    // the iOS the apple-mobile-web-app-* meta tags in index.html exist for.
    ...(isTauri && {
      target: env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari15',
    }),
    minify: !env.TAURI_ENV_DEBUG,
    sourcemap: !!env.TAURI_ENV_DEBUG,
    // dist/.vite/manifest.json, which the build-graph test reads.
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
