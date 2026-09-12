/**
 * Bundle Loader - Loads .softn bundles into the builder state
 *
 * What comes out is everything the archive held, in two kinds: the parts the
 * Builder models (UI and logic files, collections and their records, assets,
 * the icon, the declaration) and, as opaque bytes, everything else — the
 * manifest as read, `server/` files, files in groups the Builder does not
 * know, files in no group at all. The second kind used to be dropped on the
 * floor, so a save rewrote the app without its server and without whatever
 * a newer manifest had said. It is kept now and written back as it was.
 *
 * Files are kept at the archive path they were found at. The loader used to
 * prepend `ui/`, `logic/` and so on to any declared path that lacked the
 * folder, which moved files that a legacy manifest named without it; the
 * fallback lookup still exists for those bundles, but a file found at its
 * declared path is not moved (see bundleValidator.resolveEntry).
 */

import { debug } from './debug';
import { MAX_ZIP_INPUT_BYTES } from '@softn/core';
import { ensureFieldIds } from './schemaFields';
import { readBuilderSchema } from './builderSchemaMetadata';
import { parseBundle, type BundleManifest } from './bundleExporter';
import { parseSource, parseLogicFile } from './sourceParser';
import { validateBundle as validateBundleIntegrity, resolveEntry, FILE_GROUPS, type FileGroup } from './bundleValidator';
import { emptyDeclaration, readPermissionJson, type PermissionDeclaration } from './permissions';
import { identityOf, parseXdb, type RecordIdentity, type XdbRecordEnvelope } from './xdbFormat';
import type {
  CollectionDef,
  UIFileState,
  LogicFileState,
  UIImport,
  EntityDef,
  SchemaField,
  RelationshipDef,
} from '../types/builder';

export interface LoadedBundle {
  manifest: BundleManifest;
  /** The manifest exactly as parsed, for the export to patch rather than rebuild. */
  rawManifest: Record<string, unknown>;
  uiFiles: Map<string, UIFileState>;
  logicFiles: Map<string, LogicFileState>;
  collections: CollectionDef[];
  entities: EntityDef[];
  relationships: RelationshipDef[];
  seedData: Map<string, Record<string, unknown>[]>;
  /** The identity of each live seed row, aligned with `seedData`, by entity id. */
  recordIdentity: Map<string, RecordIdentity[]>;
  /** Records read with `deleted: true`, verbatim, by entity id. */
  tombstones: Map<string, XdbRecordEnvelope[]>;
  /** Where each collection's .xdb was, by collection name. */
  xdbPaths: Map<string, string>;
  assets: Map<string, Uint8Array>;
  /**
   * Validated entries the Builder does not model: `server/` files, files of
   * unknown groups, files in no group. Written back verbatim; never run.
   */
  extraEntries: Map<string, Uint8Array>;
  /** The archive path of the entry file, and the id of the UI file loaded from it. */
  mainPath: string;
  mainFileId: string;
  warnings: string[];
  /** What the bundle's permission.json declares; nothing when it has none. */
  permissions: PermissionDeclaration;
  /** The manifest's icon as a data URL, when the bundle carries it. */
  iconDataUrl: string | null;
  /** The archive path of the icon, when the manifest named one that exists. */
  iconPath: string | null;
}

