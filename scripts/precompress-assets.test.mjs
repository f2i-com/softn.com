import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { precompressTree } from './precompress-assets.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-compress-test-'));
  t.after(() => {
    const checked = fs.realpathSync(root);
    assert.equal(path.dirname(checked), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(checked).startsWith('softn-compress-test-'));
    fs.rmSync(checked, { recursive: true, force: true });
  });
  return {
    root,
    write(name, source) {
      const full = path.join(root, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, source);
      return full;
    },
  };
}

test('identical files across app folders compress once, while same-size different content stays distinct', t => {
  const { root, write } = fixture(t);
  const first = Buffer.from('runtime-A '.repeat(300));
  const second = Buffer.from('runtime-B '.repeat(300));
  assert.equal(first.length, second.length);
  const inputs = new Map([
    [write('web/core.wasm', first), first],
    [write('builder/nested/core.wasm', first), first],
    [write('studio/core.js', first), first],
    [write('play/different.wasm', second), second],
  ]);
  const originalBrotli = zlib.brotliCompressSync;
  const originalGzip = zlib.gzipSync;
  const brotli = t.mock.method(zlib, 'brotliCompressSync');
  const gzip = t.mock.method(zlib, 'gzipSync');
  const stats = precompressTree(root);
  assert.equal(brotli.mock.callCount(), 2);
  assert.equal(gzip.mock.callCount(), 2);
  assert.equal(stats.scanned, 4);
  assert.equal(stats.reused, 2);
  assert.equal(stats.written, 8);
  assert.equal(stats.raw, first.length * 4);
  let brBytes = 0, gzBytes = 0;
  for (const [file, source] of inputs) {
    const br = fs.readFileSync(file + '.br');
    const gz = fs.readFileSync(file + '.gz');
    assert.deepEqual(zlib.brotliDecompressSync(br), source);
    assert.deepEqual(zlib.gunzipSync(gz), source);
    // Exact legacy settings, including size hint; caching must not change bytes.
    assert.deepEqual(br, originalBrotli(source, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length } }));
    assert.deepEqual(gz, originalGzip(source, { level: 9 }));
    brBytes += br.length;
    gzBytes += gz.length;
  }
  assert.equal(stats.brotli, brBytes);
  assert.equal(stats.gzip, gzBytes);
});

test('retains size/type/private-directory exclusions and reuses rejected compression results', t => {
  const { root, write } = fixture(t);
  const source = Buffer.alloc(1024, 42);
  const noise = randomBytes(4096);
  const skipped = [
    write('small.js', source.subarray(0, 1023)),
    write('archive.softn', source),
    write('api/config.json', source),
    write('data/state.json', source),
  ];
  const accepted = write('exact-minimum.JS', source);
  const rejected = [write('web/noise.wasm', noise), write('builder/noise.wasm', noise)];
  const brotli = t.mock.method(zlib, 'brotliCompressSync');
  const gzip = t.mock.method(zlib, 'gzipSync');
  const stats = precompressTree(root);
  assert.equal(brotli.mock.callCount(), 2);
  assert.equal(gzip.mock.callCount(), 2);
  assert.equal(stats.scanned, 3);
  assert.equal(stats.reused, 1);
  assert.equal(stats.written, 2);
  for (const file of [...skipped, ...rejected]) for (const ext of ['.br', '.gz']) assert.equal(fs.existsSync(file + ext), false, file + ext);
  assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(accepted + '.br')), source);
  assert.deepEqual(zlib.gunzipSync(fs.readFileSync(accepted + '.gz')), source);
});

test('each pass reads fresh bytes and removes obsolete twins when the new source no longer benefits', t => {
  const { root, write } = fixture(t);
  const file = write('mutable.js', Buffer.alloc(4096, 65));
  const brotli = t.mock.method(zlib, 'brotliCompressSync');
  const gzip = t.mock.method(zlib, 'gzipSync');
  assert.equal(precompressTree(root).reused, 0);
  const changed = Buffer.alloc(4096, 66);
  write('mutable.js', changed);
  assert.equal(precompressTree(root).reused, 0);
  assert.equal(brotli.mock.callCount(), 2);
  assert.equal(gzip.mock.callCount(), 2);
  assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(file + '.br')), changed);
  assert.deepEqual(zlib.gunzipSync(fs.readFileSync(file + '.gz')), changed);
  write('mutable.js', randomBytes(4096));
  assert.equal(precompressTree(root).written, 0);
  assert.equal(fs.existsSync(file + '.br'), false);
  assert.equal(fs.existsSync(file + '.gz'), false);
  write('mutable.js', changed);
  precompressTree(root);
  write('mutable.js', Buffer.from('small again'));
  assert.equal(precompressTree(root).scanned, 0);
  assert.equal(fs.existsSync(file + '.br'), false);
  assert.equal(fs.existsSync(file + '.gz'), false);
});

test('only twins strictly smaller than 95 percent are written', t => {
  const { root, write } = fixture(t);
  const file = write('threshold.js', Buffer.alloc(2000, 42));
  t.mock.method(zlib, 'brotliCompressSync', () => Buffer.alloc(1900));
  t.mock.method(zlib, 'gzipSync', () => Buffer.alloc(1899));
  const stats = precompressTree(root);
  assert.equal(fs.existsSync(file + '.br'), false);
  assert.equal(fs.statSync(file + '.gz').size, 1899);
  assert.equal(stats.brotli, 2000);
  assert.equal(stats.gzip, 1899);
  assert.equal(stats.written, 1);
});
