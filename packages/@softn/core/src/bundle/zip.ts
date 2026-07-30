/**
 * Validated reading of a .softn bundle.
 *
 * A bundle is untrusted input: it arrives by download, drag-and-drop or sync.
 * fflate decompresses to whatever size the archive *declares* and verifies
 * nothing, so without these checks a crafted bundle can hand one reader a
 * truncated file while every other reader sees the whole one — and can inflate
 * far beyond what its compressed size suggests.
 *
 * The walk over the central directory below is not a preflight in front of
 * `unzipSync`; it *is* the extractor. It used to be a preflight, and that split
 * was the bug: the two halves disagreed about which archive they were looking
 * at. `unzipSync` takes its entry count from EOCD+8 ("entries on this disk")
 * while the checks read EOCD+10 ("total entries"), so a two-byte edit made the
 * checks inspect one entry while fflate inflated every one of them — and by the
 * time control came back the whole archive was already in memory, with the
 * caps, the checksums and the size declarations all unverified. Owning the loop
 * means every byte allocated has been charged against a budget first.
 *
 * This lives in core because it was previously duplicated: softn-web and
 * softn-loader each carried a hardened copy, while the builder opened bundles
 * through a bare `unzipSync` with none of it. Opening a hostile .softn in the
 * builder therefore bypassed every defence the other two paths had.
 */

import { inflateSync } from 'fflate';

const MAX_ZIP_INPUT_BYTES = 200 * 1024 * 1024; // 200 MB
const MAX_ZIP_ENTRIES = 10_000;
const MAX_ZIP_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_ZIP_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** What the central directory claims about one entry, and where its bytes are. */
interface DeclaredEntry {
  name: string;
  crc32: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number;
}

/**
 * CRC-32 — the only field in a ZIP that actually attests to an entry's bytes.
 *
 * fflate decompresses to the *declared* size and verifies nothing, so a bundle
 * that understates a size is silently truncated to it. Comparing the length
 * back against the declaration does not help: the lie is self-consistent. Only
 * the checksum catches it, and without it the same file reads differently here
 * than in any other reader.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function readCentralDirectory(data: Uint8Array): DeclaredEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const EOCD_SIGNATURE = 0x06054b50;
  const CEN_SIGNATURE = 0x02014b50;
  const LFH_SIGNATURE = 0x04034b50;
  const MAX_COMMENT = 0xffff;
  const eocdMinOffset = Math.max(0, data.byteLength - (22 + MAX_COMMENT));

  let eocdOffset = -1;
  for (let i = data.byteLength - 22; i >= eocdMinOffset; i--) {
    if (view.getUint32(i, true) !== EOCD_SIGNATURE) continue;
    // Binary payloads — images especially — contain these four bytes often
    // enough that the signature alone is not proof. A real EOCD is preceded by
    // the central directory it describes, so require that to fit.
    const candidateSize = view.getUint32(i + 12, true);
    const candidateOffset = view.getUint32(i + 16, true);
    if (candidateOffset + candidateSize <= i) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid ZIP: missing end-of-central-directory');
  }

  // The two entry counts are separate 16-bit fields and nothing in the format
  // forces them to agree. Different readers pick different ones, so an archive
  // whose fields disagree is one that does not have a single meaning — reject
  // it rather than choose.
  const entriesThisDisk = view.getUint16(eocdOffset + 8, true);
  const entriesTotal = view.getUint16(eocdOffset + 10, true);
  if (entriesThisDisk !== entriesTotal) {
    throw new Error('Corrupt ZIP: end-of-central-directory entry counts disagree');
  }
  const entryCount = entriesThisDisk;
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error('Bundle has too many files');
  }

  const declared: DeclaredEntry[] = [];
  const seenLocalHeaders = new Set<number>();
  const decoder = new TextDecoder();
  let offset = centralDirOffset;
  let totalUncompressed = 0;
  let totalCompressed = 0;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > data.byteLength || view.getUint32(offset, true) !== CEN_SIGNATURE) {
      throw new Error('Invalid ZIP central directory entry');
    }

    const method = view.getUint16(offset + 10, true);
    const declaredCrc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error('ZIP64 bundles are not supported');
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new Error(`Unsupported compression method in bundle: ${method}`);
    }
    // A stored entry is its own compressed form, so the two sizes describing it
    // have to be the same number. Letting them differ meant the budget was
    // charged one figure while the extraction copied the other.
    if (method === METHOD_STORED && compressedSize !== uncompressedSize) {
      throw new Error('Corrupt ZIP: stored entry declares two different sizes');
    }
    if (uncompressedSize > MAX_ZIP_FILE_BYTES) {
      throw new Error('File too large in bundle');
    }

    // Two entries pointing at one local header is how a small archive claims a
    // large payload many times over: the budget below is charged once per
    // entry, but the bytes are extracted once per entry too.
    if (seenLocalHeaders.has(localHeaderOffset)) {
      throw new Error('Corrupt ZIP: two entries share a local header');
    }
    seenLocalHeaders.add(localHeaderOffset);

    // The compressed bytes have to actually exist in the file. A stored entry
    // extracts `compressedSize` bytes regardless of what it claims uncompressed,
    // so budgeting only the uncompressed figure left that path unbounded.
    totalCompressed += compressedSize;
    if (totalCompressed > data.byteLength) {
      throw new Error('Corrupt ZIP: entries claim more data than the file holds');
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('Bundle contents too large');
    }

    if (localHeaderOffset + 30 > data.byteLength) {
      throw new Error('Corrupt ZIP: local header out of bounds');
    }
    if (view.getUint32(localHeaderOffset, true) !== LFH_SIGNATURE) {
      throw new Error('Corrupt ZIP: invalid local file header');
    }

    // The name and extra field of the *local* header may differ in length from
    // the central directory's copy, so the payload can only be located here.
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > data.byteLength) {
      throw new Error('Corrupt ZIP: entry data out of bounds');
    }

    const nameBytes = data.slice(offset + 46, offset + 46 + fileNameLength);
    declared.push({
      name: decoder.decode(nameBytes).replace(/\\/g, '/'),
      crc32: declaredCrc,
      method,
      compressedSize,
      uncompressedSize,
      dataOffset,
    });

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return declared;
}

/**
 * Produce one entry's bytes, allocating no more than it declared.
 *
 * fflate writes into the buffer it is handed and never grows it, and a write
 * past the end of a typed array is discarded rather than resized — so an entry
 * whose deflate stream expands beyond its declared size costs the declared size
 * and no more. What comes back is then short or wrong, and the checksum below
 * refuses it.
 */
