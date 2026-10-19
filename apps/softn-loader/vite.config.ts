import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { coreWorkerAssetPlugin } from '../../scripts/core-worker-assets.mjs';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

// Core's dist, engine binary included, under assets/core-runtime/: the main
// thread loads a content-hashed copy Vite emits from core's inlined glue, and
// the off-main-thread script runtime (a bundle's `config.execution:
// "worker"`) and the local-model worker load the files beside their own
// chunks, here. The plugin the web hosts use, so the desktop build is held to
// the same rules: dev serves the files straight from core's dist, and a build
// copies them without core's nested core-runtime/ mirror (12.9 MB of
// duplicates) and without the host-JavaScript engine, which no Worker can
// reach and no app runtime may carry (scripts/host-js-isolation.test.mjs).

export default defineConfig({
  plugins: [react(), coreWorkerAssetPlugin()],
  clearScreen: false,
  server: {
    port: 1431,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  define: {
    __ANDROID__: JSON.stringify(env.TAURI_ENV_PLATFORM === 'android'),
  },
  build: {
    target: 'es2022',
    minify: !env.TAURI_ENV_DEBUG,
    sourcemap: !!env.TAURI_ENV_DEBUG,
  },
  assetsInclude: ['**/*.softn'],
});
