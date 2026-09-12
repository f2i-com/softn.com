/**
 * Bundle Exporter - Creates .softn ZIP bundles
 *
 * The manifest is the one the bundle came with, patched, not a new one. The
 * export used to rebuild it from six fields: the entry file was chosen by
 * searching the UI paths for "main.ui" (so an app whose entry was `app.ui`
 * and which also had a `not-main.ui` was exported pointing at the wrong
 * file), the window was reset to 1200×800, `config.execution` and every
 * field the Builder did not know were dropped, and the `server` group went
 * with the server files. Now the retained manifest is copied and only what
 * the Builder edits is written over it: name, version, description, theme
 * mode, icon, and the four file groups it rebuilds. `main` is the declared
 * entry, followed through a rename by file id, never guessed.
 *
 * Every .xdb entry is written by utils/xdbFormat.ts, for both export paths.
 */

import { zipSync, strToU8 } from 'fflate';
import { readBundleEntries } from '@softn/core';
import type {
  CanvasElement,
  CollectionDef,
  AssetFile,
  UIFileState,
  LogicFileState,
} from '../types/builder';
import { generateSource } from './sourceGenerator';
import { debug } from './debug';
import { buildPermissionJson, type PermissionDeclaration } from './permissions';
import { envelopeFor, serializeXdb, type XdbRecordEnvelope } from './xdbFormat';

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
    /** Server-side logic; the Builder carries these through, it does not edit them. */
    server?: string[];
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

/** What an opened bundle carried that the export writes back rather than rebuilds. */
export interface RetainedExportSource {
  /** The manifest as read, or null for a project made in the Builder. */
  manifest: Record<string, unknown> | null;
  /** Validated entries the Builder does not model, written back verbatim. */
  extraEntries: Map<string, Uint8Array>;
  /** Where the icon was, when the bundle had one. */
  iconPath: string | null;
  /** Where each collection's .xdb was, by collection name. */
  xdbPaths: Map<string, string>;
}

interface SharedOptions {
  name: string;
  version: string;
  description: string;
  themeMode: 'light' | 'dark' | 'system';
  collections: CollectionDef[];
  /**
   * The records each collection is written with, by collection name. A
   * collection without an entry is written from its `seedData` with fresh
   * identity, which is right only for a collection that never had any.
   */
  records?: Map<string, XdbRecordEnvelope[]>;
  assets: AssetFile[];
  icon?: Uint8Array;
  /** Where the icon goes in the archive; `assets/icon.png` when not said. */
  iconPath?: string;
  /** What the app declares it needs; nothing declared writes no permission.json. */
  permissions?: PermissionDeclaration;
  /** What the opened bundle carried; absent for a project made here. */
  source?: RetainedExportSource;
}

export interface BundleOptions extends SharedOptions {
  elements: Map<string, CanvasElement>;
  rootId: string;
  logicSource: string;
  /** The entry file's path; `ui/main.ui` when not said. */
  main?: string;
}

export interface MultiBundleOptions extends SharedOptions {
  uiFiles: Map<string, UIFileState>;
  logicFiles: Map<string, LogicFileState>;
  /**
   * The entry file's path: the declared entry followed through renames, or
   * `ui/main.ui` for a project made here — the caller knows which. When not
   * said, `ui/main.ui` if the project has it, else the only UI file if there
   * is one; never a search of the names. A path that is not a UI file of
   * the project is refused rather than replaced.
   */
  main?: string;
}

