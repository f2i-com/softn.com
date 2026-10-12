import { useAIStore, useEditStore, useVFSStore, useWorkspaceStore } from '../stores';
import { DEFAULT_TOKEN_BUDGET } from '../stores/aiStore';
import { bundleNameFromUrl, resolveBundleUrl } from '@softn/bundle-format/url';
import { fetchSameOriginBundle } from '@softn/editor-shared/remoteOpen';
import {
  clearLegacySnapshots,
  deleteProjectRecord,
  loadActiveProjectId,
  normalizeMode,
  loadGlobalSettings,
  loadProjectRecord,
  readProjectRecord,
  readProjectRecordAnswer,
  type ReadRecord,
  migrateLegacyProject,
  removeRecentProject,
  saveActiveProjectId,
  saveGlobalSettings,
  saveProjectRecord,
  saveRecentProject,
  sameProjectContent,
  decodeRecordFiles,
  type PersistedFile,
  type PersistedWorkspace,
  type ProjectRecord,
  type SaveFailureReason,
  type SaveResult,
} from './persistence';
import { boundJournal, persistJournal, readPersistedJournal } from './undoJournal';
import { PROJECT_FIELDS, baseAfterMerge, describeParts, hasConflicts, mergeProjectRecords, type MergeOutcome, type MergeParts } from './projectMerge';
import { DEFAULT_MAX_OUTPUT_TOKENS, PREVIOUS_DEFAULT_MAX_OUTPUT_TOKENS } from './aiProvider';

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

/**
 * What this tab last had from storage for the project in the stores, part by
 * part: the record it opened or last wrote, or, after a merged save, what it
 * holds of the merged record (lib/projectMerge.ts). A save that finds a newer
 * stored copy, written by another tab, is merged against it. Null for a
 * project not saved yet.
 */
let synced: ProjectRecord | null = null;
/** A merge kept some part back: storage no longer holds what `synced` says for it, so every save merges. */
let syncedPinned = false;
/**
 * What the last merged save could not write: the parts both tabs changed,
 * and the record it wrote, which holds the other tab's version of them.
 */
let lastConflicts: { parts: MergeParts; written: ProjectRecord } | null = null;

function resetSynced(record: ProjectRecord | null): void {
  synced = record;
  syncedPinned = false;
  lastConflicts = null;
}

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
  /** `parts`: a merged save left out what both tabs changed, and these are they, in words; this tab's version of them can be kept. */
  | { state: 'failed'; revision: number; at: number; reason: SaveFailureReason; message: string; parts?: string };

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

// A project whose last save failed is in this tab's memory and nowhere else: the bar says so
// and offers the export, and closing or reloading the tab used to lose it without a word (the
// browser's question was asked only for a file being edited by hand, stores/editStore.ts).
// Asked here, where the save's result is known, and only while there is a project to lose.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', (event) => {
    if (saveStatus.state !== 'failed' || !hasProjectContent()) return;
    event.preventDefault();
    event.returnValue = '';
  });
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
    // A draft of a file edited by hand is of the project that is going away.
    useEditStore.getState().close();
  } finally {
    hydrating = false;
  }
  revision = 0;
  lastSaved = null;
  resetSynced(null);
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

/** The workspace fields that are the project, as a record holds them. */
function projectFields(): Pick<PersistedWorkspace, (typeof PROJECT_FIELDS)[number]> {
  const ws = useWorkspaceStore.getState();
  return {
    projectName: ws.projectName,
    brief: ws.brief ? (({ referenceImages: _referenceImages, ...rest }) => rest)(ws.brief) : null,
    blueprint: ws.blueprint,
    taskGraph: ws.taskGraph,
    blueprintApproved: ws.blueprintApproved,
    mode: ws.mode,
  };
}

