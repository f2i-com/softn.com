#!/usr/bin/env node
/**
 * Package `dist/` — the complete static release that `build:site` writes — as
 * one archive ready to upload to a web host, and prove the archive is right.
 *
 *   node scripts/package-site.mjs --tag v0.0.1 [--out release] [--allow-dirty]
 *
 * The archive is `softn-com-<tag>-zipp-<engine release>.zip`, the engine
 * release taken from BUILD-INFO.json so the name says what is inside. Every
 * file under dist/ is included, `.htaccess` and the other dotfiles among them
 * (a host upload that misses `.htaccess` serves brotli as text), with the
 * directory layout intact so the contents can be dropped into a document root.
 *
 * Files that are already compressed — the .br/.gz twins, the engine, fonts,
 * images, the .softn bundles — are stored, not deflated: deflating a brotli
 * stream makes it larger and costs the time. Everything else is deflated at
 * level 9. No zip64: the release is a few hundred MB in under a thousand
 * files, and the script refuses rather than emit an archive it cannot verify.
 *
 * Verification reads the finished archive back the way an extractor would —
 * central directory, then every entry — and compares each entry, inflated,
 * byte for byte against the file on disk. A `.sha256` sidecar is written for
 * the release page. Written without dependencies so the release workflow and
 * a laptop produce the same bytes from the same dist/.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const allowDirty = args.includes('--allow-dirty');
const outDir = path.resolve(root, opt('--out') ?? 'release');
let tag = opt('--tag');
if (!tag) {
  // Without --tag, the archive is named for the tag on HEAD, and only that.
  try {
    tag = execFileSync('git', ['describe', '--tags', '--exact-match'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    fail('No --tag given and HEAD is not at a tag. Name the release: --tag v0.0.1');
  }
}
if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
  fail(`The tag must look like v1.2.3 or v1.2.3-beta.1, not "${tag}".`);
}

function fail(message) {
  console.error(`package-site: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// What is being packaged
// ---------------------------------------------------------------------------
const infoPath = path.join(distDir, 'BUILD-INFO.json');
if (!fs.existsSync(path.join(distDir, 'index.html')) || !fs.existsSync(infoPath)) {
  fail('dist/ is missing or incomplete. Run `npm run build:site` first.');
}
const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
if (info.softn?.dirty && !allowDirty) {
  fail(
    'BUILD-INFO.json says the tree was dirty when dist/ was built. A release is built from a clean checkout; pass --allow-dirty for a local trial.'
  );
}
if (!fs.existsSync(path.join(distDir, '.htaccess'))) {
  fail('dist/.htaccess is missing; the archive would deploy without its server rules.');
}
// The engine's release tag, when SOURCE.json has one that reads as a version;
// failing that its version, or the short commit. Never anything else: this
// goes into a file name, and one release run tried to open
// `…-zipp-https:/github.com/…/v0.0.14.zip` when the field held the release URL.
const looksLikeVersion = (s) => typeof s === 'string' && /^v?\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?$/.test(s);
const engine = looksLikeVersion(info.zipp?.release)
  ? info.zipp.release
  : looksLikeVersion(info.zipp?.version)
    ? `v${info.zipp.version.replace(/^v/, '')}`
    : /^[0-9a-f]{7,40}$/i.test(info.zipp?.revision ?? '')
      ? info.zipp.revision.slice(0, 8)
      : 'unknown';
const archiveName = `softn-com-${tag}-zipp-${engine}.zip`;

// Sorted, forward-slash, relative — the same order and names on every OS.
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}
// The directory API's state lives under data/ and is never part of a release:
// a dist/ that has been served locally holds a database, uploaded bundles and
// a config with the site's admin key, none of which belongs on another host.
// Only the rules that keep the directory unserved travel.
const DATA_KEEP = new Set(['data/.htaccess', 'data/README.txt']);
const files = walk(distDir)
  .filter((name) => !(name === 'data' || name.startsWith('data/')) || DATA_KEEP.has(name))
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
if (files.length === 0) fail('dist/ has no files.');
for (const required of DATA_KEEP) {
  if (!files.includes(required)) fail(`dist/${required} is missing; the directory would deploy unprotected.`);
}
if (files.length >= 0xffff) fail(`${files.length} files is more than a zip without zip64 can list.`);

// Already compressed on disk; stored as they are.
const STORED = new Set([
  '.br', '.gz', '.zip', '.wasm', '.softn',
  '.woff', '.woff2',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.mp3', '.mp4', '.webm', '.ogg',
]);

// ---------------------------------------------------------------------------
// Zip writing — the 1989 format, method 0 (stored) and 8 (deflate)
// ---------------------------------------------------------------------------
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Entry timestamps: the build's own time, so two archives of one build agree.
// DOS time has two-second resolution and no year before 1980.
const stamp = new Date(info.builtAt ?? Date.now());
const dosTime = (stamp.getHours() << 11) | (stamp.getMinutes() << 5) | (stamp.getSeconds() >> 1);
const dosDate = ((Math.max(stamp.getFullYear(), 1980) - 1980) << 9) | ((stamp.getMonth() + 1) << 5) | stamp.getDate();

const FLAG_UTF8 = 0x0800;
const VERSION_NEEDED = 20;

function localHeader(e) {
  const name = Buffer.from(e.name, 'utf8');
  const h = Buffer.alloc(30 + name.length);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(VERSION_NEEDED, 4);
  h.writeUInt16LE(FLAG_UTF8, 6);
  h.writeUInt16LE(e.method, 8);
  h.writeUInt16LE(dosTime, 10);
  h.writeUInt16LE(dosDate, 12);
  h.writeUInt32LE(e.crc, 14);
  h.writeUInt32LE(e.compressedSize, 18);
  h.writeUInt32LE(e.size, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  name.copy(h, 30);
  return h;
}

function centralHeader(e) {
  const name = Buffer.from(e.name, 'utf8');
  const h = Buffer.alloc(46 + name.length);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(VERSION_NEEDED, 4); // made by
  h.writeUInt16LE(VERSION_NEEDED, 6); // needed
  h.writeUInt16LE(FLAG_UTF8, 8);
  h.writeUInt16LE(e.method, 10);
  h.writeUInt16LE(dosTime, 12);
  h.writeUInt16LE(dosDate, 14);
  h.writeUInt32LE(e.crc, 16);
  h.writeUInt32LE(e.compressedSize, 20);
  h.writeUInt32LE(e.size, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt16LE(0, 30); // extra
  h.writeUInt16LE(0, 32); // comment
  h.writeUInt16LE(0, 34); // disk
  h.writeUInt16LE(0, 36); // internal attrs
  h.writeUInt32LE(0, 38); // external attrs
  h.writeUInt32LE(e.offset, 42);
  name.copy(h, 46);
  return h;
}

fs.mkdirSync(outDir, { recursive: true });
const archivePath = path.join(outDir, archiveName);
const fd = fs.openSync(archivePath, 'w');
let offset = 0;
const write = (buf) => {
  fs.writeSync(fd, buf);
  offset += buf.length;
};

const entries = [];
let storedBytes = 0;
let deflatedBytes = 0;
let rawBytes = 0;
for (const name of files) {
  const data = fs.readFileSync(path.join(distDir, name));
  const stored = STORED.has(path.extname(name).toLowerCase());
  const body = stored ? data : zlib.deflateRawSync(data, { level: 9 });
  const e = {
    name,
    method: stored ? 0 : 8,
    crc: crc32(data),
    size: data.length,
    compressedSize: body.length,
    offset,
  };
  if (e.size >= 0xffffffff || e.compressedSize >= 0xffffffff || offset >= 0xffffffff) {
    fs.closeSync(fd);
    fail(`${name} needs zip64, which this script does not write.`);
  }
  write(localHeader(e));
  write(body);
  entries.push(e);
  rawBytes += e.size;
  if (stored) storedBytes += e.compressedSize;
  else deflatedBytes += e.compressedSize;
}
const centralStart = offset;
for (const e of entries) write(centralHeader(e));
const centralSize = offset - centralStart;
if (centralStart >= 0xffffffff) {
  fs.closeSync(fd);
  fail('The archive is larger than a zip without zip64 can address.');
}
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralSize, 12);
eocd.writeUInt32LE(centralStart, 16);
eocd.writeUInt16LE(0, 20);
write(eocd);
fs.closeSync(fd);

// ---------------------------------------------------------------------------
// Verification: read it back as an extractor would
// ---------------------------------------------------------------------------
const zip = fs.readFileSync(archivePath);
let problems = 0;
const problem = (message) => {
  problems++;
  console.error(`  problem: ${message}`);
};

const tail = zip.subarray(zip.length - 22);
if (tail.readUInt32LE(0) !== 0x06054b50) problem('end-of-central-directory record not where it should be');
const count = tail.readUInt16LE(10);
const cdSize = tail.readUInt32LE(12);
const cdStart = tail.readUInt32LE(16);
if (count !== entries.length) problem(`central directory lists ${count} entries, wrote ${entries.length}`);
if (cdStart + cdSize + 22 !== zip.length) problem('central directory does not end at the record');

const seen = new Set();
let p = cdStart;
for (let i = 0; i < count; i++) {
  if (zip.readUInt32LE(p) !== 0x02014b50) {
    problem(`central entry ${i} has a bad signature`);
    break;
  }
  const method = zip.readUInt16LE(p + 10);
  const crc = zip.readUInt32LE(p + 16);
  const csize = zip.readUInt32LE(p + 20);
  const usize = zip.readUInt32LE(p + 24);
  const nlen = zip.readUInt16LE(p + 28);
  const xlen = zip.readUInt16LE(p + 30);
  const clen = zip.readUInt16LE(p + 32);
  const local = zip.readUInt32LE(p + 42);
  const name = zip.subarray(p + 46, p + 46 + nlen).toString('utf8');
  p += 46 + nlen + xlen + clen;
  seen.add(name);

  if (zip.readUInt32LE(local) !== 0x04034b50) {
    problem(`${name}: local header signature`);
    continue;
  }
  const lnlen = zip.readUInt16LE(local + 26);
  const lxlen = zip.readUInt16LE(local + 28);
  const dataStart = local + 30 + lnlen + lxlen;
  const body = zip.subarray(dataStart, dataStart + csize);
  let data;
  try {
    data = method === 0 ? body : zlib.inflateRawSync(body);
  } catch (error) {
    problem(`${name}: does not inflate (${error.message})`);
    continue;
  }
  if (data.length !== usize) problem(`${name}: inflates to ${data.length} bytes, header says ${usize}`);
  if (crc32(data) !== crc) problem(`${name}: CRC mismatch`);
  const onDisk = fs.readFileSync(path.join(distDir, name));
  if (!onDisk.equals(data)) problem(`${name}: differs from dist/`);
}
for (const name of files) if (!seen.has(name)) problem(`${name}: in dist/ but not in the archive`);
for (const name of seen) if (!files.includes(name)) problem(`${name}: in the archive but not in dist/`);
if (!seen.has('.htaccess')) problem('.htaccess is not in the archive');
for (const name of seen) {
  if (/\.sqlite$/.test(name) || name === 'data/config.json' || name === 'data/seeded') problem(`${name}: the directory's state must not ship`);
}

if (problems > 0) {
  fs.rmSync(archivePath, { force: true });
  fail(`${problems} problem(s); the archive was removed.`);
}

const digest = crypto.createHash('sha256').update(zip).digest('hex');
fs.writeFileSync(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`);

const mb = (n) => (n / 1048576).toFixed(1);
console.log(`package-site: ${archiveName}`);
console.log(`  ${entries.length} files, ${mb(rawBytes)} MB in dist/ -> ${mb(zip.length)} MB archived`);
console.log(`  ${entries.filter((e) => e.method === 0).length} stored (${mb(storedBytes)} MB), ${entries.filter((e) => e.method === 8).length} deflated (${mb(deflatedBytes)} MB)`);
console.log(`  softn ${String(info.softn?.revision ?? '').slice(0, 7)}${info.softn?.dirty ? ' (dirty)' : ''}, zipp ${engine}, built ${info.builtAt ?? 'unknown'}`);
console.log(`  read back and compared byte for byte with dist/: all ${entries.length} entries identical`);
console.log(`  sha256 ${digest}`);
console.log(`  ${path.relative(root, archivePath)}`);
