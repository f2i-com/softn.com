import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Use relative paths for Tauri embedded assets
  base: './',
  server: {
    port: env.VITE_PORT ? Number(env.VITE_PORT) : 1422,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari15',
    minify: !env.TAURI_ENV_DEBUG,
    sourcemap: !!env.TAURI_ENV_DEBUG,
  },
});