/** The stores as a record at revision `rev`, or null when there is no project. */
export function collectProjectRecord(rev: number, now = Date.now()): ProjectRecord | null {
  const ws = useWorkspaceStore.getState();
  if (!ws.projectId) return null;
  const ai = useAIStore.getState();
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
      ...projectFields(),
      projectId: ws.projectId,
      leftPanel: ws.leftPanel,
      leftPanelExpanded: ws.leftPanelExpanded,
      // Kept for an older Studio (a cached service worker, say) opening
      // this record: its reader requires them. This one ignores them.
      rightSidebarOpen: true,
      bottomDrawerOpen: ws.bottomDrawerOpen,
      bottomTab: ws.bottomTab,
      advancedMode: false,
      activePageId: ws.activePageId,
      activeFilePath: ws.activeFilePath,
      selectedComponentId: null,
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
    undo: persistJournal(useVFSStore.getState().journal),
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
    // A draft of a file edited by hand was of the project this one replaces.
    useEditStore.getState().close();
    useWorkspaceStore.getState().reset();
    useWorkspaceStore.setState({
      projectName: ws.projectName,
      projectId: record.projectId,
      brief: ws.brief ? { ...ws.brief, referenceImages: [] } : null,
      blueprint: ws.blueprint,
      taskGraph: ws.taskGraph,
      blueprintApproved: ws.blueprintApproved,
      mode: normalizeMode(ws.mode),
      leftPanel: ws.leftPanel as never,
      leftPanelExpanded: ws.leftPanelExpanded,
      bottomDrawerOpen: ws.bottomDrawerOpen,
      bottomTab: ws.bottomTab as never,
      activePageId: ws.activePageId,
      activeFilePath: ws.activeFilePath,
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
    // A project saved before the journal existed has none: its steps' Undo is explained, not offered.
    useVFSStore.getState().hydrateJournal(readPersistedJournal(record.undo));
  } finally {
    hydrating = false;
  }
  revision = record.revision;
  lastSaved = { projectId: record.projectId, revision: record.revision };
  resetSynced(record);
  setSaveStatus({ state: 'saved', revision: record.revision, at: record.savedAt });
}

const byPath = (files: readonly PersistedFile[]) => new Map(files.map((file) => [file.path, file]));

/**
 * Bring into the stores what a merged save took from storage: the other tab's
 * changes. A part is brought in only when this tab still holds what the save
 * collected for it; one the person changed while the save was in flight is
 * left as it is, and the next save meets both changes. Answers what was
 * brought in. The undo data and the counters are always brought in.
 */
function bringIn(collected: ProjectRecord, merge: MergeOutcome): MergeParts {
  const merged = merge.record;
  const applied: MergeParts = { files: [], fields: [], messages: [] };
  hydrating = true;
  try {
    const vfs = useVFSStore.getState();
    const wroteFiles = byPath(collected.files);
    const mergedFiles = byPath(merged.files);
    const changes: Parameters<typeof vfs.takeInFiles>[0] = [];
    for (const path of merge.taken.files) {
      if (vfs.files.get(path)?.content !== wroteFiles.get(path)?.content) continue;
      const file = mergedFiles.get(path);
      changes.push({ path, content: file?.content, lastModifiedBy: file?.lastModifiedBy });
      applied.files.push(path);
    }
    vfs.takeInFiles(changes);

    const now = projectFields();
    const patch: Record<string, unknown> = {};
    for (const field of merge.taken.fields) {
      if (JSON.stringify(now[field]) !== JSON.stringify(collected.workspace[field])) continue;
      const value = merged.workspace[field];
      if (field === 'brief') {
        // The reference images are not saved: this tab's stay with the brief.
        patch.brief = value ? { ...(value as object), referenceImages: useWorkspaceStore.getState().brief?.referenceImages ?? [] } : null;
      } else {
        patch[field] = field === 'mode' ? normalizeMode(String(value)) : value;
      }
      applied.fields.push(field);
    }
    if (applied.fields.length > 0) useWorkspaceStore.setState(patch);

    const ai = useAIStore.getState();
    const wroteMessages = new Map(collected.session.messages.map((m) => [m.id, m]));
    const mergedMessages = new Map(merged.session.messages.map((m) => [m.id, m]));
    let messages = ai.messages;
    for (const id of merge.taken.messages) {
      const index = messages.findIndex((m) => m.id === id);
      if ((index < 0 ? undefined : messages[index]) !== wroteMessages.get(id)) continue;
      const message = mergedMessages.get(id);
      messages = [...messages];
      if (!message) messages.splice(index, 1);
      else if (index >= 0) messages[index] = message;
      else {
        const at = messages.findIndex((m) => m.timestamp > message.timestamp);
        messages.splice(at < 0 ? messages.length : at, 0, message);
      }
      applied.messages.push(id);
    }
    const spent = (key: 'iterationsUsed' | 'tokensUsed' | 'filesChanged') => Math.max(0, ai[key] + merged.session[key] - collected.session[key]);
    useAIStore.setState({
      messages: messages.length > 200 ? messages.slice(-200) : messages,
      iterationsUsed: spent('iterationsUsed'),
      tokensUsed: spent('tokensUsed'),
      filesChanged: spent('filesChanged'),
    });

    // Undo data: the other tab's new entries are added and the ones it used up go. One both
    // have stays as this tab has it.
    if (merge.taken.journal.length > 0) {
      const taken = new Set(merge.taken.journal);
      const theirs = readPersistedJournal({ version: 1, entries: (merged.undo?.entries ?? []).filter((entry) => taken.has(entry.id)) });
      const journal = useVFSStore.getState().journal;
      const have = new Set(journal.map((entry) => entry.id));
      const kept = new Set((merged.undo?.entries ?? []).map((entry) => entry.id));
      const next = [...journal.filter((entry) => !taken.has(entry.id) || kept.has(entry.id)), ...theirs.filter((entry) => !have.has(entry.id))];
      useVFSStore.setState({ journal: boundJournal(next.sort((a, b) => a.at - b.at)) });
    }
  } finally {
    hydrating = false;
  }
  return applied;
}

/** The person's provider settings into the AI store. */
function applyGlobalSettings(): void {
  const settings = loadGlobalSettings();
  if (!settings) return;
  useAIStore.setState({
    providers: settings.providers,
    activeProviderId: settings.activeProviderId,
    modelProfile: settings.modelProfile,
    setupSkipped: settings.setupSkipped ?? false,
  });
  // Through the setters, so a value written by an older Studio with wider
  // bounds lands clamped rather than as written. Absent means the default.
  const ai = useAIStore.getState();
  ai.setMaxIterations(settings.maxIterations);
  // Settings saved before the agent loop (no agentSettings) carry the
  // single-shot budget of 50,000 tokens, which an agent run spends in a few
  // steps. They are raised to the agent default once; a budget chosen since
  // is kept as chosen.
  ai.setTokenBudget(settings.agentSettings === undefined ? Math.max(settings.tokenBudget, DEFAULT_TOKEN_BUDGET) : settings.tokenBudget);
  if (settings.requestTimeoutMs !== undefined) ai.setRequestTimeoutMs(settings.requestTimeoutMs);
  // Every Studio saved the output cap whether or not it was changed, so a
  // saved 16,384 is almost always the old default, which a reasoning model
  // can spend thinking. It is read as the current default.
  if (settings.maxOutputTokens !== undefined) {
    ai.setMaxOutputTokens(settings.maxOutputTokens === PREVIOUS_DEFAULT_MAX_OUTPUT_TOKENS ? DEFAULT_MAX_OUTPUT_TOKENS : settings.maxOutputTokens);
  }
  if (settings.agentSettings !== undefined) ai.updateAgentSettings(settings.agentSettings);
  if (settings.toolProtocols !== undefined) useAIStore.setState({ toolProtocols: settings.toolProtocols });
  if (settings.streamModes !== undefined) useAIStore.setState({ streamModes: settings.streamModes });
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
    setupSkipped: ai.setupSkipped,
    agentSettings: ai.agentSettings,
    toolProtocols: ai.toolProtocols,
    streamModes: ai.streamModes,
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
    // The revision of this project this tab last read or wrote: when storage holds a later one,
    // another tab saved since, and the save is merged with it part by part (projectMerge.ts).
    // After a merge that kept a part back, storage is not what this tab last had whatever its
    // revision, and every save is merged.
    const seen = lastSaved !== null && lastSaved.projectId === record.projectId ? lastSaved.revision : undefined;
    const lastSeen = seen !== undefined && syncedPinned ? -1 : seen;
    const base = synced !== null && synced.projectId === record.projectId ? synced : null;
    let merge: MergeOutcome | null = null;
    const reconcile = base
      ? (stored: ProjectRecord) => {
          merge = mergeProjectRecords(base, record, stored, Math.max(rev, stored.revision + 1));
          return merge.record;
        }
      : undefined;
    const result = await save(record, lastSeen, reconcile);
    if (stopped) return result;
    if (result.ok) {
      const merged = merge as MergeOutcome | null;
      const written = merged ? merged.record : record;
      if (merged && base) {
        const applied = bringIn(record, merged);
        const next = baseAfterMerge(base, record, merged.record, applied);
        synced = next.base;
        syncedPinned = next.pinned;
        lastConflicts = hasConflicts(merged.conflicts) ? { parts: merged.conflicts, written: merged.record } : null;
        // Above what either tab wrote, and still counting what changed here while the save was in flight.
        revision = merged.record.revision + (revision - rev);
        lastSaved = { projectId: record.projectId, revision: merged.record.revision };
        const brought = describeParts(applied);
        if (brought) useWorkspaceStore.getState().addConsoleOutput(`Brought in what another tab saved: ${brought}.`);
      } else {
        resetSynced(record);
        lastSaved = { projectId: record.projectId, revision: rev };
      }
      saveActiveProjectId(record.projectId);
      saveRecentProject({
        id: record.projectId,
        name: record.workspace.projectName || 'Untitled app',
        target: record.workspace.blueprint?.target ?? 'web',
        lastModified: new Date(record.savedAt).toLocaleString(),
      });
      if (lastConflicts) {
        const parts = describeParts(lastConflicts.parts);
        setSaveStatus({
          state: 'failed',
          revision: rev,
          at: now(),
          reason: 'conflict',
          parts,
          message: `${parts} changed in another tab as well as in this one, so this tab’s version was not saved over the other tab’s. The rest of this tab’s changes are saved. Keep this tab’s version, or reload to continue from the saved copy.`,
        });
      } else {
        setSaveStatus({ state: 'saved', revision: rev, at: record.savedAt });
      }
      if (legacyPendingId === record.projectId) {
        // The legacy snapshot's replacement has committed; read it back before
        // the old keys go, as the start-up migration would have.
        const readBack = await loadProjectRecord(record.projectId);
        if (readBack && sameProjectContent(written, readBack)) {
          clearLegacySnapshots();
          legacyPendingId = null;
        }
      }
      // Changes arrived while the write was in flight: they are the next save.
      if (revision !== written.revision) schedule();
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

  const controller: AutosaveController = {
    flush: () => run(),
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const unsubscribe of unsubscribers) unsubscribe();
      if (running === controller) running = null;
    },
  };
  running = controller;

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
        state.maxOutputTokens !== previous.maxOutputTokens ||
        state.setupSkipped !== previous.setupSkipped ||
        state.agentSettings !== previous.agentSettings ||
        state.toolProtocols !== previous.toolProtocols ||
        state.streamModes !== previous.streamModes
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

  return controller;
}

