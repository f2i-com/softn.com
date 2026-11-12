/**
 * An app's bundle with its text files as an editor has them: what is
 * downloaded, handed to the publish page, and saved as a person's own copy.
 * Its pictures and other binary files are the bundle's own, byte for byte.
 *
 * The archive is written here, by hand, and packed by the browser's own
 * `CompressionStream`. The archiver the runtime reads bundles with could
 * write one too, but it is one module, and the half that writes would then
 * be carried by every visitor in what the runtime starts with; this is
 * fetched with the editor. Where the browser has no `CompressionStream` an
 * entry is stored as it is, which every reader of a bundle takes.
 */

import { classifyAsset, openBundleArchive } from '@softn/core';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** `bytes` packed (raw deflate), or null where that is not to be had or saves nothing. */
async function packed(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (bytes.length < 64 || typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new CompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    // Not awaited before the reading starts: a stream nobody reads stops taking what is written.
    const written = writer.write(bytes as BufferSource).then(() => writer.close());
    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as Uint8Array);
      length += (value as Uint8Array).length;
    }
    await written;
    if (length >= bytes.length) return null;
    const out = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  } catch {
    return null;
  }
}

// 1 January 2000, 00:00, as the archive writes a date: every bundle made here says the same, so the same files make the same bytes.
const DOS_TIME = 0;
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;
/** Names are UTF-8. */
const FLAGS = 0x0800;

/** A ZIP archive of `entries`, in order. */
export async function zipOf(entries: ReadonlyArray<readonly [string, Uint8Array]>): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const [path, bytes] of entries) {
    const name = new Uint8Array(encoder.encode(path));
    const deflated = await packed(bytes);
    const data = deflated ?? bytes;
    const method = deflated ? 8 : 0;
    const crc = crc32(bytes);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, FLAGS, true);
    local.setUint16(8, method, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, FLAGS, true);
    central.setUint16(10, method, true);
    central.setUint16(12, DOS_TIME, true);
    central.setUint16(14, DOS_DATE, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, bytes.length, true);
    central.setUint16(28, name.length, true);
    // No extra field, no comment, the one disk, no attributes of its own.
    central.setUint32(42, offset, true);
    directory.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.length + data.length;
  }
  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);

  const out = new Uint8Array(offset + directorySize + 22);
  let at = 0;
  for (const part of [...parts, ...directory, new Uint8Array(end.buffer)]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** What is said of a file of the bundle that cannot be read, where the whole app is asked for. */
export function damagedFile(path: string): Error {
  return new Error(`“${path}” in this app is damaged and cannot be read, so the app cannot be copied or written as a file.`);
}

/**
 * `bundle` with `textFiles` as its text: each written, and a text file of the
 * bundle's that is not among them left out.
 *
 * A file whose text is the bundle's own is written from the bundle's own
 * bytes, not from the text: read as text and written again, a file with a
 * byte order mark loses it, and one that is not UTF-8 has its other
 * characters replaced, in every app the person only meant to change a
 * heading of.
 *
 * Every file is read here, including ones the app never asked for. One that
 * is damaged stops this with a sentence that names it.
 */
export async function bundleWith(bundle: Uint8Array, textFiles: ReadonlyMap<string, string>): Promise<Uint8Array> {
  const archive = openBundleArchive(bundle);
  const names = new Set(archive.names());
  const own = (path: string): Uint8Array | undefined => {
    if (!names.has(path)) return undefined;
    try {
      return archive.read(path);
    } catch {
      throw damagedFile(path);
    }
  };
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const entries: Array<[string, Uint8Array]> = [];
  // By name: a tab's files are read from its bundle as each is asked for, and
  // a damaged one fails the read that asks for it.
  for (const path of textFiles.keys()) {
    // A name that is a binary file's is that file's: text is never written over one.
    if (classifyAsset(path).binary) continue;
    let text: string | undefined;
    try {
      text = textFiles.get(path);
    } catch {
      throw damagedFile(path);
    }
    if (text === undefined) continue;
    const had = own(path);
    entries.push([path, had !== undefined && decoder.decode(had) === text ? had : new Uint8Array(encoder.encode(text))]);
  }
  for (const path of names) {
    if (classifyAsset(path).binary) entries.push([path, own(path) as Uint8Array]);
    // A text file of the bundle's that `textFiles` has not: taken out by the
    // person, or never readable. Read here to tell the two apart, so that a
    // damaged file is said, and not quietly left out as if it had been removed.
    else if (!textFiles.has(path)) own(path);
  }
  if (entries.length > 0xffff) throw new Error('The app has more files than a bundle holds.');
  return zipOf(entries);
}

/** Offer `bytes` to the person as a file called `name`. */
export function downloadBundle(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/[\\/:*?"<>|]+/g, '-')}.softn`;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
