/**
 * Request admission (API-01, fixture F19): a body is refused by its route's
 * limit before it is materialised, whatever the client said its length was.
 *
 * The reader used to be file_get_contents('php://input') with a length check
 * afterwards: a 100 MB PATCH was read whole into memory before the 48 MB
 * JSON limit looked at it, an unknown-length (chunked) body was bounded by
 * nothing but memory_limit, a base64 bundle was decoded in full before its
 * decoded size was compared, and an image was stored with whatever
 * dimensions its header declared. These tests run the API under limits
 * small enough to reach, on a server started with the ini values the
 * deployed .user.ini asks for, and — for the cases a real HTTP server cannot
 * deliver, a body longer than its Content-Length — through the same library
 * on the command line, where php://input is stdin.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startServer, runPhp, makeBundle, skip, PNG_1x1, pngDeclaring } from './helpers/harness.mjs';

const JSON_LIMIT = 64 * 1024;
const BUNDLE_LIMIT = 1024 * 1024;
const IMAGE_LIMIT = 64 * 1024;

let s = null;
let slug = '';
let editKey = '';
/** The listing and the app folders as they stood before any refusal below. */
let inventory = null;

before(async () => {
  s = await startServer({
    config: { maxJsonBytes: JSON_LIMIT, maxBundleBytes: BUNDLE_LIMIT, maxThumbnailBytes: IMAGE_LIMIT },
    // Far below the bodies sent below, so a reader that materialises one is a fatal, not a 413.
    ini: { memory_limit: '32M' },
    prefix: 'softn-admission-',
  });
  const p = await s.publish('Admission Target');
  slug = p.app.slug;
  editKey = p.editKey;
  inventory = await snapshot();
});

after(() => s?.stop());

async function snapshot() {
  const list = (await s.api('GET', '/api/apps?perPage=48')).json;
  const folders = fs.readdirSync(path.join(s.dataDir, 'apps')).sort();
  const files = Object.fromEntries(folders.map((f) => [f, fs.readdirSync(path.join(s.dataDir, 'apps', f)).sort()]));
  return { apps: list.apps.map((a) => [a.slug, a.version, a.size]), folders, files };
}

/** A request whose body goes as chunks with no Content-Length, which fetch() will not send. */
function chunked(method, route, headers, chunks) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: route, method, headers: { ...headers, 'Transfer-Encoding': 'chunked' } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    for (const c of chunks) req.write(c);
    req.end();
  });
}

/** A JSON comment body of exactly `bytes` bytes. */
function commentOf(bytes) {
  const frame = JSON.stringify({ name: 'Ann', body: 'A fine comment.', pad: '' });
  return JSON.stringify({ name: 'Ann', body: 'A fine comment.', pad: 'x'.repeat(bytes - frame.length) });
}

test('a JSON body at its route limit is read; one byte over is a 413 that names the limit', skip, async () => {
  const at = commentOf(JSON_LIMIT);
  assert.equal(Buffer.byteLength(at), JSON_LIMIT);
  const ok = await s.api('POST', `/api/apps/${slug}/comments`, { raw: at, headers: { 'Content-Type': 'application/json' } });
  assert.equal(ok.status, 201, ok.text);
  const over = await s.api('POST', `/api/apps/${slug}/comments`, { raw: commentOf(JSON_LIMIT + 1), headers: { 'Content-Type': 'application/json' } });
  assert.equal(over.status, 413, over.text);
  assert.equal(over.json.ok, false);
  assert.equal(over.json.limit, JSON_LIMIT, 'the reply carries the limit in bytes');
  assert.match(over.json.error, /64 KB/);
  assert.equal((await s.api('GET', `/api/apps/${slug}/comments`)).json.total, 1, 'the refused comment was not stored');
});

