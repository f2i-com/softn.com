import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'node:fs';
import path from 'node:path';

const coreDistRoot = path.resolve(__dirname, '../../packages/@softn/core/dist');

function copyDirRecursive(srcDir: string, destDir: string) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function coreWorkerAssetPlugin() {
  const workerBaseRoute = '/assets/core-runtime/';
  return {
    name: 'core-worker-asset',
    configureServer(server: { middlewares: { use: (route: string, fn: (req: unknown, res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body: string) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use(workerBaseRoute, (req: { url?: string }, res, next) => {
        const urlPath = String(req.url || '');
        const relPath = urlPath.replace(workerBaseRoute, '');
        if (!relPath || relPath.includes('..')) {
          next();
          return;
        }
        const sourcePath = path.join(coreDistRoot, relPath);
        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
          next();
          return;
        }
        const source = fs.readFileSync(sourcePath, 'utf8');
        res.statusCode = 200;
        if (sourcePath.endsWith('.js')) {
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        } else if (sourcePath.endsWith('.map')) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
        } else if (sourcePath.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        }
        res.end(source);
      });
    },
    writeBundle(options: { dir?: string }) {
      const outDir = options.dir || path.resolve(__dirname, 'dist');
      const destRoot = path.join(outDir, 'assets', 'core-runtime');
      copyDirRecursive(coreDistRoot, destRoot);
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    coreWorkerAssetPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: false, // We provide our own manifest.json in public/
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 1422,
    strictPort: true,
  },
  build: {
    target: 'ES2020',
    sourcemap: true,
  },
});
