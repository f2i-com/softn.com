import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { STORED_EXTENSIONS, crc32, readArchive, writeArchive } from './archive.mjs';

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `softn-archive-${name}-`));
  return {
    dir,
    done() {
      const checked = fs.realpathSync(dir);
      assert.equal(path.dirname(checked), fs.realpathSync(os.tmpdir()));
      fs.rmSync(checked, { recursive: true, force: true });
    },
  };
}

test('stores what is already compressed, deflates the rest, keeps modes and restores exact bytes', () => {
  const s = scratch('write');
  try {
    const text = Buffer.from('x'.repeat(50000));
    const gz = zlib.gzipSync(text);
    const entries = {
      'b/index.html': text,
      'a.txt.gz': gz,
      'font.woff2': Buffer.from([1, 2, 3, 4]),
      'engine.wasm': Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), Buffer.alloc(4096)]),
      'bin/node': { data: Buffer.from('#!/bin/sh\n'), mode: 0o100755 },
    };
    const out = path.join(s.dir, 'out', 'test.zip');
    const result = writeArchive(entries, out, { stamp: new Date('2026-01-02T03:04:06Z') });
    assert.equal(result.name, 'test.zip');
    assert.equal(result.entries.length, 5);
    // Sorted names, the same on every OS.
    assert.deepEqual(result.entries.map((e) => e.name), ['a.txt.gz', 'b/index.html', 'bin/node', 'engine.wasm', 'font.woff2']);
    const by = Object.fromEntries(result.entries.map((e) => [e.name, e]));
    assert.equal(by['a.txt.gz'].method, 0);
    assert.equal(by['font.woff2'].method, 0);
    assert.equal(by['b/index.html'].method, 8);
    assert.ok(by['b/index.html'].compressedSize < text.length / 10);
    assert.equal(by['engine.wasm'].method, 8, 'WebAssembly is a binary format, not a compression format');
    assert.equal(result.storedBytes, gz.length + 4);

    const zip = fs.readFileSync(out);
    const { entries: read, problems } = readArchive(zip);
    assert.deepEqual(problems, []);
    for (const [name, value] of Object.entries(entries)) {
      const data = Buffer.isBuffer(value) ? value : value.data;
      assert.ok(read.get(name).data.equals(data), name);
    }
    assert.equal(read.get('bin/node').mode, 0o100755);
    assert.equal(read.get('b/index.html').mode, 0o100644);

    const sidecar = fs.readFileSync(`${out}.sha256`, 'utf8');
    assert.match(sidecar, /^[0-9a-f]{64}  test\.zip\n$/);
    assert.equal(sidecar.slice(0, 64), result.sha256);

    // A second opinion from a tool that shares no code with the writer, when one is around.
    try {
      const listed = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).trim().split('\n');
      assert.deepEqual(listed.sort(), Object.keys(entries).sort());
      execFileSync('unzip', ['-tq', out], { stdio: 'pipe' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    // Byte-for-byte reproducible from the same input and stamp.
    const again = path.join(s.dir, 'again.zip');
    writeArchive(entries, again, { stamp: new Date('2026-01-02T03:04:06Z') });
    assert.ok(fs.readFileSync(again).equals(zip));
  } finally {
    s.done();
  }
});

test('refuses names that cannot be entries, duplicates and nothing at all', () => {
  const s = scratch('refuse');
  try {
    const out = path.join(s.dir, 'x.zip');
    assert.throws(() => writeArchive({}, out), /nothing to archive/);
    assert.throws(() => writeArchive({ '/abs': Buffer.alloc(1) }, out), /not a name/);
    assert.throws(() => writeArchive({ 'a/../b': Buffer.alloc(1) }, out), /not a name/);
    assert.throws(() => writeArchive({ 'a\\b': Buffer.alloc(1) }, out), /not a name/);
    assert.throws(() => writeArchive([['a', Buffer.alloc(1)], ['a', Buffer.alloc(2)]], out), /listed twice/);
    assert.ok(!fs.existsSync(out));
  } finally {
    s.done();
  }
});

test('reads back a damaged archive as problems, never as success', () => {
  const s = scratch('damage');
  try {
    const out = path.join(s.dir, 'x.zip');
    writeArchive({ 'a.txt': Buffer.from('hello world, hello world, hello world') }, out);
    const zip = fs.readFileSync(out);
    // Flip a byte inside the deflated body: the CRC no longer matches.
    const damaged = Buffer.from(zip);
    const bodyStart = 30 + 'a.txt'.length;
    damaged[bodyStart + 2] ^= 0xff;
    const { problems } = readArchive(damaged);
    assert.ok(problems.length > 0, problems.join('; '));
    assert.deepEqual(readArchive(Buffer.from('not a zip at all, not even close')).problems.length > 0, true);
  } finally {
    s.done();
  }
});

test('the stored list and the crc are what the writer relies on', () => {
  assert.ok(STORED_EXTENSIONS.has('.br') && STORED_EXTENSIONS.has('.softn') && !STORED_EXTENSIONS.has('.wasm'));
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});
