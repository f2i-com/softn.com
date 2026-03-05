/**
 * Bundle Processing — extracted from softn-loader/src/App.tsx
 *
 * Pure functions for reading .softn ZIP bundles, loading XDB data,
 * and resolving imports/logic into a single renderable source string.
 * No Tauri dependencies — uses only browser APIs.
 */

import { unzipSync } from 'fflate';
import { getXDB } from '@softn/core';
import type { PermissionConfig } from '@softn/core';

// ── Types ────────────────────────────────────────────────────────────

export interface BundleManifest {
  name: string;
  version: string;
  description?: string;
  main: string;
  icon?: string;
  files: {
    ui?: string[];
    logic?: string[];
    xdb?: string[];
    assets?: string[];
  };
  config?: {
    window?: {
      title?: string;
      width?: number;
      height?: number;
    };
    theme?: {
      primary?: string;
      mode?: 'light' | 'dark' | 'system';
    };
  };
  permissions?: import('@softn/core').AppPermissions;
}

interface XDBFile {
  collection: string;
  records: Array<{
    id: string;
    collection: string;
    data: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
    created_at?: string;
    updated_at?: string;
    deleted?: boolean;
  }>;
}

export interface ZipResult {
  textFiles: Map<string, string>;
  binaryFiles: Map<string, Uint8Array>;
}

const MAX_ZIP_INPUT_BYTES = 200 * 1024 * 1024; // 200 MB
const MAX_ZIP_ENTRIES = 10_000;
const MAX_ZIP_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_ZIP_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

function preflightZip(data: Uint8Array): void {
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

  let offset = centralDirOffset;
  let totalUncompressed = 0;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > data.byteLength || view.getUint32(offset, true) !== CEN_SIGNATURE) {
      throw new Error('Invalid ZIP central directory entry');
    }

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

    offset += 46 + fileNameLength + extraLength + commentLength;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function isBinaryFile(fileName: string): boolean {
  const binaryExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svg', '.bmp', '.avif', '.tiff', '.tif',
    '.glb', '.obj', '.fbx', '.stl', '.3ds', '.dae', '.bin',
    '.mp3', '.mp4', '.wav', '.ogg', '.webm',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.hdr', '.exr', '.pdf',
  ];
  const lowerName = fileName.toLowerCase();
  return binaryExtensions.some((ext) => lowerName.endsWith(ext));
}

/** Resolve a relative path against a base file path */
function resolvePath(basePath: string, relativePath: string): string {
  const baseParts = basePath.split('/');
  baseParts.pop(); // Remove filename to get directory

  const relativeParts = relativePath.split('/');
  for (const part of relativeParts) {
    if (part === '..') {
      baseParts.pop();
    } else if (part !== '.') {
      baseParts.push(part);
    }
  }

  const resolved = baseParts.filter(Boolean).join('/');
  // Reject paths that escape the bundle root (e.g., too many `..` segments)
  if (resolved.includes('..') || resolved.startsWith('/')) {
    throw new Error(`Unsafe import path: ${relativePath}`);
  }
  return resolved;
}

/** Escape special regex characters in a string */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Core Functions ───────────────────────────────────────────────────

/** Read ZIP entries from Uint8Array using fflate */
export function readZip(data: Uint8Array): ZipResult {
  if (data.byteLength > MAX_ZIP_INPUT_BYTES) {
    throw new Error('Bundle too large');
  }

  const textFiles = new Map<string, string>();
  const binaryFiles = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();

  preflightZip(data);

  const unzipped = unzipSync(data);
  const entries = Object.entries(unzipped);
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error('Bundle has too many files');
  }
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

    // Skip directories
    if (normalizedPath.endsWith('/')) continue;

    if (content.byteLength > MAX_ZIP_FILE_BYTES) {
      throw new Error(`File too large in bundle: ${normalizedPath}`);
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('Bundle contents too large');
    }

    if (isBinaryFile(normalizedPath)) {
      binaryFiles.set(normalizedPath, content);
    } else {
      textFiles.set(normalizedPath, decoder.decode(content));
    }
  }

  console.log('[SoftN Web] Loaded files:', Array.from(textFiles.keys()));

  return { textFiles, binaryFiles };
}

