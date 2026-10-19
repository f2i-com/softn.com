import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { compressTwins, WORKER_MARK } from './lib/compress-twins.mjs';

const COMPRESSIBLE = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.webmanifest',
  '.wasm', '.svg', '.map', '.txt', '.md', '.xml', '.ui', '.logic',
]);
const MIN_COMPRESS_BYTES = 1024;

/**
 * Every file in the tree that gets twins, in walk order, with the digest of
 * its bytes; the twins of a file too small to compress are removed on the way.
 */
function collect(root) {
  const entries = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // PHP is executed, not served, and the data directory is the API's own.
        if (dir === root && (entry.name === 'api' || entry.name === 'data')) continue;
        visit(full);
        continue;
      }
      if (!entry.isFile() || !COMPRESSIBLE.has(path.extname(entry.name).toLowerCase())) continue;
      const source = fs.readFileSync(full);
      if (source.length < MIN_COMPRESS_BYTES) {
        fs.rmSync(full + '.br', { force: true });
        fs.rmSync(full + '.gz', { force: true });
        continue;
      }
      entries.push({ full, length: source.length, digest: createHash('sha256').update(source).digest('hex') });
    }
  }
  visit(root);
  return entries;
}

/** The first file of each content, the one its twins are made from. */
function distinct(entries) {
  const first = new Map();
  for (const entry of entries) if (!first.has(entry.digest)) first.set(entry.digest, entry);
  return [...first.values()];
}

/** Only useful compressed buffers are kept: a twin must beat 95% of its source. */
function useful(length, { brotli, gzip }) {
  return {
    brotli: brotli.length < length * 0.95 ? brotli : null,
    gzip: gzip.length < length * 0.95 ? gzip : null,
  };
}

/** Writes (or removes) every file's twins from its content's, and counts. */
function settle(entries, twinsByDigest) {
  const stats = { scanned: 0, written: 0, raw: 0, gzip: 0, brotli: 0, reused: 0 };
  const seen = new Set();
  for (const { full, length, digest } of entries) {
    if (seen.has(digest)) stats.reused += 1;
    seen.add(digest);
    const twins = twinsByDigest.get(digest);
    stats.scanned += 1;
    stats.raw += length;
    for (const [encoding, extension] of [['brotli', '.br'], ['gzip', '.gz']]) {
      const twin = twins[encoding];
      if (twin) {
        fs.writeFileSync(full + extension, twin);
        stats[encoding] += twin.length;
        stats.written += 1;
      } else {
        // A caller may run a fresh pass in the same tree after changing a file.
        fs.rmSync(full + extension, { force: true });
        stats[encoding] += length;
      }
    }
  }
  return stats;
}

/**
 * Quality-11 Brotli and level-9 gzip twins, made once per distinct content in
 * this pass. Runtime assets are copied into several apps; hashing their bytes
 * avoids compressing each identical copy again. Nothing is retained between
 * builds.
 */
export function precompressTree(root) {
  const entries = collect(root);
  const twinsByDigest = new Map();
  for (const { full, length, digest } of distinct(entries)) {
    twinsByDigest.set(digest, useful(length, compressTwins(fs.readFileSync(full))));
  }
  return settle(entries, twinsByDigest);
}

/**
 * The same pass with the compression spread over worker threads: the same
 * twins, byte for byte (each is made by compressTwins with the same settings,
 * only on another thread), and the same counts. Quality-11 Brotli is what a
 * site build spends its time on — the engine modules are megabytes each, and
 * the largest takes seconds on its own — so the largest contents are handed out
 * first and the rest fill in around them.
 */
export async function precompressTreeInParallel(root, { workers = defaultWorkers() } = {}) {
  const entries = collect(root);
  const jobs = distinct(entries).sort((a, b) => b.length - a.length);
  const twinsByDigest = new Map();
  const threads = Math.min(Math.max(1, workers), jobs.length);
  await Promise.all(Array.from({ length: threads }, async () => {
    const worker = new Worker(new URL('./lib/compress-twins.mjs', import.meta.url), { workerData: WORKER_MARK });
    try {
      for (let job = jobs.shift(); job; job = jobs.shift()) {
        twinsByDigest.set(job.digest, useful(job.length, await ask(worker, job)));
      }
    } finally {
      await worker.terminate();
    }
  }));
  return settle(entries, twinsByDigest);
}

/** One job to one worker: its answer, or the reason it has none. */
function ask(worker, { full, length, digest }) {
  return new Promise((resolve, reject) => {
    const done = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onMessage = (twins) => {
      done();
      // The file must still be the content it was hashed as.
      if (twins.digest !== digest || twins.length !== length) reject(new Error(`${full} changed while it was being compressed`));
      else resolve(twins);
    };
    const onError = (error) => {
      done();
      reject(error);
    };
    const onExit = (code) => {
      done();
      reject(new Error(`the compression worker for ${full} stopped (exit code ${code})`));
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.postMessage(full);
  });
}

/** One thread a core, up to eight: quality-11 Brotli holds a sizeable window per thread. */
function defaultWorkers() {
  return Math.max(1, Math.min(8, os.availableParallelism()));
}
