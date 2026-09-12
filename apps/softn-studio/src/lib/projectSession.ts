import { useAIStore, useVFSStore, useWorkspaceStore } from '../stores';
import {
  clearLegacySnapshots,
  deleteProjectRecord,
  loadActiveProjectId,
  loadGlobalSettings,
  loadProjectRecord,
  migrateLegacyProject,
  removeRecentProject,
  saveActiveProjectId,
  saveGlobalSettings,
  saveProjectRecord,
  saveRecentProject,
  sameProjectContent,
  decodeRecordFiles,
  type PersistedFile,
  type ProjectRecord,
  type SaveFailureReason,
  type SaveResult,
} from './persistence';

/**
 * The life of a project in this tab: which project the stores hold, whether
 * an async action still owns the right to replace it, how many changes it
 * has had, and whether the last of those reached storage.
 *
 * Three counters, each with one job.
 *
 * The workspace *generation* goes up every time something takes the
 * workspace: a new project, an import, a restore, an open from a link, an
 * open from the recent list. An async action claims a generation before its
 * first await and checks it is still the owner before it commits — after
 * every await, because a fetch that ignores its AbortSignal still resolves.
 * A result whose generation has been superseded is dropped without a word:
 * it is not an error that the person moved on.
 *
 * The *revision* goes up with every change to the project in the session.
 * Autosave writes the revision it read; if the revision is still the one it
 * last wrote there is nothing to write, which is what keeps a save from
 * running for every render of an unchanged project.
 *
 * The save *status* is what the bar shows: saved, saving, or failed with
 * the reason. It is a tiny external store so any component can read it.
 */

// --- Workspace generation ---------------------------------------------------

let generation = 0;
let pendingAbort: AbortController | null = null;

export function currentGeneration(): number {
  return generation;
}

/**
 * Take the workspace for an action that will replace the project. The
 * previous in-flight action, if any, has its signal aborted; whether or not
 * it honours that, its ownership check will fail at commit.
 */
export function claimWorkspace(): { generation: number; signal: AbortSignal } {
  generation += 1;
  pendingAbort?.abort();
  pendingAbort = new AbortController();
  return { generation, signal: pendingAbort.signal };
}

export function ownsWorkspace(claimed: number): boolean {
  return generation === claimed;
}

/** Nobody owns the workspace any more: the editor is going away. */
export function releaseWorkspace(): void {
  generation += 1;
  pendingAbort?.abort();
  pendingAbort = null;
}

// --- Revision ---------------------------------------------------------------

let revision = 0;
let hydrating = false;
let lastSaved: { projectId: string; revision: number } | null = null;

export function currentRevision(): number {
  return revision;
}

/** A change happened. Returns the new revision. No-op while a record is being applied to the stores. */
export function touchRevision(): number {
  if (!hydrating) revision += 1;
  return revision;
}

export function isHydrating(): boolean {
  return hydrating;
}

/** Whether the revision in the stores is the one last written for this project. */
export function isSavedAt(projectId: string, rev: number): boolean {
  return lastSaved !== null && lastSaved.projectId === projectId && lastSaved.revision === rev;
}

export function markSaved(projectId: string, rev: number): void {
  lastSaved = { projectId, revision: rev };
}

// --- Save status ------------------------------------------------------------

export type SaveStatus =
  | { state: 'idle' }
  | { state: 'saving'; revision: number }
  | { state: 'saved'; revision: number; at: number }
  | { state: 'failed'; revision: number; at: number; reason: SaveFailureReason; message: string };

let saveStatus: SaveStatus = { state: 'idle' };
const statusListeners = new Set<() => void>();

export function getSaveStatus(): SaveStatus {
  return saveStatus;
}

export function subscribeSaveStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function setSaveStatus(next: SaveStatus): void {
  saveStatus = next;
  for (const listener of statusListeners) listener();
}

// --- Sessions ---------------------------------------------------------------

function newProjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Start a fresh project in the stores, with its own id, keeping the
 * person's display preference and provider configuration. The previous
 * project is not touched in storage: it has its own record under its own
 * id. Returns the new id.
 */
export function beginNewProjectSession(): string {
  const theme = useWorkspaceStore.getState().themePreview;
  const projectId = newProjectId();
  hydrating = true;
  try {
    useWorkspaceStore.getState().reset();
    useWorkspaceStore.setState({ projectId, themePreview: theme });
    useVFSStore.getState().reset();
    useAIStore.getState().resetSession();
  } finally {
    hydrating = false;
  }
  revision = 0;
  lastSaved = null;
  setSaveStatus({ state: 'idle' });
  return projectId;
}

