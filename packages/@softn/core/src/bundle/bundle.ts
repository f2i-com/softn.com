/**
 * SoftN Bundle Reader/Writer
 *
 * Handles reading and writing .softn bundle files.
 * Bundles are ZIP archives containing UI, logic, and data files.
 */

import type {
  SoftNManifest,
  SoftNBundle,
  SoftNBundleInput,
  BundleFile,
  UIFile,
  LogicFile,
  XDBBundleData,
  BundleCreateOptions,
  BundleLoadOptions,
  UIImport,
  LogicImport,
} from './types';
import { validateManifest, createDefaultManifest } from './types';
import { MAX_ZIP_INPUT_BYTES, readBundleEntries } from './zip';
import { classifyAsset } from './asset-classification';
import type { XDBService } from '../runtime/xdb';

// ============================================================================
// Bundle Reader
// ============================================================================

/**
 * Read and parse a .softn bundle from a Uint8Array
 */
export async function readBundle(
  data: Uint8Array,
  options: BundleLoadOptions = {}
): Promise<SoftNBundle> {
  const { validate = true, eager = true } = options;

  // Read through the shared hardened reader. This file used to carry its own
  // ZIP reader, and the two drifted: this one never checked a CRC, so a bundle
  // that tampered with a stored entry's bytes opened here while the reader
  // softn-web and softn-loader use rejected it.
  const zipEntries = readBundleEntries(data);

  // Find and parse manifest
  const manifestEntry = zipEntries.get('manifest.json');
  if (!manifestEntry) {
    throw new Error('Bundle missing manifest.json');
  }

  const manifestText = new TextDecoder().decode(manifestEntry);
  const manifest = JSON.parse(manifestText);

  if (validate && !validateManifest(manifest)) {
    throw new Error('Invalid manifest.json');
  }
  const normalizedMain = manifest.main.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (validate && !zipEntries.has(normalizedMain)) {
    throw new Error(`Bundle missing main entry: ${manifest.main}`);
  }

  // Create bundle structure
  const bundle: SoftNBundle = {
    manifest: normalizedMain === manifest.main ? manifest : { ...manifest, main: normalizedMain },
    files: new Map(),
    uiFiles: new Map(),
    logicFiles: new Map(),
    xdbData: new Map(),
  };

  // Process all files
  for (const [path, content] of zipEntries) {
    const fileType = getFileType(path);
    const file: BundleFile = {
      path,
      type: fileType,
      content: fileType === 'asset' ? content : new TextDecoder().decode(content),
      size: content.byteLength,
    };

    bundle.files.set(path, file);

    // Parse files if eager loading
    if (eager) {
      if (fileType === 'ui') {
        bundle.uiFiles.set(path, parseUIFile(path, file.content as string));
      } else if (fileType === 'logic') {
        bundle.logicFiles.set(path, parseLogicFile(path, file.content as string));
      } else if (fileType === 'xdb') {
        bundle.xdbData.set(path, parseXDBFile(path, file.content as string));
      }
    }
  }

  return bundle;
}

/**
 * Read a bundle from a file path (Node.js/Tauri)
 */
export async function readBundleFromFile(
  filePath: string,
  options: BundleLoadOptions = {}
): Promise<SoftNBundle> {
  // Try Tauri first
  if (typeof window !== 'undefined' && '__TAURI__' in window) {
    let tauriFs: { readFile(path: string): Promise<Uint8Array> } | undefined;
    try {
      // Dynamic import to avoid bundler resolving
      const tauriModuleName = '@tauri-apps/plugin-fs';
      tauriFs = await import(/* @vite-ignore */ tauriModuleName);
    } catch {
      // Tauri fs not available
    }

    // Keep I/O and bundle-validation errors intact. The old broad catch also
    // swallowed a missing file or a corrupt archive and eventually reported
    // "No file system API available", even though the API worked perfectly.
    if (tauriFs) {
      const data = await tauriFs.readFile(filePath);
      return readBundle(data, options);
    }
  }

  // Try Node.js (use dynamic import)
  let fs: typeof import('fs') | undefined;
  try {
    // Dynamic import to avoid bundler resolving
    const fsModuleName = 'fs';
    fs = await import(/* @vite-ignore */ fsModuleName);
  } catch {
    // Node.js fs not available
  }

  if (fs) {
    const data = fs.readFileSync(filePath);
    return readBundle(new Uint8Array(data), options);
  }

  throw new Error('No file system API available');
}

/**
 * Read a bundle from a URL (browser)
 */
