/**
 * A ZIP writer for tests that says exactly what it is told to, true or not.
 *
 * fflate's `zipSync` only writes honest archives, and patching one byte at a
 * time gets as far as a count or a size. The reader's job is the archives no
 * writer produces: a size that is not the stream's, a second directory, a name
 * given twice in two fields. Each field here defaults to the honest value and
 * can be overridden on its own.
 */
import { deflateSync } from 'fflate';

export const LFH_SIGNATURE = 0x04034b50;
export const CEN_SIGNATURE = 0x02014b50;
export const EOCD_SIGNATURE = 0x06054b50;
export const EOCD64_SIGNATURE = 0x06064b50;
export const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;

/** jsdom's TextEncoder returns a cross-realm Uint8Array, which fflate does not recognise. */
export const enc = (s: string): Uint8Array => Uint8Array.from(new TextEncoder().encode(s));
export const dec = (b: Uint8Array | undefined): string => new TextDecoder().decode(b);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface CraftEntry {
  /** The name both headers carry, as text or as the exact bytes. */
  name: string | Uint8Array;
  /** The file's content; compressed here unless `payload` is given. */
  data?: Uint8Array;
  /** 0 stored (the default) or 8 deflate. */
  method?: number;
  /** The bytes that follow the local header, when they are not `data` under `method`. */
  payload?: Uint8Array;
  /** General purpose flags, in both headers. */
  flags?: number;
  /** What the headers declare, when it is not the truth. */
  crc?: number;
  uncompressedSize?: number;
  compressedSize?: number;
  /** A name for the local header alone. */
  localName?: string | Uint8Array;
  centralExtra?: Uint8Array;
  localExtra?: Uint8Array;
  comment?: Uint8Array;
  versionMadeBy?: number;
  externalAttributes?: number;
  /** Point the central record at this offset instead of the entry's own local header. */
  localHeaderOffset?: number;
}

export interface CraftOptions {
  /** Bytes before the first local header. */
  prefix?: Uint8Array;
  /** Bytes between the last entry and the central directory. */
  beforeDirectory?: Uint8Array;
  /** Bytes between the central directory and the end record. */
  beforeEnd?: Uint8Array;
  /** The archive comment. */
  comment?: Uint8Array;
  /** Bytes after the end record and its comment. */
  trailing?: Uint8Array;
  entriesThisDisk?: number;
  entriesTotal?: number;
  directorySize?: number;
  directoryOffset?: number;
  commentLength?: number;
}

export interface Crafted {
  bytes: Uint8Array;
  /** Where the central directory starts, and how long it is. */
  directoryOffset: number;
  directorySize: number;
  /** Where the end record starts. */
  endOffset: number;
  /** Each entry's local header offset, in order. */
  localOffsets: number[];
}

function nameBytes(name: string | Uint8Array): Uint8Array {
  return typeof name === 'string' ? enc(name) : name;
}

function localHeader(entry: CraftEntry, payload: Uint8Array, crc: number, size: number): Uint8Array {
  const name = nameBytes(entry.localName ?? entry.name);
  const extra = entry.localExtra ?? new Uint8Array(0);
  const head = new Uint8Array(30 + name.length + extra.length);
  const view = new DataView(head.buffer);
  view.setUint32(0, LFH_SIGNATURE, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, entry.flags ?? 0, true);
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

function centralRecord(entry: CraftEntry, payload: Uint8Array, crc: number, size: number, offset: number): Uint8Array {
  const name = nameBytes(entry.name);
  const extra = entry.centralExtra ?? new Uint8Array(0);
  const comment = entry.comment ?? new Uint8Array(0);
  const rec = new Uint8Array(46 + name.length + extra.length + comment.length);
  const view = new DataView(rec.buffer);
  view.setUint32(0, CEN_SIGNATURE, true);
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
  view.setUint32(38, entry.externalAttributes ?? 0, true);
  view.setUint32(42, entry.localHeaderOffset ?? offset, true);
  rec.set(name, 46);
  rec.set(extra, 46 + name.length);
  rec.set(comment, 46 + name.length + extra.length);
  return rec;
}

/** The local headers and payloads of `entries`, laid out from `base`, and the central records for them. */
export function craftRecords(entries: CraftEntry[], base = 0): { body: Uint8Array; directory: Uint8Array; localOffsets: number[] } {
  const bodyParts: Uint8Array[] = [];
  const records: Uint8Array[] = [];
  const localOffsets: number[] = [];
  let at = base;
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array(0);
    const payload = entry.payload ?? (entry.method === 8 ? deflateSync(data) : data);
    const crc = entry.crc ?? crc32(data);
    const size = entry.uncompressedSize ?? data.length;
    const head = localHeader(entry, payload, crc, size);
    localOffsets.push(at);
    records.push(centralRecord(entry, payload, crc, size, at));
    bodyParts.push(head, payload);
    at += head.length + payload.length;
  }
  return { body: concat(...bodyParts), directory: concat(...records), localOffsets };
}

