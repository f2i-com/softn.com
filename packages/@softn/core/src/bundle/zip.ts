/**
 * Validated reading of a .softn bundle.
 *
 * A bundle is untrusted input: it arrives by download, drag-and-drop or sync.
 * fflate decompresses to whatever size the archive *declares* and verifies
 * nothing, so without these checks a crafted bundle can hand one reader a
 * truncated file while every other reader sees the whole one — and can inflate
 * far beyond what its compressed size suggests.
 *
 * This lives in core because it was previously duplicated: softn-web and
 * softn-loader each carried a hardened copy, while the builder opened bundles
 * through a bare `unzipSync` with none of it. Opening a hostile .softn in the
 * builder therefore bypassed every defence the other two paths had.
 */

import { unzipSync } from 'fflate';

const MAX_ZIP_INPUT_BYTES = 200 * 1024 * 1024; // 200 MB
const MAX_ZIP_ENTRIES = 10_000;
const MAX_ZIP_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_ZIP_FILE_BYTES = 50 * 1024 * 1024; // 50 MB


/** What the central directory claims about one entry. */
interface DeclaredEntry {
  crc32: number;
  uncompressedSize: number;
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

function preflightZip(data: Uint8Array): Map<string, DeclaredEntry> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const EOCD_SIGNATURE = 0x06054b50;
  const CEN_SIGNATURE = 0x02014b50;
  const LFH_SIGNATURE = 0x04034b50;
  const MAX_COMMENT = 0xffff;
  const eocdMinOffset = Math.max(0, data.byteLength - (22 + MAX_COMMENT));

  let eocdOffset = -1;
  for (let i = data.byteLength - 22; i >= eocdMinOffset; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid ZIP: missing end-of-central-directory');
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirSize = view.getUint32(eocdOffset + 12, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error('Bundle has too many files');
  }
  if (centralDirSize > data.byteLength || centralDirOffset > data.byteLength) {
    throw new Error('Invalid ZIP central directory');
  }
  if (centralDirOffset + centralDirSize > data.byteLength) {
    throw new Error('Corrupt ZIP: central directory out of bounds');
  }

  const declared = new Map<string, DeclaredEntry>();
  const seenLocalHeaders = new Set<number>();
  let offset = centralDirOffset;
  let totalUncompressed = 0;
  let totalCompressed = 0;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > data.byteLength || view.getUint32(offset, true) !== CEN_SIGNATURE) {
      throw new Error('Invalid ZIP central directory entry');
    }

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

    const nameBytes = data.slice(offset + 46, offset + 46 + fileNameLength);
    const entryName = new TextDecoder().decode(nameBytes).replace(/\\/g, '/');
    declared.set(entryName, { crc32: declaredCrc, uncompressedSize });

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return declared;
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

  const declared = preflightZip(data);
  const unzipped = unzipSync(data);
  const entries = Object.entries(unzipped);
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error('Bundle has too many files');
  }

  const files = new Map<string, Uint8Array>();
  let totalBytes = 0;

  for (const [path, content] of entries) {
    const normalizedPath = path.replace(/\\/g, '/');
    if (
      normalizedPath.startsWith('/') ||
      normalizedPath.includes('..') ||
      normalizedPath.includes('\0') ||
      /^[a-zA-Z]:/.test(normalizedPath)
    ) {
      continue;
    }
    if (normalizedPath.endsWith('/')) continue;

    if (content.byteLength > MAX_ZIP_FILE_BYTES) {
      throw new Error(`File too large in bundle: ${normalizedPath}`);
    }

    // Check what came out against what the archive claimed. Without this a
    // crafted bundle silently hands this reader a truncated file while every
    // other reader sees the whole one.
    const claim = declared.get(normalizedPath) ?? declared.get(path);
    if (claim) {
      if (content.byteLength !== claim.uncompressedSize) {
        throw new Error(`Corrupt bundle: size mismatch for ${normalizedPath}`);
      }
      if (crc32(content) !== claim.crc32) {
        throw new Error(`Corrupt bundle: checksum mismatch for ${normalizedPath}`);
      }
    }

    totalBytes += content.byteLength;
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('Bundle contents too large');
    }

    files.set(normalizedPath, content);
  }

  return files;
}