export async function readBundleFromUrl(
  url: string,
  options: BundleLoadOptions = {}
): Promise<SoftNBundle> {
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) {
    // A failed response can still carry a large body. The caller will never
    // inspect it, so do not leave the browser downloading it in the background.
    try {
      await response.body?.cancel();
    } catch {
      // Preserve the useful HTTP error if the stream was already disturbed.
    }
    throw new Error(`Failed to fetch bundle: ${response.statusText}`);
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ZIP_INPUT_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // The size violation remains the actionable failure.
    }
    throw new Error('Bundle archive is too large');
  }

  // Enforce the compressed-input cap while downloading, not after
  // response.arrayBuffer() has already allocated attacker-controlled memory.
  // Content-Length is only a hint and can be absent or dishonest.
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      let next = await reader.read();
      while (!next.done) {
        const { value } = next;
        if (value) {
          total += value.byteLength;
          if (total > MAX_ZIP_INPUT_BYTES) {
            try {
              await reader.cancel();
            } catch {
              // The size violation remains the actionable failure.
            }
            throw new Error('Bundle archive is too large');
          }
          chunks.push(value);
        }
        next = await reader.read();
      }
    } finally {
      reader.releaseLock();
    }

    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return readBundle(data, options);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_ZIP_INPUT_BYTES) {
    throw new Error('Bundle archive is too large');
  }
  return readBundle(new Uint8Array(arrayBuffer), options);
}

// ============================================================================
// Bundle Writer
// ============================================================================

/**
 * Create a .softn bundle from manifest and files map
 */
export async function createBundleFromFiles(
  manifest: SoftNManifest,
  files: Map<string, string | Uint8Array>
): Promise<Uint8Array> {
  const zipEntries = new Map<string, Uint8Array>();

  // Add manifest
  const manifestJson = JSON.stringify(manifest, null, 2);
  zipEntries.set('manifest.json', new TextEncoder().encode(manifestJson));

  // Add all files
  for (const [path, content] of files) {
    if (typeof content === 'string') {
      zipEntries.set(path, new TextEncoder().encode(content));
    } else {
      zipEntries.set(path, content);
    }
  }

  return writeZip(zipEntries);
}

/**
 * Create a .softn bundle from a SoftNBundleInput object
 */
export async function createBundle(bundle: SoftNBundleInput): Promise<Uint8Array> {
  const zipEntries = new Map<string, Uint8Array>();

  // Add manifest
  const manifestJson = JSON.stringify(bundle.manifest, null, 2);
  zipEntries.set('manifest.json', new TextEncoder().encode(manifestJson));

  // Add all files from the files array
  for (const file of bundle.files) {
    if (file.path === 'manifest.json') continue; // Skip manifest, already added

    if (typeof file.content === 'string') {
      zipEntries.set(file.path, new TextEncoder().encode(file.content));
    } else if (file.content instanceof Uint8Array) {
      zipEntries.set(file.path, file.content);
    } else {
      // Handle Buffer (Node.js) - convert to Uint8Array
      zipEntries.set(file.path, new Uint8Array(file.content as ArrayBufferLike));
    }
  }

  return writeZip(zipEntries);
}

/**
 * Create a bundle from a source directory
 */
export async function createBundleFromDirectory(
  _options: BundleCreateOptions
): Promise<Uint8Array> {
  // This would need file system access - implement based on environment
  // For now, throw an error indicating it needs to be called from Node/Tauri
  throw new Error('createBundleFromDirectory requires Node.js or Tauri environment');
}

// ============================================================================
// File Parsing
// ============================================================================

/**
 * Determine file type from path
 */
function getFileType(path: string): BundleFile['type'] {
  if (path === 'manifest.json') return 'manifest';
  if (path.endsWith('.ui')) return 'ui';
  if (path.endsWith('.logic')) return 'logic';
  if (path.endsWith('.xdb')) return 'xdb';

  // Anything the shared registry marks binary must stay 'asset': readBundle
  // decodes every other type as UTF-8, which is not reversible. The list that
  // lived here knew images and fonts only, so a model or an audio file fell
  // to 'other' and its bytes were corrupted by the decode.
  if (classifyAsset(path).binary) return 'asset';

  return 'other';
}

/**
 * Parse a .ui file
 */