/** An end-of-central-directory record. */
export function craftEnd(count: number, directorySize: number, directoryOffset: number, comment: Uint8Array = new Uint8Array(0), options: CraftOptions = {}): Uint8Array {
  const end = new Uint8Array(22 + comment.length);
  const view = new DataView(end.buffer);
  view.setUint32(0, EOCD_SIGNATURE, true);
  view.setUint16(8, options.entriesThisDisk ?? count, true);
  view.setUint16(10, options.entriesTotal ?? count, true);
  view.setUint32(12, options.directorySize ?? directorySize, true);
  view.setUint32(16, options.directoryOffset ?? directoryOffset, true);
  view.setUint16(20, options.commentLength ?? comment.length, true);
  end.set(comment, 22);
  return end;
}

/** A whole archive: entries, their directory, the end record. */
export function craftZip(entries: CraftEntry[], options: CraftOptions = {}): Crafted {
  const prefix = options.prefix ?? new Uint8Array(0);
  const { body, directory, localOffsets } = craftRecords(entries, prefix.length);
  const beforeDirectory = options.beforeDirectory ?? new Uint8Array(0);
  const beforeEnd = options.beforeEnd ?? new Uint8Array(0);
  const directoryOffset = prefix.length + body.length + beforeDirectory.length;
  const end = craftEnd(entries.length, directory.length, directoryOffset, options.comment, options);
  const endOffset = directoryOffset + directory.length + beforeEnd.length;
  const bytes = concat(prefix, body, beforeDirectory, directory, beforeEnd, end, options.trailing ?? new Uint8Array(0));
  return { bytes, directoryOffset, directorySize: directory.length, endOffset, localOffsets };
}

/**
 * A ZIP64 end record and its locator, pointing at a central directory. Readers
 * that honour ZIP64 look for the locator in the 20 bytes before the ordinary
 * end record and, finding it, take the directory from here instead.
 */
export function craftZip64End(count: number, directorySize: number, directoryOffset: number, recordOffset: number): Uint8Array {
  const out = new Uint8Array(56 + 20);
  const view = new DataView(out.buffer);
  view.setUint32(0, EOCD64_SIGNATURE, true);
  view.setBigUint64(4, 44n, true);
  view.setUint16(12, 45, true);
  view.setUint16(14, 45, true);
  view.setBigUint64(24, BigInt(count), true);
  view.setBigUint64(32, BigInt(count), true);
  view.setBigUint64(40, BigInt(directorySize), true);
  view.setBigUint64(48, BigInt(directoryOffset), true);
  view.setUint32(56, EOCD64_LOCATOR_SIGNATURE, true);
  view.setBigUint64(64, BigInt(recordOffset), true);
  view.setUint32(72, 1, true);
  return out;
}

/** An Info-ZIP Unicode Path extra field (0x7075) giving `path` as the name of the entry whose header name is `headerName`. */
export function unicodePathExtra(headerName: string | Uint8Array, path: string): Uint8Array {
  const utf8 = enc(path);
  const out = new Uint8Array(4 + 5 + utf8.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0x7075, true);
  view.setUint16(2, 5 + utf8.length, true);
  view.setUint8(4, 1);
  view.setUint32(5, crc32(nameBytes(headerName)), true);
  out.set(utf8, 9);
  return out;
}
