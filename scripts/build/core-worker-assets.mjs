import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyWorkerFiles } from '../../packages/@softn/core/scripts/worker-files.mjs';

const defaultCoreRoot = fileURLToPath(new URL('../../packages/@softn/core/dist/', import.meta.url));
const MIME_TYPES = new Map([
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

function inside(root, candidate) {
  return candidate.startsWith(root + path.sep);
}

/** Serve/copy the adjacent assets required by the script and local-model workers. */
export function coreWorkerAssetPlugin({ coreDistRoot = defaultCoreRoot } = {}) {
  const sourceRoot = path.resolve(coreDistRoot);
  let outputRoot;
  return {
    name: 'core-worker-asset',
    configResolved(config) {
      outputRoot = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = String(req.url || '').match(/(?:^|\/)assets\/core-runtime\/([^?#]*)/);
        if (!match) return next();
        try {
          const relative = decodeURIComponent(match[1]);
          if (!relative || relative.includes('\\') || relative.includes('\0') || relative.includes(':') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid-asset-path');
          const source = path.resolve(sourceRoot, relative);
          if (!inside(sourceRoot, source) || !inside(fs.realpathSync(sourceRoot), fs.realpathSync(source)) || !fs.statSync(source).isFile()) throw new Error('missing-asset');
          // WASM and preset voice data must retain their exact bytes.
          const bytes = fs.readFileSync(source);
          res.statusCode = 200;
          res.setHeader('Content-Type', MIME_TYPES.get(path.extname(source)) || 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(bytes);
        } catch {
          // A missing worker dependency must never become an HTML SPA fallback.
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Core runtime asset not found');
        }
      });
    },
    writeBundle(options) {
      const destination = options.dir || outputRoot;
      if (!destination) throw new Error('Core runtime assets need a Vite output directory');
      if (!fs.existsSync(sourceRoot)) throw new Error('Build @softn/core before building runtime consumers');
      // What the workers reach and nothing else (packages/@softn/core/scripts/worker-files.mjs):
      // their modules, the local-model worker's modules and licences, and the torch
      // package. Not core's mirror, its entry chunks, its declarations or its source
      // maps; not the host-JavaScript engine, which runs only on the main thread and
      // which the editors and the ZIPP runtime must be able to prove they do not
      // carry (scripts/checks/host-js-isolation.test.mjs); not the ZIPP engine, which the
      // page posts to every worker it starts. A copy of the whole dist was 4.1 MB per
      // app, of which the workers reach 2.8 MB.
      const target = path.join(destination, 'assets', 'core-runtime');
      fs.rmSync(target, { recursive: true, force: true });
      copyWorkerFiles(sourceRoot, target);
    },
  };
}
