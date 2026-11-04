/**
 * Replacing the workspace: a candidate first, the stores second.
 *
 * Opening a file, restoring the saved session and following a `?open=`
 * link all end here, and all three used to reset the live stores and then
 * fill them in step by step, so a failure halfway — a bad asset, a session
 * with a canvas but no files, an entry file the bundle did not have — left
 * the previous project gone and the new one half there. The file picker
 * was awaited outside any handler, so a rejected read was an unhandled
 * rejection; a session that failed to parse was deleted, taking the only
 * copy of the work with it.
 *
 * Now: {@link prepareProjectSnapshot} and {@link prepareSessionSnapshot}
 * decode and validate a complete candidate — assets, entry file, records
 * and their identity, cross-references — touching nothing, and throw when
 * they cannot. {@link commitProjectSnapshot} sets every store from the
 * candidate, and puts every store back if any step throws. A session that
 * will not restore is quarantined under its own key with the error, kept
 * for export, not deleted.
 *
 * Remote open (`?open=`) is bound to the workspace generation captured
 * before the fetch begins and re-checked before the commit, so a late
 * response cannot replace a project opened or edited in the meantime.
 *
 * Precedence at startup, decided in {@link startupAction}: a `?open=` link
 * wins over the session-restore prompt. The link is the reason the page was
 * opened; the saved session stays stored, untouched, for the next plain
 * launch, and is set aside if the first edit would replace unsaved work
 * ({@link noteOpenedFromLink}). There is no second prompt after a remote open
 * fails.
 */

import { useCanvasStore } from '../stores/canvasStore';
import { useProjectStore, emptyRetainedSource, type RetainedSource, type SerializedProject } from '../stores/projectStore';
import { useHistoryStore } from '../stores/historyStore';
import { useSchemaStore } from '../stores/schemaStore';
import { ensureFieldIds } from './schemaFields';
import { useFilesStore } from '../stores/filesStore';
import { fetchSameOriginBundle, isAbort } from '@softn/editor-shared/remoteOpen';
import { classifyAsset, readPythonPackages } from '@softn/core';
import { loadBundle, type LoadedBundle } from './bundleLoader';
import { base64ToBytes, bytesToBase64 } from './base64';
import { isObject } from './values';
import { inferRelationships, validRelationships } from './schemaRelationships';
import { encodeAsset, decodeAsset, type SerializedAssetFile } from './sessionAssets';
import { SESSION_ASSETS_HEAD_KEY, SESSION_ASSETS_KEY, captureAssets, joinStoredSession, type AssetRef } from './storedAssets';
import { freshIdentity, type RecordIdentity, type XdbRecordEnvelope } from './xdbFormat';
import { readLocalStorage, removeLocalStorage } from './safeStorage';
import { describeMigrations, migrateElements } from './propMigrations';
import { applyInlineLogicMove, planInlineLogicMove, takenPaths } from './inlineLogic';
import { entryFileId } from './logicFiles';
import { readThemeMode } from './themeMode';
import { emptyDeclaration, withManifestPermissions } from './permissions';
import { keepSavedPoint } from './savedPoint';
import { askConfirm } from './confirm';
import { gatherCollections, gatherRecords } from './buildProjectBundle';
import { xdbText, type KeptXdb } from './bundleExporter';
import { elementsEqual } from './elementsEqual';
import { isDesktop, saveDesktopFile } from './desktop';
import type {
  AssetFile,
  CanvasElement,
  EntityDef,
  LogicFileState,
  ProjectFileNode,
  RelationshipDef,
  UIFileState,
} from '../types/builder';

export type ViewMode = 'design' | 'preview' | 'code' | 'data';
const VIEW_MODES: readonly ViewMode[] = ['design', 'preview', 'code', 'data'];

export const SESSION_STORAGE_KEY = 'softn.builder.session.v1';
/** Where a session that would not restore is kept, with the error, until exported or discarded. */
export const QUARANTINE_STORAGE_KEY = 'softn.builder.session.v1.quarantine';
/** The assets of the session set aside, which are a record of their own (utils/storedAssets.ts). */
export const QUARANTINE_ASSETS_KEY = 'softn.builder.session.v1.quarantine.assets';

interface SerializedUIFile extends Omit<UIFileState, 'elements' | 'baseline'> {
  elements: [string, CanvasElement][];
}

export interface BuilderSession {
  savedAt: string;
  /** The project this session was written from, and at which revision. */
  projectId?: string;
  revision?: number;
  view: ViewMode | 'logic';
  project: SerializedProject;
  canvas: {
    elements: [string, CanvasElement][];
    rootId: string;
    imports: UIFileState['imports'];
  };
  schema: {
    entities: EntityDef[];
    relationships: RelationshipDef[];
    seedData: [string, Record<string, unknown>[]][];
    /** Sessions written before identity was kept have none; rows are re-identified on restore. */
    recordIdentity?: [string, RecordIdentity[]][];
    tombstones?: [string, XdbRecordEnvelope[]][];
    selectedEntityId: string | null;
  };
  files: {
    nodes: [string, ProjectFileNode][];
    rootFolders: string[];
    uiFiles: [string, SerializedUIFile][];
    logicFiles: [string, LogicFileState][];
    /**
     * Assets, base64-encoded.
     *
     * These were omitted entirely, so restoring a session brought back a
     * project whose every `asset('logo.png')` resolved to nothing — images
     * and sounds gone, with the file tree still listing them.
     *
     * Base64 rather than the raw `Uint8Array`: JSON.stringify turns a byte
     * array into `{"0":80,"1":75,…}`, roughly seven bytes of text per byte of
     * asset, which would push almost any project past the storage quota.
     */
    assetFiles?: [string, SerializedAssetFile][];
    /** The assets by name, size and hash, where their bytes are kept in a record of their own (utils/storedAssets.ts). */
    assetRefs?: [string, AssetRef][];
    activeFileId: string | null;
    openTabs: string[];
  };
  /** What the opened bundle carried that the Builder does not model. */
  source?: {
    manifest: Record<string, unknown> | null;
    /** Base64. Absent in sessions written before it was kept. */
    manifestBytes?: string | null;
    extraEntries: [string, string][];
    mainFileId: string | null;
    xdbPaths: [string, string][];
    iconPath: string | null;
  };
}