function extractEntry(data: Uint8Array, entry: DeclaredEntry): Uint8Array {
  const raw = data.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === METHOD_STORED) {
    return raw.slice();
  }
  try {
    return inflateSync(raw, { out: new Uint8Array(entry.uncompressedSize) });
  } catch {
    throw new Error(`Corrupt bundle: could not decompress ${entry.name}`);
  }
}

/** Names that cannot refer to a file inside a bundle, and are only ever escapes. */
function isUnsafeEntryName(path: string): boolean {
  if (
    path.startsWith('/') ||
    path.includes('..') ||
    path.includes('\0') ||
    /^[a-zA-Z]:/.test(path)
  ) {
    return true;
  }
  // `.` and empty segments survive the substring checks above but still make a
  // path that names the same file two ways.
  return path.split('/').some((segment) => segment === '.' || segment === '');
}

/**
 * Read every file in a bundle, rejecting anything that does not check out.
 *
 * Returns normalized path -> bytes. Directory entries, absolute paths, paths
 * containing `..` or NUL, and drive-letter paths are dropped rather than
 * returned: none of them can name a file inside a bundle, and all of them are
 * escape attempts.
 */
export function readBundleEntries(data: Uint8Array): Map<string, Uint8Array> {
  if (data.byteLength > MAX_ZIP_INPUT_BYTES) {
    throw new Error('Bundle too large');
  }

  const declared = readCentralDirectory(data);
  const files = new Map<string, Uint8Array>();
  let totalBytes = 0;

  for (const entry of declared) {
    if (entry.name.endsWith('/')) continue;
    if (isUnsafeEntryName(entry.name)) continue;

    // Charged before the buffer is allocated, not after it is filled: this is
    // the whole point of extracting entry by entry, so the cap bounds what the
    // bundle can make this process hold rather than describing it afterwards.
    totalBytes += entry.uncompressedSize;
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('Bundle contents too large');
    }

    const content = extractEntry(data, entry);

    // Check what came out against what the archive claimed. Without this a
    // crafted bundle silently hands this reader a truncated file while every
    // other reader sees the whole one.
    if (content.byteLength !== entry.uncompressedSize) {
      throw new Error(`Corrupt bundle: size mismatch for ${entry.name}`);
    }
    if (crc32(content) !== entry.crc32) {
      throw new Error(`Corrupt bundle: checksum mismatch for ${entry.name}`);
    }

    files.set(entry.name, content);
  }

  return files;
}