/** The entry file when the caller did not say: the conventional one, or the only one. */
function defaultMain(uiPaths: string[]): string {
  if (uiPaths.includes('ui/main.ui')) return 'ui/main.ui';
  if (uiPaths.length === 1) return uiPaths[0];
  throw new Error('The project has no ui/main.ui to be its entry file. Create one, or name one main.ui.');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stripSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

/** Where a collection's .xdb goes: where it was, or `xdb/<name>.xdb`. */
function xdbPathFor(name: string, source?: RetainedExportSource): string {
  return source?.xdbPaths.get(name) ?? `xdb/${name}.xdb`;
}

/**
 * The manifest to write: the retained one with the Builder's edits over it,
 * or a fresh one for a project that never had a manifest. Whatever the
 * retained manifest carried that the Builder does not edit — window and
 * runtime settings, `files.server`, fields from a newer format — is kept
 * exactly, in its place.
 */
function composeManifest(
  options: SharedOptions,
  groups: { ui: string[]; logic: string[]; xdb: string[]; assets: string[] },
  main: string,
  iconPath: string | null
): Record<string, unknown> {
  const retained = options.source?.manifest;
  const manifest: Record<string, unknown> = retained
    ? (JSON.parse(JSON.stringify(retained)) as Record<string, unknown>)
    : { formatVersion: BUNDLE_FORMAT_VERSION };

  manifest.name = options.name;
  manifest.version = options.version;
  manifest.description = options.description;
  manifest.main = main;
  if (iconPath) manifest.icon = iconPath;
  else delete manifest.icon;

  const files = isObject(manifest.files) ? { ...manifest.files } : {};
  files.ui = groups.ui;
  // Helper initialization order is meaningful; a store rebuild/rename must
  // not reorder still-declared helpers. Newly created files follow them.
  const declaredLogic = Array.isArray(files.logic) ? files.logic.filter((path): path is string => typeof path === 'string' && groups.logic.includes(path)) : [];
  files.logic = [...new Set([...declaredLogic, ...groups.logic])];
  files.xdb = groups.xdb;
  files.assets = groups.assets;
  manifest.files = files;

  const config = isObject(manifest.config) ? { ...manifest.config } : {};
  const previousName = typeof retained?.name === 'string' ? retained.name : null;
  const window = isObject(config.window) ? { ...config.window } : { title: options.name, width: 1200, height: 800 };
  // The window title tracked the app's name when it was the same; a title
  // set to something else is a setting the Builder has no control for.
  if (previousName !== null && window.title === previousName) window.title = options.name;
  config.window = window;
  config.theme = { ...(isObject(config.theme) ? config.theme : {}), mode: options.themeMode };
  manifest.config = config;

  return manifest;
}

/**
 * The archive entries every export shares: the declaration, the icon at its
 * own path, the assets, the .xdb entries and the passthrough entries. The
 * icon is listed among the assets once. Returns the assets group.
 */
function addSharedEntries(
  files: Record<string, Uint8Array>,
  options: SharedOptions
): { assets: string[]; xdb: string[]; iconPath: string | null } {
  const assets: string[] = [];
  for (const asset of options.assets) {
    const path = asset.bundlePath || `assets/${asset.name}`;
    if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..') || /^[A-Za-z]:/.test(path)) {
      throw new Error(`Invalid asset path: ${path}`);
    }
    files[path] = asset.data;
    assets.push(path);
  }

  let iconPath: string | null = null;
  if (options.icon) {
    iconPath = options.iconPath || 'assets/icon.png';
    files[iconPath] = options.icon;
    // Listed among the assets when it lives there, once.
    if (iconPath.startsWith('assets/') && !assets.includes(iconPath)) assets.push(iconPath);
  }

  const permission = options.permissions ? buildPermissionJson(options.permissions) : null;
  if (permission) files['permission.json'] = strToU8(permission);

  // Generate XDB entries, one serializer for both export paths.
  const xdb: string[] = [];
  for (const col of options.collections) {
    const path = xdbPathFor(col.name, options.source);
    const records = options.records?.get(col.name) ?? (col.seedData || []).map((data) => envelopeFor(col.name, data, undefined));
    files[path] = strToU8(
      serializeXdb({
        name: col.name,
        schema: { alias: col.alias ?? col.name, fields: col.fields ?? [] },
        records,
      })
    );
    xdb.push(path);
  }

  // What the Builder does not model goes back as it came, unless the Builder
  // now has a file of its own at that path.
  for (const [path, bytes] of options.source?.extraEntries ?? []) {
    if (path in files) continue;
    files[path] = bytes;
  }

  return { assets, xdb, iconPath };
}

/** Whether the project carries a `logic/main.logic` for the entry file to link. */
function hasMainLogic(logicFiles: Map<string, { path: string }>): boolean {
  for (const [, file] of logicFiles) {
    if (stripSlash(file.path) === 'logic/main.logic') return true;
  }
  return false;
}

function zip(files: Record<string, Uint8Array>, options: SharedOptions): Uint8Array {
  return zipSync(files, {
    level: 6,
    comment: `SoftN Bundle - ${options.name} v${options.version}`,
  });
}

/**
 * Export a .softn bundle as a ZIP file
 */
