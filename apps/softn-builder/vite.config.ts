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
    // What runs as script: this deployment's files only (scripts/build/script-policy.mjs). Not in
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
      manifest: {
        name: 'SoftN Builder',
        short_name: 'Builder',
        description: 'Visual editor for SoftN applications',
        display: 'standalone',
        // The Builder's own ground, the brand's dark --ink, as index.html paints it.
        theme_color: '#101317',
        background_color: '#101317',
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
        // A complete install: everything the Builder ships, so an installed
        // Builder works offline with every feature. The canvas and preview
        // still load each one (charts, editors, Scene3D with Three.js, the QR
        // decoder, the workers' files under core-runtime/) only when a page
        // draws or asks for it, so this is what installing downloads, not what
        // a page loads.
        globIgnores: [],
        // Every file fits inside 8 MiB — the largest is the ZIPP engine at
        // ~6.1 MiB (javascript-python-base; torch is a package of ~2 MiB under
        // core-runtime/). Raise this rather than let Workbox skip a file,
        // because a skipped precache entry fails only offline.
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
  // In the site build, the engine and the QR decoder by their one shared copy
  // (scripts/build/shared-assets.mjs); elsewhere, Vite's own URLs.
  experimental: { renderBuiltUrl: sharedRenderBuiltUrl },
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
    // A debug desktop build, or a development build (scripts/build/sourcemaps.mjs).
    sourcemap: !!env.TAURI_ENV_DEBUG || buildSourcemaps(),
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