/** The autosave that is running, for what has to save now from outside it. */
let running: AutosaveController | null = null;

/**
 * After a merged save left out what both tabs changed: the person chose this
 * tab's version of those parts. Each is taken to be made on top of the other
 * tab's version the save met, so the next save writes it over that one;
 * anything the other tab changed elsewhere is still merged as before. A part
 * the other tab has changed again since is a conflict again, and is said so:
 * the choice was about the version that was reported.
 */
export function keepThisTabsVersion(): Promise<SaveResult> {
  const conflicts = lastConflicts;
  const base = synced;
  if (!conflicts || !base || !running) return Promise.resolve(NOTHING_TO_SAVE);
  const { parts, written } = conflicts;
  const theirFiles = byPath(written.files);
  const files = base.files.filter((file) => !parts.files.includes(file.path));
  for (const path of parts.files) {
    const file = theirFiles.get(path);
    if (file) files.push(file);
  }
  const workspace: PersistedWorkspace = { ...base.workspace };
  for (const field of parts.fields) (workspace as unknown as Record<string, unknown>)[field] = written.workspace[field];
  const theirMessages = new Map(written.session.messages.map((m) => [m.id, m]));
  const messages = base.session.messages.filter((m) => !parts.messages.includes(m.id));
  for (const id of parts.messages) {
    const message = theirMessages.get(id);
    if (message) messages.push(message);
  }
  synced = { ...base, workspace, files, session: { ...base.session, messages } };
  lastConflicts = null;
  touchRevision();
  return running.flush();
}