/**
 * A complete, validated replacement for the workspace. Everything a commit
 * needs, decoded, and nothing the stores have not been asked to hold.
 */
export interface ProjectSnapshot {
  /** Where it came from, for the message and the file-handle policy. */
  origin: 'bundle' | 'session';
  project: {
    name: string;
    version: string;
    description: string;
    icon: string | null;
    themeMode: 'light' | 'dark' | 'system';
    permissions: SerializedProject['permissions'];
    pythonPackages: string[];
    logicSource: string;
    collections: SerializedProject['collections'];
    assets: AssetFile[];
    source: RetainedSource;
  };
  canvas: {
    elements: Map<string, CanvasElement>;
    rootId: string;
    imports: UIFileState['imports'];
  };
  schema: {
    entities: EntityDef[];
    relationships: RelationshipDef[];
    seedData: Map<string, Record<string, unknown>[]>;
    recordIdentity: Map<string, RecordIdentity[]>;
    tombstones: Map<string, XdbRecordEnvelope[]>;
    selectedEntityId: string | null;
  };
  files:
    | {
        kind: 'bundle';
        uiFiles: Map<string, UIFileState>;
        logicFiles: Map<string, LogicFileState>;
        assetFiles: Map<string, AssetFile>;
        /** The UI file the canvas shows once loaded; its tree may differ from the file's by the theme. */
        mainFileId: string;
      }
    | {
        kind: 'state';
        nodes: Map<string, ProjectFileNode>;
        rootFolders: string[];
        uiFiles: Map<string, UIFileState>;
        logicFiles: Map<string, LogicFileState>;
        assetFiles: Map<string, AssetFile>;
        activeFileId: string | null;
        openTabs: string[];
      };
  view: ViewMode;
  warnings: string[];
  /** For the toast. */
  label: string;
}

/**
 * The candidate for an opened bundle. Throws when the bundle cannot be a
 * whole workspace: no entry file, an entry file whose tree has no root, a
 * seed-row set that names no entity.
 */
export function prepareProjectSnapshot(bundle: LoadedBundle): ProjectSnapshot {
  const assets: AssetFile[] = Array.from(bundle.assets.entries()).map(([path, bytes]) => ({
    bundlePath: path,
    name: path.replace(/^assets\//, ''),
    type: classifyAsset(path).mime,
    data: bytes,
  }));
  const assetFiles = new Map<string, AssetFile>();
  for (const asset of assets) assetFiles.set(asset.bundlePath!, asset);

  const mainUIFile = bundle.uiFiles.get(bundle.mainFileId);
  if (!mainUIFile) {
    throw new Error(`The entry file "${bundle.manifest.main}" was not loaded from the bundle.`);
  }
  if (!mainUIFile.elements.has(mainUIFile.rootId)) {
    throw new Error(`The entry file "${mainUIFile.path}" has no root element; it did not parse as a UI file.`);
  }

  // The project's theme is what its manifest declares, and "system" where it
  // declares nothing, or a word that is not one of the three: what a runtime
  // makes of the same manifest (utils/themeMode.ts). It was "light" where the
  // manifest had none, or the side a literal `<App theme>` named, and the
  // next export wrote that into the manifest: an app that followed its
  // visitor's device was pinned by being opened and saved. The page's own
  // `theme` is the page's. It is read where the page is drawn
  // (utils/drawnTheme.ts) and is not changed to match the project: it used
  // to be, on the way in, and the first unrelated edit wrote that into the file.
  const elements = mainUIFile.elements;
  const themeMode = readThemeMode(bundle.manifest.config?.theme?.mode);

  for (const entityId of bundle.seedData.keys()) {
    if (!bundle.entities.some((e) => e.id === entityId)) {
      throw new Error(`Seed rows are keyed to an entity the bundle does not define: ${entityId}`);
    }
  }
  for (const entity of bundle.entities) {
    for (const field of entity.fields) {
      if (field.refEntity && !bundle.entities.some((e) => e.id === field.refEntity)) {
        throw new Error(`Field "${entity.name}.${field.name}" refers to an entity the bundle does not define.`);
      }
    }
  }

  const mainLogicFile = Array.from(bundle.logicFiles.values()).find((f) => f.path === 'logic/main.logic');

  return {
    origin: 'bundle',
    project: {
      name: bundle.manifest.name,
      version: bundle.manifest.version,
      description: bundle.manifest.description || '',
      icon: bundle.iconDataUrl,
      themeMode,
      permissions: bundle.permissions,
      // What the manifest asks the Python engine for. Only names the runtime
      // offers become the setting, and export writes the setting: a
      // misspelt declaration is dropped on the next save rather than kept.
      pythonPackages: readPythonPackages(bundle.rawManifest).packages,
      // The default logic is not this project's; a bundle without a main
      // logic file has none.
      logicSource: mainLogicFile?.content ?? '',
      collections: [],
      assets,
      source: {
        manifest: bundle.rawManifest,
        manifestBytes: bundle.manifestBytes,
        extraEntries: bundle.extraEntries,
        mainFileId: bundle.mainFileId,
        xdbPaths: bundle.xdbPaths,
        // How the Builder writes each as it was read is known once the project is in the stores (commitProjectSnapshot).
        xdbFiles: new Map([...bundle.xdbFiles].map(([name, bytes]) => [name, { bytes, written: null }])),
        iconPath: bundle.iconPath,
      },
    },
    canvas: { elements, rootId: mainUIFile.rootId, imports: mainUIFile.imports || [] },
    schema: {
      entities: bundle.entities,
      relationships: bundle.relationships ?? inferRelationships(bundle.entities),
      seedData: bundle.seedData,
      recordIdentity: bundle.recordIdentity,
      tombstones: bundle.tombstones,
      selectedEntityId: bundle.entities[0]?.id ?? null,
    },
    files: {
      kind: 'bundle',
      uiFiles: bundle.uiFiles,
      logicFiles: bundle.logicFiles,
      assetFiles,
      mainFileId: bundle.mainFileId,
    },
    view: 'design',
    warnings: bundle.warnings,
    label: `${bundle.manifest.name} v${bundle.manifest.version}`,
  };
}

function pairs<V>(value: unknown, what: string): [string, V][] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((p) => !Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string')) {
    throw new Error(`${what} is not a list of [id, value] pairs`);
  }
  return value as [string, V][];
}

