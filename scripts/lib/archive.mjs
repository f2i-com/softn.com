/**
 * The one zip writer every release archive goes through.
 *
 * Four scripts used to write archives four ways: the site with a careful
 * dependency-free writer, the two single-app archives with fflate at level 9
 * on everything (re-deflating brotli twins, fonts and the engine, which only
 * makes them larger and slower), and the PHP backend packager with a third
 * fflate call of its own. This is the site's writer, kept whole, offered to
 * all of them:
 *
 *   - Files that are already compressed (.br/.gz twins, fonts, images, media,
 *     .softn bundles) are stored; everything else is deflated. WebAssembly is
 *     a binary format, not a compression format: it deflates like JavaScript.
 *   - No zip64. A release is a few hundred MB in under a thousand files; the
 *     writer refuses rather than emit an archive it cannot verify.
 *   - Entry timestamps are one fixed stamp (the build's own time), so two
 *     archives of one build agree byte for byte.
 *   - Unix modes travel in the external attributes, so an executable
 *     (`backend/bin/node`) is still executable after `unzip`.
 *   - The finished file is read back the way an extractor reads it (central
 *     directory, then every entry), inflated and compared byte for byte with
 *     what was asked for. A problem removes the file and throws.
 *   - A `<archive>.sha256` sidecar is written for the release page.
 *
 * Written without dependencies, so the release workflow and a laptop produce
 * the same bytes from the same input.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

/** Already compressed on disk; stored as they are. */
export const STORED_EXTENSIONS = new Set([
  '.br', '.gz', '.zip', '.softn',
  '.woff', '.woff2',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.mp3', '.mp4', '.webm', '.ogg',
]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const FLAG_UTF8 = 0x0800;
const VERSION_NEEDED = 20;
const MADE_BY_UNIX = (3 << 8) | VERSION_NEEDED;
const LIMIT = 0xffffffff;

function dosStamp(stamp) {
  // DOS time has two-second resolution and no year before 1980.
  const time = (stamp.getHours() << 11) | (stamp.getMinutes() << 5) | (stamp.getSeconds() >> 1);
  const date = ((Math.max(stamp.getFullYear(), 1980) - 1980) << 9) | ((stamp.getMonth() + 1) << 5) | stamp.getDate();
  return { time, date };
}

function localHeader(e, stamp) {
  const name = Buffer.from(e.name, 'utf8');
  const h = Buffer.alloc(30 + name.length);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(VERSION_NEEDED, 4);
  h.writeUInt16LE(FLAG_UTF8, 6);
  h.writeUInt16LE(e.method, 8);
  h.writeUInt16LE(stamp.time, 10);
  h.writeUInt16LE(stamp.date, 12);
  h.writeUInt32LE(e.crc, 14);
  h.writeUInt32LE(e.compressedSize, 18);
  h.writeUInt32LE(e.size, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  name.copy(h, 30);
  return h;
}

function centralHeader(e, stamp) {
  const name = Buffer.from(e.name, 'utf8');
  const h = Buffer.alloc(46 + name.length);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(MADE_BY_UNIX, 4);
  h.writeUInt16LE(VERSION_NEEDED, 6);
  h.writeUInt16LE(FLAG_UTF8, 8);
  h.writeUInt16LE(e.method, 10);
  h.writeUInt16LE(stamp.time, 12);
  h.writeUInt16LE(stamp.date, 14);
  h.writeUInt32LE(e.crc, 16);
  h.writeUInt32LE(e.compressedSize, 20);
  h.writeUInt32LE(e.size, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt16LE(0, 30); // extra
  h.writeUInt16LE(0, 32); // comment
  h.writeUInt16LE(0, 34); // disk
  h.writeUInt16LE(0, 36); // internal attrs
  h.writeUInt32LE((e.mode << 16) >>> 0, 38); // external attrs: the unix mode
  h.writeUInt32LE(e.offset, 42);
  name.copy(h, 46);
  return h;
}

/**
 * Read an archive the way an extractor does: the end-of-central-directory
 * record, the central directory, then every entry through its local header.
 * Returns the entries inflated, in central-directory order, and the list of
 * problems found (empty when the archive is sound). Never throws on a bad
 * archive; the caller decides.
 */
export function readArchive(zip) {
  const problems = [];
  const entries = new Map();
  const problem = (message) => problems.push(message);
  if (zip.length < 22) return { entries, problems: ['too short to be a zip'] };
  const tail = zip.subarray(zip.length - 22);
  if (tail.readUInt32LE(0) !== 0x06054b50) problem('end-of-central-directory record not where it should be');
  const count = tail.readUInt16LE(10);
  const cdSize = tail.readUInt32LE(12);
  const cdStart = tail.readUInt32LE(16);
  if (cdStart + cdSize + 22 !== zip.length) problem('central directory does not end at the record');
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) {
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
    const mode = zip.readUInt32LE(p + 38) >>> 16;
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) {
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
    entries.set(name, { data, method, mode, size: usize, compressedSize: csize });
  }
  if (entries.size !== count && problems.length === 0) problem(`central directory lists ${count} entries, read ${entries.size}`);
  return { entries, problems };
}

/**
 * Write `entries` to `out` and prove the file is right.
 *
 * @param {Iterable<[string, Buffer | {data: Buffer, mode?: number}]> | Record<string, Buffer | {data: Buffer, mode?: number}>} entries
 *   Names use forward slashes and no leading slash. They are sorted, so the
 *   same input gives the same archive on every OS.
 * @param {string} out  The archive path; `${out}.sha256` is written beside it.
 * @param {object} [options]
 * @param {Date} [options.stamp]  Every entry's timestamp; the build's own time.
 * @param {number} [options.level]  Deflate level for entries that are deflated (9).
 * @param {Set<string>} [options.stored]  Extensions stored rather than deflated.
 * @param {boolean} [options.sidecar]  Write the .sha256 file (true).
 * @returns {{path: string, name: string, sha256: string, size: number, entries: {name: string, method: number, size: number, compressedSize: number}[], rawBytes: number, storedBytes: number, deflatedBytes: number}}
 */
export function writeArchive(entries, out, options = {}) {
  const { stamp = new Date(), level = 9, stored = STORED_EXTENSIONS, sidecar = true } = options;
  const list = (entries instanceof Map || Symbol.iterator in Object(entries) ? [...entries] : Object.entries(entries))
    .map(([name, value]) => {
      const data = Buffer.isBuffer(value) ? value : Buffer.from(value.data ?? value);
      const mode = Buffer.isBuffer(value) ? 0o100644 : (value.mode ?? 0o100644);
      if (name.startsWith('/') || name.includes('\\') || name.split('/').some((s) => s === '..' || s === '' || s === '.')) {
        throw new Error(`${name}: not a name an archive entry can have`);
      }
      return { name, data, mode };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (list.length === 0) throw new Error('nothing to archive');
  if (list.length >= 0xffff) throw new Error(`${list.length} files is more than a zip without zip64 can list.`);
  const seen = new Set();
  for (const { name } of list) {
    if (seen.has(name)) throw new Error(`${name}: listed twice`);
    seen.add(name);
  }

  const dos = dosStamp(stamp);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fd = fs.openSync(out, 'w');
  let offset = 0;
  const write = (buf) => {
    fs.writeSync(fd, buf);
    offset += buf.length;
  };
  const written = [];
  let rawBytes = 0;
  let storedBytes = 0;
  let deflatedBytes = 0;
  try {
    for (const { name, data, mode } of list) {
      const store = stored.has(path.extname(name).toLowerCase());
      const body = store ? data : zlib.deflateRawSync(data, { level });
      const e = { name, method: store ? 0 : 8, crc: crc32(data), size: data.length, compressedSize: body.length, offset, mode };
      if (e.size >= LIMIT || e.compressedSize >= LIMIT || offset >= LIMIT) throw new Error(`${name} needs zip64, which this writer does not produce.`);
      write(localHeader(e, dos));
      write(body);
      written.push(e);
      rawBytes += e.size;
      if (store) storedBytes += e.compressedSize;
      else deflatedBytes += e.compressedSize;
    }
    const centralStart = offset;
    if (centralStart >= LIMIT) throw new Error('The archive is larger than a zip without zip64 can address.');
    for (const e of written) write(centralHeader(e, dos));
    const centralSize = offset - centralStart;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(written.length, 8);
    eocd.writeUInt16LE(written.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    write(eocd);
    fs.closeSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(out, { force: true });
    throw error;
  }

  // Read it back as an extractor would and compare with what was asked for.
  const zip = fs.readFileSync(out);
  const { entries: read, problems } = readArchive(zip);
  for (const { name, data, mode } of list) {
    const got = read.get(name);
    if (!got) problems.push(`${name}: asked for but not in the archive`);
    else {
      if (!got.data.equals(data)) problems.push(`${name}: differs from the input`);
      if (got.mode !== mode) problems.push(`${name}: mode ${got.mode.toString(8)}, asked for ${mode.toString(8)}`);
    }
  }
  for (const name of read.keys()) if (!seen.has(name)) problems.push(`${name}: in the archive but never asked for`);
  if (problems.length) {
    fs.rmSync(out, { force: true });
    throw new Error(`${problems.length} problem(s) reading the archive back; it was removed:\n  ${problems.join('\n  ')}`);
  }

  const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  const name = path.basename(out);
  if (sidecar) fs.writeFileSync(`${out}.sha256`, `${sha256}  ${name}\n`);
  return {
    path: out,
    name,
    sha256,
    size: zip.length,
    entries: written.map(({ name: n, method, size, compressedSize }) => ({ name: n, method, size, compressedSize })),
    rawBytes,
    storedBytes,
    deflatedBytes,
  };
}