/** Start a successfully decoded import from a clean project session. */
export function resetProjectSessionForImport(): string {
  return beginNewProjectSession();
}

/** Whether the stores hold anything worth keeping. */
export function hasProjectContent(): boolean {
  const ws = useWorkspaceStore.getState();
  return Boolean(ws.projectId) && (useVFSStore.getState().files.size > 0 || ws.projectName.trim().length > 0);
}

/** The stores as a record at revision `rev`, or null when there is no project. */
export function collectProjectRecord(rev: number, now = Date.now()): ProjectRecord | null {
  const ws = useWorkspaceStore.getState();
  if (!ws.projectId) return null;
  const ai = useAIStore.getState();
  const persistedBrief = ws.brief ? (({ referenceImages: _referenceImages, ...rest }) => rest)(ws.brief) : null;
  const files: PersistedFile[] = [];
  for (const file of useVFSStore.getState().files.values()) {
    files.push({
      path: file.path,
      mimeType: file.mimeType,
      lastModified: file.lastModified,
      lastModifiedBy: file.lastModifiedBy,
      version: file.version,
      content: file.content,
    });
  }
  return {
    projectId: ws.projectId,
    schemaVersion: 1,
    revision: rev,
    savedAt: now,
    workspace: {
      projectName: ws.projectName,
      projectId: ws.projectId,
      brief: persistedBrief,
      blueprint: ws.blueprint,
      taskGraph: ws.taskGraph,
      blueprintApproved: ws.blueprintApproved,
      mode: ws.mode,
      leftPanel: ws.leftPanel,
      leftPanelExpanded: ws.leftPanelExpanded,
      rightSidebarOpen: ws.rightSidebarOpen,
      bottomDrawerOpen: ws.bottomDrawerOpen,
      bottomTab: ws.bottomTab,
      advancedMode: ws.advancedMode,
      activePageId: ws.activePageId,
      activeFilePath: ws.activeFilePath,
      selectedComponentId: ws.selectedComponentId,
      devicePreset: ws.devicePreset,
      zoom: ws.zoom,
      themePreview: ws.themePreview,
      consoleOutput: ws.consoleOutput,
    },
    files,
    session: {
      messages: ai.messages,
      iterationsUsed: ai.iterationsUsed,
      tokensUsed: ai.tokensUsed,
      filesChanged: ai.filesChanged,
    },
  };
}

/**
 * Put a record into the stores. Workspace, files and chat come from the
 * same record, so they are the same revision by construction. The theme
 * stays as it is: it follows the product bar, not the saved project.
 */
export function applyProjectRecord(record: ProjectRecord): void {
  const theme = useWorkspaceStore.getState().themePreview;
  const ws = record.workspace;
  hydrating = true;
  try {
    useWorkspaceStore.getState().reset();
    useWorkspaceStore.setState({
      projectName: ws.projectName,
      projectId: record.projectId,
      brief: ws.brief ? { ...ws.brief, referenceImages: [] } : null,
      blueprint: ws.blueprint,
      taskGraph: ws.taskGraph,
      blueprintApproved: ws.blueprintApproved,
      mode: ws.mode as never,
      leftPanel: ws.leftPanel as never,
      leftPanelExpanded: ws.leftPanelExpanded,
      rightSidebarOpen: ws.rightSidebarOpen,
      bottomDrawerOpen: ws.bottomDrawerOpen,
      bottomTab: ws.bottomTab as never,
      advancedMode: ws.advancedMode,
      activePageId: ws.activePageId,
      activeFilePath: ws.activeFilePath,
      selectedComponentId: ws.selectedComponentId,
      devicePreset: ws.devicePreset as never,
      zoom: ws.zoom,
      themePreview: theme,
      consoleOutput: ws.consoleOutput,
      errors: [],
    });
    useAIStore.setState({
      messages: record.session.messages,
      draftMessage: '',
      lastFailure: null,
      iterationsUsed: record.session.iterationsUsed,
      tokensUsed: record.session.tokensUsed,
      filesChanged: record.session.filesChanged,
      agentState: 'idle',
      currentStep: '',
    });
    useVFSStore.getState().reset();
    useVFSStore.getState().hydrateFiles(decodeRecordFiles(record));
  } finally {
    hydrating = false;
  }
  revision = record.revision;
  lastSaved = { projectId: record.projectId, revision: record.revision };
  setSaveStatus({ state: 'saved', revision: record.revision, at: record.savedAt });
}

