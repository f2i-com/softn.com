import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultContainerRuntimeRoot = fileURLToPath(
  new URL('../../packages/@softn/container/dist/runtime/', import.meta.url)
);

const MIME_TYPES = new Map([
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

function inside(root, candidate) {
  return candidate.startsWith(root + path.sep);
}

function copyRuntimeDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.endsWith('.map') || entry.name.endsWith('.br') || entry.name.endsWith('.gz')) {
      continue;
    }
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyRuntimeDir(src, dest);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    }
  }
}

/**
 * Serve and copy `@softn/container`'s Worker, tiered ZIPP WASM engines, `.glue.js`
 * bindings, and hosted `/vendor/` modules under `assets/container-runtime/`.
 */
export function containerRuntimeAssetPlugin({ runtimeDistRoot = defaultContainerRuntimeRoot } = {}) {
  const sourceRoot = path.resolve(runtimeDistRoot);
  let outputRoot;
  return {
    name: 'container-runtime-asset',
    configResolved(config) {
      outputRoot = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = String(req.url || '').match(/(?:^|\/)assets\/container-runtime\/([^?#]*)/);
        if (!match) return next();
        try {
          const relative = decodeURIComponent(match[1]);
          if (
            !relative ||
            relative.includes('\\') ||
            relative.includes('\0') ||
            relative.includes(':') ||
            relative.split('/').some((part) => !part || part === '.' || part === '..')
          ) {
            throw new Error('invalid-asset-path');
          }
          const source = path.resolve(sourceRoot, relative);
          if (
            !inside(sourceRoot, source) ||
            !inside(fs.realpathSync(sourceRoot), fs.realpathSync(source)) ||
            !fs.statSync(source).isFile()
          ) {
            throw new Error('missing-asset');
          }
          const acceptEnc = String(req.headers['accept-encoding'] || '');
          const brTwin = `${source}.br`;
          const useBr = acceptEnc.includes('br') && fs.existsSync(brTwin);
          const bytes = fs.readFileSync(useBr ? brTwin : source);
          res.statusCode = 200;
          res.setHeader('Content-Type', MIME_TYPES.get(path.extname(source)) || 'application/octet-stream');
          if (useBr) {
            res.setHeader('Content-Encoding', 'br');
            res.setHeader('Vary', 'Accept-Encoding');
          }
          res.setHeader('Cache-Control', 'no-cache');
          res.end(bytes);
        } catch {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Container runtime asset not found');
        }
      });
    },
    writeBundle(options) {
      const destination = options.dir || outputRoot;
      if (!destination) throw new Error('Container runtime assets need a Vite output directory');
      if (!fs.existsSync(sourceRoot)) {
        throw new Error('Build @softn/container before building runtime consumers');
      }
      const target = path.join(destination, 'assets', 'container-runtime');
      fs.rmSync(target, { recursive: true, force: true });
      copyRuntimeDir(sourceRoot, target);
    },
  };
}
