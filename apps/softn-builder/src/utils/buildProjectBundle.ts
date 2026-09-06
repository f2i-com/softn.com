/**
 * The project as a bundle, from the stores as they stand.
 *
 * Save and the export dialog each built the bundle themselves, in the same
 * twenty lines: flush the canvas into the active file, gather the schema's
 * collections, choose single- or multi-file export. Two copies, and they had
 * already disagreed once (one flushed, one did not). This is the one copy.
 * Everything that wants the bundle — a save, a download, a pre-flight check,
 * a hand-off to the runtime or the directory — asks here.
 */

import { useCanvasStore } from '../stores/canvasStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import { useFilesStore } from '../stores/filesStore';
import { exportBundle, exportMultiFileBundle } from './bundleExporter';
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

export async function buildProjectBundle(): Promise<Uint8Array> {
  flushCanvasToActiveFile();

  const projectState = useProjectStore.getState();
  const canvasState = useCanvasStore.getState();
  const filesState = useFilesStore.getState();
  const collections = gatherCollections();
  const icon = decodeIconDataUrl(projectState.icon);

  // Count the files rather than asking whether any came from a bundle:
  // `originalSource` is only set for files parsed out of an opened bundle, so a
  // project built from scratch would otherwise export only `ui/main.ui`.
  const hasMultipleFiles = filesState.uiFiles.size + filesState.logicFiles.size > 1;

  const common = {
    name: projectState.name,
    version: projectState.version,
    description: projectState.description,
    themeMode: projectState.themeMode,
    collections,
    assets: projectState.assets,
    permissions: projectState.permissions,
    icon: icon?.bytes,
    iconPath: icon?.path,
  };

  if (hasMultipleFiles) {
    debug('[buildProjectBundle] multi-file export');
    return exportMultiFileBundle({
      ...common,
      uiFiles: filesState.uiFiles,
      logicFiles: filesState.logicFiles,
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
