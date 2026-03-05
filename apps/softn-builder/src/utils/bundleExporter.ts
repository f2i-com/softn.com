/**
 * Bundle Exporter - Creates .softn ZIP bundles
 */

import { zipSync, unzipSync, strToU8 } from 'fflate';
import type {
  CanvasElement,
  CollectionDef,
  AssetFile,
  UIFileState,
  LogicFileState,
} from '../types/builder';
import { generateSource } from './sourceGenerator';
import { debug } from './debug';

export const BUNDLE_FORMAT_VERSION = '1.0';

export interface BundleManifest {
  formatVersion?: string;
  name: string;
  version: string;
  description: string;
  main: string;
  icon?: string;
  files: {
    ui: string[];
    logic: string[];
    xdb: string[];
    assets: string[];
  };
  config: {
    window: {
      title: string;
      width: number;
      height: number;
    };
    theme: {
      mode: 'light' | 'dark' | 'system';
    };
  };
}

export interface BundleOptions {
  name: string;
  version: string;
  description: string;
  themeMode: 'light' | 'dark' | 'system';
  elements: Map<string, CanvasElement>;
  rootId: string;
  logicSource: string;
  collections: CollectionDef[];
  assets: AssetFile[];
  icon?: Uint8Array;
}

export interface MultiBundleOptions {
  name: string;
  version: string;
  description: string;
  themeMode: 'light' | 'dark' | 'system';
  uiFiles: Map<string, UIFileState>;
  logicFiles: Map<string, LogicFileState>;
  collections: CollectionDef[];
  assets: AssetFile[];
  icon?: Uint8Array;
}

/**
 * Export a .softn bundle as a ZIP file
 */
export async function exportBundle(options: BundleOptions): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};

  // Generate manifest.json
  const manifest: BundleManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    name: options.name,
    version: options.version,
    description: options.description,
    main: 'ui/main.ui',
    files: {
      ui: ['ui/main.ui'],
      logic: options.logicSource.trim() ? ['logic/main.logic'] : [],
      xdb: options.collections.map((c) => `xdb/${c.name}.xdb`),
      assets: options.assets.map((a) => `assets/${a.name}`),
    },
    config: {
      window: {
        title: options.name,
        width: 1200,
        height: 800,
      },
      theme: {
        mode: options.themeMode,
      },
    },
  };

  if (options.icon) {
    manifest.icon = 'assets/icon.png';
  }

  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

  // Generate main.ui from canvas
  const uiSource = generateSource(
    options.elements,
    options.rootId,
    '', // Logic is in separate file
    options.collections
  );
  files['ui/main.ui'] = strToU8(uiSource);

  // Generate logic file
  if (options.logicSource.trim()) {
    files['logic/main.logic'] = strToU8(options.logicSource);
  }

  // Generate XDB seed files
  for (const col of options.collections) {
    const xdbFile = {
      collection: col.name,
      records: col.seedData.map((data, i) => ({
        id: `seed-${i}`,
        collection: col.name,
        data,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted: false,
      })),
    };
    files[`xdb/${col.name}.xdb`] = strToU8(JSON.stringify(xdbFile, null, 2));
  }

  // Add icon if provided
  if (options.icon) {
    files['assets/icon.png'] = options.icon;
  }

  // Add other assets
  for (const asset of options.assets) {
    files[`assets/${asset.name}`] = asset.data;
  }

  // Create ZIP
  const zipped = zipSync(files, {
    level: 6,
    comment: `SoftN Bundle - ${options.name} v${options.version}`,
  });

  return zipped;
}

/**
 * Export a multi-file .softn bundle from filesStore data
 * Uses originalSource when available (preserves imports like <logic src="./main.logic" />)
 */