function parseUIFile(path: string, content: string): UIFile {
  const imports: UIImport[] = [];

  // Extract imports using regex (before full parsing)
  const importRegex = /<import\s+(?:(\w+)\s+)?(?:\{([^}]+)\}\s+)?from\s+["']([^"']+)["']\s*\/>/g;
  let match;

  while ((match = importRegex.exec(content)) !== null) {
    const [, defaultImport, namedImportsStr, source] = match;
    const namedImports = namedImportsStr
      ? namedImportsStr
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    imports.push({
      defaultImport: defaultImport || undefined,
      namedImports,
      source,
      type: resolveImportType(source),
    });
  }

  // Extract style
  const styleMatch = content.match(/<style>([\s\S]*?)<\/style>/);
  const style = styleMatch ? styleMatch[1].trim() : undefined;

  // For now, store the template content as-is
  // Full parsing happens when rendering
  return {
    path,
    imports,
    template: [], // Will be parsed lazily
    style,
    component: undefined, // Will be parsed lazily
  };
}

/**
 * Parse a .logic file
 */
function parseLogicFile(path: string, content: string): LogicFile {
  const imports: LogicImport[] = [];

  // Extract imports using regex
  const importRegex = /import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]+)\})?\s*from\s+["']([^"']+)["']/g;
  let match;

  while ((match = importRegex.exec(content)) !== null) {
    const [, defaultImport, namedImportsStr, source] = match;
    const namedImports = namedImportsStr
      ? namedImportsStr
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    imports.push({
      defaultImport: defaultImport || undefined,
      namedImports,
      source,
      type: resolveImportType(source),
    });
  }

  // Extract exports (state, functions, computed)
  const stateRegex = /(?:export\s+)?(?:let|const)\s+(\w+)\s*=\s*([^;]+);/g;
  const functionRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
  const computedRegex = /(?:export\s+)?const\s+(\w+)\s*=\s*\$computed/g;

  const state: Record<string, unknown> = {};
  const functions: string[] = [];
  const computed: string[] = [];

  while ((match = stateRegex.exec(content)) !== null) {
    const [, name, value] = match;
    try {
      // Try to parse the initial value
      state[name] = JSON.parse(value.trim());
    } catch {
      state[name] = undefined;
    }
  }

  while ((match = functionRegex.exec(content)) !== null) {
    functions.push(match[1]);
  }

  while ((match = computedRegex.exec(content)) !== null) {
    computed.push(match[1]);
  }

  return {
    path,
    imports,
    exports: { state, functions, computed },
    code: content,
  };
}

/**
 * Parse a .xdb file (bundled database)
 */
const XDB_FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export function parseXDBFile(path: string, content: string): XDBBundleData {
  const fallbackCollection = path.replace('.xdb', '');
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { collection: fallbackCollection, records: [] };
    }
    const data = parsed as Record<string, unknown>;
    const records = Array.isArray(data.records)
      ? data.records.flatMap((record): XDBBundleData['records'] => {
          if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
          const candidate = record as Record<string, unknown>;
          if (typeof candidate.id !== 'string') return [];

          const hasNestedData = Object.prototype.hasOwnProperty.call(candidate, 'data');
          let recordData: Record<string, unknown>;
          if (hasNestedData) {
            if (
              !candidate.data ||
              typeof candidate.data !== 'object' ||
              Array.isArray(candidate.data)
            ) {
              return [];
            }
            recordData = candidate.data as Record<string, unknown>;
          } else {
            // Studio authors seed records as `{ id, ...fields }`. Keep every
            // authored field (including date-like fields) in the record data;
            // only XDB identity belongs outside it.
            recordData = Object.fromEntries(
              Object.entries(candidate).filter(([key]) => key !== 'id' && key !== 'collection')
            );
          }

          const rawCreatedAt = candidate.created_at ?? candidate.createdAt;
          const rawUpdatedAt = candidate.updated_at ?? candidate.updatedAt;
          const createdAt =
            typeof rawCreatedAt === 'string'
              ? rawCreatedAt
              : typeof rawUpdatedAt === 'string'
                ? rawUpdatedAt
                : XDB_FALLBACK_TIMESTAMP;
          const updatedAt = typeof rawUpdatedAt === 'string' ? rawUpdatedAt : createdAt;

          return [
            {
              id: candidate.id,
              data: recordData,
              created_at: createdAt,
              updated_at: updatedAt,
            },
          ];
        })
      : [];
    return {
      collection:
        typeof data.collection === 'string' && data.collection
          ? data.collection
          : fallbackCollection,
      records,
    };
  } catch {
    return {
      collection: fallbackCollection,
      records: [],
    };
  }
}