/**
 * The kept .xdb files with how the Builder writes each collection as it was
 * read, from the stores of a bundle just opened. Never from a restored
 * session, whose collections may be edited since the file was read.
 */
function writtenAsRead(files: Map<string, KeptXdb>): Map<string, KeptXdb> {
  let collections;
  try {
    collections = gatherCollections();
  } catch {
    // Two collections of one name, a field with none: the export refuses those, and each file is written anew.
    return files;
  }
  const records = gatherRecords();
  const written = new Map(collections.map((collection) => [collection.name, xdbText(collection, records.get(collection.name))]));
  return new Map([...files].map(([name, file]) => [name, { ...file, written: written.get(name) ?? null }]));
}

/**
 * The file whose page the snapshot's canvas holds (canvasStore, pageId). A
 * bundle is opened with its entry on the canvas. A session does not say:
 * it is the one page that has the canvas's root and its elements, when
 * there is one, and otherwise nobody's until a page is opened.
 */
function pageOnCanvas(snapshot: ProjectSnapshot): string | null {
  if (snapshot.files.kind === 'bundle') return snapshot.files.mainFileId;
  const holding = [...snapshot.files.uiFiles.values()].filter(
    (file) => file.rootId === snapshot.canvas.rootId && elementsEqual(file.elements, snapshot.canvas.elements)
  );
  return holding.length === 1 ? holding[0].id : null;
}

/**
 * The candidate for a saved session. Throws — with a reason worth keeping —
 * on anything that does not decode to a whole workspace.
 */