/** The person's provider settings into the AI store. */
function applyGlobalSettings(): void {
  const settings = loadGlobalSettings();
  if (!settings) return;
  useAIStore.setState({
    providers: settings.providers,
    activeProviderId: settings.activeProviderId,
    modelProfile: settings.modelProfile,
    maxIterations: settings.maxIterations,
    tokenBudget: settings.tokenBudget,
  });
  // Through the setters, so a value written by an older Studio with wider
  // bounds lands clamped rather than as written. Absent means the default.
  const ai = useAIStore.getState();
  if (settings.requestTimeoutMs !== undefined) ai.setRequestTimeoutMs(settings.requestTimeoutMs);
  if (settings.maxOutputTokens !== undefined) ai.setMaxOutputTokens(settings.maxOutputTokens);
}

/** The AI store's settings part to its own key. Returns the write's result. */
export function persistGlobalSettings(): SaveResult {
  const ai = useAIStore.getState();
  return saveGlobalSettings({
    providers: ai.providers,
    activeProviderId: ai.activeProviderId,
    modelProfile: ai.modelProfile,
    maxIterations: ai.maxIterations,
    tokenBudget: ai.tokenBudget,
    requestTimeoutMs: ai.requestTimeoutMs,
    maxOutputTokens: ai.maxOutputTokens,
  });
}

// --- Autosave ---------------------------------------------------------------

export interface AutosaveController {
  /** Save now if anything changed since the last save. Resolves with that save's result. */
  flush(): Promise<SaveResult>;
  stop(): void;
}

export interface AutosaveOptions {
  /** Quiet time after the last change before a save. */
  debounceMs?: number;
  /** The longest a change may wait while more keep arriving. */
  maxWaitMs?: number;
  save?: typeof saveProjectRecord;
  now?: () => number;
}

const NOTHING_TO_SAVE: SaveResult = { ok: true };

/**
 * The workspace fields that are the project. Validation errors are derived
 * from the files and re-derived on every restore; the dirty flag and the
 * theme are session state. None of those is a reason to write the record,
 * and counting them was one write per open for nothing.
 */
type WorkspaceSnapshot = ReturnType<typeof useWorkspaceStore.getState>;
const NON_PROJECT_WORKSPACE_KEYS = new Set<keyof WorkspaceSnapshot>(['errors', 'isDirty', 'themePreview']);

function workspaceProjectChanged(state: WorkspaceSnapshot, previous: WorkspaceSnapshot): boolean {
  for (const key of Object.keys(state) as Array<keyof WorkspaceSnapshot>) {
    if (typeof state[key] === 'function' || NON_PROJECT_WORKSPACE_KEYS.has(key)) continue;
    if (!Object.is(state[key], previous[key])) return true;
  }
  return false;
}

/**
 * The id of a project opened from the legacy keys that could not be
 * migrated at start. Once a later save of it has committed and read back
 * equal, the legacy keys have a verified replacement and are removed.
 */
let legacyPendingId: string | null = null;

/**
 * Watch the stores and write the project record after changes settle.
 *
 * Every store change bumps the revision and arms a short timer; more
 * changes push the timer back, up to `maxWaitMs`, so a streaming AI turn
 * does not put off the checkpoint for good. A save writes the revision it
 * read; a second flush with the same revision writes nothing. A failure
 * is reported through the save status and stays there until a later save
 * succeeds — the project is still in memory and still exportable, and the
 * bar says so. The AI store's settings part goes to its own key on its
 * own; the project record never carries it.
 */