export async function exportBundle(options: BundleOptions): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const main = options.main ?? 'ui/main.ui';
  const hasLogic = options.logicSource.trim().length > 0;

  // Generate main.ui from canvas
  const uiSource = generateSource(
    options.elements,
    options.rootId,
    '', // Logic is in separate file
    options.collections
  );
  // Link that separate file. The loader inlines logic solely by rewriting a
  // `<logic src>` tag, so without one the bundle carries its logic and never
  // runs it — bindings read undefined and handlers do nothing.
  files[main] = strToU8(hasLogic ? `<logic src="../logic/main.logic" />\n${uiSource}` : uiSource);

  // Generate logic file
  if (hasLogic) {
    files['logic/main.logic'] = strToU8(options.logicSource);
  }

  const shared = addSharedEntries(files, options);
  const manifest = composeManifest(
    options,
    { ui: [main], logic: hasLogic ? ['logic/main.logic'] : [], xdb: shared.xdb, assets: shared.assets },
    main,
    shared.iconPath
  );
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

  return zip(files, options);
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
    const path = stripSlash(uiFile.path);
    uiPaths.push(path);

    // Use originalSource if available, otherwise generate from elements
    let source: string;
    if (uiFile.originalSource !== undefined) {
      source = uiFile.originalSource;
    } else {
      source = generateSource(uiFile.elements, uiFile.rootId, '', options.collections);
      // A generated entry file has no <logic src>, and that tag is the only
      // thing that links logic to markup — the loader inlines by rewriting it,
      // with no manifest fallback. Without it the bundle ships its logic and
      // never runs it: bindings read undefined and handlers do nothing.
      if (path === 'ui/main.ui' && hasMainLogic(options.logicFiles)) {
        source = `<logic src="../logic/main.logic" />\n${source}`;
      }
    }

    files[path] = strToU8(source);
    debug('[exportMultiFileBundle] Added UI file:', path, 'length:', source.length);
  }

  const main = options.main !== undefined ? stripSlash(options.main) : defaultMain(uiPaths);
  if (!uiPaths.includes(main)) {
    throw new Error(
      `The entry file "${main}" is not a UI file of this project (it has ${uiPaths.join(', ') || 'none'}). Restore it, or open the project's manifest to change main.`
    );
  }

  // Add logic files
  for (const [, logicFile] of options.logicFiles) {
    const path = stripSlash(logicFile.path);
    logicPaths.push(path);
    files[path] = strToU8(logicFile.content);
    debug(
      '[exportMultiFileBundle] Added logic file:',
      path,
      'length:',
      logicFile.content.length
    );
  }

  const shared = addSharedEntries(files, options);
  const manifest = composeManifest(
    options,
    { ui: uiPaths, logic: logicPaths, xdb: shared.xdb, assets: shared.assets },
    main,
    shared.iconPath
  );
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

  debug('[exportMultiFileBundle] Creating bundle with', Object.keys(files).length, 'files');

  return zip(files, options);
}

/**
 * Parse a .softn bundle from ZIP data
 */
export function parseBundle(data: Uint8Array): {
  manifest: BundleManifest;
  files: Map<string, Uint8Array>;
} {
  // Validated read, shared with softn-web and softn-loader.
  //
  // This used to be a bare `unzipSync`: no size limits, no entry cap, no CRC
  // check, no path filtering. Opening a hostile .softn in the builder therefore
  // bypassed every defence the other two readers had — including the one that
  // catches an archive understating a file's size, which hands this reader a
  // truncated file while every other reader sees the whole one.
  const files = readBundleEntries(data);

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

  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestData));
  } catch (e) {
    throw new Error(`Invalid bundle: manifest.json is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!isObject(manifest)) {
    throw new Error('Invalid bundle: manifest.json is not a JSON object');
  }

  return { manifest: manifest as unknown as BundleManifest, files };
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
  existingHandle?: import('./desktop').BundleFileHandle | null,
): Promise<import('./desktop').BundleFileHandle | null> {
  const { isDesktop, saveDesktopFile } = await import('./desktop');
  if (isDesktop()) {
    return saveDesktopFile(bundleData, `${suggestedName}.softn`,
      existingHandle?.kind === 'desktop-file' ? existingHandle : undefined);
  }
  if (existingHandle?.kind === 'desktop-file') throw new Error('Open this file again before saving it in the browser.');
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
