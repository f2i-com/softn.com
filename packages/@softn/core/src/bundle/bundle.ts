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
import { readBundleEntries } from './zip';
import { classifyAsset } from './asset-classification';

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

  // Create bundle structure
  const bundle: SoftNBundle = {
    manifest,
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
    try {
      // Dynamic import to avoid bundler resolving
      const tauriModuleName = '@tauri-apps/plugin-fs';
      const tauriFs = await import(/* @vite-ignore */ tauriModuleName);
      const data = await tauriFs.readFile(filePath);
      return readBundle(data, options);
    } catch {
      // Tauri fs not available
    }
  }

  // Try Node.js (use dynamic import)
  try {
    // Dynamic import to avoid bundler resolving
    const fsModuleName = 'fs';
    const fs = await import(/* @vite-ignore */ fsModuleName);
    const data = fs.readFileSync(filePath);
    return readBundle(new Uint8Array(data), options);
  } catch {
    // Node.js fs not available
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
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch bundle: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
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
function parseXDBFile(path: string, content: string): XDBBundleData {
  try {
    const data = JSON.parse(content);
    return {
      collection: data.collection || path.replace('.xdb', ''),
      records: data.records || [],
    };
  } catch {
    return {
      collection: path.replace('.xdb', ''),
      records: [],
    };
  }
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