export function startProjectAutosave(options: AutosaveOptions = {}): AutosaveController {
  const debounceMs = options.debounceMs ?? 800;
  const maxWaitMs = options.maxWaitMs ?? 5000;
  const save = options.save ?? saveProjectRecord;
  const now = options.now ?? (() => Date.now());

  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstChangeAt: number | null = null;
  let chain: Promise<SaveResult> = Promise.resolve(NOTHING_TO_SAVE);
  let stopped = false;

  async function performSave(): Promise<SaveResult> {
    if (stopped || !hasProjectContent()) return NOTHING_TO_SAVE;
    const rev = revision;
    const record = collectProjectRecord(rev, now());
    if (!record) return NOTHING_TO_SAVE;
    if (isSavedAt(record.projectId, rev)) return NOTHING_TO_SAVE;
    setSaveStatus({ state: 'saving', revision: rev });
    const result = await save(record);
    if (stopped) return result;
    if (result.ok) {
      lastSaved = { projectId: record.projectId, revision: rev };
      saveActiveProjectId(record.projectId);
      saveRecentProject({
        id: record.projectId,
        name: record.workspace.projectName || 'Untitled app',
        target: record.workspace.blueprint?.target ?? 'web',
        lastModified: new Date(record.savedAt).toLocaleString(),
      });
      setSaveStatus({ state: 'saved', revision: rev, at: record.savedAt });
      if (legacyPendingId === record.projectId) {
        // The legacy snapshot's replacement has committed; read it back before
        // the old keys go, as the start-up migration would have.
        const readBack = await loadProjectRecord(record.projectId);
        if (readBack && sameProjectContent(record, readBack)) {
          clearLegacySnapshots();
          legacyPendingId = null;
        }
      }
      // Changes arrived while the write was in flight: they are the next save.
      if (revision !== rev) schedule();
    } else {
      setSaveStatus({ state: 'failed', revision: rev, at: now(), reason: result.reason, message: result.message });
    }
    return result;
  }

  function run(): Promise<SaveResult> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    firstChangeAt = null;
    chain = chain.then(performSave, performSave);
    return chain;
  }

  function schedule(): void {
    if (stopped) return;
    const t = now();
    if (firstChangeAt === null) firstChangeAt = t;
    const remaining = Math.max(0, maxWaitMs - (t - firstChangeAt));
    const delay = Math.min(debounceMs, remaining);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delay);
  }

  function onProjectChange(): void {
    if (hydrating) return;
    touchRevision();
    schedule();
  }

  const unsubscribers = [
    useWorkspaceStore.subscribe((state, previous) => {
      if (workspaceProjectChanged(state, previous)) onProjectChange();
    }),
    useVFSStore.subscribe(onProjectChange),
    useAIStore.subscribe((state, previous) => {
      if (
        state.providers !== previous.providers ||
        state.activeProviderId !== previous.activeProviderId ||
        state.modelProfile !== previous.modelProfile ||
        state.maxIterations !== previous.maxIterations ||
        state.tokenBudget !== previous.tokenBudget ||
        state.requestTimeoutMs !== previous.requestTimeoutMs ||
        state.maxOutputTokens !== previous.maxOutputTokens
      ) {
        const written = persistGlobalSettings();
        if (!written.ok) {
          useWorkspaceStore.getState().addConsoleOutput(`Provider settings were not saved: ${written.message}`);
        }
      }
      if (
        state.messages !== previous.messages ||
        state.iterationsUsed !== previous.iterationsUsed ||
        state.tokensUsed !== previous.tokensUsed ||
        state.filesChanged !== previous.filesChanged
      ) {
        onProjectChange();
      }
    }),
  ];

  return {
    flush: () => run(),
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
}

// --- Restore and open -------------------------------------------------------

export type RestoreOutcome = { restored: boolean; notice: string | null };

/**
 * What the tab starts with.
 *
 * Precedence, in one place so it is the same on every start: the settings
 * key first (the person's providers, whatever project opens); then the
 * record the active-project pointer names; failing that, the legacy
 * single-slot snapshot, migrated; failing that, nothing — the dashboard.
 * A `?open=` link is handled by the caller *after* this returns, and it
 * opens as a new project: it never replaces what was restored, and what was
 * restored keeps its own record. A restore that is superseded while its
 * read is in flight (a StrictMode remount, an import started at once)
 * applies nothing.
 */
export async function restoreSession(now = Date.now()): Promise<RestoreOutcome> {
  const claim = claimWorkspace();
  applyGlobalSettings();
  const activeId = loadActiveProjectId();
  if (activeId) {
    const record = await loadProjectRecord(activeId);
    if (!ownsWorkspace(claim.generation)) return { restored: false, notice: null };
    if (record) {
      applyProjectRecord(record);
      return { restored: true, notice: null };
    }
  }
  const migration = await migrateLegacyProject(now);
  if (!ownsWorkspace(claim.generation)) return { restored: false, notice: null };
  if (migration.status === 'none') {
    applyGlobalSettings();
    return { restored: false, notice: null };
  }
  applyGlobalSettings();
  applyProjectRecord(migration.record);
  if (migration.status === 'migrated') {
    saveActiveProjectId(migration.record.projectId);
    saveRecentProject({
      id: migration.record.projectId,
      name: migration.record.workspace.projectName,
      target: migration.record.workspace.blueprint?.target ?? 'web',
      lastModified: new Date(now).toLocaleString(),
    });
    // The old list keyed this project by its name; that entry now points nowhere.
    removeRecentProject(migration.record.workspace.projectName);
    return { restored: true, notice: null };
  }
  // Kept: the project is open from the legacy keys, which stay until a later
  // save of it commits and reads back. The saved status is honest about
  // where it stands.
  lastSaved = null;
  legacyPendingId = migration.record.projectId;
  setSaveStatus({
    state: 'failed',
    revision: migration.record.revision,
    at: now,
    reason: migration.result.ok ? 'error' : migration.result.reason,
    message: `Your project was opened from the older save, but could not be moved to the new store: ${migration.result.ok ? '' : migration.result.message}`,
  });
  return {
    restored: true,
    notice: 'This project was opened from an older save that could not be moved to project storage. Export it to keep a copy.',
  };
}

