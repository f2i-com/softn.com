/**
 * What @softn/container needs beside an app, served in dev and written at build: its Worker,
 * the ZIPP engines an app that carries @softn/core does not already have, and the bindings
 * of each engine that runs.
 *
 * Not the whole of the package's `dist/runtime/`, which is a drop-in for a page with no SoftN
 * on it and so carries everything. An app built here has @softn/core, and with it:
 *
 *   - the JavaScript-and-Python engine, which is what the container's Python tiers run. The
 *     host hands the container the module its page already compiles
 *     (packages/@softn/runtime-shell/src/containerHost.ts), so `zipp-python-base.wasm`, the
 *     same 6.6 MB under another name, stays out;
 *   - that engine's JavaScript, which is all the `javascript` tier asks for (`Intl` and
 *     `Temporal`; `zipp-javascript.wasm` is the same engine built without Python). The host
 *     hands over core's for that tier too, so the 4.9 MB file and its bindings stay out;
 *   - the torch package, in `assets/core-runtime/`. `zipp-torch.wasm` is the same file;
 *   - Three.js, the chunk its own 3D components load, which it hands the container for a
 *     scene an app draws. `vendor/three.js` is the same library once more;
 *   - the container itself, compiled into the app's own chunks, so the drop-in's entry
 *     (`softn.js`) and its chunks are never asked for.
 *
 * What is left are the two engines that do something core's does not: `lite`, which starts
 * a plain web app on 2.8 MB instead of 6.6, and `typescript`.
 *
 * v0.0.43 copied all of it into every app: 35 MB in each of the site's four apps, of which
 * the engine and torch were already there, which took the website archive from 32 MB to 114.
 *
 * The folder is named by the digest of what is in it: `assets/container-runtime/<digest>/`.
 * The files keep their names from release to release (`engines/zipp-javascript-lite.wasm`,
 * `container-worker.js`), and a name like `zipp-javascript-lite.wasm` read as a fingerprinted
 * file to the cache rule SoftN's deployments shipped (`-[A-Za-z0-9_-]{8,}.wasm`: a year,
 * immutable), which a host that deployed an earlier release may still serve under. Under a
 * fixed folder a returning browser would have run the last release's engine with this
 * release's bindings. With the digest in the path, what a path names never changes, and a
 * release that changes any file names another folder; the site's rules now keep the folder
 * for a year by that digest (build-site.mjs), and a service worker keeps it for good.
 *
 * In the site build (SOFTN_SHARED_CONTAINER_RUNTIME, set by scripts/build/build-site.mjs) no
 * app keeps a folder of its own: all four name the one under /shared/, which build-site
 * writes once (placeSharedContainerRuntime below).
 *
 * The app learns its folder from `import.meta.env.VITE_SOFTN_CONTAINER_RUNTIME`, defined
 * here for a build. The dev server defines nothing and serves the package's files at
 * `assets/container-runtime/`, which is where an app looks when it is told nothing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultContainerRuntimeRoot = fileURLToPath(
  new URL('../../packages/@softn/container/dist/runtime/', import.meta.url)
);

/** An app's own folder for the container's files, beneath which the digest names the build's. */
export const CONTAINER_RUNTIME_DIR = 'assets/container-runtime';

/** What `import.meta.env` calls the folder in an app's code. */
export const CONTAINER_RUNTIME_ENV = 'VITE_SOFTN_CONTAINER_RUNTIME';

