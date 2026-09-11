/**
 * The project as a bundle, from the stores as they stand.
 *
 * Save and the export dialog each built the bundle themselves, in the same
 * twenty lines: flush the canvas into the active file, gather the schema's
 * collections, choose single- or multi-file export. Two copies, and they had
 * already disagreed once (one flushed, one did not). This is the one copy.
 * Everything that wants the bundle — a save, a download, a pre-flight check,
 * a hand-off to the runtime or the directory — asks here.
 *
 * Every store read here happens synchronously, before the first await, so a
 * caller that captures the project's revision and then calls this gets the
 * bundle of that revision (utils/saveProject.ts depends on it).
 */

import { useCanvasStore } from '../stores/canvasStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import { useFilesStore } from '../stores/filesStore';
import { exportBundle, exportMultiFileBundle, type RetainedExportSource } from './bundleExporter';
import { envelopeFor, type XdbRecordEnvelope } from './xdbFormat';
import { debug } from './debug';
import type { CollectionDef } from '../types/builder';

/** Bytes and path for a project icon stored as a data URL, or nothing. */
export function decodeIconDataUrl(icon: string | null): { bytes: Uint8Array; path: string } | null {
  if (!icon) return null;
  const m = icon.match(/^data:(image\/(png|jpeg|webp|svg\+xml));base64,(.*)$/s);
  if (!m) return null;
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2] === 'svg+xml' ? 'svg' : m[2];
  try {
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, path: `assets/icon.${ext}` };
  } catch {
    return null;
  }
}

/**
 * The collections a bundle carries: the schema's entities first, then any
 * collection defined by hand that the schema does not already name.
 * References are written by entity name, because ids are minted afresh on
 * every open and would point at nothing after a round trip.
 */
export function gatherCollections(): CollectionDef[] {
  const projectState = useProjectStore.getState();
  const schemaState = useSchemaStore.getState();
  const entityNameById = new Map(schemaState.entities.map((e) => [e.id, e.name]));
  const schemaCollections: CollectionDef[] = schemaState.entities.map((entity) => ({
    name: entity.name,
    alias: entity.alias,
    fields: entity.fields.map((f) =>
      f.refEntity ? { ...f, refEntity: entityNameById.get(f.refEntity) ?? f.refEntity } : f
    ),
    seedData: schemaState.seedData.get(entity.id) || [],
  }));
  const schemaNames = new Set(schemaCollections.map((c) => c.name));
  const manual = projectState.collections.filter((c) => !schemaNames.has(c.name));
  return [...schemaCollections, ...manual];
}

/**
 * The records each schema collection is written with: every live row under
 * the identity it was read or made with, then the tombstones as they were.
 * See utils/xdbFormat.ts for the policy.
 */
export function gatherRecords(now = new Date().toISOString()): Map<string, XdbRecordEnvelope[]> {
  const schemaState = useSchemaStore.getState();
  const records = new Map<string, XdbRecordEnvelope[]>();
  for (const entity of schemaState.entities) {
    const rows = schemaState.seedData.get(entity.id) || [];
    const identity = schemaState.recordIdentity.get(entity.id) || [];
    const live = rows.map((data, i) => envelopeFor(entity.name, data, identity[i], now));
    const tombstones = schemaState.tombstones.get(entity.id) || [];
    records.set(entity.name, [...live, ...tombstones]);
  }
  return records;
}

/** Write the canvas into the file it is editing, so the export carries the latest edit. */
export function flushCanvasToActiveFile(): void {
  const filesState = useFilesStore.getState();
  const canvasState = useCanvasStore.getState();
  if (!filesState.activeFileId) return;
  const activeNode = filesState.nodes.get(filesState.activeFileId);
  if (activeNode?.type === 'file' && activeNode.fileType === 'ui') {
    filesState.updateUIFile(filesState.activeFileId, canvasState.elements, canvasState.rootId);
  }
}

/**
 * The entry file's path: the declared entry followed through a rename by its
 * file id; the declared path when that file is gone but another sits at the
 * path; `ui/main.ui` for a project made here. Never a guess from the names.
 */
export function resolveMainPath(): string {
  const projectState = useProjectStore.getState();
  const filesState = useFilesStore.getState();
  const uiPaths = [...filesState.uiFiles.values()].map((f) => (f.path.startsWith('/') ? f.path.slice(1) : f.path));
  const { mainFileId, manifest } = projectState.source;
  if (mainFileId) {
    const file = filesState.uiFiles.get(mainFileId);
    if (file) return file.path.startsWith('/') ? file.path.slice(1) : file.path;
  }
  const declared = manifest && typeof manifest.main === 'string' ? manifest.main : null;
  if (declared) {
    const stripped = declared.startsWith('/') ? declared.slice(1) : declared;
    if (uiPaths.includes(stripped)) return stripped;
    throw new Error(
      `The entry file "${declared}" is no longer in the project. Restore it, or rename another UI file to that path, before exporting.`
    );
  }
  if (uiPaths.includes('ui/main.ui')) return 'ui/main.ui';
  if (uiPaths.length === 1) return uiPaths[0];
  throw new Error('The project has no ui/main.ui to be its entry file. Create one, or name one main.ui.');
}

export async function buildProjectBundle(): Promise<Uint8Array> {
  flushCanvasToActiveFile();

  const projectState = useProjectStore.getState();
  const canvasState = useCanvasStore.getState();
  const filesState = useFilesStore.getState();
  const collections = gatherCollections();
  const records = gatherRecords();
  const icon = decodeIconDataUrl(projectState.icon);
  const retained = projectState.source;
  const source: RetainedExportSource = {
    manifest: retained.manifest,
    extraEntries: retained.extraEntries,
    iconPath: retained.iconPath,
    xdbPaths: retained.xdbPaths,
  };
  // The icon stays where the bundle had it when the format still matches;
  // a new icon of another format takes the default path.
  const iconPath =
    icon && retained.iconPath && retained.iconPath.toLowerCase().endsWith(icon.path.slice(icon.path.lastIndexOf('.')).toLowerCase())
      ? retained.iconPath
      : icon?.path;

  // Count the files rather than asking whether any came from a bundle:
  // `originalSource` is only set for files parsed out of an opened bundle, so a
  // project built from scratch would otherwise export only `ui/main.ui`. A
  // project opened from a bundle always takes the multi-file path, whatever
  // its count, because that is the path that keeps original source and the
  // declared entry.
  const hasMultipleFiles = filesState.uiFiles.size + filesState.logicFiles.size > 1 || retained.manifest !== null;

  const common = {
    name: projectState.name,
    version: projectState.version,
    description: projectState.description,
    themeMode: projectState.themeMode,
    collections,
    records,
    assets: projectState.assets,
    permissions: projectState.permissions,
    icon: icon?.bytes,
    iconPath,
    source,
  };

  if (hasMultipleFiles) {
    debug('[buildProjectBundle] multi-file export');
    return exportMultiFileBundle({
      ...common,
      uiFiles: filesState.uiFiles,
      logicFiles: filesState.logicFiles,
      main: resolveMainPath(),
    });
  }
  debug('[buildProjectBundle] single-file export');
  return exportBundle({
    ...common,
    elements: canvasState.elements,
    rootId: canvasState.rootId,
    logicSource: projectState.logicSource,
  });
}

/** The file name a bundle of this project downloads as. */
export function bundleFileName(name: string): string {
  return `${name.replace(/\s+/g, '-').toLowerCase() || 'untitled'}.softn`;
}