// --- Restore and open -------------------------------------------------------

export type RestoreOutcome = { restored: boolean; notice: string | null };

/**
 * The project the start was to open and could not, because the store did not
 * answer in time, with the workspace generation that start held. The
 * dashboard says the store did not answer and offers Try again; pressed once
 * the store answers, that refreshed the list and nothing else, so the project
 * the start had been opening stayed closed until it was found in the list.
 */
let unanswered: { projectId: string; generation: number } | null = null;

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
  unanswered = null;
  applyGlobalSettings();
  const activeId = loadActiveProjectId();
  if (activeId) {
    const { answered, read } = await readProjectRecordAnswer(activeId);
    if (!ownsWorkspace(claim.generation)) return { restored: false, notice: null };
    if (read) {
      applyProjectRecord(read.record);
      return { restored: true, notice: announceLeftOut(read) };
    }
    if (!answered) unanswered = { projectId: activeId, generation: claim.generation };
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
  resetSynced(null);
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
 * Open the project the start could not ask the store for, now that it may
 * answer. Null when there is none, or when something has taken the workspace
 * since the start (a new app, an example, an import, a project opened from
 * the list): that is the project being worked on now, and it is not replaced.
 * While the store still does not answer, the project is kept for the next try.
 */
export async function reopenUnansweredProject(): Promise<OpenOutcome | null> {
  const pending = unanswered;
  if (!pending || !ownsWorkspace(pending.generation) || hasProjectContent() || loadActiveProjectId() !== pending.projectId) {
    unanswered = null;
    return null;
  }
  const claim = claimWorkspace();
  unanswered = { projectId: pending.projectId, generation: claim.generation };
  const { answered, read } = await readProjectRecordAnswer(pending.projectId);
  if (!ownsWorkspace(claim.generation)) return null;
  if (!answered) return { ok: false, message: 'This browser’s storage still did not answer.' };
  unanswered = null;
  if (!read) return { ok: false, message: 'There is no saved copy of that project in this browser.' };
  applyProjectRecord(read.record);
  const notice = announceLeftOut(read);
  if (notice) useWorkspaceStore.getState().addConsoleOutput(notice);
  return { ok: true };
}

/**
 * A project that opened with parts of its save left out (persistence.ts,
 * readStoredRecord) says so where the person is looking: the sentence is
 * answered for the log, and put in the chat. Null when the record read whole.
 * The message is a change to the project, so the next autosave writes a record
 * that reads whole in place of the one that did not.
 */
function announceLeftOut(read: ReadRecord): string | null {
  if (read.leftOut.length === 0) return null;
  const name = read.record.workspace.projectName.trim() || 'This project';
  const files = read.record.files.length;
  const notice = `${name} was opened from a save that could not be read whole. Its ${files} file${files === 1 ? ' is' : 's are'} here; left out: ${read.leftOut.join(', ')}. Export a bundle to keep a copy.`;
  useAIStore.getState().addMessage({ id: newProjectId(), role: 'assistant', content: notice, timestamp: Date.now() });
  return notice;
}

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
  const read = await readProjectRecord(projectId);
  if (!ownsWorkspace(claim.generation)) return { ok: false, message: 'Superseded by a later action.' };
  if (!read) return { ok: false, message: 'There is no saved copy of that project in this browser.' };
  applyProjectRecord(read.record);
  saveActiveProjectId(projectId);
  const notice = announceLeftOut(read);
  if (notice) useWorkspaceStore.getState().addConsoleOutput(notice);
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
  try {
    new URL(open, origin);
  } catch {
    return { error: 'The open link is not a valid address.' };
  }
  // The rule (http(s), this origin, no credentials, a .softn) is the bundle
  // contract's; the runtime and the directory apply the same one.
  try {
    return { url: resolveBundleUrl(open, origin) };
  } catch {
    return { error: 'Only a .softn served by this site can be opened from a link.' };
  }
}

/** The bundle's name from its address, from the bundle contract (the directory's `<slug>/bundle.softn` is understood). */
export { bundleNameFromUrl };

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
  try {
    // Redirect-origin check, bounded read, body cancelled when superseded:
    // the shared fetch (@softn/editor-shared) does what Builder's does too.
    const fetched = await fetchSameOriginBundle(url, { fetch: deps.fetch, signal: claim.signal, superseded: () => !ownsWorkspace(claim.generation) });
    if (fetched.kind === 'superseded') return;
    await deps.importFile(new File([fetched.bytes], `${bundleNameFromUrl(url)}.softn`), claim.generation);
  } catch (error) {
    if (!ownsWorkspace(claim.generation)) return;
    deps.log(`Could not open ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
