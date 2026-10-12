/**
 * The directory and the runtime read a bundle the same way.
 *
 * The directory lists what PHP reads from a bundle (its name, the
 * capabilities it declares, its storage policies) and the browser runs what
 * the runtime's reader reads. PHP's reader is libzip, and the two disagreed
 * about archives no ordinary tool writes: a second end record or a ZIP64 one,
 * a gap before the end record, a count the directory does not hold, an entry
 * renamed by a Unicode Path field, an encrypted flag in one header only, a
 * deflate stream longer than its entry declares. The runtime has refused
 * those since October 2026; the directory still published some of them, and
 * then listed one app while the browser ran another, or nothing.
 *
 * Each archive below is put to both readers: the runtime's own
 * (`openBundleArchive` from @softn/bundle-format, the code the browser runs)
 * and the directory's (`Bundle::inspect`, what publishing calls). Every
 * archive the runtime refuses must be refused by the directory, with the
 * reason in words; every archive the runtime opens must be published.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openBundleArchive } from '@softn/bundle-format/zip';
import { makeBundle, repo, runPhp, skip, startServer } from './helpers/harness.mjs';
import { concat, craftEnd, craftRecords, craftZip, craftZip64End, crc32, deflate, enc, unicodePathExtra } from './helpers/craft.mjs';

const require = createRequire(import.meta.url);
const { deflateSync, zipSync } = require('fflate');

const manifest = (name, extra = {}) => enc(JSON.stringify({ name, version: '1.0.0', main: 'main.ui', ...extra }));
const MAIN = { name: 'main.ui', data: enc('<div>hello</div>') };
const CAMERA = enc('{"permissions":{"camera":{"enabled":true}}}');
/** An app's two files and whatever else the case needs. */
const app = (name, ...more) => [{ name: 'manifest.json', data: manifest(name) }, MAIN, ...more];

