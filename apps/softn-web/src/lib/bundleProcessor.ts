/**
 * Bundle Processing — extracted from softn-loader/src/App.tsx
 *
 * Pure functions for reading .softn ZIP bundles, loading XDB data,
 * and resolving imports/logic into a single renderable source string.
 * No Tauri dependencies — uses only browser APIs.
 */

import { getXDB, readBundleEntries } from '@softn/core';
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
    server?: {
      url?: string;
      token?: string;
      collections?: string[];
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
  const textFiles = new Map<string, string>();
  const binaryFiles = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();

  // Validation lives in @softn/core so all three readers share it. This file
  // and softn-loader each carried their own copy — identical today, but two
  // copies of a security check are two chances to fix only one — and the
  // builder had none at all.
  for (const [normalizedPath, content] of readBundleEntries(data)) {
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
 * the script runtime via the importResolver callback.
 */
export function processBundle(
  textFiles: Map<string, string>,
  manifest: BundleManifest
): { source: string; logicBasePath?: string; preIncludedLogicPaths: string[] } {
  const mainUI = textFiles.get(manifest.main);
  if (!mainUI) {
    throw new Error(`Main file not found: ${manifest.main}`);
  }

  let fullSource = mainUI;
  let logicBasePath: string | undefined;
  // Logic files concatenated below. Reported to the runtime so an `import`
  // naming one of them is skipped rather than inlining the file a second time.
  const preIncludedLogic = new Set<string>();

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
          preIncludedLogic.add(mlPath);
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
      // Function replacer: a component's markup is content, not a substitution
      // pattern. Passed as a string, `$&` re-inserts the tag it just replaced
      // and `$'` splices in the rest of the document.
      nextSource = nextSource.replace(selfClosingRegex, () => templateContent);

      const pairedRegex = new RegExp(`<${escapedName}[^>]*>.*?</${escapedName}>`, 'gs');
      nextSource = nextSource.replace(pairedRegex, () => templateContent);
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

  return { source: fullSource, logicBasePath, preIncludedLogicPaths: [...preIncludedLogic] };
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
    } catch (e) {
      // A malformed permission.json must not be treated as an absent one.
      // `checkPermission` allows everything when the config is null (documented
      // backward compatibility for bundles predating the file), so falling
      // through here meant a bundle whose permission.json had a trailing comma
      // got strictly *more* privilege than the same bundle with valid JSON
      // declaring nothing at all. An empty config denies every capability,
      // which is the safe reading of "the author meant to declare something".
      console.error('[SoftN] Invalid permission.json — denying all capabilities:', e);
      return { permissions: {} } as PermissionConfig;
    }
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

/**
 * Every capability a permission config asks for.
 *
 * One list, read by both the consent check and the grant record, so the two
 * cannot disagree about what was approved.
 */
const CAPABILITIES = ['net', 'camera', 'files', 'qr', 'ai', 'gpu', 'sync'] as const;

export function requestedCapabilities(config: PermissionConfig): string[] {
  const perms = (config.permissions ?? {}) as Record<string, { enabled?: boolean } | undefined>;
  return CAPABILITIES.filter((name) => perms[name]?.enabled);
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
