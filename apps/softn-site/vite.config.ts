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

  // Standalone site development can point directly at another runtime.
  // `npm run dev` instead supplies private proxy targets and browser-facing
  // paths, making this Vite server the one public origin for all four apps.
  const webRuntimeTarget = env.VITE_WEB_PROXY_TARGET || env.VITE_WEB_URL || 'http://localhost:1420';
  const appProxies = [
    ['/web', env.VITE_WEB_PROXY_TARGET],
    ['/builder', env.VITE_BUILDER_PROXY_TARGET],
    ['/studio', env.VITE_STUDIO_PROXY_TARGET],
    ['/api', env.VITE_API_PROXY_TARGET],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  const demoProxy = {
    target: webRuntimeTarget,
    changeOrigin: true,
    // The runtime's public/ directory follows its `/web/` Vite base. Production
    // also copies those bundles to root `/demos/`; mirror that alias in dev.
    ...(env.VITE_WEB_PROXY_TARGET && { rewrite: (url: string) => `/web${url}` }),
  };

  return {
    plugins: [react()],
    server: {
      port: env.VITE_PORT ? Number(env.VITE_PORT) : 1421,
      strictPort: true,
      proxy: Object.fromEntries([
        ...appProxies.map(([route, target]) => [route, { target, changeOrigin: true, ws: true }]),
        // In a deployed build the site and the runtime sit under one origin and
        // `/demos` is a plain directory. Proxying it in dev keeps the fetch
        // same-origin in both places, so the demo shelf needs no CORS handling
        // and no separate code path.
        ['/demos', demoProxy],
      ]),
    },
    build: {
      target: 'es2022',
      sourcemap: true,
    },
  };
});