export type OpenOutcome = { ok: true } | { ok: false; message: string };

/**
 * Claim the workspace before checkpointing the current project. A slow save
 * must not let an older Open click replace a newer import or new project.
 */
export async function openProjectById(projectId: string, checkpoint?: () => Promise<boolean>): Promise<OpenOutcome> {
  const claim = claimWorkspace();
  if (checkpoint) {
    const proceed = await checkpoint();
    if (!ownsWorkspace(claim.generation)) return { ok: false, message: 'Superseded by a later action.' };
    if (!proceed) return { ok: false, message: 'The current project was kept open.' };
  }
  const record = await loadProjectRecord(projectId);
  if (!ownsWorkspace(claim.generation)) return { ok: false, message: 'Superseded by a later action.' };
  if (!record) return { ok: false, message: 'There is no saved copy of that project in this browser.' };
  applyProjectRecord(record);
  saveActiveProjectId(projectId);
  return { ok: true };
}

/**
 * Delete one project's record and its recent entry. If it is the project in
 * the stores, the stores are cleared too, so autosave does not put it back.
 * The provider settings are not in scope and are not touched.
 */
export async function deleteProject(projectId: string): Promise<OpenOutcome> {
  const deleted = await deleteProjectRecord(projectId);
  if (!deleted.ok) return { ok: false, message: deleted.message };
  removeRecentProject(projectId);
  if (loadActiveProjectId() === projectId) saveActiveProjectId(null);
  if (useWorkspaceStore.getState().projectId === projectId) {
    claimWorkspace();
    beginNewProjectSession();
  }
  return { ok: true };
}

// --- Remote open ------------------------------------------------------------

/**
 * The `?open=` link, checked: same origin as this page and a .softn path.
 * Null when there is no such parameter.
 */
export function readOpenLink(search: string, origin: string): { url: URL } | { error: string } | null {
  const params = new URLSearchParams(search);
  const open = params.get('open');
  if (!open) return null;
  let url: URL;
  try {
    url = new URL(open, origin);
  } catch {
    return { error: 'The open link is not a valid address.' };
  }
  if (url.origin !== origin || !/\.softn$/i.test(url.pathname)) {
    return { error: 'Only a .softn served by this site can be opened from a link.' };
  }
  return { url };
}

/** The bundle's name from its address: the directory serves every bundle as bundle.softn under the app's own segment. */
export function bundleNameFromUrl(url: URL): string {
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? 'app.softn';
  const name = segments.length >= 2 && /^bundle\.softn$/i.test(last) ? segments[segments.length - 2] : last.replace(/\.softn$/i, '');
  try {
    return decodeURIComponent(name) || 'app';
  } catch {
    return name || 'app';
  }
}

export interface RemoteOpenDeps {
  fetch?: typeof fetch;
  /** Import the fetched bundle as the owner of `generation`; must re-check ownership before it commits. */
  importFile: (file: File, generation: number) => Promise<void>;
  log: (line: string) => void;
}

/**
 * Fetch a bundle from a same-origin link and import it as a new project.
 *
 * The generation is claimed before the fetch starts, so anything that takes
 * the workspace while the response is on its way — a new project, an
 * import, an open from the recent list, the editor unmounting — supersedes
 * it. The check is repeated after each await and the import repeats it
 * before commit, because the fetch may ignore its signal. A superseded
 * result, and any error from one, is dropped without a message: the person
 * has moved on, and a stale "could not open" would be about a project they
 * are no longer looking at.
 */
export async function openRemoteBundle(url: URL, deps: RemoteOpenDeps): Promise<void> {
  const claim = claimWorkspace();
  const doFetch = deps.fetch ?? fetch;
  try {
    const resp = await doFetch(url.href, { credentials: 'same-origin', signal: claim.signal });
    if (!ownsWorkspace(claim.generation)) return;
    if (!resp.ok) throw new Error(`${url.pathname} responded ${resp.status}`);
    const bytes = await resp.arrayBuffer();
    if (!ownsWorkspace(claim.generation)) return;
    await deps.importFile(new File([bytes], `${bundleNameFromUrl(url)}.softn`), claim.generation);
  } catch (error) {
    if (!ownsWorkspace(claim.generation)) return;
    deps.log(`Could not open ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