const MIME_TYPES = new Map([
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

// What the app has already, or stands in for (see the note above). The bindings of core's
// engine stay (`zipp-python-base.glue.js`): the container loads them for whichever tier that
// engine runs.
const APP_HAS = new Set([
  'engines/zipp-python-base.wasm',
  'engines/zipp-torch.wasm',
  'engines/zipp-javascript.wasm',
  'engines/zipp-javascript.glue.js',
]);

/** Whether a host that carries @softn/core serves this file of `dist/runtime/` (a `/`-separated path). */
export function isHostedRuntimeFile(relative) {
  // Source maps are not shipped; .br and .gz twins are the deployment's to write
  // (precompress-assets.mjs), from the bytes it ends up serving.
  if (/\.(?:map|br|gz)$/.test(relative)) return false;
  if (APP_HAS.has(relative)) return false;
  return (
    relative === 'container-worker.js' ||
    relative === 'backend-worker.js' ||
    relative.startsWith('engines/') ||
    relative.startsWith('vendor/')
  );
}

function inside(root, candidate) {
  return candidate.startsWith(root + path.sep);
}

function requireRuntime(sourceRoot) {
  if (!fs.existsSync(path.join(sourceRoot, 'container-worker.js'))) {
    throw new Error('Build @softn/container before building runtime consumers');
  }
}

/** The hosted files of `sourceRoot`, as sorted `/`-separated paths. */
export function hostedRuntimeFiles(sourceRoot = defaultContainerRuntimeRoot) {
  requireRuntime(sourceRoot);
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${relative}/`);
      else if (entry.isFile() && isHostedRuntimeFile(relative)) files.push(relative);
    }
  };
  walk(sourceRoot, '');
  return files.sort();
}

/** Twelve hex digits that change when any hosted file, or the set of them, does. */
export function containerRuntimeDigest(sourceRoot = defaultContainerRuntimeRoot) {
  const all = crypto.createHash('sha256');
  for (const relative of hostedRuntimeFiles(sourceRoot)) {
    const bytes = fs.readFileSync(path.join(sourceRoot, ...relative.split('/')));
    all.update(`${relative}\0${crypto.createHash('sha256').update(bytes).digest('hex')}\n`);
  }
  return all.digest('hex').slice(0, 12);
}

/** Copy the hosted files into `target`, which is emptied first. Returns their paths. */
export function copyHostedRuntime(target, sourceRoot = defaultContainerRuntimeRoot) {
  const files = hostedRuntimeFiles(sourceRoot);
  fs.rmSync(target, { recursive: true, force: true });
  for (const relative of files) {
    const dest = path.join(target, ...relative.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, ...relative.split('/')), dest);
  }
  return files;
}

/** Where the site keeps its one copy, as an absolute path ending in `/`; null when the build is not the site's. */
export function sharedContainerRuntimeBase(env = process.env) {
  const base = env.SOFTN_SHARED_CONTAINER_RUNTIME;
  if (!base) return null;
  if (!/^\/(?:[\w-]+\/)+$/.test(base)) {
    throw new Error(`SOFTN_SHARED_CONTAINER_RUNTIME must be an absolute path ending in "/", not "${base}"`);
  }
  return base;
}

/**
 * In the site build, the shared folder's files as precache entries, for an app that installs
 * everything it ships (Studio, the Builder): its own output holds none of them to find. No
 * revisions, as their addresses change with their content. Elsewhere nothing: the files are
 * in the app's own output, where its precache finds them.
 */
export function sharedContainerPrecache(env = process.env, sourceRoot = defaultContainerRuntimeRoot) {
  const base = sharedContainerRuntimeBase(env);
  if (!base) return [];
  const digest = containerRuntimeDigest(sourceRoot);
  return hostedRuntimeFiles(sourceRoot).map((file) => ({ url: `${base}${digest}/${file}`, revision: null }));
}

/**
 * After the site's apps are built into `outDir/<app>/`: write the one shared folder,
 * `outDir/<base>/<digest>/`, and hold every app to it. Refuses an app that kept a folder of
 * its own or whose scripts do not name the shared one (built without the variable, or
 * against another build of the container), since such an app would ask for files that are
 * not there. Returns the folder's digest and files.
 */
export function placeSharedContainerRuntime(outDir, apps, base, sourceRoot = defaultContainerRuntimeRoot) {
  const digest = containerRuntimeDigest(sourceRoot);
  const url = `${base}${digest}/`;
  for (const app of apps) {
    const own = path.join(outDir, app, ...CONTAINER_RUNTIME_DIR.split('/'));
    if (fs.existsSync(own)) {
      throw new Error(`${app}/${CONTAINER_RUNTIME_DIR}/ exists; build ${app} with SOFTN_SHARED_CONTAINER_RUNTIME=${base}`);
    }
    const assets = path.join(outDir, app, 'assets');
    const scripts = fs.existsSync(assets) ? fs.readdirSync(assets).filter((n) => /\.m?js$/.test(n)) : [];
    if (!scripts.some((name) => fs.readFileSync(path.join(assets, name), 'utf8').includes(url))) {
      throw new Error(`No script of ${app} names ${url}; build ${app} with SOFTN_SHARED_CONTAINER_RUNTIME=${base} after @softn/container`);
    }
  }
  const files = copyHostedRuntime(path.join(outDir, ...url.split('/').filter(Boolean)), sourceRoot);
  return { digest, url, files };
}

/** Serve the container's files in dev; in a build, name their folder to the app and write it. */
export function containerRuntimeAssetPlugin({ runtimeDistRoot = defaultContainerRuntimeRoot, env = process.env } = {}) {
  const sourceRoot = path.resolve(runtimeDistRoot);
  const sharedBase = sharedContainerRuntimeBase(env);
  let outputRoot;
  let digest = null;
  return {
    name: 'container-runtime-asset',
    config(_config, { command }) {
      if (command !== 'build') return undefined;
      digest = containerRuntimeDigest(sourceRoot);
      // Absolute for the site's shared folder; otherwise relative to the app's base, which
      // the app puts in front (a single-app build's base is `./`).
      const folder = sharedBase ? `${sharedBase}${digest}/` : `${CONTAINER_RUNTIME_DIR}/${digest}/`;
      const define = { [`import.meta.env.${CONTAINER_RUNTIME_ENV}`]: JSON.stringify(folder) };
      if (sharedBase) define['import.meta.env.VITE_SOFTN_CONTAINER_WORKER'] = JSON.stringify(`container-worker-${digest}.js`);
      return { define };
    },
    configResolved(config) {
      outputRoot = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = String(req.url || '').match(/(?:^|\/)assets\/container-runtime\/([^?#]*)/);
        if (!match) return next();
        // These files finish here before Vite's static middleware applies server.headers.
        // In particular, a module Worker must receive the embedding page's COEP to start.
        for (const [name, value] of Object.entries(server.config.server.headers ?? {})) {
          if (value !== undefined) res.setHeader(name, value);
        }
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
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
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
      if (sharedBase) {
        // Firefox selects a dedicated worker's controller by its own script URL. A
        // blob worker importing the shared module can still go to the network offline.
        // The local entry and its shared imports all run under this host's worker.
        const worker = `container-worker-${digest}.js`;
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(path.join(destination, worker), `import ${JSON.stringify(`${sharedBase}${digest}/container-worker.js`)};\n`);
        return;
      }
      const own = path.join(destination, ...CONTAINER_RUNTIME_DIR.split('/'));
      // The whole of it, so a folder a previous build named does not stay beside this one's.
      fs.rmSync(own, { recursive: true, force: true });
      copyHostedRuntime(path.join(own, digest ?? containerRuntimeDigest(sourceRoot)), sourceRoot);
    },
  };
}
