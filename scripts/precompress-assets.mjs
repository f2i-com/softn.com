import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const COMPRESSIBLE = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.webmanifest',
  '.wasm', '.svg', '.map', '.txt', '.md', '.xml', '.ui', '.logic',
]);
const MIN_COMPRESS_BYTES = 1024;

/**
 * Quality-11 Brotli and level-9 gzip twins, reused by content within this pass.
 * Runtime assets are copied into several apps; hashing their bytes avoids
 * compressing each identical copy again. Nothing is retained between builds.
 * Only useful compressed buffers are cached, never raw inputs or larger twins.
 */
export function precompressTree(root) {
  const stats = { scanned: 0, written: 0, raw: 0, gzip: 0, brotli: 0, reused: 0 };
  const compressedByDigest = new Map();

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

      const digest = createHash('sha256').update(source).digest('hex');
      let twins = compressedByDigest.get(digest);
      if (twins) {
        stats.reused += 1;
      } else {
        const brotli = zlib.brotliCompressSync(source, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length,
          },
        });
        const gzip = zlib.gzipSync(source, { level: 9 });
        twins = {
          brotli: brotli.length < source.length * 0.95 ? brotli : null,
          gzip: gzip.length < source.length * 0.95 ? gzip : null,
        };
        compressedByDigest.set(digest, twins);
      }

      stats.scanned += 1;
      stats.raw += source.length;
      for (const [encoding, extension] of [['brotli', '.br'], ['gzip', '.gz']]) {
        const twin = twins[encoding];
        if (twin) {
          fs.writeFileSync(full + extension, twin);
          stats[encoding] += twin.length;
          stats.written += 1;
        } else {
          // A caller may run a fresh pass in the same tree after changing a file.
          fs.rmSync(full + extension, { force: true });
          stats[encoding] += source.length;
        }
      }
    }
  }

  visit(root);
  return stats;
}
