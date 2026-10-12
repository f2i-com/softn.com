/**
 * A ZIP writer for tests that writes exactly what it is told, true or not:
 * the same writer as packages/@softn/bundle-format/test/craft.ts, for the
 * directory's suites. An ordinary zip tool only writes honest archives; the
 * directory has to refuse the ones no tool writes (a size that is not the
 * stream's, a second directory, a name given twice), so each field defaults
 * to the honest value and can be overridden on its own.
 */
import zlib from 'node:zlib';

export const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
export const concat = (...parts) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))));
export const deflate = (bytes, level = 6) => new Uint8Array(zlib.deflateRawSync(bytes, { level }));

const TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const nameBytes = (name) => (typeof name === 'string' ? enc(name) : name);

function localHeader(entry, payload, crc, size) {
  const name = nameBytes(entry.localName ?? entry.name);
  const extra = entry.localExtra ?? new Uint8Array(0);
  const head = new Uint8Array(30 + name.length + extra.length);
  const view = new DataView(head.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, entry.localFlags ?? entry.flags ?? 0, true);
  view.setUint16(8, entry.method ?? 0, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, entry.compressedSize ?? payload.length, true);
  view.setUint32(22, size, true);
  view.setUint16(26, name.length, true);
  view.setUint16(28, extra.length, true);
  head.set(name, 30);
  head.set(extra, 30 + name.length);
  return head;
}

function centralRecord(entry, payload, crc, size, offset) {
  const name = nameBytes(entry.name);
  const extra = entry.centralExtra ?? new Uint8Array(0);
  const comment = entry.comment ?? new Uint8Array(0);
  const rec = new Uint8Array(46 + name.length + extra.length + comment.length);
  const view = new DataView(rec.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, entry.versionMadeBy ?? 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, entry.flags ?? 0, true);
  view.setUint16(10, entry.method ?? 0, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, entry.compressedSize ?? payload.length, true);
  view.setUint32(24, size, true);
  view.setUint16(28, name.length, true);
  view.setUint16(30, extra.length, true);
  view.setUint16(32, comment.length, true);
  view.setUint32(42, entry.localHeaderOffset ?? offset, true);
  rec.set(name, 46);
  rec.set(extra, 46 + name.length);
  rec.set(comment, 46 + name.length + extra.length);
  return rec;
}

/** Local headers and payloads laid out from `base`, and the central records for them. */
export function craftRecords(entries, base = 0) {
  const body = [];
  const records = [];
  const localOffsets = [];
  let at = base;
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array(0);
    const payload = entry.payload ?? (entry.method === 8 ? deflate(data) : data);
    const crc = entry.crc ?? crc32(data);
    const size = entry.uncompressedSize ?? data.length;
    const head = localHeader(entry, payload, crc, size);
    localOffsets.push(at);
    records.push(centralRecord(entry, payload, crc, size, at));
    body.push(head, payload);
    at += head.length + payload.length;
  }
  return { body: concat(...body), directory: concat(...records), localOffsets };
}

/** An end-of-central-directory record. */
export function craftEnd(count, directorySize, directoryOffset, comment = new Uint8Array(0), options = {}) {
  const end = new Uint8Array(22 + comment.length);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, options.entriesThisDisk ?? count, true);
  view.setUint16(10, options.entriesTotal ?? count, true);
  view.setUint32(12, options.directorySize ?? directorySize, true);
  view.setUint32(16, options.directoryOffset ?? directoryOffset, true);
  view.setUint16(20, options.commentLength ?? comment.length, true);
  end.set(comment, 22);
  return end;
}

/** A whole archive: entries, their directory, the end record. */
export function craftZip(entries, options = {}) {
  const prefix = options.prefix ?? new Uint8Array(0);
  const { body, directory } = craftRecords(entries, prefix.length);
  const beforeEnd = options.beforeEnd ?? new Uint8Array(0);
  const directoryOffset = prefix.length + body.length;
  const end = craftEnd(entries.length, directory.length, directoryOffset, options.comment, options);
  return concat(prefix, body, directory, beforeEnd, end, options.trailing ?? new Uint8Array(0));
}

/** A ZIP64 end record and its locator, naming a central directory. */
export function craftZip64End(count, directorySize, directoryOffset, recordOffset) {
  const out = new Uint8Array(56 + 20);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x06064b50, true);
  view.setBigUint64(4, 44n, true);
  view.setUint16(12, 45, true);
  view.setUint16(14, 45, true);
  view.setBigUint64(24, BigInt(count), true);
  view.setBigUint64(32, BigInt(count), true);
  view.setBigUint64(40, BigInt(directorySize), true);
  view.setBigUint64(48, BigInt(directoryOffset), true);
  view.setUint32(56, 0x07064b50, true);
  view.setBigUint64(64, BigInt(recordOffset), true);
  view.setUint32(72, 1, true);
  return out;
}

/** An Info-ZIP Unicode Path extra field giving `path` as the name of the entry whose header name is `headerName`. */
export function unicodePathExtra(headerName, path) {
  const utf8 = enc(path);
  const out = new Uint8Array(9 + utf8.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0x7075, true);
  view.setUint16(2, 5 + utf8.length, true);
  view.setUint8(4, 1);
  view.setUint32(5, crc32(nameBytes(headerName)), true);
  out.set(utf8, 9);
  return out;
}
