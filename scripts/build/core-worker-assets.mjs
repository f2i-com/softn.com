import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { copyWorkerFiles, moduleReferences, WORKER_ENTRIES } from '../../packages/@softn/core/scripts/worker-files.mjs';
import { sharedAssetsBase } from './shared-assets.mjs';

/** Below this a module is left as it is: the saving is smaller than a request's headers. */
const MINIFY_MIN_BYTES = 4096;

/** What a module is to the modules around it: what it exports, what it imports, what it names by URL. */
function moduleInterface(meta, text) {
  const output = Object.values(meta.outputs)[0];
  return JSON.stringify({
    exports: [...output.exports].sort(),
    imports: output.imports.map((entry) => `${entry.kind} ${entry.path}`).sort(),
    references: moduleReferences(text).sort(),
  });
}

function esbuildModule(text, sourcefile, minify) {
  const result = buildSync({
    stdin: { contents: text, loader: 'js', sourcefile },
    write: false,
    bundle: false,
    format: 'esm',
    target: 'esnext',
    charset: 'utf8',
    legalComments: 'inline',
    minify,
    metafile: true,
    outfile: sourcefile,
    logLevel: 'silent',
  });
  return { code: result.outputFiles[0].text, meta: result.metafile };
}

/**
 * Core's build leaves its modules readable (the apps' bundlers minify what they
 * bundle), but the workers' copies are served as they are: 570 KB of script,
 * of which minifying takes 120 KB (28 KB gzipped) in every app that carries
 * them. A module is replaced only by output that exports, imports and names by
 * URL exactly what it did, and only when that saves a twentieth of it; anything
 * else, the WASM and the licences included, stays byte for byte. The names do
 * not change: a chunk keeps the name core's build gave its source. Returns the
 * files it rewrote.
 */
export function minifyWorkerModules(root, files) {
  const rewritten = [];
  for (const rel of files) {
    if (!/\.m?js$/.test(rel)) continue;
    const file = path.join(root, ...rel.split('/'));
    const source = fs.readFileSync(file, 'utf8');
    if (source.length < MINIFY_MIN_BYTES) continue;
    let minified;
    try {
      const plain = esbuildModule(source, rel, false);
      minified = esbuildModule(source, rel, true);
      if (moduleInterface(plain.meta, source) !== moduleInterface(minified.meta, minified.code)) continue;
    } catch {
      continue;
    }
    if (Buffer.byteLength(minified.code) > source.length * 0.95) continue;
    fs.writeFileSync(file, minified.code);
    rewritten.push(rel);
  }
  return rewritten;
}

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
export function coreWorkerAssetPlugin({ coreDistRoot = defaultCoreRoot, env = process.env } = {}) {
  const sourceRoot = path.resolve(coreDistRoot);
  const shared = sharedAssetsBase(env);
  let outputRoot;
  return {
    name: 'core-worker-asset',
    config(config, { command }) {
      if (command === 'build' && shared) {
        return { define: { __SOFTN_WORKER_PATHS__: JSON.stringify({ shared, entries: (config.base ?? '/').replace(/\/?$/, '/') + 'workers/' }) } };
      }
    },
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
      minifyWorkerModules(target, copyWorkerFiles(sourceRoot, target));
      if (shared) {
        // One small static import in the owning service worker's scope. The worker
        // implementation and every relative import still live in the shared folder.
        const assets = path.join(destination, 'assets');
        const scripts = WORKER_ENTRIES.filter((entry) => fs.existsSync(path.join(target, entry)))
          .map((entry) => 'core-runtime/' + entry);
        const zipWorkers = fs.readdirSync(assets).filter((name) => /^zipWorker-[\w-]+\.js$/.test(name));
        const entries = path.join(destination, 'workers');
        fs.mkdirSync(entries, { recursive: true });
        for (const entry of [...scripts, ...zipWorkers]) {
          fs.writeFileSync(path.join(entries, path.basename(entry)), `import ${JSON.stringify(shared + entry)};\n`);
        }
      }
    },
  };
}
