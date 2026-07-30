import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => {
  // loadEnv, not process.env. Vite never writes .env values into process.env —
  // it keeps them in its own resolved env and injects them into client code as
  // import.meta.env. Reading process.env at module scope also runs before Vite
  // has opened a .env file at all, so VITE_WEB_URL set in .env.local was visible
  // to the app through import.meta.env but invisible to the proxy and the port
  // below: half the config honoured the file and half ignored it. Real
  // environment variables still win, which is what CI and the site build rely on.
  const env = loadEnv(mode, appDir, 'VITE_');

  // Where the web runtime lives while developing. The site never bundles the
  // runtime; it points an iframe at it and reads the same `/demos` directory the
  // runtime serves, so the two only have to agree on a URL.
  const webRuntimeOrigin = env.VITE_WEB_URL || 'http://localhost:1420';

  return {
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
  };
});