/**
 * Add bundled seed rows without replacing user data or reviving tombstones.
 * Returns the number of rows that were actually inserted.
 */
export function seedXDBBundleData(
  xdb: Pick<XDBService, 'getAllRaw' | 'writeRecord'>,
  data: XDBBundleData
): number {
  const existingIds = new Set(xdb.getAllRaw(data.collection).map((record) => record.id));
  let inserted = 0;

  for (const record of data.records) {
    if (existingIds.has(record.id)) continue;

    xdb.writeRecord(data.collection, {
      ...record,
      collection: data.collection,
      deleted: false,
    });
    existingIds.add(record.id);
    inserted += 1;
  }

  return inserted;
}

/**
 * Resolve the type of an import based on the source path
 */
function resolveImportType(source: string): 'ui' | 'logic' | 'external' {
  if (source.endsWith('.ui')) return 'ui';
  if (source.endsWith('.logic')) return 'logic';
  if (source.startsWith('./') || source.startsWith('../') || source.startsWith('/')) {
    // Relative path without extension - assume based on context
    return 'ui';
  }
  return 'external';
}

// ============================================================================
// Minimal ZIP Writer
// ============================================================================

/**
 * Write entries to a ZIP file
 */
async function writeZip(entries: Map<string, Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const centralDirectory: Uint8Array[] = [];
  let offset = 0;

  for (const [name, data] of entries) {
    const nameBytes = new TextEncoder().encode(name);

    // Local file header
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);

    localView.setUint32(0, 0x04034b50, true); // Signature
    localView.setUint16(4, 20, true); // Version needed
    localView.setUint16(6, 0, true); // Flags
    localView.setUint16(8, 0, true); // Compression (stored)
    localView.setUint16(10, 0, true); // Mod time
    localView.setUint16(12, 0, true); // Mod date
    localView.setUint32(14, crc32(data), true); // CRC-32
    localView.setUint32(18, data.length, true); // Compressed size
    localView.setUint32(22, data.length, true); // Uncompressed size
    localView.setUint16(26, nameBytes.length, true); // Name length
    localView.setUint16(28, 0, true); // Extra length

    localHeader.set(nameBytes, 30);

    chunks.push(localHeader);
    chunks.push(data);

    // Central directory entry
    const cdEntry = new Uint8Array(46 + nameBytes.length);
    const cdView = new DataView(cdEntry.buffer);

    cdView.setUint32(0, 0x02014b50, true); // Signature
    cdView.setUint16(4, 20, true); // Version made by
    cdView.setUint16(6, 20, true); // Version needed
    cdView.setUint16(8, 0, true); // Flags
    cdView.setUint16(10, 0, true); // Compression
    cdView.setUint16(12, 0, true); // Mod time
    cdView.setUint16(14, 0, true); // Mod date
    cdView.setUint32(16, crc32(data), true); // CRC-32
    cdView.setUint32(20, data.length, true); // Compressed size
    cdView.setUint32(24, data.length, true); // Uncompressed size
    cdView.setUint16(28, nameBytes.length, true); // Name length
    cdView.setUint16(30, 0, true); // Extra length
    cdView.setUint16(32, 0, true); // Comment length
    cdView.setUint16(34, 0, true); // Disk start
    cdView.setUint16(36, 0, true); // Internal attrs
    cdView.setUint32(38, 0, true); // External attrs
    cdView.setUint32(42, offset, true); // Local header offset

    cdEntry.set(nameBytes, 46);
    centralDirectory.push(cdEntry);

    offset += localHeader.length + data.length;
  }

  // Add central directory
  const cdStart = offset;
  for (const entry of centralDirectory) {
    chunks.push(entry);
    offset += entry.length;
  }

  // End of central directory
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);

  eocdView.setUint32(0, 0x06054b50, true); // Signature
  eocdView.setUint16(4, 0, true); // Disk number
  eocdView.setUint16(6, 0, true); // CD disk
  eocdView.setUint16(8, entries.size, true); // CD entries on disk
  eocdView.setUint16(10, entries.size, true); // Total CD entries
  eocdView.setUint32(12, offset - cdStart, true); // CD size
  eocdView.setUint32(16, cdStart, true); // CD offset
  eocdView.setUint16(20, 0, true); // Comment length

  chunks.push(eocd);

  // Combine all chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }

  return result;
}

/**
 * Calculate CRC-32
 */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;

  // CRC-32 table
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }

  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

// ============================================================================
// Exports
// ============================================================================

export { validateManifest, createDefaultManifest, getFileType };