/** Bytes deflate cannot compress, so a level-0 stream of them is stored blocks of a known layout. */
function noise(length) {
  const out = new Uint8Array(length);
  let x = 0x9e3779b9;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** What the runtime makes of an archive: null when it opens and every file reads, else why not. */
function runtimeVerdict(bytes) {
  try {
    const archive = openBundleArchive(bytes);
    archive.readAll();
    // The reader drops these and runs the rest; the inspector, and the
    // directory, refuse the bundle for them.
    if (archive.unsafeNames().length > 0) return `unsafe name: ${archive.unsafeNames().join(', ')}`;
    if (archive.backslashNames().length > 0) return `backslashes: ${archive.backslashNames().join(', ')}`;
    return null;
  } catch (err) {
    return err.message;
  }
}

/** What Bundle::inspect makes of each archive, in one PHP process. */
function directoryVerdicts(archives) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-agreement-'));
  try {
    const files = archives.map((bytes, i) => {
      const file = path.join(dir, `case-${i}.softn`);
      fs.writeFileSync(file, bytes);
      return file;
    });
    const r = runPhp({
      dataDir: dir,
      args: files,
      script: `
$out = [];
foreach (array_slice($argv, 2) as $file) {
    try {
        $info = Bundle::inspect($file);
        $out[] = ['ok' => true, 'name' => $info['name'], 'capabilities' => $info['capabilities']];
    } catch (ApiError $e) {
        $out[] = ['ok' => false, 'status' => $e->status, 'error' => $e->getMessage()];
    }
}
echo json_encode($out, JSON_INVALID_UTF8_SUBSTITUTE);`,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return JSON.parse(r.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A 200 KB deflate stream in stored blocks whose third block header is not a block type. */
function streamWithABadTail() {
  const plain = noise(200 * 1024);
  const payload = deflateSync(plain, { level: 0 });
  payload[2 * (5 + 65535)] = 0x07;
  return { payload, plain };
}

function twoDirectoriesZip64() {
  const shown = app('Shown to the directory');
  const run = app('Run in the browser', { name: 'permission.json', data: CAMERA });
  const a = craftRecords(shown);
  const b = craftRecords(run, a.body.length);
  const runDirAt = a.body.length + b.body.length;
  const shownDirAt = runDirAt + b.directory.length;
  const zip64At = shownDirAt + a.directory.length;
  return concat(a.body, b.body, b.directory, a.directory, craftZip64End(shown.length, a.directory.length, shownDirAt, zip64At), craftEnd(run.length, b.directory.length, runDirAt));
}

function twoEndRecords() {
  const shown = app('Shown to the directory');
  const run = app('Run in the browser', { name: 'permission.json', data: CAMERA });
  const first = craftRecords(shown);
  const second = craftRecords(run, first.body.length);
  const secondDirAt = first.body.length + second.body.length;
  const firstDirAt = secondDirAt + second.directory.length + 22;
  return concat(
    first.body,
    second.body,
    second.directory,
    craftEnd(run.length, second.directory.length, secondDirAt, new Uint8Array(0), { commentLength: first.directory.length + 22 }),
    first.directory,
    craftEnd(shown.length, first.directory.length, firstDirAt)
  );
}

function endRecordInComment() {
  const shown = app('Shown to the directory');
  const run = app('Run in the browser', { name: 'permission.json', data: CAMERA });
  const first = craftRecords(shown);
  const second = craftRecords(run, first.body.length);
  const firstDirAt = first.body.length + second.body.length;
  const secondDirAt = firstDirAt + first.directory.length;
  return concat(
    first.body,
    second.body,
    first.directory,
    second.directory,
    craftEnd(shown.length, first.directory.length, firstDirAt, new Uint8Array(0), { commentLength: 22 }),
    craftEnd(run.length, second.directory.length, secondDirAt)
  );
}

function shiftedByAGap() {
  const here = craftRecords(app('Read at the offset'));
  const gap = here.directory.length;
  const shifted = craftRecords([{ name: 'manifest.json', data: manifest('Read after shift') }, { name: 'main.ui', data: enc('<div>after shift!</div>') }], here.body.length - gap);
  assert.equal(shifted.directory.length, gap);
  return concat(here.body, shifted.body, here.directory, shifted.directory, craftEnd(2, gap, here.body.length + shifted.body.length));
}

function overlapping() {
  const inner = craftRecords([{ name: 'b.bin', data: new Uint8Array(64 * 1024) }], 30 + 'a.bin'.length);
  const outer = craftRecords([{ name: 'a.bin', payload: inner.body, data: inner.body }]);
  const head = craftRecords(app('Overlap'), outer.body.length);
  const directory = concat(outer.directory, inner.directory, head.directory);
  return concat(outer.body, head.body, directory, craftEnd(4, directory.length, outer.body.length + head.body.length));
}

function noLocalHeader() {
  const bytes = craftZip(app('No local header'));
  // main.ui's local header follows manifest.json's.
  const at = 30 + 'manifest.json'.length + manifest('No local header').length;
  bytes[at] = 0;
  return bytes;
}

function noEndRecord() {
  const bytes = craftZip(app('No end'));
  bytes[bytes.length - 22] = 0;
  return bytes;
}

const whole = enc('<div>shown</div>' + '<Button onClick={hidden()} />'.repeat(4));
const badTail = streamWithABadTail();

/** [what it is, the archive, what the directory must say]. */
const refused = [
  ['a stream longer than its entry declares', craftZip([{ name: 'manifest.json', data: manifest('Overflow') }, { name: 'main.ui', method: 8, data: whole, uncompressedSize: 16, crc: crc32(whole.subarray(0, 16)) }]), /main\.ui inflates to more than the size it declares/],
  ['a long stream that runs past its declaration before its bad block', craftZip(app('Bad tail', { name: 'a.bin', method: 8, payload: badTail.payload, uncompressedSize: 1000, crc: crc32(badTail.plain.subarray(0, 1000)) })), /a\.bin inflates to more than the size it declares/],
  ['a stream that is not deflate', craftZip(app('Not deflate', { name: 'a.bin', method: 8, payload: new Uint8Array(64).fill(0xff), uncompressedSize: 10, crc: 0 })), /a\.bin does not decompress/],
  ['an empty deflate stream', craftZip(app('Empty stream', { name: 'empty.txt', method: 8, payload: new Uint8Array(0) })), /empty\.txt does not decompress/],
  ['a stream that stops before its last block', craftZip(app('Stops short', { name: 'a.txt', method: 8, payload: new Uint8Array([0x00, 0x05, 0x00, 0xfa, 0xff, 104, 101, 108, 108, 111]), data: enc('hello') })), /a\.txt does not decompress/],
  ['a stream shorter than its entry declares', craftZip(app('Short', { name: 'a.bin', method: 8, data: noise(100 * 1024), uncompressedSize: 100 * 1024 + 1 })), /a\.bin is not the size it declares/],
  ['a stored entry with the wrong checksum', craftZip(app('Checksum', { name: 'a.txt', data: enc('contents'), crc: 1 })), /a\.txt does not match its checksum/],
  ['an entry flagged encrypted in both headers', craftZip(app('Encrypted', { name: 'permission.json', data: CAMERA, flags: 1 })), /encrypted entry/],
  ['an entry flagged encrypted in its local header only', craftZip(app('Encrypted here', { name: 'permission.json', data: CAMERA, flags: 0, localFlags: 1 })), /encrypted entry/],
  ['a ZIP64 end record naming another directory', twoDirectoriesZip64(), /ZIP64/],
  ['a second end record of its own', twoEndRecords(), /more than one end record/],
  ['a second end record inside the first one\u2019s comment', endRecordInComment(), /more than one end record/],
  ['an entry count short of the directory', craftZip(app('Count', { name: 'permission.json', data: CAMERA }), { entriesThisDisk: 2, entriesTotal: 2 }), /does not hold the number of entries/],
  ['an entry count past the directory', craftZip(app('Count', { name: 'permission.json', data: CAMERA }), { entriesThisDisk: 4, entriesTotal: 4 }), /does not hold the number of entries/],
  ['two entry counts that disagree', craftZip(app('Counts'), { entriesThisDisk: 2, entriesTotal: 3 }), /two different counts/],
  ['a second directory in a gap before the end record', shiftedByAGap(), /does not end where its end record begins/],
  ['a gap of zeros before the end record', craftZip(app('Gap'), { beforeEnd: new Uint8Array(8) }), /does not end where its end record begins/],
  ['an entry a Unicode Path field renames', craftZip([{ name: 'manifest.json', data: manifest('Unicode path') }, MAIN, { name: 'permission.json', data: CAMERA, centralExtra: unicodePathExtra('permission.json', 'notes/readme.txt') }, { name: 'declared.json', data: enc('{"permissions":{}}'), centralExtra: unicodePathExtra('declared.json', 'permission.json') }]), /permission\.json is also named notes\/readme\.txt/],
  ['two entries of one name', craftZip(app('Twice', { name: 'main.ui', data: enc('<div>other</div>') })), /more than one entry named main\.ui/],
  ['a folder that climbs out', craftZip(app('Dir', { name: 'assets/' }, { name: '../outside/' })), /unsafe path: \.\.\/outside\//],
  ['a folder on a drive', craftZip(app('Drive', { name: 'C:/Users/' })), /unsafe path: C:\/Users\//],
  ['a file with two dots in its name', craftZip(app('Dots', { name: 'assets/a..b.png', data: enc('x') })), /unsafe path: assets\/a\.\.b\.png/],
  ['a file under an empty segment', craftZip(app('Empty segment', { name: 'assets//x.png', data: enc('x') })), /unsafe path: assets\/\/x\.png/],
  ['a file under a dot segment', craftZip(app('Dot segment', { name: './x.png', data: enc('x') })), /unsafe path: \.\/x\.png/],
  ['a path written with backslashes', craftZip(app('Backslash', { name: 'assets\\x.png', data: enc('x') })), /written with backslashes: assets\\x\.png/],
  ['an entry compressed with bzip2', craftZip(app('Bzip2', { name: 'a.bin', method: 12, payload: enc('BZh91AY&SY'), data: enc('x') })), /compressed with method 12/],
  ['a stored entry with two sizes', craftZip(app('Two sizes', { name: 'a.txt', data: enc('hello'), uncompressedSize: 4 })), /stored, but declares two different sizes/],
  ['an entry declaring more than 50 MB', craftZip(app('Large', { name: 'big.bin', method: 8, data: enc('x'), uncompressedSize: 51 * 1024 * 1024 })), /larger than 50 MB/],
  ['an entry declaring a ZIP64 size', craftZip(app('Zip64 size', { name: 'a.txt', data: enc('x'), uncompressedSize: 0xffffffff, compressedSize: 0xffffffff })), /ZIP64/],
  ['two entries sharing one local header', craftZip(app('Shared', { name: 'copy.ui', data: enc('<div>hello</div>'), localHeaderOffset: 30 + 'manifest.json'.length + manifest('Shared').length })), /point at the same bytes/],
  ['entries claiming more bytes than the file holds', overlapping(), /claim more data than the file holds/],
  ['an entry with no local header', noLocalHeader(), /main\.ui has no local header/],
  ['an archive with no end record', noEndRecord(), /not a \.softn bundle/],
];

test('every archive the runtime refuses, the directory refuses, and says why', skip, () => {
  const verdicts = directoryVerdicts(refused.map(([, bytes]) => bytes));
  // Every disagreement at once, rather than the first.
  const wrong = [];
  refused.forEach(([what, bytes, reason], i) => {
    const got = verdicts[i];
    if (runtimeVerdict(bytes) === null) wrong.push(`the runtime opens ${what}: the case is not what it says`);
    else if (got.ok) wrong.push(`the directory took ${what}`);
    else if (got.status !== 400 || !reason.test(got.error)) wrong.push(`${what}: ${got.status} ${got.error}`);
  });
  assert.deepEqual(wrong, []);
});

/** What zip tools write, and what a bundle may hold, that looks like one of the above. */
function honest() {
  const ut = new Uint8Array([0x55, 0x54, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
  const body = enc('<div>hello</div>');
  const descriptor = new Uint8Array(16);
  const view = new DataView(descriptor.buffer);
  view.setUint32(0, 0x08074b50, true);
  view.setUint32(4, crc32(body), true);
  view.setUint32(8, deflateSync(body).length, true);
  view.setUint32(12, body.length, true);
  const plain = noise(150 * 1024);
  const inner = zipSync({ 'inner.txt': enc('inside') });
  return [
    ['an ordinary bundle', makeBundle('Ordinary', { permissions: { camera: { enabled: true } } })],
    [
      'a data descriptor, timestamps in extra fields, a folder entry and an archive comment',
      craftZip(
        [
          { name: 'manifest.json', data: manifest('Honest'), centralExtra: ut, localExtra: ut },
          { name: 'ui/' },
          { name: 'main.ui', method: 8, flags: 0x8, payload: concat(deflateSync(body), descriptor), compressedSize: deflateSync(body).length, data: body },
        ],
        { comment: enc('made by hand') }
      ),
    ],
    ['a Unicode Path field left over from another name', craftZip(app('Stale', { name: 'notes.txt', data: enc('renamed since'), centralExtra: unicodePathExtra('old-name.txt', 'old-name.txt') }))],
    ['a Unicode Path field that says what the header says', craftZip(app('Same name', { name: 'café.ui', data: enc('<div/>'), flags: 0x800, centralExtra: unicodePathExtra('café.ui', 'café.ui') }))],
    ['another archive stored inside, end record and all', zipSync({ 'manifest.json': manifest('Nested'), 'main.ui': enc('<div/>'), 'assets/pack.zip': inner, 'assets/empty.zip': craftZip([]) }, { level: 0 })],
    ['bytes before the first entry and after the end record', craftZip(app('Prefixed'), { prefix: enc('#!/bin/sh\n'), trailing: enc('\n') })],
    ['bytes after a long stream\u2019s last block', craftZip(app('Padded', { name: 'long.bin', method: 8, data: plain, payload: concat(deflateSync(plain, { level: 0 }), new Uint8Array(256 * 1024).fill(0xaa)) }, { name: 'short.txt', method: 8, data: enc('hello'), payload: concat(deflate(enc('hello')), new Uint8Array(64).fill(0xaa)) }))],
    ['large stored and deflated files', zipSync({ 'manifest.json': manifest('Large'), 'main.ui': enc('<div/>'), 'big.bin': noise(300 * 1024), 'zeros.bin': new Uint8Array(400 * 1024) }, { level: 6 })],
    ['an empty file, stored and deflated', craftZip(app('Empty files', { name: 'a.txt' }, { name: 'b.txt', method: 8, data: new Uint8Array(0) }))],
    ['a name with dots that do not climb', craftZip(app('Dots', { name: 'assets/.hidden/a.b.png', data: enc('x') }))],
  ];
}

test('every archive the runtime opens, the directory publishes', skip, () => {
  const cases = honest();
  const verdicts = directoryVerdicts(cases.map(([, bytes]) => bytes));
  const wrong = [];
  cases.forEach(([what, bytes], i) => {
    const runtime = runtimeVerdict(bytes);
    if (runtime !== null) wrong.push(`the runtime refuses ${what}: ${runtime}`);
    else if (!verdicts[i].ok) wrong.push(`the directory refuses ${what}: ${verdicts[i].error}`);
  });
  assert.deepEqual(wrong, []);
});

test('a byte order mark in front of manifest.json or permission.json is read past, as the runtime reads it', skip, () => {
  // TextDecoder, which every runtime path decodes these files with, drops
  // one leading byte order mark; json_decode refused the file for it, so the
  // directory refused a bundle every browser runs. One is dropped, not two.
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const [withBom, permissionWithBom, twice] = directoryVerdicts([
    craftZip([{ name: 'manifest.json', data: concat(bom, manifest('Notepad')) }, MAIN]),
    craftZip([{ name: 'manifest.json', data: manifest('Notepad too') }, MAIN, { name: 'permission.json', data: concat(bom, CAMERA) }]),
    craftZip([{ name: 'manifest.json', data: concat(bom, bom, manifest('Twice')) }, MAIN]),
  ]);
  assert.equal(withBom.ok, true, withBom.error);
  assert.equal(withBom.name, 'Notepad');
  assert.equal(permissionWithBom.ok, true, permissionWithBom.error);
  assert.deepEqual(permissionWithBom.capabilities, ['camera']);
  assert.equal(twice.ok, false);
  assert.match(twice.error, /manifest\.json is not valid JSON/);
  assert.throws(() => JSON.parse(new TextDecoder().decode(concat(bom, bom, manifest('Twice')))), 'the runtime refuses two as well');
});

test('a manifest\u2019s older permissions block is read as the runtime reads it when there is no permission.json', skip, () => {
  // extractPermissions in @softn/core: `network` is net and `filesystem` is
  // files when JavaScript counts the value as true; the rest are dropped.
  // The directory read none of it and listed such an app as asking for
  // nothing, while its play page asked for the network.
  const legacy = (permissions, ...more) => craftZip([{ name: 'manifest.json', data: manifest('Legacy', { permissions }) }, MAIN, ...more]);
  const verdicts = directoryVerdicts([
    legacy({ network: true, filesystem: 'read', clipboard: true, geolocation: true }),
    legacy({ network: '0', filesystem: {} }),
    legacy({ network: false, filesystem: 0 }),
    legacy({ network: '', filesystem: null }),
    legacy({ network: true }, { name: 'permission.json', data: CAMERA }),
  ]);
  assert.deepEqual(
    verdicts.map((v) => v.capabilities),
    [['net', 'files'], ['net', 'files'], [], [], ['camera']]
  );
});

test('a name that is not UTF-8 is refused, where the runtime would read it with replacement characters', skip, () => {
  // Deliberately stricter: libzip reads such a name as CP437 and the runtime
  // as UTF-8 with U+FFFD in it, so the two would list different names.
  const name = new Uint8Array([0x63, 0x61, 0x66, 0x82, 0x2e, 0x75, 0x69]);
  const bytes = craftZip(app('Code page', { name, data: enc('<div/>') }));
  assert.equal(runtimeVerdict(bytes), null);
  const [got] = directoryVerdicts([bytes]);
  assert.equal(got.ok, false);
  assert.match(got.error, /not UTF-8/);
});

test('publishing and a new version answer a refused archive with the reason', skip, async () => {
  const s = await startServer({ prefix: 'softn-agreement-' });
  try {
    const hostile = refused[0][1];
    const fd = new FormData();
    fd.append('bundle', new Blob([hostile]), 'app.softn');
    const r = await s.api('POST', '/api/apps', { body: fd, headers: { 'X-Admin-Key': s.adminKey } });
    assert.equal(r.status, 400, r.text);
    assert.match(r.json.error, /main\.ui inflates to more than the size it declares/);
    const listed = await s.api('GET', '/api/apps');
    assert.equal(listed.json.total, 0, 'nothing was published');

    const pub = await s.publish('Fine');
    const v = new FormData();
    v.append('bundle', new Blob([twoEndRecords()]), 'next.softn');
    const nv = await s.api('POST', `/api/apps/${pub.app.slug}/versions`, { body: v, headers: { 'X-Edit-Key': pub.editKey } });
    assert.equal(nv.status, 400, nv.text);
    assert.match(nv.json.error, /more than one end record/);

    // A manifest behind a byte order mark is published, and read past the
    // mark wherever the directory reads it again: the app page's summary,
    // and the play page's light boot screen for a project that declares light.
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const light = new FormData();
    light.append('bundle', new Blob([craftZip([{ name: 'manifest.json', data: concat(bom, manifest('Light Notes', { config: { theme: { mode: 'light' } } })) }, MAIN])]), 'light.softn');
    const lit = await s.api('POST', '/api/apps', { body: light, headers: { 'X-Admin-Key': s.adminKey } });
    assert.equal(lit.status, 201, lit.text);
    const detail = (await s.api('GET', `/api/apps/${lit.json.app.slug}`)).json.app;
    assert.equal(detail.manifest?.main, 'main.ui');
    const play = await fetch(`${s.base}/play/${lit.json.app.slug}`);
    assert.match(await play.text(), /background:#f5f5f8/);
  } finally {
    s.stop();
  }
});

const demoDir = path.join(repo, 'apps/softn-web/public/demos');
const demos = fs.existsSync(demoDir) ? fs.readdirSync(demoDir).filter((f) => f.endsWith('.softn')) : [];

test('the demo bundles the seed publishes open in both readers', demos.length === 0 ? { skip: 'no demo bundles in apps/softn-web/public/demos (they are fetched, not committed)' } : skip, () => {
  const archives = demos.map((f) => new Uint8Array(fs.readFileSync(path.join(demoDir, f))));
  const verdicts = directoryVerdicts(archives);
  demos.forEach((file, i) => {
    assert.equal(runtimeVerdict(archives[i]), null, `the runtime refuses ${file}`);
    assert.equal(verdicts[i].ok, true, `the directory refuses ${file}: ${verdicts[i].error}`);
  });
});
