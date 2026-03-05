/**
 * Bundle Loader - Loads .softn bundles into the builder state
 */

import { debug } from './debug';
import { parseBundle, BUNDLE_FORMAT_VERSION, type BundleManifest } from './bundleExporter';
import { parseSource, parseLogicFile } from './sourceParser';
import { validateBundle as validateBundleIntegrity } from './bundleValidator';
import type {
  CollectionDef,
  UIFileState,
  LogicFileState,
  UIImport,
  EntityDef,
  SchemaField,
} from '../types/builder';

export interface LoadedBundle {
  manifest: BundleManifest;
  uiFiles: Map<string, UIFileState>;
  logicFiles: Map<string, LogicFileState>;
  collections: CollectionDef[];
  entities: EntityDef[];
  seedData: Map<string, Record<string, unknown>[]>;
  assets: Map<string, Uint8Array>;
  warnings: string[];
}

let fileIdCounter = 0;

function generateFileId(): string {
  return `file_${Date.now()}_${fileIdCounter++}`;
}

/**
 * Normalize a file path to ensure it has the correct folder prefix
 */
function normalizePath(path: string, type: 'ui' | 'logic' | 'xdb' | 'assets'): string {
  // Normalize backslashes to forward slashes (cross-platform)
  let normalized = path.replace(/\\/g, '/');
  // Remove leading slash if present
  normalized = normalized.startsWith('/') ? normalized.slice(1) : normalized;

  // Check if already has correct prefix
  const prefixes: Record<string, string> = {
    ui: 'ui/',
    logic: 'logic/',
    xdb: 'xdb/',
    assets: 'assets/',
  };

  const prefix = prefixes[type];
  if (!normalized.startsWith(prefix)) {
    normalized = prefix + normalized;
  }

  return normalized;
}

/**
 * Try to get file content from files map, checking multiple path variations
 */
function getFileContent(
  files: Map<string, Uint8Array>,
  manifestPath: string,
  type: 'ui' | 'logic' | 'xdb' | 'assets'
): Uint8Array | undefined {
  // Try the path as-is first
  let content = files.get(manifestPath);
  if (content) return content;

  // Try with normalized path
  const normalizedPath = normalizePath(manifestPath, type);
  content = files.get(normalizedPath);
  if (content) return content;

  // Try without prefix (for older bundles where manifest has prefix but files don't)
  const prefixes = ['ui/', 'logic/', 'xdb/', 'assets/'];
  for (const prefix of prefixes) {
    if (manifestPath.startsWith(prefix)) {
      content = files.get(manifestPath.slice(prefix.length));
      if (content) return content;
    }
  }

  return undefined;
}

/**
 * Load a .softn bundle from Uint8Array data
 */
export async function loadBundle(data: Uint8Array): Promise<LoadedBundle> {
  fileIdCounter = 0;

  const { manifest, files } = parseBundle(data);

  // Handle format versioning
  if (!manifest.formatVersion) {
    manifest.formatVersion = '0.9'; // Legacy bundle without version
  }
  if (manifest.formatVersion !== BUNDLE_FORMAT_VERSION) {
    debug(
      `[bundleLoader] Bundle format ${manifest.formatVersion}, current ${BUNDLE_FORMAT_VERSION}`
    );
  }

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
  const assets = new Map<string, Uint8Array>();
  const warnings: string[] = [...validation.warnings];

  const decoder = new TextDecoder();

  // Load UI files
  for (const uiPath of manifest.files.ui || []) {
    const content = getFileContent(files, uiPath, 'ui');
    if (!content) {
      warnings.push(`UI file not found: ${uiPath}`);
      continue;
    }

    const source = decoder.decode(content);
    const parsed = parseSource(source);

    const fileId = generateFileId();

    // Convert parsed imports to UIImport format
    const imports: UIImport[] = parsed.imports || [];

    // Normalize the path to ensure it has the ui/ prefix
    const normalizedPath = normalizePath(uiPath, 'ui');

    uiFiles.set(fileId, {
      id: fileId,
      path: normalizedPath,
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

  // Load logic files
  for (const logicPath of manifest.files.logic || []) {
    const content = getFileContent(files, logicPath, 'logic');
    if (!content) {
      warnings.push(`Logic file not found: ${logicPath}`);
      continue;
    }

    const source = decoder.decode(content);
    const { imports, exports } = parseLogicFile(source);

    const fileId = generateFileId();

    // Normalize the path to ensure it has the logic/ prefix
    const normalizedPath = normalizePath(logicPath, 'logic');

    logicFiles.set(fileId, {
      id: fileId,
      path: normalizedPath,
      content: source,
      imports,
      exports,
    });
  }

  // Load XDB files
  debug('[bundleLoader] XDB files in manifest:', manifest.files.xdb || []);
  for (const xdbPath of manifest.files.xdb || []) {
    const content = getFileContent(files, xdbPath, 'xdb');
    if (!content) {
      warnings.push(`XDB file not found: ${xdbPath}`);
      continue;
    }

    try {
      const xdbData = JSON.parse(decoder.decode(content));
      const collectionName = xdbData.collection;
      const records = xdbData.records || [];
      debug(`[bundleLoader] Loaded XDB: ${collectionName} with ${records.length} records`);

      // Extract field schema from seed data
      const fields: SchemaField[] = [];
      if (records.length > 0) {
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
        alias: collectionName,
        fields,
        position: { x: 100 + entities.length * 300, y: 100 },
      });

      // Store seed data using entity ID as key (to match schemaStore expectations)
      // Store flat data objects for the Data tab display
      const flatRecordData = records.map((r: { data: Record<string, unknown> }) => r.data);
      seedData.set(entityId, flatRecordData);

      // Also store full records for Preview (which needs { id, collection, data, ... } structure)
      // We'll transform this in LivePreview when building initialData

      // Also update collection with seed data
      const existingCol = collections.find((c) => c.name === collectionName);
      if (existingCol) {
        existingCol.fields = fields;
        existingCol.seedData = flatRecordData;
        existingCol.fullRecords = records; // Keep full records for preview
      } else {
        collections.push({
          name: collectionName,
          alias: collectionName,
          fields,
          seedData: flatRecordData,
          fullRecords: records, // Keep full records for preview
        });
      }
    } catch (e) {
      warnings.push(`Failed to parse XDB file: ${xdbPath} - ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }

  // Load assets
  for (const assetPath of manifest.files.assets || []) {
    const content = getFileContent(files, assetPath, 'assets');
    if (content) {
      const normalizedPath = normalizePath(assetPath, 'assets');
      assets.set(normalizedPath, content);
    }
  }

  debug('[bundleLoader] Loaded:', uiFiles.size, 'UI files,', logicFiles.size, 'logic files');
  debug(
    '[bundleLoader] Entities:',
    entities.length,
    entities.map((e) => `${e.name}(${e.id})`)
  );
  debug('[bundleLoader] SeedData keys:', Array.from(seedData.keys()));
  debug(
    '[bundleLoader] SeedData sizes:',
    Array.from(seedData.entries()).map(([k, v]) => `${k}: ${v.length} records`)
  );

  if (warnings.length > 0) {
    console.warn('[bundleLoader] Warnings:', warnings);
  }

  return {
    manifest,
    uiFiles,
    logicFiles,
    collections,
    entities,
    seedData,
    assets,
    warnings,
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
 * Prompt user to select a .softn file
 */
export async function selectBundleFile(): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
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
        const arrayBuffer = await file.arrayBuffer();
        resolve(new Uint8Array(arrayBuffer));
      } catch (e) {
        console.error('Failed to read file:', e);
        resolve(null);
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
