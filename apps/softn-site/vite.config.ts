import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

// Where the web runtime lives while developing. The site never bundles the
// runtime; it points an iframe at it and reads the same `/demos` directory the
// runtime serves, so the two only have to agree on a URL.
const webRuntimeOrigin = env.VITE_WEB_URL || 'http://localhost:1420';

export default defineConfig({
  plugins: [react()],
  server: {
    port: env.VITE_PORT ? Number(env.VITE_PORT) : 1421,
    strictPort: true,
    proxy: {
      // In a deployed build the site and the runtime sit under one origin and
      // `/demos` is a plain directory. Proxying it in dev keeps the fetch
      // same-origin in both places, so the demo shelf needs no CORS handling
      // and no separate code path.
      '/demos': {
        target: webRuntimeOrigin,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
