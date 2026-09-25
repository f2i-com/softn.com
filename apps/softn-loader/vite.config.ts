import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const coreDistRoot = path.resolve(__dirname, '../../packages/@softn/core/dist');

// The whole of core's dist, engine binary included. The main thread loads a
// content-hashed copy Vite emits from core's inlined glue; the off-main-thread
// script runtime, which a bundle asks for with `config.execution: "worker"`,
// loads the one beside its own chunk, here. This copy used to skip that
// binary while the loader ran every script on the main thread, and a worker
// bundle would now die on its 404. Dev is unaffected either way: the
// middleware below serves these files straight from core's dist.
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
  return {
    name: 'core-worker-asset',
    configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body: string | Buffer) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((req: { url?: string }, res, next) => {
        const rawUrl = String(req.url || '');
        const match = rawUrl.match(/(?:^|\/)assets\/core-runtime\/([^?#]+)/);
        if (!match) {
          next();
          return;
        }
        const relPath = match[1];
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