/** Load XDB data from bundle files into XDB (browser sync mode) */
export async function loadXDBData(
  textFiles: Map<string, string>,
  manifest: BundleManifest,
  appId?: string
): Promise<void> {
  const xdb = getXDB(appId);
  const xdbFiles = manifest.files.xdb || [];

  const normalizeRecord = (
    collection: string,
    record: XDBFile['records'][number]
  ) => {
    const createdAt = record.created_at || record.createdAt || new Date().toISOString();
    const updatedAt = record.updated_at || record.updatedAt || createdAt;
    return {
      id: record.id,
      collection: record.collection || collection,
      data: record.data || {},
      created_at: createdAt,
      updated_at: updatedAt,
      deleted: record.deleted ?? false,
    };
  };

  for (const xdbFileName of xdbFiles) {
    const content = textFiles.get(xdbFileName);
    if (!content) continue;

    try {
      const xdbData: XDBFile = JSON.parse(content);
      const { collection, records } = xdbData;

      // Check if collection already has data (avoid duplicates on reload)
      const existing = xdb.query(collection);

      if (existing.length > 0) {
        console.log(
          `[SoftN Web] Collection ${collection} already has ${existing.length} records, skipping seed`
        );
        continue;
      }

      // Insert each record (preserve IDs/timestamps)
      for (const record of records) {
        const normalized = normalizeRecord(collection, record);
        xdb.writeRecord(collection, normalized);
      }

      console.log(`[SoftN Web] Loaded ${records.length} records into ${collection}`);
    } catch (err) {
      console.error(`[SoftN Web] Failed to load XDB file ${xdbFileName}:`, err);
    }
  }
}

/**
 * Process a bundle's main UI file: resolve `<logic src="..."/>` inlining
 * and `<import X from="..."/>` resolution into a single source string.
 * Logic file imports are NOT resolved here — they're handled natively by
 * the FormLogic engine via the importResolver callback.
 */
export function processBundle(
  textFiles: Map<string, string>,
  manifest: BundleManifest
): { source: string; logicBasePath?: string } {
  const mainUI = textFiles.get(manifest.main);
  if (!mainUI) {
    throw new Error(`Main file not found: ${manifest.main}`);
  }

  let fullSource = mainUI;
  let logicBasePath: string | undefined;

  const inlineLogic = (source: string, basePath: string): string => {
    return source.replace(/<logic\s+src=["']([^"']+)["']\s*\/>/g, (match, rel) => {
      const logicPath = resolvePath(basePath, rel);
      console.log('[SoftN Web] Resolving logic:', rel, '->', logicPath);

      const logicFile = textFiles.get(logicPath);
      if (!logicFile) {
        console.warn('[SoftN Web] Logic file not found:', logicPath);
        return match;
      }
      // Capture the logic file's path for import resolution
      logicBasePath = logicPath;

      // Concatenate all manifest-listed .logic files into a single block.
      // Files other than the main entry are prepended so that their class/function
      // definitions are available when the main file's top-level code runs.
      const manifestLogicFiles = manifest.files.logic || [];
      const parts: string[] = [];
      for (const mlPath of manifestLogicFiles) {
        if (mlPath === logicPath) continue; // main entry added last
        const content = textFiles.get(mlPath);
        if (content) {
          console.log('[SoftN Web] Including manifest logic file:', mlPath);
          parts.push(content);
        }
      }
      parts.push(logicFile); // main entry last

      return `<logic>\n${parts.join('\n')}\n</logic>`;
    });
  };

  const inlineImports = (
    source: string,
    basePath: string,
    stack: Set<string>,
    cache: Map<string, string>
  ): string => {
    let nextSource = inlineLogic(source, basePath);
    const importRegex = /<import\s+(\w+)\s+from=["']([^"']+)["']\s*\/>/g;
    const imports: Array<{ name: string; path: string; content: string }> = [];

    let match;
    while ((match = importRegex.exec(nextSource)) !== null) {
      const componentName = match[1];
      const importPath = match[2];
      const resolvedPath = resolvePath(basePath, importPath);
      console.log('[SoftN Web] Resolving import:', componentName, '->', resolvedPath);

      const componentContent = textFiles.get(resolvedPath);
      if (componentContent) {
        if (cache.has(resolvedPath)) {
          imports.push({ name: componentName, path: resolvedPath, content: cache.get(resolvedPath)! });
          continue;
        }
        if (stack.has(resolvedPath)) {
          console.warn('[SoftN Web] Skipping circular import:', resolvedPath);
          continue;
        }
        stack.add(resolvedPath);
        const inlined = inlineImports(componentContent, resolvedPath, stack, cache);
        stack.delete(resolvedPath);
        cache.set(resolvedPath, inlined);
        imports.push({ name: componentName, path: resolvedPath, content: inlined });
      } else {
        console.warn('[SoftN Web] Imported file not found:', resolvedPath);
      }
    }

    nextSource = nextSource.replace(/<import\s+\w+\s+from=["'][^"']+["']\s*\/>\n?/g, '');

    for (const imp of imports) {
      const templateContent = imp.content
        .replace(/^\/\/[^\n]*\n/gm, '')
        .trim();

      const escapedName = escapeRegex(imp.name);
      const selfClosingRegex = new RegExp(`<${escapedName}\\s*/>`, 'g');
      nextSource = nextSource.replace(selfClosingRegex, templateContent);

      const pairedRegex = new RegExp(`<${escapedName}[^>]*>.*?</${escapedName}>`, 'gs');
      nextSource = nextSource.replace(pairedRegex, templateContent);
    }

    return nextSource;
  };

  fullSource = inlineImports(
    fullSource,
    manifest.main,
    new Set([manifest.main]),
    new Map()
  );

  console.log('[SoftN Web] Final source prepared with inlined components');

  return { source: fullSource, logicBasePath };
}

