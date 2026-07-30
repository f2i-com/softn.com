import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

// The browser is the primary target, so assets are served from an absolute
// base; set VITE_BASE to deploy under a sub-path such as /builder/. Tauri is
// the exception: its webview loads the bundle off disk, where only relative
// paths resolve.
const isTauri = !!env.TAURI_ENV_PLATFORM;
const base = isTauri ? './' : env.VITE_BASE || '/';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // A service worker buys nothing inside the Tauri webview — the assets are
      // already local — and it can keep serving a previous build after the app
      // updates, so the PWA exists only for the web build. Disabling the plugin
      // rather than dropping it keeps `virtual:pwa-register/react` resolvable,
      // which the Tauri build still has to compile.
      disable: isTauri,
      // 'prompt' is what makes PwaUpdater's toast reachable: under 'autoUpdate'
      // the generated client only reloads on `activated` and never calls
      // onNeedRefresh, so a worker update would throw away the canvas mid-edit.
      // Studio arrives at the same behaviour from 'autoUpdate' by setting
      // injectRegister false to stop Workbox forcing skipWaiting, but it needs
      // that only because it registers the worker by hand; the builder goes
      // through `virtual:pwa-register/react`, which already suppresses the
      // injected registration script, so asking for prompt outright is the
      // shorter route.
      registerType: 'prompt',
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
        // so leaving it out would break preview offline. `ttf` is Monaco's
        // codicon font, which its @font-face pulls in for every chevron and
        // suggest-widget glyph in the editor chrome.
        globPatterns: ['**/*.{js,css,html,svg,png,ttf,woff2,wasm}'],
        // The ONNX runtime binaries are 20+ MB each and back optional AI
        // features. Precaching them would make an install download tens of
        // megabytes it will most likely never use, so they stay on-demand.
        globIgnores: ['**/ort-*.wasm'],
        // Everything left after that ignore fits inside 8 MiB — the largest
        // are Monaco's TypeScript worker at ~5.8 MiB and the main chunk at
        // ~5.1 MiB. Raise this rather than let Workbox skip a file, because a
        // skipped precache entry fails only offline.
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
    // Tauri ships a known webview with each platform, so that build compiles
    // straight for the engine it will run on. The web build names no target and
    // takes Vite's default baseline instead: raising it drops Safari 15.0-15.3,
    // the iOS the apple-mobile-web-app-* meta tags in index.html exist for.
    ...(isTauri && {
      target: env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari15',
    }),
    minify: !env.TAURI_ENV_DEBUG,
    sourcemap: !!env.TAURI_ENV_DEBUG,
  },
});
