import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
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
    configureServer(server: { middlewares: { use: (route: string, fn: (req: { url?: string }, res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body: string | Buffer) => void }, next: () => void) => void) => void } }) {
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
        // Read as a Buffer, never utf8: the engine .wasm is not text, and
        // decoding it replaces every invalid byte sequence with U+FFFD, so it
        // arrives bigger than it left and WebAssembly rejects it.
        const source = fs.readFileSync(sourcePath);
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
  plugins: [react(), coreWorkerAssetPlugin()],
  clearScreen: false,
  server: {
    port: 1421,
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