/** The icon named by a manifest, as a data URL the project store keeps. */
function readIcon(bytes: Uint8Array, path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase();
  const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : null;
  if (!mime) return null;
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:${mime};base64,${btoa(bin)}`;
}

let fileIdCounter = 0;

function generateFileId(): string {
  return `file_${Date.now()}_${fileIdCounter++}`;
}

function declaredPaths(manifest: BundleManifest, group: FileGroup): string[] {
  const groups = (manifest as { files?: Record<string, unknown> }).files;
  const list = groups && !Array.isArray(groups) && typeof groups === 'object' ? groups[group] : undefined;
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
}

/**
 * Load a .softn bundle from Uint8Array data
 */
export async function loadBundle(data: Uint8Array): Promise<LoadedBundle> {
  fileIdCounter = 0;

  const { manifest, files } = parseBundle(data);
  // The manifest as read, before anything here touches the typed view of it.
  const rawManifest = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;

  debug(`[bundleLoader] Bundle format ${manifest.formatVersion ?? '(none, legacy)'}`);

  // Validate bundle integrity
  const validation = validateBundleIntegrity(manifest, files);
  if (!validation.valid) {
    throw new Error(
      `Invalid bundle: ${validation.errors.join('; ')}`
    );
  }

  debug('[bundleLoader] Loaded bundle:', manifest.name, 'v' + manifest.version);

  const uiFiles = new Map<string, UIFileState>();
  const logicFiles = new Map<string, LogicFileState>();
  const collections: CollectionDef[] = [];
  const entities: EntityDef[] = [];
  const seedData = new Map<string, Record<string, unknown>[]>();
  const recordIdentity = new Map<string, RecordIdentity[]>();
  const tombstones = new Map<string, XdbRecordEnvelope[]>();
  const xdbPaths = new Map<string, string>();
  const assets = new Map<string, Uint8Array>();
  const warnings: string[] = [...validation.warnings];
  /** Every archive path something here has taken; the rest are passthrough. */
  const consumed = new Set<string>();

  const decoder = new TextDecoder();

  const mainEntry = resolveEntry(files, manifest.main, 'ui');
  if (!mainEntry) throw new Error(`Invalid bundle: entry file "${manifest.main}" is not in the bundle`);
  let mainFileId: string | null = null;

  // Load UI files
  for (const uiPath of declaredPaths(manifest, 'ui')) {
    const found = resolveEntry(files, uiPath, 'ui');
    if (!found) {
      // Validation refuses this; the guard is for a manifest edited in between.
      warnings.push(`UI file not found: ${uiPath}`);
      continue;
    }
    if (consumed.has(found.path)) continue;
    consumed.add(found.path);
    if (found.migrated) warnings.push(`UI file "${uiPath}" was found at "${found.path}"; the export will name it there.`);

    const source = decoder.decode(found.bytes);
    const parsed = parseSource(source);

    const fileId = generateFileId();
    if (found.path === mainEntry.path) mainFileId = fileId;

    // Convert parsed imports to UIImport format
    const imports: UIImport[] = parsed.imports || [];

    uiFiles.set(fileId, {
      id: fileId,
      path: found.path,
      elements: parsed.elements,
      rootId: parsed.rootId,
      logicSrc: parsed.logicSrc,
      imports,
      originalSource: source, // Preserve original source for preview
    });

    // Collect collections from this file
    for (const col of parsed.collections) {
      if (!collections.some((c) => c.name === col.name)) {
        collections.push(col);
      }
    }
  }
  if (!mainFileId) {
    throw new Error(`Invalid bundle: entry file "${manifest.main}" is not listed in manifest.files.ui`);
  }

  // Load logic files
  for (const logicPath of declaredPaths(manifest, 'logic')) {
    const found = resolveEntry(files, logicPath, 'logic');
    if (!found) {
      warnings.push(`Logic file not found: ${logicPath}`);
      continue;
    }
    if (consumed.has(found.path)) continue;
    consumed.add(found.path);
    if (found.migrated) warnings.push(`Logic file "${logicPath}" was found at "${found.path}"; the export will name it there.`);

    const source = decoder.decode(found.bytes);
    const { imports, exports } = parseLogicFile(source);

    const fileId = generateFileId();

    logicFiles.set(fileId, {
      id: fileId,
      path: found.path,
      content: source,
      imports,
      exports,
    });
  }

  // Load XDB files
  debug('[bundleLoader] XDB files in manifest:', declaredPaths(manifest, 'xdb'));
  for (const xdbPath of declaredPaths(manifest, 'xdb')) {
    const found = resolveEntry(files, xdbPath, 'xdb');
    if (!found) {
      warnings.push(`XDB file not found: ${xdbPath}`);
      continue;
    }
    if (consumed.has(found.path)) continue;
    consumed.add(found.path);

    try {
      const fallbackName = found.path.replace(/^xdb\//, '').replace(/\.xdb$/, '');
      const parsed = parseXdb(decoder.decode(found.bytes), fallbackName);
      const collectionName = parsed.collection;
      const records = parsed.records;
      debug(`[bundleLoader] Loaded XDB: ${collectionName} with ${records.length} records`);
      if (parsed.skipped > 0) {
        warnings.push(`XDB file "${xdbPath}": ${parsed.skipped} record(s) without a usable id or data were skipped, as the runtime skips them.`);
      }
      if (xdbPaths.has(collectionName)) {
        warnings.push(`XDB file "${xdbPath}" repeats collection "${collectionName}"; the first one is kept.`);
        continue;
      }
      xdbPaths.set(collectionName, found.path);

      // Prefer the schema the bundle recorded; fall back to sniffing the first
      // seed row only for bundles written before it was recorded at all.
      //
      // Inference cannot recover what it never saw: `required` came back false
      // for everything, select options and references were dropped, and a
      // collection with no rows yet came back with no fields — so a save and
      // reopen silently emptied half the work the Data view exists to do.
      const declared = parsed.schema;
      let fields: SchemaField[] = [];
      if (declared && declared.fields.length > 0) {
        fields = ensureFieldIds(declared.fields);
      } else if (!declared && records.length > 0) {
        const sampleData = records[0].data || {};
        for (const [key, value] of Object.entries(sampleData)) {
          fields.push({
            id: `field_${key}`,
            name: key,
            type: inferFieldType(value),
            required: false,
          });
        }
      }

      // Create entity definition
      const entityId = `entity_${collectionName}`;
      entities.push({
        id: entityId,
        name: collectionName,
        alias: declared?.alias || collectionName,
        fields,
        position: { x: 100 + entities.length * 300, y: 100 },
      });

      // Rows for the Data view, and the identity each was read with, in the
      // same order. Tombstones are kept apart, verbatim.
      const flatRecordData = records.map((r) => r.data);
      seedData.set(entityId, flatRecordData);
      recordIdentity.set(entityId, records.map(identityOf));
      if (parsed.tombstones.length > 0) tombstones.set(entityId, parsed.tombstones);

      // Also update collection with seed data
      const fullRecords = [...records, ...parsed.tombstones] as Record<string, unknown>[];
      const existingCol = collections.find((c) => c.name === collectionName);
      if (existingCol) {
        existingCol.fields = fields;
        existingCol.seedData = flatRecordData;
        existingCol.fullRecords = fullRecords; // Keep full records for preview
      } else {
        collections.push({
          name: collectionName,
          alias: declared?.alias || collectionName,
          fields,
          seedData: flatRecordData,
          fullRecords, // Keep full records for preview
        });
      }
    } catch (e) {
      warnings.push(`Failed to parse XDB file: ${xdbPath} - ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }

  // Load assets
  for (const assetPath of declaredPaths(manifest, 'assets')) {
    const found = resolveEntry(files, assetPath, 'assets');
    if (!found) continue;
    if (consumed.has(found.path)) continue;
    consumed.add(found.path);
    assets.set(found.path, found.bytes);
  }

  // The icon, wherever the manifest put it. It is an asset when it is in the
  // assets group; either way the project keeps it as a data URL too.
  let iconDataUrl: string | null = null;
  let iconPath: string | null = null;
  if (typeof manifest.icon === 'string' && manifest.icon) {
    const found = resolveEntry(files, manifest.icon, 'assets');
    if (found) {
      iconDataUrl = readIcon(found.bytes, found.path);
      iconPath = found.path;
      consumed.add(found.path);
    } else {
      warnings.push(`Icon "${manifest.icon}" named by the manifest is not in the bundle.`);
    }
  }

  const permissionEntry = files.get('permission.json');
  const permissions = permissionEntry ? readPermissionJson(decoder.decode(permissionEntry)) : emptyDeclaration();
  consumed.add('permission.json');
  consumed.add('manifest.json');

  // Everything else passes through as it is: server files, files of groups
  // the Builder does not know, files no group names. Each has already been
  // through the bounded reader's path and checksum checks. Nothing is run.
  const extraEntries = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) {
    if (consumed.has(path)) continue;
    if (path.endsWith('/')) continue;
    extraEntries.set(path, bytes);
  }
  for (const group of FILE_GROUPS) {
    if (group === 'ui' || group === 'logic' || group === 'xdb' || group === 'assets') continue;
    for (const declared of declaredPaths(manifest, group)) {
      const found = resolveEntry(files, declared, group);
      if (found && !extraEntries.has(found.path) && !consumed.has(found.path)) extraEntries.set(found.path, found.bytes);
    }
  }

  debug('[bundleLoader] Loaded:', uiFiles.size, 'UI files,', logicFiles.size, 'logic files,', extraEntries.size, 'passthrough entries');
  debug(
    '[bundleLoader] Entities:',
    entities.length,
    entities.map((e) => `${e.name}(${e.id})`)
  );

  // Turn the reference names the exporter wrote back into this session's entity
  // ids. Every id here was generated a moment ago, so a reference stored as an
  // id would point at an entity from a previous run — which is to say, nothing.
  // A name that matches nothing is dropped rather than left dangling, so the
  // picker shows "no collection selected" instead of silently pointing nowhere.
  const entityIdByName = new Map(entities.map((e) => [e.name, e.id]));
  for (const entity of entities) {
    entity.fields = entity.fields.map((field) => {
      if (!field.refEntity) return field;
      return { ...field, refEntity: entityIdByName.get(field.refEntity) };
    });
  }

  if (warnings.length > 0) {
    console.warn('[bundleLoader] Warnings:', warnings);
  }

  const diagram = readBuilderSchema(rawManifest, entities);

  return {
    manifest,
    rawManifest,
    uiFiles,
    logicFiles,
    collections,
    entities: diagram.entities,
    relationships: diagram.relationships,
    seedData,
    recordIdentity,
    tombstones,
    xdbPaths,
    assets,
    extraEntries,
    mainPath: mainEntry.path,
    mainFileId,
    warnings,
    permissions,
    iconDataUrl,
    iconPath,
  };
}

