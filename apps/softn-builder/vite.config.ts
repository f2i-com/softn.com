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
import { fullEngineGlob, fullEngineRuntimeCaching, vendorThreeGroup } from '../../scripts/build/on-demand-chunks.mjs';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

// The browser is the primary target, so assets are served from an absolute
// base; set VITE_BASE to deploy under a sub-path such as /builder/. Tauri is
// the exception: its webview loads the bundle off disk, where only relative
// paths resolve.
const isTauri = !!env.TAURI_ENV_PLATFORM;
const base = isTauri ? './' : env.VITE_BASE || '/';

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
    // What runs as script: this deployment's files only (scripts/build/script-policy.mjs). Not in
    // the desktop build, whose webview has a policy of its own. FormLogic frames this page as a
    // document of its own, so it needs the policy as much as a site does.
    ...(isTauri ? [] : [scriptPolicyPlugin()]),
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
        // Install the editor tools and lite previews for offline use. The full engine
        // enters the shared runtime cache when a project first asks for it.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        globIgnores: [fullEngineGlob],
        sourceCompilers: true,
        // Web projects need the code editor and preview offline. A full-tier web
        // preview also imports web-host to compile the engine it has downloaded.
        classicSharedRoots: [
          '../../packages/@softn/components/dist/code-editor.js',
          'src/components/preview/ContainerPreviewRuntime.tsx',
          '../../packages/@softn/core/dist/web-host.js',
        ],
        classicRoots: [
          'src/components/preview/ClassicPreviewSurface.ts',
          'src/components/canvas/Canvas.tsx',
          '../../packages/@softn/components/dist/lazy.js',
        ],
        runtimeCaching: [fullEngineRuntimeCaching],
        // What a web-container preview runs on (@softn/container's Worker, the engines
        // core does not carry, the vendor modules): under assets/ in a build of the
        // Builder alone, where the globs find it; in the site build in the one folder
        // all four apps share, which is installed from there.
        additionalManifestEntries: env.VITE_FORMLOGIC_EDITOR === '1' ? [] : sharedContainerPrecache(),
        // Large offline tools include the TypeScript engine and the QR decoder.
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
  // In the site build, what this builds by its address in the site's one folder of
  // built files (scripts/build/shared-assets.mjs); elsewhere, Vite's own URLs.
  experimental: { renderBuiltUrl: sharedRenderBuiltUrl },
  build: {
    outDir: isTauri ? 'dist-desktop' : 'dist',
    // Tauri ships a known webview with each platform; the web build matches
    // the ES2022 baseline of softn-site, softn-web, softn-studio, and softn-single
    // so shared chunks (Three.js, addons, core modules) hash identically in /shared/assets/.
    target: isTauri ? (env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari15') : 'es2022',
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
