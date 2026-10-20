/**
 * The files of core's dist a Worker can reach: what an app copies to
 * assets/core-runtime/ and core mirrors to dist/core-runtime/. The script,
 * sandbox and local-model workers, every module they import (statically or
 * through a literal import()) and every file they name with
 * `new URL('…', import.meta.url)`; the local-model worker's modules and
 * licences in runtime/models/; the torch package, which the page fetches from
 * `./core-runtime/zipp_torch.wasm` through a variable, so no reference names
 * it; and the licence texts at the root. Not the ZIPP engine: the page posts
 * its own compiled engine to every worker it starts.
 *
 * A copy of the whole dist was 4.1 MB per app, of which the workers reach
 * 2.8 MB; the rest was core's own entry chunks and declaration files, which no
 * worker loads.
 */
import fs from 'node:fs';
import path from 'node:path';

export const WORKER_ENTRIES = ['runtime/script-worker.js', 'runtime/sandbox-worker.js', 'runtime/model-worker.js'];

/** Always copied: what is fetched by a path no module spells out. */
const ALWAYS = ['zipp_torch.wasm'];
const MODELS_DIR = 'runtime/models/';

const REFERENCES = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
];

/** The relative files a module names. */
export function moduleReferences(text) {
  const refs = [];
  for (const pattern of REFERENCES) {
    for (const match of text.matchAll(pattern)) {
      const ref = match[1];
      // Relative paths, and a bare file name in a URL() (the engine glue's spelling); no packages.
      if (/^\.{1,2}\//.test(ref) || /^[\w.-]+\.(?:js|mjs|wasm|json)$/.test(ref)) refs.push(ref);
    }
  }
  return refs;
}

/** Every file under `dist` (relative, forward slashes) a worker can reach, sorted. */
export function workerFiles(dist) {
  const exists = (rel) => fs.existsSync(path.join(dist, rel)) && fs.statSync(path.join(dist, rel)).isFile();
  const files = new Set();
  const queue = [...WORKER_ENTRIES];
  while (queue.length) {
    const rel = queue.shift();
    if (files.has(rel) || !exists(rel)) continue;
    files.add(rel);
    if (!/\.m?js$/.test(rel)) continue;
    for (const ref of moduleReferences(fs.readFileSync(path.join(dist, rel), 'utf8'))) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), ref));
      if (!target.startsWith('../') && target !== 'zipp_wasm_bg.wasm') queue.push(target);
    }
  }
  for (const rel of ALWAYS) if (exists(rel)) files.add(rel);
  const models = path.join(dist, MODELS_DIR);
  if (fs.existsSync(models)) {
    for (const name of fs.readdirSync(models)) if (exists(MODELS_DIR + name) && !name.endsWith('.map')) files.add(MODELS_DIR + name);
  }
  for (const name of fs.readdirSync(dist)) if (name.endsWith('.txt') && exists(name)) files.add(name);
  return [...files].sort();
}

/** Copy the worker files of `dist` into `destination`, byte for byte. */
export function copyWorkerFiles(dist, destination) {
  const files = workerFiles(dist);
  for (const rel of files) {
    const to = path.join(destination, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(dist, rel), to);
  }
  return files;
}
