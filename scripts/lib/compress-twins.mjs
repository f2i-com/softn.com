import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';

/**
 * A file's precompressed twins: quality-11 Brotli sized to the input, and
 * level-9 gzip. The one place these settings live, for the in-process pass and
 * for the worker threads of the parallel one (scripts/build/precompress-assets.mjs),
 * so both write the same bytes.
 */
export function compressTwins(source) {
  return {
    brotli: zlib.brotliCompressSync(source, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length,
      },
    }),
    gzip: zlib.gzipSync(source, { level: 9 }),
  };
}

// As the worker thread precompress-assets.mjs starts (and no other: a test
// runner's own worker may import this module): given a file's path, answer
// with its twins, its length and the digest of the bytes they were made from.
export const WORKER_MARK = 'softn-compress-twins';
if (parentPort && workerData === WORKER_MARK) {
  parentPort.on('message', (file) => {
    const source = fs.readFileSync(file);
    const twins = compressTwins(source);
    parentPort.postMessage({
      ...twins,
      length: source.length,
      digest: createHash('sha256').update(source).digest('hex'),
    });
  });
}