export async function exportMultiFileBundle(options: MultiBundleOptions): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};

  // Collect all file paths
  const uiPaths: string[] = [];
  const logicPaths: string[] = [];

  // Add UI files
  for (const [, uiFile] of options.uiFiles) {
    const path = uiFile.path.startsWith('/') ? uiFile.path.slice(1) : uiFile.path;
    uiPaths.push(path);

    // Use originalSource if available, otherwise generate from elements
    let source: string;
    if (uiFile.originalSource) {
      source = uiFile.originalSource;
    } else {
      source = generateSource(uiFile.elements, uiFile.rootId, '', options.collections);
    }

    files[path] = strToU8(source);
    debug('[exportMultiFileBundle] Added UI file:', path, 'length:', source.length);
  }

  // Add logic files
  for (const [, logicFile] of options.logicFiles) {
    const path = logicFile.path.startsWith('/') ? logicFile.path.slice(1) : logicFile.path;
    logicPaths.push(path);
    files[path] = strToU8(logicFile.content);
    debug(
      '[exportMultiFileBundle] Added logic file:',
      path,
      'length:',
      logicFile.content.length
    );
  }

  // Generate manifest.json
  const manifest: BundleManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    name: options.name,
    version: options.version,
    description: options.description,
    main: uiPaths.find((p) => p.includes('main.ui')) || uiPaths[0] || 'ui/main.ui',
    files: {
      ui: uiPaths,
      logic: logicPaths,
      xdb: options.collections.map((c) => `xdb/${c.name}.xdb`),
      assets: options.assets.map((a) => `assets/${a.name}`),
    },
    config: {
      window: {
        title: options.name,
        width: 1200,
        height: 800,
      },
      theme: {
        mode: options.themeMode,
      },
    },
  };

  if (options.icon) {
    manifest.icon = 'assets/icon.png';
  }

  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

  // Generate XDB seed files
  for (const col of options.collections) {
    const xdbFile = {
      collection: col.name,
      records: (col.seedData || []).map((data, i) => ({
        id: `seed-${i}`,
        collection: col.name,
        data,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted: false,
      })),
    };
    files[`xdb/${col.name}.xdb`] = strToU8(JSON.stringify(xdbFile, null, 2));
  }

  // Add icon if provided
  if (options.icon) {
    files['assets/icon.png'] = options.icon;
  }

  // Add other assets
  for (const asset of options.assets) {
    files[`assets/${asset.name}`] = asset.data;
  }

  debug('[exportMultiFileBundle] Creating bundle with', Object.keys(files).length, 'files');

  // Create ZIP
  const zipped = zipSync(files, {
    level: 6,
    comment: `SoftN Bundle - ${options.name} v${options.version}`,
  });

  return zipped;
}

/**
 * Parse a .softn bundle from ZIP data
 */
export function parseBundle(data: Uint8Array): {
  manifest: BundleManifest;
  files: Map<string, Uint8Array>;
} {
  const unzipped = unzipSync(data);

  const files = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(unzipped)) {
    // Normalize path: convert backslashes to forward slashes
    const normalizedPath = path.replace(/\\/g, '/');
    files.set(normalizedPath, content);
  }

  // Debug: log all paths in the bundle
  debug('[parseBundle] Files in bundle:', Array.from(files.keys()));

  // Try to find manifest.json with different path variations
  let manifestData = files.get('manifest.json');
  if (!manifestData) {
    // Try with forward slash prefix
    manifestData = files.get('/manifest.json');
  }
  if (!manifestData) {
    // Search for manifest.json anywhere in the paths
    for (const [path, content] of files) {
      if (path.endsWith('manifest.json') || path === 'manifest.json') {
        debug('[parseBundle] Found manifest at:', path);
        manifestData = content;
        break;
      }
    }
  }
  if (!manifestData) {
    throw new Error('Invalid bundle: missing manifest.json');
  }

  const manifest = JSON.parse(new TextDecoder().decode(manifestData)) as BundleManifest;

  return { manifest, files };
}

/**
 * Save bundle data to a file using File System Access API (native save dialog),
 * or fall back to a blob download for unsupported browsers.
 *
 * When `existingHandle` is provided, writes directly to that file (re-save).
 * Returns the file handle for subsequent saves, or null if blob fallback was used.
 */
export async function saveBundleToFile(
  bundleData: Uint8Array,
  suggestedName: string,
  existingHandle?: FileSystemFileHandle | null,
): Promise<FileSystemFileHandle | null> {
  const blob = new Blob([new Uint8Array(bundleData)], { type: 'application/zip' });

  // If we have an existing handle, write directly (re-save)
  if (existingHandle) {
    const writable = await existingHandle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (err) {
      await writable.abort();
      throw err;
    }
    return existingHandle;
  }

  // Try File System Access API for native "Save As" dialog
  if ('showSaveFilePicker' in window) {
    const handle = await window.showSaveFilePicker!({
      suggestedName: `${suggestedName}.softn`,
      types: [{
        description: 'SoftN Bundle',
        accept: { 'application/zip': ['.softn'] },
      }],
    });
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (err) {
      await writable.abort();
      throw err;
    }
    return handle;
  }

  // Fallback: blob download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${suggestedName}.softn`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return null;
}

/**
 * Validate a bundle manifest
 */
export function validateManifest(manifest: unknown): manifest is BundleManifest {
  if (typeof manifest !== 'object' || manifest === null) return false;

  const m = manifest as Record<string, unknown>;

  if (typeof m.name !== 'string') return false;
  if (typeof m.version !== 'string') return false;
  if (typeof m.main !== 'string') return false;

  if (typeof m.files !== 'object' || m.files === null) return false;

  const files = m.files as Record<string, unknown>;
  if (!Array.isArray(files.ui)) return false;

  return true;
}