export function prepareSessionSnapshot(raw: string): ProjectSnapshot {
  let session: unknown;
  try {
    session = JSON.parse(raw);
  } catch (e) {
    throw new Error(`the saved session is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!isObject(session)) throw new Error('the saved session is not an object');
  const s = session as Partial<BuilderSession>;
  if (!isObject(s.project) || !isObject(s.canvas) || !isObject(s.files) || !isObject(s.schema)) {
    throw new Error('the saved session is missing its project, canvas, schema or files');
  }

  const elements = new Map<string, CanvasElement>(pairs<CanvasElement>(s.canvas.elements, 'canvas.elements'));
  if (typeof s.canvas.rootId !== 'string' || !elements.has(s.canvas.rootId)) {
    throw new Error('the saved canvas has no root element');
  }
  // A session saved by an older Builder may hold props the components never
  // read (propMigrations.ts); they become what the components take, and the
  // rewrites are listed with the session's warnings.
  const migrationWarnings = describeMigrations('canvas', migrateElements(elements.values()));

  const uiFiles = new Map<string, UIFileState>(
    pairs<SerializedUIFile>(s.files.uiFiles, 'files.uiFiles').map(([id, file]) => {
      if (!isObject(file) || typeof file.path !== 'string') throw new Error(`UI file ${id} in the saved session is malformed`);
      const fileElements = new Map<string, CanvasElement>(pairs<CanvasElement>(file.elements, `files.uiFiles[${id}].elements`));
      migrationWarnings.push(...describeMigrations(file.path, migrateElements(fileElements.values())));
      // What a record says a file was read as is not taken from it: that is
      // worked out when the files are put in place (commitProjectSnapshot),
      // after everything a restore itself rewrites in them.
      return [id, { ...file, elements: fileElements, baseline: undefined }];
    })
  );
  const logicFiles = new Map<string, LogicFileState>(pairs<LogicFileState>(s.files.logicFiles, 'files.logicFiles'));
  for (const [id, file] of logicFiles) {
    if (!isObject(file) || typeof file.content !== 'string') throw new Error(`logic file ${id} in the saved session is malformed`);
  }
  const assetFiles = new Map<string, AssetFile>();
  for (const [id, asset] of pairs<SerializedAssetFile>(s.files.assetFiles, 'files.assetFiles')) {
    if (!isObject(asset) || typeof asset.data !== 'string' || typeof asset.name !== 'string') {
      throw new Error(`asset ${id} in the saved session is malformed`);
    }
    try {
      assetFiles.set(id, decodeAsset(asset));
    } catch (e) {
      throw new Error(`asset ${asset.name} in the saved session did not decode (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  const nodes = new Map<string, ProjectFileNode>(pairs<ProjectFileNode>(s.files.nodes, 'files.nodes'));

  const entities = Array.isArray(s.schema.entities)
    ? (s.schema.entities as EntityDef[]).map(entity => ({ ...entity, fields: ensureFieldIds(entity.fields) }))
    : [];
  const seedData = new Map<string, Record<string, unknown>[]>(pairs<Record<string, unknown>[]>(s.schema.seedData, 'schema.seedData'));
  for (const [entityId, rows] of seedData) {
    if (!Array.isArray(rows)) throw new Error(`seed rows of ${entityId} in the saved session are not a list`);
  }
  const storedIdentity = new Map<string, RecordIdentity[]>(pairs<RecordIdentity[]>(s.schema.recordIdentity, 'schema.recordIdentity'));
  const recordIdentity = new Map<string, RecordIdentity[]>();
  for (const [entityId, rows] of seedData) {
    const known = storedIdentity.get(entityId) || [];
    recordIdentity.set(
      entityId,
      rows.map((row, i) => known[i] ?? freshIdentity(row))
    );
  }
  const tombstones = new Map<string, XdbRecordEnvelope[]>(pairs<XdbRecordEnvelope[]>(s.schema.tombstones, 'schema.tombstones'));

  const src = s.source;
  const source: RetainedSource = src && isObject(src)
    ? {
        manifest: isObject(src.manifest) ? src.manifest : null,
        manifestBytes: typeof src.manifestBytes === 'string' ? base64ToBytes(src.manifestBytes) : null,
        extraEntries: new Map(pairs<string>(src.extraEntries, 'source.extraEntries').map(([path, b64]) => [path, base64ToBytes(b64)])),
        mainFileId: typeof src.mainFileId === 'string' ? src.mainFileId : null,
        xdbPaths: new Map(pairs<string>(src.xdbPaths, 'source.xdbPaths')),
        iconPath: typeof src.iconPath === 'string' ? src.iconPath : null,
      }
    : emptyRetainedSource();

  // A session saved before the Code view linked logic may hold the entry's
  // logic as an inline `<logic>` block — a copy the dock cannot see and the
  // preview and export run. It moves into its logic file here when that
  // loses nothing; otherwise it is left, and the dock offers the move.
  let fileTables = {
    nodes,
    rootFolders: Array.isArray(s.files.rootFolders) ? (s.files.rootFolders as string[]) : [],
    uiFiles,
    logicFiles,
  };
  const entryId = entryFileId(uiFiles, source);
  const entry = entryId ? uiFiles.get(entryId) : undefined;
  const move = entry
    ? planInlineLogicMove(entry, logicFiles, { isEntry: true, lossless: true, takenPaths: takenPaths(nodes, logicFiles) })
    : null;
  if (entry && move) {
    let n = 0;
    fileTables = applyInlineLogicMove(fileTables, move, () => `file_${Date.now()}_inline_${n++}`, false);
    migrationWarnings.push(
      `${entry.path} kept its logic inline; it now lives in ${move.logicPath}, linked with <logic src="${move.logicSrc}" />.`
    );
  }

  const project = s.project as SerializedProject;
  const view: ViewMode = s.view === 'logic' || s.view === undefined ? 'design' : (s.view as ViewMode);

  return {
    origin: 'session',
    project: {
      name: project.name || 'Untitled App',
      version: project.version || '1.0.0',
      description: project.description || '',
      icon: project.icon || null,
      // A record from before the theme was kept has none: see utils/themeMode.ts.
      themeMode: readThemeMode(project.themeMode),
      // What the runtime grants an export of it: a session saved before the manifest's older
      // `permissions` block was read showed nothing on for an app that block gives the network.
      permissions: withManifestPermissions({ ...emptyDeclaration(), ...(project.permissions ?? {}) }, source.manifest),
      // A session written before the setting existed has it only in the
      // manifest it retained, if it came from a bundle.
      pythonPackages: Array.isArray(project.pythonPackages) ? project.pythonPackages : readPythonPackages(source.manifest).packages,
      logicSource: project.logicSource || '',
      collections: project.collections || [],
      assets: [...assetFiles.values()],
      source,
    },
    canvas: { elements, rootId: s.canvas.rootId, imports: Array.isArray(s.canvas.imports) ? s.canvas.imports : [] },
    schema: {
      entities,
      relationships: Array.isArray(s.schema.relationships) ? validRelationships(entities, s.schema.relationships as RelationshipDef[]) : inferRelationships(entities),
      seedData,
      recordIdentity,
      tombstones,
      selectedEntityId: typeof s.schema.selectedEntityId === 'string' ? s.schema.selectedEntityId : entities[0]?.id ?? null,
    },
    files: {
      kind: 'state',
      ...fileTables,
      assetFiles,
      activeFileId: typeof s.files.activeFileId === 'string' ? s.files.activeFileId : null,
      openTabs: Array.isArray(s.files.openTabs) ? (s.files.openTabs as string[]) : [],
    },
    view,
    warnings: migrationWarnings,
    label: project.name || 'previous local session',
  };
}

/**
 * Set every store from the snapshot. Nothing is read from the stores; if
 * any step throws, every store is put back as it was and the error is
 * rethrown, so the caller reports a failed open over an intact workspace.
 * Advances the workspace generation, which is what makes a pending remote
 * open give up.
 */
export function commitProjectSnapshot(snapshot: ProjectSnapshot): void {
  const previous = {
    canvas: useCanvasStore.getState(),
    project: useProjectStore.getState(),
    history: useHistoryStore.getState(),
    schema: useSchemaStore.getState(),
    files: useFilesStore.getState(),
  };
  try {
    useCanvasStore.getState().reset();
    useProjectStore.getState().reset();
    useHistoryStore.getState().clear();
    useSchemaStore.getState().reset();
    useFilesStore.getState().reset();

    const project = useProjectStore.getState();
    project.fromJSON({
      name: snapshot.project.name,
      version: snapshot.project.version,
      description: snapshot.project.description,
      icon: snapshot.project.icon,
      themeMode: snapshot.project.themeMode,
      permissions: snapshot.project.permissions,
      pythonPackages: snapshot.project.pythonPackages,
      logicSource: snapshot.project.logicSource,
      collections: snapshot.project.collections,
    });
    useProjectStore.setState({ assets: [...snapshot.project.assets] });
    project.setSource(snapshot.project.source);

    const files = useFilesStore.getState();
    if (snapshot.files.kind === 'bundle') {
      files.loadFromBundle(snapshot.files.uiFiles, snapshot.files.logicFiles, snapshot.files.assetFiles, snapshot.files.mainFileId);
      // The file store must hold the same tree the canvas is given, or the
      // first flush reads the theme it put there as an edit and rewrites the
      // file's source. This is the copy on open, not an edit.
      useFilesStore.getState().syncUIFileElements(snapshot.files.mainFileId, snapshot.canvas.elements, snapshot.canvas.rootId);
    } else {
      useFilesStore.setState({
        nodes: snapshot.files.nodes,
        rootFolders: snapshot.files.rootFolders,
        // Each page is read as the text the session left it with: as it is
        // now, after an inline logic block has been moved to its file, and
        // not as it was stored.
        uiFiles: new Map(
          [...snapshot.files.uiFiles].map(([id, file]) => [
            id,
            file.originalSource === undefined
              ? { ...file, baseline: undefined }
              : { ...file, baseline: { source: file.originalSource, elements: file.elements, rootId: file.rootId, imports: file.imports ?? [] } },
          ])
        ),
        logicFiles: snapshot.files.logicFiles,
        assetFiles: snapshot.files.assetFiles,
        activeFileId: snapshot.files.activeFileId,
        openTabs: snapshot.files.openTabs,
      });
    }

    useCanvasStore.getState().loadState(snapshot.canvas.elements, snapshot.canvas.rootId, snapshot.canvas.imports, [], pageOnCanvas(snapshot));

    useSchemaStore.setState({
      entities: snapshot.schema.entities,
      relationships: snapshot.schema.relationships,
      selectedEntityId: snapshot.schema.selectedEntityId,
      seedData: snapshot.schema.seedData,
      recordIdentity: snapshot.schema.recordIdentity,
      tombstones: snapshot.schema.tombstones,
    });

    if (snapshot.files.kind === 'bundle') {
      const kept = useProjectStore.getState().source;
      if (kept.xdbFiles && kept.xdbFiles.size > 0) useProjectStore.getState().setSource({ ...kept, xdbFiles: writtenAsRead(kept.xdbFiles) });
    }

    // Loaded, not edited: clean, at revision 0 of a new project id, and
    // what an edit that is undone comes back to.
    useProjectStore.getState().newWorkspace();
    keepSavedPoint();
  } catch (e) {
    useCanvasStore.setState(previous.canvas, true);
    useProjectStore.setState(previous.project, true);
    useHistoryStore.setState(previous.history, true);
    useSchemaStore.setState(previous.schema, true);
    useFilesStore.setState(previous.files, true);
    throw e;
  }
}

/**
 * The session as the stores stand, for the recovery record. Synchronous,
 * so a save that captured a revision a moment ago writes that revision.
 *
 * `assets: 'apart'` is the shape it is stored in: each asset named
 * (`files.assetRefs`) and none of them held, the bytes being a record of
 * their own that is written only when they change (utils/storedAssets.ts).
 * Without it the assets are in the session, as every stored record had
 * them before, and as a session is restored from once the two are joined.
 */
export function captureSession(view: ViewMode, options: { assets?: 'inline' | 'apart' } = {}): BuilderSession {
  const projectState = useProjectStore.getState();
  const canvasState = useCanvasStore.getState();
  const schemaState = useSchemaStore.getState();
  const filesState = useFilesStore.getState();
  const apart = options.assets === 'apart';
  return {
    savedAt: new Date().toISOString(),
    projectId: projectState.projectId,
    revision: projectState.revision,
    view,
    project: projectState.toJSON(),
    canvas: {
      elements: Array.from(canvasState.elements.entries()),
      rootId: canvasState.rootId,
      imports: canvasState.imports || [],
    },
    schema: {
      entities: schemaState.entities,
      relationships: schemaState.relationships,
      seedData: Array.from(schemaState.seedData.entries()),
      recordIdentity: Array.from(schemaState.recordIdentity.entries()),
      tombstones: Array.from(schemaState.tombstones.entries()),
      selectedEntityId: schemaState.selectedEntityId,
    },
    files: {
      nodes: Array.from(filesState.nodes.entries()),
      rootFolders: filesState.rootFolders,
      uiFiles: Array.from(filesState.uiFiles.entries()).map(([id, file]) => [
        id,
        // What the file was read as is the editor's own, and is not kept: it holds the page a second time.
        { ...file, baseline: undefined, elements: Array.from(file.elements.entries()) },
      ]),
      logicFiles: Array.from(filesState.logicFiles.entries()),
      assetFiles: apart ? [] : Array.from(filesState.assetFiles.entries()).map(([id, asset]) => [id, encodeAsset(asset)] as [string, SerializedAssetFile]),
      ...(apart ? { assetRefs: captureAssets(filesState.assetFiles).refs } : {}),
      activeFileId: filesState.activeFileId,
      openTabs: filesState.openTabs,
    },
    source: {
      manifest: projectState.source.manifest,
      manifestBytes: projectState.source.manifestBytes ? bytesToBase64(projectState.source.manifestBytes) : null,
      extraEntries: Array.from(projectState.source.extraEntries.entries()).map(([path, bytes]) => [path, bytesToBase64(bytes)]),
      mainFileId: projectState.source.mainFileId,
      xdbPaths: Array.from(projectState.source.xdbPaths.entries()),
      // The .xdb files as they came are not here: a session is written again
      // and again into a store of a few megabytes, and they would be most of
      // it for an app with much data. A project restored from one writes its
      // collections anew (bundleExporter.ts, KeptXdb).
      iconPath: projectState.source.iconPath,
    },
  };
}

// ---------------------------------------------------------------------------
// Quarantine
// ---------------------------------------------------------------------------

export interface QuarantinedSession {
  quarantinedAt: string;
  error: string;
  /** The payload exactly as it was stored. */
  payload: string;
}

/**
 * Keep a session that would not restore, with the reason, under its own key.
 * The live key is cleared so the prompt does not recur; the bytes are not
 * deleted, because they may be the only copy of the work.
 *
 * `assetsRaw` is the record of the assets the session names. It is set
 * aside with it: left where it was it is the next project's to remove at
 * its first change, and the session kept would be its text alone. Moved,
 * not copied: the store has not the room for two of it.
 *
 * Whether it was set aside: a store that will not take it leaves it where it
 * was, and a caller about to write over that place must not. `keepEarlier`
 * leaves a session already set aside where it is, and this one too: it may be
 * someone's only copy, kept for them until they discard it (downloading it leaves it there).
 */
export function quarantineSession(raw: string, error: unknown, assetsRaw: string | null = null, options: { keepEarlier?: boolean } = {}): false | 'kept' | 'kept-without-assets' {
  if (options.keepEarlier && recoveryKeepsOne()) return false;
  const record: QuarantinedSession = {
    quarantinedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    payload: raw,
  };
  // `raw` may be a session read some time ago (as the page opened), and another tab may have
  // kept its own work there since: that one is left where it is, with its assets.
  const live = readLocalStorage(SESSION_STORAGE_KEY) === raw;
  try {
    window.localStorage.setItem(QUARANTINE_STORAGE_KEY, JSON.stringify(record));
  } catch (e) {
    // The live key is left in place then: better a repeated prompt than a lost session.
    console.warn('[openProject] Could not quarantine the session; leaving it where it is:', e);
    return false;
  }
  if (live) removeLocalStorage(SESSION_STORAGE_KEY);
  // Whatever was set aside before went with the session this one replaces.
  removeLocalStorage(QUARANTINE_ASSETS_KEY);
  if (assetsRaw === null) return 'kept';
  if (live) {
    removeLocalStorage(SESSION_ASSETS_KEY);
    removeLocalStorage(SESSION_ASSETS_HEAD_KEY);
  }
  try {
    window.localStorage.setItem(QUARANTINE_ASSETS_KEY, assetsRaw);
  } catch (e) {
    // (copied, not moved, when another tab's session took its place: two copies may not fit, and what the person is
    // told says the session was kept without them)
    console.warn('[openProject] The assets of the quarantined session could not be kept with it:', e);
    return 'kept-without-assets';
  }
  return 'kept';
}

/** What Recovery is said to hold when its record is not one this Builder writes. */
export const RECOVERY_UNREAD = 'the record it was kept in could not be read';

/**
 * The session Recovery keeps, or null when it keeps none. A record this Builder cannot read
 * (damaged, or in another form) is given as it is, so it can still be downloaded or discarded:
 * counted as kept but shown as nothing, it held Recovery for good, and every later set-aside was
 * refused for want of room no one could make.
 */
export function readQuarantinedSession(): QuarantinedSession | null {
  const raw = readLocalStorage(QUARANTINE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (isObject(parsed) && typeof parsed.payload === 'string') {
      return {
        quarantinedAt: typeof parsed.quarantinedAt === 'string' ? parsed.quarantinedAt : '',
        error: typeof parsed.error === 'string' ? parsed.error : 'unknown error',
        payload: parsed.payload,
      };
    }
  } catch {
    // Given as it is, below.
  }
  return { quarantinedAt: '', error: RECOVERY_UNREAD, payload: raw };
}

/** Whether Recovery keeps a session, as Export → Recovery shows it: one test, wherever it is asked. */
function recoveryKeepsOne(): boolean {
  return readQuarantinedSession() !== null;
}

/**
 * Whether Recovery still holds the session the person was shown. Another tab
 * may have discarded that one and set another aside since (a session held for
 * want of room moves in as soon as there is room), and that one is nobody's to
 * download or discard unseen.
 */
function stillHolds(shown: Pick<QuarantinedSession, 'quarantinedAt' | 'payload'>): boolean {
  const now = readQuarantinedSession();
  return now !== null && now.quarantinedAt === shown.quarantinedAt && now.payload === shown.payload;
}

/**
 * Discard the session in Recovery the person was shown, and only that one:
 * false, discarding nothing, when Recovery holds another now.
 */
export function discardQuarantinedSession(shown: Pick<QuarantinedSession, 'quarantinedAt' | 'payload'>): boolean {
  if (recoveryKeepsOne() && !stillHolds(shown)) return false;
  removeLocalStorage(QUARANTINE_STORAGE_KEY);
  removeLocalStorage(QUARANTINE_ASSETS_KEY);
  return true;
}

/**
 * The session in Recovery the person was shown, as a file they can keep:
 * false, saving nothing, when Recovery holds another now.
 */
export async function exportQuarantinedSession(shown: Pick<QuarantinedSession, 'quarantinedAt' | 'payload'>): Promise<boolean> {
  if (!stillHolds(shown)) return false;
  const record = readQuarantinedSession();
  if (!record) return false;
  const name = `softn-builder-session-${record.quarantinedAt.replace(/[:.]/g, '-') || 'quarantined'}.json`;
  // Whole: the session with the assets that were set aside with it put back into it.
  const assets = readLocalStorage(QUARANTINE_ASSETS_KEY);
  const payload = assets === null ? record.payload : joinStoredSession(record.payload, assets).raw;
  if (isDesktop()) {
    await saveDesktopFile(new TextEncoder().encode(payload), name, undefined, 'recovery');
    return true;
  }
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

// ---------------------------------------------------------------------------
// Startup precedence and remote open
// ---------------------------------------------------------------------------

export type StartupAction =
  /** `view`: the link's `&view=` (a starter opens on its running preview), else the bundle's own. */
  | { kind: 'remote-open'; url: URL; view?: ViewMode }
  | { kind: 'restore-prompt'; raw: string }
  | { kind: 'nothing' }
  | { kind: 'refused-link'; message: string };

/**
 * What the page does first, decided once. A `?open=` link wins over the
 * session-restore prompt; the link is consumed from the address bar so a
 * reload does not open it again over edited work. Same-origin .softn URLs
 * only — the value comes from the address bar and is not ours to trust.
 */
export function startupAction(location: Location, history: History, storedSession: string | null): StartupAction {
  const params = new URLSearchParams(location.search);
  const open = params.get('open');
  if (open !== null) {
    const asked = params.get('view');
    const view = VIEW_MODES.find((mode) => mode === asked);
    params.delete('open');
    params.delete('view');
    const rest = params.toString();
    history.replaceState(history.state, '', location.pathname + (rest ? `?${rest}` : '') + (location.hash || ''));
    let url: URL | null = null;
    try {
      url = new URL(open, location.origin);
    } catch {
      url = null;
    }
    if (!url || url.origin !== location.origin || !/\.softn$/i.test(url.pathname)) {
      return { kind: 'refused-link', message: 'Only a .softn served by this site can be opened from a link.' };
    }
    return view ? { kind: 'remote-open', url, view } : { kind: 'remote-open', url };
  }
  if (storedSession) return { kind: 'restore-prompt', raw: storedSession };
  return { kind: 'nothing' };
}

/**
 * A project opened from a link leaves the session it found in the store, for
 * the next plain launch. That holds until the first edit: the recovery copy is
 * one record, and a moment after the first change it would replace what was
 * there. So the first write is told (see writeRecoveryCopy), and someone's only
 * copy of unsaved work is set aside rather than written over.
 */
/** `raw`, for a session that would not restore: the text held, which the hold is for while the store still holds it. */
let pendingSetAside: { reason: string; unrestored: boolean; raw?: string } | null = null;

/** The reason kept with work set aside because a link opened another project over it. */
export const SET_ASIDE_BY_LINK = 'It was set aside when a link opened another project.';

/** The reason kept with work set aside because it was not restored when the Builder offered to. */
export const SET_ASIDE_NOT_RESTORED = 'It was set aside when it was not restored as the Builder opened.';

/**
 * A link is opening a project over whatever session the store holds. Said as the link is followed,
 * not once its project is open: a link that fails or is declined leaves the page on an empty
 * project, and a change made to it, or made while the link is loading, would write over the session.
 */
export function noteOpenedFromLink(): void {
  pendingSetAside = { reason: SET_ASIDE_BY_LINK, unrestored: false };
}

/**
 * The Builder has offered to restore the stored session. Until it is restored (takeOpenedFromLink
 * then), the next write sets it aside first: "Not now" leaves the page on an empty project, and its
 * first change would otherwise write over the work it declined for now.
 */
export function noteRestoreOffered(): void {
  pendingSetAside = { reason: SET_ASIDE_NOT_RESTORED, unrestored: false };
}

/**
 * A session that would not restore, and that Recovery would not take (it keeps another, or the
 * store has no room), is left where it is: the next write sets it aside first, with `reason`, or
 * writes nothing over it. Held whatever the session is, a copy of unsaved work or not: it would
 * not restore, so nothing else has it in a form this Builder can open.
 */
export function holdUnrestoredSession(reason: string, raw: string): void {
  pendingSetAside = { reason, unrestored: true, raw };
}

/** Whether this write is the first since a link opened a project: asked once. */
export function takeOpenedFromLink(): boolean {
  const opened = pendingSetAside !== null;
  pendingSetAside = null;
  return opened;
}

/**
 * The session `raw`, offered as the page opened, was restored: it is this tab's work now, and the
 * next write is its copy. Unless what is stored is no longer it: another tab kept its own work
 * there while the offer waited for an answer, and that is set aside before anything is written over
 * it, as after "Not now".
 */
export function restoredFromStore(raw: string): void {
  const stored = readLocalStorage(SESSION_STORAGE_KEY);
  if (stored === null || stored === raw) takeOpenedFromLink();
}

/**
 * Set aside a session that would not restore: in Recovery when it has room, and Recovery's own
 * is never replaced. When it is not set aside it stays where it is, and nothing is written over
 * it (holdUnrestoredSession). Returns what the person is told.
 */
export function setAsideUnrestored(raw: string, error: unknown, assetsRaw: string | null): string {
  const occupied = recoveryKeepsOne();
  const kept = quarantineSession(raw, error, assetsRaw, { keepEarlier: true });
  if (kept === 'kept-without-assets') {
    return 'It was kept without its pictures and other assets (this browser’s storage has no room for a copy of them); download it from Export → Recovery.';
  }
  if (kept) {
    return 'It was kept; download it from Export → Recovery.';
  }
  // No longer stored here (another tab kept its own work where it was): nothing of it is left to hold, and the set-aside
  // already waiting (as after "Not now") goes on keeping what is there now from being written over.
  if (readLocalStorage(SESSION_STORAGE_KEY) !== raw) {
    return 'It could not be set aside (Recovery keeps another, or this browser’s storage is full), and another tab has kept its own work where it was stored, so it is not kept here.';
  }
  holdUnrestoredSession(error instanceof Error ? error.message : String(error), raw);
  return occupied
    ? 'It is left where it is, and nothing is written over it: Recovery already keeps another. To make room, download that one in Export → Recovery if you want it, then discard it; or save this project to a file.'
    : 'It is left where it is, and nothing is written over it: this browser’s storage has no room to set it aside. Save this project to a file to keep your work.';
}

let judged: { raw: string; error: string | null } | null = null;

/**
 * Why a stored session would not restore, or null when it would. Asked once for each text: a
 * session that is held is asked about again at every write.
 */
function restoreError(raw: string): string | null {
  if (judged?.raw !== raw) {
    let error: string | null = null;
    try {
      prepareSessionSnapshot(raw);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    judged = { raw, error };
  }
  return judged.error;
}

/** A stored session's project name, read as far as it can be: for saying whose work is held. */
function sessionName(raw: string): string {
  try {
    const name = (JSON.parse(raw) as { project?: { name?: unknown } } | null)?.project?.name;
    if (typeof name === 'string' && name) return name;
  } catch {
    // A session that will not parse has no name to give.
  }
  return 'the session that would not restore';
}

/** What a copy of unsaved work says of itself (utils/recoveryCopy.ts). */
export interface RecoveryMark {
  tab: string;
  unsaved: true;
  assets: 'kept' | 'left-out';
}

/** What a stored session says of itself as a copy of unsaved work, or null for one Save wrote. */
export function recoveryOf(raw: string): (RecoveryMark & { name: string; savedAt: string }) | null {
  try {
    const session = JSON.parse(raw) as { recovery?: Partial<RecoveryMark>; project?: { name?: unknown }; savedAt?: unknown };
    if (!session || typeof session !== 'object' || session.recovery?.unsaved !== true) return null;
    return {
      tab: typeof session.recovery.tab === 'string' ? session.recovery.tab : '',
      unsaved: true,
      assets: session.recovery.assets === 'left-out' ? 'left-out' : 'kept',
      name: typeof session.project?.name === 'string' && session.project.name ? session.project.name : 'Untitled App',
      savedAt: typeof session.savedAt === 'string' ? session.savedAt : '',
    };
  } catch {
    return null;
  }
}

export type SetAside =
  /** Nothing to set aside: no link opened this project over unsaved work, or that is done. */
  | { kind: 'clear' }
  /** The unsaved work of `name` is under Export → Recovery now. */
  | { kind: 'set-aside'; name: string }
  /**
   * `keeping`'s unsaved work could not be set aside, and nothing may be written over it: Recovery
   * already keeps another (`recovery`), or the store has no room for a second copy (`room`).
   * Asked again at the next write.
   */
  | { kind: 'held'; keeping: string; reason: 'recovery' | 'room' };

/**
 * Asked before anything of this tab's is written where the session is kept: by the recovery copy
 * and by Save (and Export), whichever comes first. Unsaved work a link opened this project over is
 * set aside first, or not written over at all: a store with no room for a second copy of it, or
 * Recovery already keeping another, leaves it where it is.
 */
export function setAsideBeforeWriting(storage: { getItem?: (key: string) => string | null }): SetAside {
  const pending = pendingSetAside;
  pendingSetAside = null;
  if (pending === null) return { kind: 'clear' };
  const found = storage.getItem?.(SESSION_STORAGE_KEY) ?? null;
  const work = found === null ? null : recoveryOf(found);
  if (found === null) return { kind: 'clear' };
  // A session that would not restore is held for itself: once another tab has written its own over it (a session
  // Save wrote, which has its file, or its copy of unsaved work), there is nothing of it left here to keep, and what is
  // there now is not to be held, or set aside, under the reason it would not restore.
  if (pending.unrestored && pending.raw !== undefined && found !== pending.raw) return { kind: 'clear' };
  // A session Save wrote is in its file, unless it would not restore: then nothing has it in a form
  // this Builder opens, whatever opened over it, and it is kept with the reason it would not.
  const broken = work === null && !pending.unrestored ? restoreError(found) : null;
  if (work === null && !pending.unrestored && broken === null) return { kind: 'clear' };
  const name = work?.name ?? sessionName(found);
  const occupied = recoveryKeepsOne();
  if (!quarantineSession(found, new Error(broken ?? pending.reason), storage.getItem?.(SESSION_ASSETS_KEY) ?? null, { keepEarlier: true })) {
    pendingSetAside = pending;
    return { kind: 'held', keeping: name, reason: occupied ? 'recovery' : 'room' };
  }
  return { kind: 'set-aside', name };
}

export type RemoteOpenOutcome =
  | { kind: 'opened'; snapshot: ProjectSnapshot }
  | { kind: 'superseded' }
  | { kind: 'declined' }
  | { kind: 'failed'; error: unknown };

export interface RemoteOpenDeps {
  fetchImpl?: typeof fetch;
  /** Asked when the initial workspace has unsaved edits by the time the bundle arrives. */
  confirmReplace?: (message: string) => boolean | Promise<boolean>;
  load?: (bytes: Uint8Array) => Promise<LoadedBundle>;
}

/**
 * Fetch and open a bundle from a same-origin URL, bound to the workspace it
 * was started in. The generation is captured before the fetch and checked
 * again before the commit, so a response that arrives after a new project,
 * an open or a restore is dropped whether or not the fetch honoured the
 * signal. An abort — ours, from a superseding action or unmount — is quiet.
 */
export async function openRemoteBundle(url: URL, signal: AbortSignal, deps: RemoteOpenDeps = {}): Promise<RemoteOpenOutcome> {
  const confirmReplace = deps.confirmReplace
    ?? ((message: string) => askConfirm(message, { title: 'Unsaved changes', confirmLabel: 'Discard and open', danger: true }));
  const load = deps.load ?? loadBundle;
  const generation = useProjectStore.getState().workspaceGeneration;
  const superseded = () => signal.aborted || useProjectStore.getState().workspaceGeneration !== generation;

  try {
    // Redirect-origin check, bounded read, body cancelled when superseded:
    // the shared fetch (@softn/editor-shared) does what Studio's did too.
    const fetched = await fetchSameOriginBundle(url, { fetch: deps.fetchImpl, signal, superseded });
    if (fetched.kind === 'superseded') return { kind: 'superseded' };
    const snapshot = prepareProjectSnapshot(await load(fetched.bytes));
    if (superseded()) return { kind: 'superseded' };
    if (useProjectStore.getState().isDirty) {
      if (!(await confirmReplace(`Open ${snapshot.label} from the link? The edits made here since the page opened will be lost.`))) {
        return { kind: 'declined' };
      }
      // The question took time; the answer is for the workspace it was asked about.
      if (superseded()) return { kind: 'superseded' };
    }
    commitProjectSnapshot(snapshot);
    return { kind: 'opened', snapshot };
  } catch (e) {
    if (signal.aborted || isAbort(e)) return { kind: 'superseded' };
    return { kind: 'failed', error: e };
  }
}