/**
 * Infer field type from value
 */
function inferFieldType(
  value: unknown
): 'string' | 'number' | 'boolean' | 'date' | 'email' | 'url' {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') {
    // Check for email
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'email';
    // Check for URL
    if (/^https?:\/\//.test(value)) return 'url';
    // Check for date
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
  }
  return 'string';
}

/**
 * Prompt user to select a .softn file. Resolves null when the picker was
 * closed without a choice; rejects when the chosen file could not be read.
 */
export async function selectBundleFile(): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.softn';

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }

      try {
        if (file.size > MAX_ZIP_INPUT_BYTES) throw new Error('This bundle is too large. The maximum file size is 200 MB.');
        const arrayBuffer = await file.arrayBuffer();
        resolve(new Uint8Array(arrayBuffer));
      } catch (e) {
        // A file that cannot be read is a failure to report, not a cancel.
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };

    input.oncancel = () => {
      resolve(null);
    };

    input.click();
  });
}

/**
 * Load a bundle file and return parsed result
 */
export async function openBundleFile(): Promise<LoadedBundle | null> {
  const data = await selectBundleFile();
  if (!data) return null;

  try {
    return await loadBundle(data);
  } catch (e) {
    console.error('Failed to load bundle:', e);
    throw new Error(`Failed to load bundle: ${e instanceof Error ? e.message : 'Unknown error'}`);
  }
}
