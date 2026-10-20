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
 *
 * A file the Builder would write as it was read goes back as it came, byte
 * for byte: the manifest, each .xdb, and the byte-order mark at the front of
 * a page or a logic file. An untouched export rewrote them: the same to the
 * runtime, and still a change to a file nobody touched (the .xdb files of
 * four demos gained a `schema` and the Builder's spelling of their records,
 * and a logic file lost its mark).
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
import { logicSrcOf } from './logicFiles';
import { isThemeMode } from './themeMode';
import { debug } from './debug';
import { buildPermissionJson, type PermissionDeclaration } from './permissions';
import { envelopeFor, serializeXdb, type XdbRecordEnvelope } from './xdbFormat';
import { resolveEntry } from './bundleValidator';
import { isDesktop, saveDesktopFile, type BundleFileHandle } from './desktop';

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

/**
 * A collection's .xdb as it was in the archive, and the Builder's writing of
 * the collection as it was read (null until that is known): while the
 * Builder would write that still, the file goes back as it came.
 */
export interface KeptXdb {
  bytes: Uint8Array;
  written: string | null;
}

/** What an opened bundle carried that the export writes back rather than rebuilds. */
export interface RetainedExportSource {
  /** The manifest as read, or null for a project made in the Builder. */
  manifest: Record<string, unknown> | null;
  /** The manifest.json as it was in the archive, written back as it came while the export would write the same. */
  manifestBytes?: Uint8Array | null;
  /** Validated entries the Builder does not model, written back verbatim. */
  extraEntries: Map<string, Uint8Array>;
  /** Where the icon was, when the bundle had one. */
  iconPath: string | null;
  /** Where each collection's .xdb was, by collection name. */
  xdbPaths: Map<string, string>;
  /** Each collection's .xdb as it was in the archive, by collection name. */
  xdbFiles?: ReadonlyMap<string, KeptXdb>;
}

const BYTE_ORDER_MARK = [0xef, 0xbb, 0xbf];

/** Whether text in `bytes` begins with the UTF-8 byte-order mark, which decoding takes away. */
export function startsWithByteOrderMark(bytes: Uint8Array): boolean {
  return BYTE_ORDER_MARK.every((byte, at) => bytes[at] === byte);
}

/** `text` as the bytes of a file, with the byte-order mark the file had. */
function fileBytes(text: string, bom: boolean | undefined): Uint8Array {
  const body = strToU8(text);
  if (!bom) return body;
  const bytes = new Uint8Array(BYTE_ORDER_MARK.length + body.length);
  bytes.set(BYTE_ORDER_MARK);
  bytes.set(body, BYTE_ORDER_MARK.length);
  return bytes;
}

/** The manifest's bytes: as it came, where the export writes what was read; else written anew. */
function manifestBytes(manifest: Record<string, unknown>, source?: RetainedExportSource): Uint8Array {
  const written = JSON.stringify(manifest, null, 2);
  const read = source?.manifestBytes;
  if (read) {
    try {
      if (JSON.stringify(JSON.parse(new TextDecoder().decode(read)), null, 2) === written) return read;
    } catch {
      // Not readable as it was: written anew.
    }
  }
  return strToU8(written);
}

