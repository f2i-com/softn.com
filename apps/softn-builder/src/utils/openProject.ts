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
 * launch. There is no second prompt after a remote open fails.
 */

import { useCanvasStore } from '../stores/canvasStore';
import { useProjectStore, emptyRetainedSource, type RetainedSource, type SerializedProject } from '../stores/projectStore';
import { useHistoryStore } from '../stores/historyStore';
import { useSchemaStore } from '../stores/schemaStore';
import { useFilesStore } from '../stores/filesStore';
import { loadBundle, type LoadedBundle } from './bundleLoader';
import { encodeAsset, decodeAsset, type SerializedAssetFile } from './sessionAssets';
import { freshIdentity, type RecordIdentity, type XdbRecordEnvelope } from './xdbFormat';
import { readLocalStorage, removeLocalStorage } from './safeStorage';
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

export const SESSION_STORAGE_KEY = 'softn.builder.session.v1';
/** Where a session that would not restore is kept, with the error, until exported or discarded. */
export const QUARANTINE_STORAGE_KEY = 'softn.builder.session.v1.quarantine';

interface SerializedUIFile extends Omit<UIFileState, 'elements'> {
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
    activeFileId: string | null;
    openTabs: string[];
  };
  /** What the opened bundle carried that the Builder does not model. */
  source?: {
    manifest: Record<string, unknown> | null;
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

function mimeTypeFromPath(path: string): string {
  const ext = path.toLowerCase().split('.').pop() || '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'bmp') return 'image/bmp';
  return 'application/octet-stream';
}

/**
 * The candidate for an opened bundle. Throws when the bundle cannot be a
 * whole workspace: no entry file, an entry file whose tree has no root, a
 * seed-row set that names no entity.
 */
export function prepareProjectSnapshot(bundle: LoadedBundle): ProjectSnapshot {
  const themeMode = bundle.manifest.config?.theme?.mode || 'light';

  const assets: AssetFile[] = Array.from(bundle.assets.entries()).map(([path, bytes]) => ({
    name: path.replace(/^assets\//, ''),
    type: mimeTypeFromPath(path),
    data: bytes,
  }));
  const assetFiles = new Map<string, AssetFile>();
  for (const asset of assets) assetFiles.set(`assets/${asset.name}`, asset);

  const mainUIFile = bundle.uiFiles.get(bundle.mainFileId);
  if (!mainUIFile) {
    throw new Error(`The entry file "${bundle.manifest.main}" was not loaded from the bundle.`);
  }
  if (!mainUIFile.elements.has(mainUIFile.rootId)) {
    throw new Error(`The entry file "${mainUIFile.path}" has no root element; it did not parse as a UI file.`);
  }

  // Ensure the App component's theme prop matches the project themeMode.
  // This is the copy on open, not an edit; the file store gets the same tree
  // (commit syncs it without marking anything dirty), so the first flush
  // does not read the theme it put there as an edit.
  const elements = new Map(mainUIFile.elements);
  const rootElement = elements.get(mainUIFile.rootId);
  if (rootElement && rootElement.componentType === 'App' && rootElement.props.theme !== themeMode) {
    elements.set(mainUIFile.rootId, {
      ...rootElement,
      props: { ...rootElement.props, theme: themeMode },
    });
  }

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
      // The default logic is not this project's; a bundle without a main
      // logic file has none.
      logicSource: mainLogicFile?.content ?? '',
      collections: [],
      assets,
      source: {
        manifest: bundle.rawManifest,
        extraEntries: bundle.extraEntries,
        mainFileId: bundle.mainFileId,
        xdbPaths: bundle.xdbPaths,
        iconPath: bundle.iconPath,
      },
    },
    canvas: { elements, rootId: mainUIFile.rootId, imports: mainUIFile.imports || [] },
    schema: {
      entities: bundle.entities,
      relationships: [],
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

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pairs<V>(value: unknown, what: string): [string, V][] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((p) => !Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string')) {
    throw new Error(`${what} is not a list of [id, value] pairs`);
  }
  return value as [string, V][];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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

  const uiFiles = new Map<string, UIFileState>(
    pairs<SerializedUIFile>(s.files.uiFiles, 'files.uiFiles').map(([id, file]) => {
      if (!isObject(file) || typeof file.path !== 'string') throw new Error(`UI file ${id} in the saved session is malformed`);
      return [id, { ...file, elements: new Map<string, CanvasElement>(pairs<CanvasElement>(file.elements, `files.uiFiles[${id}].elements`)) }];
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

  const entities = Array.isArray(s.schema.entities) ? (s.schema.entities as EntityDef[]) : [];
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
        extraEntries: new Map(pairs<string>(src.extraEntries, 'source.extraEntries').map(([path, b64]) => [path, base64ToBytes(b64)])),
        mainFileId: typeof src.mainFileId === 'string' ? src.mainFileId : null,
        xdbPaths: new Map(pairs<string>(src.xdbPaths, 'source.xdbPaths')),
        iconPath: typeof src.iconPath === 'string' ? src.iconPath : null,
      }
    : emptyRetainedSource();

  const project = s.project as SerializedProject;
  const view: ViewMode = s.view === 'logic' || s.view === undefined ? 'design' : (s.view as ViewMode);

  return {
    origin: 'session',
    project: {
      name: project.name || 'Untitled App',
      version: project.version || '1.0.0',
      description: project.description || '',
      icon: project.icon || null,
      themeMode: project.themeMode || 'light',
      permissions: project.permissions,
      logicSource: project.logicSource || '',
      collections: project.collections || [],
      assets: [...assetFiles.values()],
      source,
    },
    canvas: { elements, rootId: s.canvas.rootId, imports: Array.isArray(s.canvas.imports) ? s.canvas.imports : [] },
    schema: {
      entities,
      relationships: Array.isArray(s.schema.relationships) ? (s.schema.relationships as RelationshipDef[]) : [],
      seedData,
      recordIdentity,
      tombstones,
      selectedEntityId: typeof s.schema.selectedEntityId === 'string' ? s.schema.selectedEntityId : entities[0]?.id ?? null,
    },
    files: {
      kind: 'state',
      nodes,
      rootFolders: Array.isArray(s.files.rootFolders) ? (s.files.rootFolders as string[]) : [],
      uiFiles,
      logicFiles,
      assetFiles,
      activeFileId: typeof s.files.activeFileId === 'string' ? s.files.activeFileId : null,
      openTabs: Array.isArray(s.files.openTabs) ? (s.files.openTabs as string[]) : [],
    },
    view,
    warnings: [],
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
      logicSource: snapshot.project.logicSource,
      collections: snapshot.project.collections,
    });
    useProjectStore.setState({ assets: [...snapshot.project.assets] });
    project.setSource(snapshot.project.source);

    const files = useFilesStore.getState();
    if (snapshot.files.kind === 'bundle') {
      files.loadFromBundle(snapshot.files.uiFiles, snapshot.files.logicFiles, snapshot.files.assetFiles);
      // The file store must hold the same tree the canvas is given, or the
      // first flush reads the theme it put there as an edit and rewrites the
      // file's source. This is the copy on open, not an edit.
      useFilesStore.getState().syncUIFileElements(snapshot.files.mainFileId, snapshot.canvas.elements, snapshot.canvas.rootId);
    } else {
      useFilesStore.setState({
        nodes: snapshot.files.nodes,
        rootFolders: snapshot.files.rootFolders,
        uiFiles: snapshot.files.uiFiles,
        logicFiles: snapshot.files.logicFiles,
        assetFiles: snapshot.files.assetFiles,
        activeFileId: snapshot.files.activeFileId,
        openTabs: snapshot.files.openTabs,
      });
    }

    useCanvasStore.getState().loadState(snapshot.canvas.elements, snapshot.canvas.rootId, snapshot.canvas.imports);

    useSchemaStore.setState({
      entities: snapshot.schema.entities,
      relationships: snapshot.schema.relationships,
      selectedEntityId: snapshot.schema.selectedEntityId,
      seedData: snapshot.schema.seedData,
      recordIdentity: snapshot.schema.recordIdentity,
      tombstones: snapshot.schema.tombstones,
    });

    // Loaded, not edited: clean, at revision 0 of a new project id.
    useProjectStore.getState().newWorkspace();
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
 */
export function captureSession(view: ViewMode): BuilderSession {
  const projectState = useProjectStore.getState();
  const canvasState = useCanvasStore.getState();
  const schemaState = useSchemaStore.getState();
  const filesState = useFilesStore.getState();
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
        { ...file, elements: Array.from(file.elements.entries()) },
      ]),
      logicFiles: Array.from(filesState.logicFiles.entries()),
      assetFiles: Array.from(filesState.assetFiles.entries()).map(
        ([id, asset]) => [id, encodeAsset(asset)] as [string, SerializedAssetFile]
      ),
      activeFileId: filesState.activeFileId,
      openTabs: filesState.openTabs,
    },
    source: {
      manifest: projectState.source.manifest,
      extraEntries: Array.from(projectState.source.extraEntries.entries()).map(([path, bytes]) => [path, bytesToBase64(bytes)]),
      mainFileId: projectState.source.mainFileId,
      xdbPaths: Array.from(projectState.source.xdbPaths.entries()),
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
 */
export function quarantineSession(raw: string, error: unknown): void {
  const record: QuarantinedSession = {
    quarantinedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    payload: raw,
  };
  try {
    window.localStorage.setItem(QUARANTINE_STORAGE_KEY, JSON.stringify(record));
  } catch (e) {
    // The live key is left in place then: better a repeated prompt than a lost session.
    console.warn('[openProject] Could not quarantine the session; leaving it where it is:', e);
    return;
  }
  removeLocalStorage(SESSION_STORAGE_KEY);
}

export function readQuarantinedSession(): QuarantinedSession | null {
  const raw = readLocalStorage(QUARANTINE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isObject(parsed) || typeof parsed.payload !== 'string') return null;
    return {
      quarantinedAt: typeof parsed.quarantinedAt === 'string' ? parsed.quarantinedAt : '',
      error: typeof parsed.error === 'string' ? parsed.error : 'unknown error',
      payload: parsed.payload,
    };
  } catch {
    return null;
  }
}

export function discardQuarantinedSession(): void {
  removeLocalStorage(QUARANTINE_STORAGE_KEY);
}

/** The quarantined payload as a file the person can keep. */
export function exportQuarantinedSession(): boolean {
  const record = readQuarantinedSession();
  if (!record) return false;
  const blob = new Blob([record.payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `softn-builder-session-${record.quarantinedAt.replace(/[:.]/g, '-') || 'quarantined'}.json`;
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
  | { kind: 'remote-open'; url: URL }
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
    params.delete('open');
    const rest = params.toString();
    history.replaceState({}, '', location.pathname + (rest ? `?${rest}` : ''));
    let url: URL | null = null;
    try {
      url = new URL(open, location.origin);
    } catch {
      url = null;
    }
    if (!url || url.origin !== location.origin || !/\.softn$/i.test(url.pathname)) {
      return { kind: 'refused-link', message: 'Only a .softn served by this site can be opened from a link.' };
    }
    return { kind: 'remote-open', url };
  }
  if (storedSession) return { kind: 'restore-prompt', raw: storedSession };
  return { kind: 'nothing' };
}

export type RemoteOpenOutcome =
  | { kind: 'opened'; snapshot: ProjectSnapshot }
  | { kind: 'superseded' }
  | { kind: 'declined' }
  | { kind: 'failed'; error: unknown };

export interface RemoteOpenDeps {
  fetchImpl?: typeof fetch;
  /** Asked when the initial workspace has unsaved edits by the time the bundle arrives. */
  confirmReplace?: (message: string) => boolean;
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
  const fetchImpl = deps.fetchImpl ?? fetch;
  const confirmReplace = deps.confirmReplace ?? ((message: string) => window.confirm(message));
  const load = deps.load ?? loadBundle;
  const generation = useProjectStore.getState().workspaceGeneration;
  const superseded = () => signal.aborted || useProjectStore.getState().workspaceGeneration !== generation;

  try {
    const resp = await fetchImpl(url.href, { credentials: 'same-origin', signal });
    if (superseded()) return { kind: 'superseded' };
    if (!resp.ok) throw new Error(`${url.pathname} responded ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (superseded()) return { kind: 'superseded' };
    const snapshot = prepareProjectSnapshot(await load(bytes));
    if (superseded()) return { kind: 'superseded' };
    if (useProjectStore.getState().isDirty) {
      if (!confirmReplace(`Open ${snapshot.label} from the link? The edits made here since the page opened will be lost.`)) {
        return { kind: 'declined' };
      }
      // The question took time; the answer is for the workspace it was asked about.
      if (superseded()) return { kind: 'superseded' };
    }
    commitProjectSnapshot(snapshot);
    return { kind: 'opened', snapshot };
  } catch (e) {
    if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return { kind: 'superseded' };
    return { kind: 'failed', error: e };
  }
}