/**
 * Create an import resolver that looks up paths in the bundle's textFiles map.
 * For URL imports (http/https), fetches with caching.
 */
export function createImportResolver(
  textFiles: Map<string, string>
): (path: string) => Promise<string | null> {
  const urlCache = new Map<string, string>();
  return async (path: string): Promise<string | null> => {
    // URL imports — fetch with caching
    if (path.startsWith('http://') || path.startsWith('https://')) {
      if (urlCache.has(path)) return urlCache.get(path)!;
      const resp = await fetch(path);
      if (!resp.ok) return null;
      const text = await resp.text();
      urlCache.set(path, text);
      return text;
    }
    // Bundle path lookup
    return textFiles.get(path) ?? null;
  };
}

/**
 * Extract permission config from the bundle.
 * Checks for a dedicated permission.json first, then falls back to manifest.permissions.
 */
export function extractPermissions(textFiles: Map<string, string>, manifest: BundleManifest): PermissionConfig | null {
  // Check for permission.json in textFiles
  const permJson = textFiles.get('permission.json');
  if (permJson) {
    try {
      return JSON.parse(permJson) as PermissionConfig;
    } catch { /* fall through */ }
  }
  // Fall back to manifest.permissions (backward compat)
  if (manifest?.permissions) {
    return {
      permissions: {
        net: manifest.permissions.network ? { enabled: true } : undefined,
        files: manifest.permissions.filesystem ? { enabled: true } : undefined,
      }
    };
  }
  return null;
}

/** Extract icon as a data URL from bundle binary files */
export function extractIconDataUrl(
  binaryFiles: Map<string, Uint8Array>,
  manifest: BundleManifest
): string | undefined {
  if (!manifest.icon) return undefined;

  // Reject paths with traversal or absolute references
  if (manifest.icon.includes('..') || manifest.icon.startsWith('/') || /^[a-zA-Z]:/.test(manifest.icon)) {
    return undefined;
  }

  const iconData = binaryFiles.get(manifest.icon);
  if (!iconData) return undefined;

  const ext = manifest.icon.split('.').pop()?.toLowerCase() || 'png';
  // Allow safe image formats. SVG is safe here because icons are always
  // rendered via <img> tags, which never execute embedded scripts.
  const safeMimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
  };
  const mime = safeMimeTypes[ext];
  if (!mime) return undefined;

  // Convert Uint8Array to base64
  let binary = '';
  for (let i = 0; i < iconData.length; i++) {
    binary += String.fromCharCode(iconData[i]);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