/** The text of a collection's .xdb, as the Builder writes it. */
export function xdbText(collection: CollectionDef, records: XdbRecordEnvelope[] | undefined): string {
  return serializeXdb({
    name: collection.name,
    schema: { alias: collection.alias ?? collection.name, fields: collection.fields ?? [] },
    records: records ?? (collection.seedData || []).map((data) => envelopeFor(collection.name, data, undefined)),
  });
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
  /**
   * The Python packages the app asks for, written as `config.python.packages`
   * (removed when empty). Absent: whatever the retained manifest said stays.
   */
  pythonPackages?: string[];
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

/**
 * The .xdb files the retained manifest lists that the Builder could not read
 * when the bundle was opened (one that did not parse, or that repeated a
 * collection): the loader keeps each among the entries it does not model, as
 * it came (bundleLoader.ts). Their archive paths, in the manifest's order.
 */
export function unreadXdbPaths(source: RetainedExportSource | undefined): string[] {
  const paths: string[] = [];
  for (const path of declaredXdb(source)) {
    const found = source ? resolveEntry(source.extraEntries, path, 'xdb') : undefined;
    if (found && !paths.includes(found.path)) paths.push(found.path);
  }
  return paths;
}

/** The .xdb paths the retained manifest lists, as written. */
function declaredXdb(source: RetainedExportSource | undefined): string[] {
  const files = source?.manifest && isObject(source.manifest.files) ? source.manifest.files : {};
  return Array.isArray(files.xdb) ? files.xdb.filter((path): path is string => typeof path === 'string') : [];
}

/**
 * Archive paths of .xdb files in the order the retained manifest lists them,
 * and those it does not list after them, in the order given. Kept files and
 * written ones are listed together, so a file kept as it came keeps its
 * place, and an untouched export writes the manifest back as it came.
 */
function inDeclaredOrder(paths: string[], source: RetainedExportSource | undefined): string[] {
  const declared = declaredXdb(source);
  const place = (path: string) => {
    const found = declared.findIndex((name) => resolveEntry(new Map([[path, new Uint8Array(0)]]), name, 'xdb') !== undefined);
    return found < 0 ? declared.length : found;
  };
  return paths
    .map((path, given) => ({ path, given, place: place(path) }))
    .sort((a, b) => a.place - b.place || a.given - b.given)
    .map((entry) => entry.path);
}

/** Where a collection's .xdb goes: where it was, or `xdb/<name>.xdb`. */
function xdbPathFor(name: string, source?: RetainedExportSource): string {
  return source?.xdbPaths.get(name) ?? `xdb/${name}.xdb`;
}

/**
 * The manifest's logic list as export writes it: the helpers the retained
 * manifest declared, in their order, while they are still in the project,
 * then every other logic file. Helper initialization order is meaningful, so
 * a rename or rebuild must not reorder still-declared helpers. The preview
 * composes with this same list, so a helper runs there when and only when it
 * runs in the exported app.
 */
export function exportedLogicPaths(retainedManifest: Record<string, unknown> | null, logicPaths: readonly string[]): string[] {
  const files = retainedManifest && isObject(retainedManifest.files) ? retainedManifest.files : {};
  const declared = Array.isArray(files.logic)
    ? files.logic.filter((path): path is string => typeof path === 'string' && logicPaths.includes(path))
    : [];
  return [...new Set([...declared, ...logicPaths])];
}

/**
 * `config` with `python.packages` set to `packages`, or without it when there
 * are none — and without `python` at all when nothing else is left in it.
 * Anything else the retained `config.python` carried is kept.
 */
export function withPythonPackages(config: Record<string, unknown>, packages: readonly string[]): Record<string, unknown> {
  const next = { ...config };
  const python = isObject(next.python) ? { ...next.python } : {};
  if (packages.length > 0) python.packages = [...packages];
  else delete python.packages;
  if (Object.keys(python).length > 0) next.python = python;
  else delete next.python;
  return next;
}

/**
 * The manifest the preview gives the composer: the retained one (or none)
 * with what export would change in it that the composer reads — the logic
 * list, and the Python packages. The composer reads `manifest.json` from the
 * files it is given, and refuses an `import torch` it does not declare.
 */
export function previewManifest(
  retainedManifest: Record<string, unknown> | null,
  logicPaths: readonly string[],
  pythonPackages: readonly string[] | undefined
): Record<string, unknown> {
  const manifest: Record<string, unknown> = retainedManifest
    ? (JSON.parse(JSON.stringify(retainedManifest)) as Record<string, unknown>)
    : { formatVersion: BUNDLE_FORMAT_VERSION };
  const files = isObject(manifest.files) ? { ...manifest.files } : {};
  files.logic = exportedLogicPaths(retainedManifest, logicPaths);
  manifest.files = files;
  if (pythonPackages !== undefined) {
    manifest.config = withPythonPackages(isObject(manifest.config) ? manifest.config : {}, pythonPackages);
  }
  return manifest;
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
  // Each group is the project's list. A group with nothing in it is written
  // for a project made here, and for a manifest that had the group; a
  // manifest that listed no `xdb` or no `assets` is not given an empty one.
  const had = isObject(retained?.files) ? retained.files : null;
  const group = (name: string, paths: string[]): void => {
    if (!retained || paths.length > 0 || (had !== null && name in had)) files[name] = paths;
    else delete files[name];
  };
  group('ui', groups.ui);
  group('logic', exportedLogicPaths(retained ?? null, groups.logic));
  group('xdb', groups.xdb);
  group('assets', groups.assets);
  manifest.files = files;

  const config = isObject(manifest.config) ? { ...manifest.config } : {};
  const previousName = typeof retained?.name === 'string' ? retained.name : null;
  // A project made here starts with a window, as the Builder's own projects
  // always have. A manifest that came with none leaves with none: the
  // Builder has no control that sets one, and `{ title, width: 1200, height:
  // 800 }` was written into every bundle that passed through, a setting
  // nobody chose.
  if (!retained || isObject(config.window)) {
    const window = isObject(config.window) ? { ...config.window } : { title: options.name, width: 1200, height: 800 };
    // The window title tracked the app's name when it was the same; a title
    // set to something else is a setting the Builder has no control for.
    if (previousName !== null && window.title === previousName) window.title = options.name;
    config.window = window;
  }
  // The theme is declared when a person chose a side, when the manifest
  // declared one of the three words, and in a project that never had a
  // manifest, where the field shows what it starts as. A manifest that came
  // with no word, or with one the Builder does not know, is a project that
  // follows the device ("system" in the field): while it still does, the
  // manifest is left saying what it said. The mode was always written, and
  // read as "light" where there was none, so an untouched export pinned an
  // app that followed its visitor's device (utils/themeMode.ts).
  const declared = isObject(config.theme) ? config.theme.mode : undefined;
  if (!retained || options.themeMode !== 'system' || isThemeMode(declared)) {
    config.theme = { ...(isObject(config.theme) ? config.theme : {}), mode: options.themeMode };
  }
  const written = options.pythonPackages !== undefined ? withPythonPackages(config, options.pythonPackages) : config;
  // Nor is an empty `config` written into a manifest that had none.
  if (Object.keys(written).length > 0 || (retained !== null && retained !== undefined && 'config' in retained)) manifest.config = written;
  else delete manifest.config;

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

  // A file that came empty is still a file, and goes back as one.
  const permission = options.permissions ? buildPermissionJson(options.permissions) : null;
  if (permission !== null) files['permission.json'] = strToU8(permission);

  // Generate XDB entries, one serializer for both export paths.
  const xdb: string[] = [];
  const unread = unreadXdbPaths(options.source);
  for (const col of options.collections) {
    const path = xdbPathFor(col.name, options.source);
    // Written there, the collection would take the place of a file kept as it came, and what is
    // in that file would be gone from the app without a word: the export is refused instead.
    if (unread.includes(path)) {
      throw new Error(`${path} could not be read when the project was opened, and is kept as it came; the collection "${col.name}" would be written over it. Give the collection another name.`);
    }
    const text = xdbText(col, options.records?.get(col.name));
    const kept = options.source?.xdbFiles?.get(col.name);
    files[path] = kept && kept.written === text ? kept.bytes : strToU8(text);
    xdb.push(path);
  }
  // Listed where they were among the collections the Builder writes, and written below with the
  // other entries kept as they came. A project with none lists its collections as it always has.
  const listed = unread.length > 0 ? inDeclaredOrder([...xdb, ...unread], options.source) : xdb;

  // What the Builder does not model goes back as it came, unless the Builder
  // now has a file of its own at that path.
  for (const [path, bytes] of options.source?.extraEntries ?? []) {
    if (path in files) continue;
    files[path] = bytes;
  }

  return { assets, xdb: listed, iconPath };
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
  files['manifest.json'] = manifestBytes(manifest, options.source);

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
      // The file's <logic src> is written with it: that tag is the only
      // thing that links logic to markup — the loader inlines by rewriting it,
      // with no manifest fallback. Without it the bundle ships its logic and
      // never runs it: bindings read undefined and handlers do nothing. The
      // tag names the file this UI file links, whatever its name and
      // language; it used to be `../logic/main.logic` or nothing, so a
      // Python entry file was exported with no logic at all.
      source = generateSource(uiFile.elements, uiFile.rootId, '', options.collections, {
        logicSrc: logicSrcOf(uiFile, options.logicFiles),
        // And the pages it uses: a page with no source has nowhere else to keep them.
        imports: uiFile.imports,
      });
    }

    files[path] = fileBytes(source, uiFile.bom);
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
    files[path] = fileBytes(logicFile.content, logicFile.bom);
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
  files['manifest.json'] = manifestBytes(manifest, options.source);

  debug('[exportMultiFileBundle] Creating bundle with', Object.keys(files).length, 'files');

  return zip(files, options);
}

/**
 * Parse a .softn bundle from ZIP data
 */
export function parseBundle(data: Uint8Array): {
  manifest: BundleManifest;
  /** The manifest.json as it was in the archive. */
  manifestBytes: Uint8Array;
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

  return { manifest: manifest as unknown as BundleManifest, manifestBytes: manifestData, files };
}

/**
 * Write a bundle where Export writes it: the browser's downloads, or on the
 * desktop a place asked for every time. The desktop's answer is handed
 * back as the file it wrote; a download has none to hand back.
 */
export async function exportBundleToFile(
  bundleData: Uint8Array,
  fileName: string,
): Promise<BundleFileHandle | null> {
  if (isDesktop()) return saveDesktopFile(bundleData, fileName, undefined, 'export');
  const blob = new Blob([new Uint8Array(bundleData)], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return null;
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
  existingHandle?: BundleFileHandle | null,
): Promise<BundleFileHandle | null> {
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