test('the reader counts the bytes it is given, not the Content-Length it was told', skip, async () => {
  const run = (server, stdin) => {
    const r = runPhp({
      dataDir: s.dataDir,
      stdin,
      server: { REQUEST_METHOD: 'POST', REQUEST_URI: `/api/apps/${slug}/comments`, CONTENT_TYPE: 'application/json', REMOTE_ADDR: '127.0.0.1', ...server },
      script: `
$before = memory_get_peak_usage();
$r = Request::fromGlobals();
try { $j = $r->json(); echo json_encode(['status' => 200, 'keys' => array_keys($j), 'peak' => memory_get_peak_usage() - $before]); }
catch (ApiError $e) { echo json_encode(['status' => $e->status, 'error' => $e->getMessage(), 'limit' => $e->extra['limit'] ?? null, 'peak' => memory_get_peak_usage() - $before]); }`,
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  // A Content-Length well under the limit, with three times the limit behind it.
  const lying = run({ CONTENT_LENGTH: '10' }, commentOf(JSON_LIMIT * 3));
  assert.equal(lying.status, 413, JSON.stringify(lying));
  assert.equal(lying.limit, JSON_LIMIT);
  // A Content-Length under the limit with a longer body that is also under it: the mismatch itself is refused.
  const longer = run({ CONTENT_LENGTH: '10' }, '{"a":1,"bb":2222222}');
  assert.equal(longer.status, 400, JSON.stringify(longer));
  assert.match(longer.error, /Content-Length/);
  // A declared length over the limit is refused before a byte is read.
  const declared = run({ CONTENT_LENGTH: String(JSON_LIMIT + 1) }, '{}');
  assert.equal(declared.status, 413, JSON.stringify(declared));
  // No Content-Length at all, and 40 MB behind it: refused at the limit, with the
  // memory to show that the rest was never read into a string.
  const unknown = run({}, commentOf(40 * 1024 * 1024));
  assert.equal(unknown.status, 413, JSON.stringify(unknown));
  assert.ok(unknown.peak < 4 * 1024 * 1024, `peak grew by ${unknown.peak} bytes for a 40 MB body`);
  // No Content-Length and a small body: read as it is.
  const fine = run({}, '{"body":"hello there","name":"Ann"}');
  assert.equal(fine.status, 200, JSON.stringify(fine));
  assert.deepEqual(fine.keys, ['body', 'name']);
});

test('an unknown-length (chunked) body is bounded by the same limit', skip, async () => {
  const over = await chunked('POST', `/api/apps/${slug}/comments`, { 'Content-Type': 'application/json' }, [commentOf(JSON_LIMIT + 1)]);
  assert.equal(over.status, 413, over.text);
  assert.equal(over.json.limit, JSON_LIMIT);
  const ok = await chunked('POST', `/api/apps/${slug}/comments`, { 'Content-Type': 'application/json' }, [commentOf(1000).slice(0, 500), commentOf(1000).slice(500)]);
  assert.equal(ok.status, 201, ok.text);
  // A raw bundle upload streamed in chunks, three times the bundle limit.
  const raw = await chunked('POST', '/api/apps', { 'Content-Type': 'application/octet-stream', 'X-Admin-Key': s.adminKey }, Array.from({ length: 3 }, () => crypto.randomBytes(BUNDLE_LIMIT)));
  assert.equal(raw.status, 413, raw.text);
  assert.equal(raw.json.limit, BUNDLE_LIMIT);
  assert.ok(await s.tempEmpty(), `temp files left: ${s.tempFiles()}`);
});

test('a raw bundle is spooled to a file up to the bundle limit and refused past it, leaving no file behind', skip, async () => {
  const headers = { 'Content-Type': 'application/octet-stream', 'X-Admin-Key': s.adminKey };
  const over = await s.api('POST', '/api/apps', { raw: crypto.randomBytes(BUNDLE_LIMIT + 1), headers });
  assert.equal(over.status, 413, over.text);
  assert.equal(over.json.limit, BUNDLE_LIMIT);
  assert.match(over.json.error, /bundle/i);
  assert.ok(await s.tempEmpty(), `temp files left: ${s.tempFiles()}`);
  // Just under: a real bundle padded with incompressible bytes to 900 KB publishes.
  const big = makeBundle('Nearly Full', { extra: { 'assets/pad.bin': crypto.randomBytes(900 * 1024) } });
  assert.ok(big.length < BUNDLE_LIMIT && big.length > 900 * 1024);
  const ok = await s.api('POST', '/api/apps', { raw: big, headers });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.app.size, big.length);
  assert.ok(await s.tempEmpty(), `temp files left after a publish: ${s.tempFiles()}`);
  // A bundle that is not one is refused after the spool, and the spool is gone.
  const junk = await s.api('POST', '/api/apps', { raw: crypto.randomBytes(4096), headers });
  assert.equal(junk.status, 400, junk.text);
  assert.ok(await s.tempEmpty(), `temp files left after a refusal: ${s.tempFiles()}`);
  inventory = await snapshot();
});

test('a base64 bundle is refused from its encoded length before it is decoded', skip, async () => {
  const headers = { 'X-Admin-Key': s.adminKey };
  const over = await s.api('POST', '/api/apps', { body: { bundleBase64: crypto.randomBytes(BUNDLE_LIMIT + 1).toString('base64') }, headers });
  assert.equal(over.status, 413, over.text);
  assert.equal(over.json.limit, BUNDLE_LIMIT);
  assert.match(over.json.error, /bundle/i);
  assert.ok(await s.tempEmpty());
  const ok = await s.api('POST', '/api/apps', {
    body: { bundleBase64: 'data:application/octet-stream;base64,' + Buffer.from(makeBundle('Encoded', { extra: { 'assets/pad.bin': crypto.randomBytes(600 * 1024) } })).toString('base64') },
    headers,
  });
  assert.equal(ok.status, 201, ok.text);
  assert.ok(await s.tempEmpty());
  const notBase64 = await s.api('POST', '/api/apps', { body: { bundleBase64: '@@not base64@@' }, headers });
  assert.equal(notBase64.status, 400);
  // The JSON envelope of a bundle route is the bundle, a thumbnail and the
  // fields, base64 overhead included; anything past that is a 413 too.
  const envelope = (await s.api('GET', '/api/health')).json.limits.bundleEnvelope;
  const pastEnvelope = await s.api('POST', '/api/apps', { raw: '{"bundleBase64":"' + 'A'.repeat(envelope) + '"}', headers: { ...headers, 'Content-Type': 'application/json' } });
  assert.equal(pastEnvelope.status, 413, pastEnvelope.text);
  assert.equal(pastEnvelope.json.limit, envelope);
  inventory = await snapshot();
});

test('a multipart bundle over the limit is a 413 as well', skip, async () => {
  const fd = new FormData();
  fd.append('bundle', new Blob([crypto.randomBytes(BUNDLE_LIMIT + 1)]), 'big.softn');
  const over = await s.api('POST', '/api/apps', { body: fd, headers: { 'X-Admin-Key': s.adminKey } });
  assert.equal(over.status, 413, over.text);
  assert.ok(await s.tempEmpty(), `temp files left: ${s.tempFiles()}`);
});

test('an image is held to its byte limit and to a dimension budget read from its header', skip, async () => {
  const owner = { 'X-Edit-Key': editKey };
  const route = `/api/apps/${slug}/thumbnail`;
  const huge = pngDeclaring(100000, 100000);
  assert.ok(huge.length < 200, 'a few hundred bytes that claim ten gigapixels');
  const declared = await s.api('POST', route, { body: { thumbnailBase64: huge.toString('base64') }, headers: owner });
  assert.equal(declared.status, 422, declared.text);
  assert.match(declared.json.error, /100000/);
  assert.equal(typeof declared.json.maxPixels, 'number');
  const fd = new FormData();
  fd.append('thumbnail', new Blob([huge], { type: 'image/png' }), 'huge.png');
  const declaredMultipart = await s.api('POST', route, { body: fd, headers: owner });
  assert.equal(declaredMultipart.status, 422, declaredMultipart.text);
  assert.ok(await s.tempEmpty(), `temp files left: ${s.tempFiles()}`);
  // A tall, narrow image within the pixel budget but past the side budget.
  const wide = await s.api('POST', route, { body: { thumbnailBase64: pngDeclaring(9000, 10).toString('base64') }, headers: owner });
  assert.equal(wide.status, 422, wide.text);
  // Bytes over the image limit, in both encodings.
  const fat = Buffer.concat([PNG_1x1, Buffer.alloc(IMAGE_LIMIT)]);
  const fatB64 = await s.api('POST', route, { body: { thumbnailBase64: fat.toString('base64') }, headers: owner });
  assert.equal(fatB64.status, 413, fatB64.text);
  assert.equal(fatB64.json.limit, IMAGE_LIMIT);
  const fatFd = new FormData();
  fatFd.append('thumbnail', new Blob([fat], { type: 'image/png' }), 'fat.png');
  const fatMultipart = await s.api('POST', route, { body: fatFd, headers: owner });
  assert.equal(fatMultipart.status, 413, fatMultipart.text);
  // Not an image at all.
  assert.equal((await s.api('POST', route, { body: { thumbnailBase64: Buffer.from('hello').toString('base64') }, headers: owner })).status, 400);
  // A real image within every budget is stored.
  const ok = await s.api('POST', route, { body: { thumbnailBase64: PNG_1x1.toString('base64') }, headers: owner });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.app.thumbnailKind, 'image');
  const shown = await fetch(`${s.base}${route}`);
  assert.equal(shown.headers.get('content-type'), 'image/png');
  assert.ok(await s.tempEmpty(), `temp files left: ${s.tempFiles()}`);
  inventory = await snapshot();
});

test('a body far larger than memory_limit is a 413, not a fatal', skip, async () => {
  // 40 MB against a 32 MB memory_limit and a 64 KB route limit. The old
  // reader took the whole body into a string first, and the built-in server
  // answered the fatal with a bare 500.
  const body = Buffer.alloc(40 * 1024 * 1024, 0x20);
  const r = await s.api('PATCH', `/api/apps/${slug}`, { raw: body, headers: { 'Content-Type': 'application/json', 'X-Edit-Key': editKey } });
  assert.equal(r.status, 413, r.text.slice(0, 200));
  assert.equal(r.json.limit, JSON_LIMIT);
  const streamed = await chunked('PATCH', `/api/apps/${slug}`, { 'Content-Type': 'application/json', 'X-Edit-Key': editKey }, Array.from({ length: 10 }, () => Buffer.alloc(4 * 1024 * 1024, 0x20)));
  assert.equal(streamed.status, 413, streamed.text.slice(0, 200));
  assert.ok(!s.log.some((l) => /Fatal|Allowed memory/.test(l)), `PHP complained: ${s.log.join('\n')}`);
});

test('health names the limits and whether the host is aligned with them', skip, async () => {
  const { json } = await s.api('GET', '/api/health');
  assert.equal(json.limits.json, JSON_LIMIT);
  assert.equal(json.limits.bundle, BUNDLE_LIMIT);
  assert.equal(json.limits.thumbnail, IMAGE_LIMIT);
  assert.ok(json.limits.bundleEnvelope > (BUNDLE_LIMIT * 4) / 3, 'the envelope covers the base64 overhead');
  assert.ok(json.limits.imageEnvelope > (IMAGE_LIMIT * 4) / 3);
  assert.equal(typeof json.limits.imageSide, 'number');
  assert.equal(typeof json.limits.imagePixels, 'number');
  assert.equal(json.postMax, '64M');
  assert.equal(json.uploadMax, '64M');
  assert.equal(json.limits.hostAligned, true, 'post_max_size and upload_max_filesize cover the bundle envelope');
});

test('a host whose post_max_size is below the envelope is reported, and a body it would drop is a 413 naming the setting', skip, async () => {
  // PHP reads a POST body only up to post_max_size; past it, a multipart
  // upload arrives with no file at all, which the API used to report as
  // "no bundle was sent". A 1 MB host against the default 32 MB bundle.
  const small = await startServer({ ini: { post_max_size: '1M', upload_max_filesize: '1M' }, prefix: 'softn-admission-ini-' });
  try {
    const health = (await small.api('GET', '/api/health')).json;
    assert.equal(health.limits.hostAligned, false);
    assert.equal(health.postMax, '1M');
    const fd = new FormData();
    fd.append('bundle', new Blob([crypto.randomBytes(2 * 1024 * 1024)]), 'big.softn');
    const dropped = await small.api('POST', '/api/apps', { body: fd, headers: { 'X-Admin-Key': small.adminKey } });
    assert.equal(dropped.status, 413, dropped.text);
    assert.match(dropped.json.error, /post_max_size/);
    assert.match(dropped.json.error, /\.user\.ini/);
    const json = await small.api('POST', '/api/apps', { raw: Buffer.alloc(2 * 1024 * 1024, 0x20), headers: { 'Content-Type': 'application/json', 'X-Admin-Key': small.adminKey } });
    assert.equal(json.status, 413, json.text);
    assert.match(json.json.error, /post_max_size/);
    // Within the host's limit the route's own limit is the one that answers.
    const fine = await small.publish('Fits The Host');
    assert.equal(fine.app.slug, 'fits-the-host');
    assert.equal((await small.api('GET', '/api/apps')).json.total, 1);
  } finally {
    small.stop();
  }
});

test('every refusal above left the catalogue exactly as it was', skip, async () => {
  assert.deepEqual(await snapshot(), inventory);
  for (const [folder, files] of Object.entries(inventory.files)) {
    assert.ok(!files.some((f) => f.startsWith('.upload-') || f.startsWith('.json-')), `${folder} holds a leftover: ${files}`);
  }
  assert.deepEqual(s.tempFiles(), []);
});
