import type {
  AgentTask,
  Blueprint,
  ChatMessage,
  ModelProfile,
  ProjectBrief,
  ProviderConfig,
  RecentProjectRecord,
  VFSFile,
} from '../types/studio';
import { normalizeProjectPath } from './projectImport';

/**
 * Where Studio keeps a project between visits.
 *
 * A project is one record in this origin's IndexedDB, keyed by its id and
 * holding the workspace metadata, the files and the chat of one revision
 * together, written in one transaction. It used to be three localStorage
 * keys — workspace, AI, files — each written on its own with the result
 * thrown away. localStorage fills up at a few megabytes, so a project with
 * an image in it could get its workspace key written and then have its
 * files key refused: the next start paired one revision's metadata with an
 * older revision's files, or no files at all, and nothing had said a save
 * failed. With one record there is nothing to pair; a save either commits
 * whole or leaves the previous revision whole, and every saver here returns
 * a `SaveResult` the caller can put on screen.
 *
 * Small preferences stay in localStorage, each under its own key: the
 * recent list (ids, names and dates — never content), the id of the
 * project to reopen, and the AI provider settings. The provider settings
 * are global on purpose: they are the person's keys, not part of any
 * project, and deleting a project must not touch them. They never go into a
 * record or an export.
 *
 * The three legacy keys are still read. On the first start after this
 * change the legacy snapshot is written as a record, read back and compared,
 * and only then are the old keys removed — so a write that does not commit
 * leaves the old snapshot exactly where it was for the next attempt.
 */

export const STORAGE_KEYS = {
  /** Legacy single-slot keys, read for migration and then removed. */
  workspace: 'softn.studio.workspace.v1',
  ai: 'softn.studio.ai.v1',
  vfs: 'softn.studio.vfs.v1',
  /** Small preferences that stay in localStorage. */
  recent: 'softn.studio.recent.v1',
  active: 'softn.studio.active.v1',
  settings: 'softn.studio.settings.v1',
} as const;

export const STUDIO_DB = 'softn-studio';
export const STUDIO_DB_VERSION = 1;
export const PROJECTS_STORE = 'projects';
export const PROJECT_SCHEMA_VERSION = 1;

export type SaveFailureReason = 'quota' | 'blocked' | 'unavailable' | 'error';
export type SaveResult = { ok: true } | { ok: false; reason: SaveFailureReason; message: string };

export type PersistedWorkspace = {
  projectName: string;
  projectId: string | null;
  brief: Omit<ProjectBrief, 'referenceImages'> | null;
  blueprint: Blueprint | null;
  taskGraph: AgentTask[];
  blueprintApproved: boolean;
  mode: string;
  leftPanel: string | null;
  leftPanelExpanded: boolean;
  rightSidebarOpen: boolean;
  bottomDrawerOpen: boolean;
  bottomTab: string;
  advancedMode: boolean;
  activePageId: string | null;
  activeFilePath: string | null;
  selectedComponentId: string | null;
  devicePreset: string;
  zoom: number;
  themePreview: 'light' | 'dark';
  consoleOutput: string[];
};

/** The legacy AI snapshot: providers and the chat in one object. */
export type PersistedAI = {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  modelProfile: ModelProfile;
  messages: ChatMessage[];
  iterationsUsed: number;
  maxIterations: number;
  tokensUsed: number;
  tokenBudget: number;
  filesChanged: number;
};

/** The legacy files snapshot: binary content as base64 text. */
export type PersistedVFS = {
  files: Array<{
    path: string;
    mimeType: string;
    lastModified: number;
    lastModifiedBy: 'user' | 'ai';
    version: number;
    kind: 'text' | 'binary';
    content: string;
  }>;
};

/** A file inside a project record. Binary content is stored as bytes. */
export interface PersistedFile {
  path: string;
  mimeType: string;
  lastModified: number;
  lastModifiedBy: 'user' | 'ai';
  version: number;
  content: string | Uint8Array;
}

/** The chat of one project. Providers are not here: see `GlobalSettings`. */
export interface PersistedSession {
  messages: ChatMessage[];
  iterationsUsed: number;
  tokensUsed: number;
  filesChanged: number;
}

/** One project, one revision, one record. */
export interface ProjectRecord {
  projectId: string;
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  /** Counts up with every change in the session; a save with the same revision as the last is skipped. */
  revision: number;
  savedAt: number;
  workspace: PersistedWorkspace;
  files: PersistedFile[];
  session: PersistedSession;
}

/** What the dashboard needs to know about a saved project, without its files. */
export interface ProjectSummary {
  projectId: string;
  name: string;
  target: string;
  revision: number;
  savedAt: number;
  fileCount: number;
}

/**
 * The person's own settings: provider keys and budgets. Never in a record.
 *
 * The per-request timeout and output cap are optional in the stored shape
 * because settings written before they existed do not have them; a missing
 * one leaves the store's default in place. A present one must be a
 * positive integer or the whole key is treated as unreadable, the same as
 * any other malformed field.
 */
export interface GlobalSettings {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  modelProfile: ModelProfile;
  maxIterations: number;
  tokenBudget: number;
  /** Per-request timeout, in milliseconds. */
  requestTimeoutMs?: number;
  /** Output allowance per request: the provider's max_tokens and the budget reservation. */
  maxOutputTokens?: number;
}

const WORKSPACE_MODES = new Set(['describe', 'structure', 'design', 'data', 'logic', 'test']);
const LEFT_PANELS = new Set(['pages', 'history', 'ai', 'settings', 'files']);
const DEVICE_PRESETS = new Set(['desktop', 'tablet', 'mobile']);
const TARGETS = new Set(['web', 'desktop', 'dual']);
const STYLES = new Set(['clean', 'bold', 'minimal', 'playful', 'dark']);
const BLUEPRINT_FIELD_TYPES = new Set(['string', 'number', 'boolean', 'date', 'array', 'object']);
const RELATIONSHIP_TYPES = new Set(['one-to-one', 'one-to-many', 'many-to-many']);
const RECENT_LIMIT = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function hasOptionalString(value: Record<string, unknown>, key: string): boolean {
  return !(key in value) || typeof value[key] === 'string';
}

function isPersistedBrief(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.appName === 'string' &&
    typeof value.description === 'string' &&
    TARGETS.has(String(value.target)) &&
    isStringArray(value.pages) &&
    isStringArray(value.collections) &&
    typeof value.authNeeded === 'boolean' &&
    STYLES.has(String(value.style))
  );
}

function isBlueprintField(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    BLUEPRINT_FIELD_TYPES.has(String(value.type)) &&
    typeof value.required === 'boolean' &&
    hasOptionalString(value, 'defaultValue')
  );
}

function isBlueprintRelationship(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.target === 'string' &&
    RELATIONSHIP_TYPES.has(String(value.type))
  );
}

function isBlueprint(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || !Array.isArray(value.pages) || !Array.isArray(value.collections))
    return false;
  if (!isRecord(value.navigation) || !isStringArray(value.navigation.items)) return false;
  return (
    typeof value.appName === 'string' &&
    TARGETS.has(String(value.target)) &&
    STYLES.has(String(value.style)) &&
    value.pages.every(
      (page) =>
        isRecord(page) &&
        typeof page.id === 'string' &&
        typeof page.name === 'string' &&
        hasOptionalString(page, 'route') &&
        typeof page.layout === 'string' &&
        isStringArray(page.components)
    ) &&
    value.collections.every(
      (collection) =>
        isRecord(collection) &&
        typeof collection.id === 'string' &&
        typeof collection.name === 'string' &&
        Array.isArray(collection.fields) &&
        collection.fields.every(isBlueprintField) &&
        Array.isArray(collection.relationships) &&
        collection.relationships.every(isBlueprintRelationship)
    ) &&
    ['tabs', 'sidebar', 'stack'].includes(String(value.navigation.type)) &&
    isStringArray(value.risks) &&
    isStringArray(value.assumptions)
  );
}

function isAgentTask(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    ['pending', 'in_progress', 'complete', 'failed', 'skipped'].includes(String(value.status)) &&
    isStringArray(value.dependencies) &&
    typeof value.retries === 'number' &&
    Number.isFinite(value.retries) &&
    isStringArray(value.files)
  );
}

function isProvider(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    ['anthropic', 'openai', 'custom'].includes(String(value.type)) &&
    typeof value.name === 'string' &&
    typeof value.apiKey === 'string' &&
    hasOptionalString(value, 'baseUrl') &&
    hasOptionalString(value, 'modelId') &&
    hasOptionalString(value, 'orgId')
  );
}

function isModelProfile(value: unknown): boolean {
  return (
    isRecord(value) &&
    ['architect', 'builder', 'repair', 'vision'].every((role) => typeof value[role] === 'string')
  );
}

function isChatMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    ['user', 'assistant', 'system'].includes(String(value.role)) &&
    typeof value.content === 'string' &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp) &&
    (!('toolCalls' in value) ||
      (Array.isArray(value.toolCalls) && value.toolCalls.every(isToolCallCard))) &&
    (!('tokens' in value) || isMessageTokens(value.tokens))
  );
}

function isToolCallCard(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.tool === 'string' &&
    isRecord(value.args) &&
    hasOptionalString(value, 'result') &&
    ['pending', 'success', 'error'].includes(String(value.status))
  );
}

function isMessageTokens(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.input === 'number' &&
    Number.isInteger(value.input) &&
    value.input >= 0 &&
    typeof value.output === 'number' &&
    Number.isInteger(value.output) &&
    value.output >= 0
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0);
}

export function isPersistedWorkspace(parsed: unknown): parsed is PersistedWorkspace {
  return (
    isRecord(parsed) &&
    typeof parsed.projectName === 'string' &&
    isNullableString(parsed.projectId) &&
    isPersistedBrief(parsed.brief) &&
    isBlueprint(parsed.blueprint) &&
    Array.isArray(parsed.taskGraph) &&
    parsed.taskGraph.every(isAgentTask) &&
    typeof parsed.blueprintApproved === 'boolean' &&
    WORKSPACE_MODES.has(String(parsed.mode)) &&
    (parsed.leftPanel === null || LEFT_PANELS.has(String(parsed.leftPanel))) &&
    typeof parsed.leftPanelExpanded === 'boolean' &&
    typeof parsed.rightSidebarOpen === 'boolean' &&
    typeof parsed.bottomDrawerOpen === 'boolean' &&
    parsed.bottomTab === 'log' &&
    typeof parsed.advancedMode === 'boolean' &&
    isNullableString(parsed.activePageId) &&
    isNullableString(parsed.activeFilePath) &&
    isNullableString(parsed.selectedComponentId) &&
    DEVICE_PRESETS.has(String(parsed.devicePreset)) &&
    typeof parsed.zoom === 'number' &&
    Number.isFinite(parsed.zoom) &&
    ['light', 'dark'].includes(String(parsed.themePreview)) &&
    isStringArray(parsed.consoleOutput)
  );
}

function isPersistedFile(value: unknown): value is PersistedFile {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    (typeof value.content === 'string' || value.content instanceof Uint8Array) &&
    typeof value.mimeType === 'string' &&
    typeof value.lastModified === 'number' &&
    (value.lastModifiedBy === 'user' || value.lastModifiedBy === 'ai') &&
    typeof value.version === 'number'
  );
}

function isPersistedSession(value: unknown): value is PersistedSession {
  return (
    isRecord(value) &&
    Array.isArray(value.messages) &&
    value.messages.every(isChatMessage) &&
    ['iterationsUsed', 'tokensUsed', 'filesChanged'].every((key) => isNonNegativeInteger(value[key]))
  );
}

export function isProjectRecord(value: unknown): value is ProjectRecord {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    value.projectId.length > 0 &&
    value.schemaVersion === PROJECT_SCHEMA_VERSION &&
    isNonNegativeInteger(value.revision) &&
    typeof value.savedAt === 'number' &&
    isPersistedWorkspace(value.workspace) &&
    Array.isArray(value.files) &&
    value.files.every(isPersistedFile) &&
    isPersistedSession(value.session)
  );
}

// ---------------------------------------------------------------------------
// localStorage: the small keys.
// ---------------------------------------------------------------------------

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Accessing the property itself can throw in privacy-restricted contexts.
    return null;
  }
}

function storageBlocked(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    void window.localStorage;
    return false;
  } catch {
    return true;
  }
}

function readItem(key: string): string | null {
  try {
    return getStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Why a storage operation failed, in the terms the UI uses. */
export function describeStorageFailure(error: unknown): { reason: SaveFailureReason; message: string } {
  const name = error instanceof Error ? error.name : '';
  const text = error instanceof Error ? error.message : String(error);
  if (name === 'QuotaExceededError' || /quota/i.test(name + ' ' + text)) {
    return {
      reason: 'quota',
      message: 'This project is larger than the browser will store. Export the bundle to keep it.',
    };
  }
  if (name === 'SecurityError' || /blocked|denied|not allowed/i.test(name + ' ' + text)) {
    return {
      reason: 'blocked',
      message: 'This browser is not letting Studio use its storage. Export the bundle to keep your work.',
    };
  }
  return { reason: 'error', message: `The save did not complete: ${text || name || 'unknown error'}.` };
}

const NO_STORAGE: SaveResult = {
  ok: false,
  reason: 'unavailable',
  message: 'This browser has no storage for Studio here. Export the bundle to keep your work.',
};

const BLOCKED_STORAGE: SaveResult = {
  ok: false,
  reason: 'blocked',
  message: 'This browser is not letting Studio use its storage. Export the bundle to keep your work.',
};

/**
 * Persist one small key, and say how it went. These writes were unguarded
 * once and a throw from an autosave effect blanked Studio; then they were
 * guarded and the result was thrown away. Now the result is the point.
 */
function writeItem(key: string, value: string): SaveResult {
  const storage = getStorage();
  if (!storage) return storageBlocked() ? BLOCKED_STORAGE : NO_STORAGE;
  try {
    storage.setItem(key, value);
    return { ok: true };
  } catch (error) {
    return { ok: false, ...describeStorageFailure(error) };
  }
}

function removeItem(key: string): void {
  try {
    getStorage()?.removeItem(key);
  } catch {
    // Storage may be revoked while the page is open; removal is best effort.
  }
}

// --- Legacy single-slot snapshots (read for migration) ---------------------

export function loadWorkspaceSnapshot(): PersistedWorkspace | null {
  const raw = readItem(STORAGE_KEYS.workspace);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPersistedWorkspace(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function loadAISnapshot(): PersistedAI | null {
  const raw = readItem(STORAGE_KEYS.ai);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      !Array.isArray(parsed.providers) ||
      !parsed.providers.every(isProvider) ||
      !isNullableString(parsed.activeProviderId) ||
      !isModelProfile(parsed.modelProfile) ||
      !Array.isArray(parsed.messages) ||
      !parsed.messages.every(isChatMessage) ||
      !['iterationsUsed', 'maxIterations', 'tokensUsed', 'tokenBudget', 'filesChanged'].every(
        (key) => isNonNegativeInteger(parsed[key])
      )
    ) {
      return null;
    }
    return parsed as PersistedAI;
  } catch {
    return null;
  }
}

export function loadVFSSnapshot(): PersistedVFS | null {
  const raw = readItem(STORAGE_KEYS.vfs);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { files?: unknown }).files)
    ) {
      return null;
    }
    return parsed as PersistedVFS;
  } catch {
    return null;
  }
}

export function decodePersistedVFS(
  snapshot: PersistedVFS
): Array<{ path: string; content: string | Uint8Array }> {
  if (!snapshot || !Array.isArray(snapshot.files)) return [];
  const decoded: Array<{ path: string; content: string | Uint8Array }> = [];
  const canonicalPaths = new Set<string>();
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') continue;
    const path = normalizeProjectPath(file.path);
    if (!path) continue;
    const canonicalPath = path.toLowerCase();
    if (canonicalPaths.has(canonicalPath)) continue;
    canonicalPaths.add(canonicalPath);
    if (file.kind === 'text') {
      decoded.push({ path, content: file.content });
      continue;
    }
    if (file.kind !== 'binary') continue;
    try {
      decoded.push({
        path,
        content: Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0)),
      });
    } catch {
      // One corrupt saved asset should not make the whole Studio fail to boot.
    }
  }
  return decoded;
}

/** Whether any of the three legacy keys is present at all. */
export function hasLegacySnapshots(): boolean {
  return (
    readItem(STORAGE_KEYS.workspace) !== null ||
    readItem(STORAGE_KEYS.vfs) !== null ||
    readItem(STORAGE_KEYS.ai) !== null
  );
}

export function clearLegacySnapshots(): void {
  removeItem(STORAGE_KEYS.workspace);
  removeItem(STORAGE_KEYS.vfs);
  removeItem(STORAGE_KEYS.ai);
}

// --- Global settings --------------------------------------------------------

export function loadGlobalSettings(): GlobalSettings | null {
  const raw = readItem(STORAGE_KEYS.settings);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      !Array.isArray(parsed.providers) ||
      !parsed.providers.every(isProvider) ||
      !isNullableString(parsed.activeProviderId) ||
      !isModelProfile(parsed.modelProfile) ||
      !isNonNegativeInteger(parsed.maxIterations) ||
      !isNonNegativeInteger(parsed.tokenBudget) ||
      !isOptionalPositiveInteger(parsed.requestTimeoutMs) ||
      !isOptionalPositiveInteger(parsed.maxOutputTokens)
    ) {
      return null;
    }
    return parsed as unknown as GlobalSettings;
  } catch {
    return null;
  }
}

export function saveGlobalSettings(settings: GlobalSettings): SaveResult {
  return writeItem(STORAGE_KEYS.settings, JSON.stringify(settings));
}

// --- The active project pointer --------------------------------------------

export function loadActiveProjectId(): string | null {
  const raw = readItem(STORAGE_KEYS.active);
  return raw && raw.trim() ? raw : null;
}

export function saveActiveProjectId(id: string | null): SaveResult {
  if (id === null) {
    if (!getStorage()) return storageBlocked() ? BLOCKED_STORAGE : NO_STORAGE;
    removeItem(STORAGE_KEYS.active);
    return { ok: true };
  }
  return writeItem(STORAGE_KEYS.active, id);
}

// --- The recent list --------------------------------------------------------

export function loadRecentProjects(): RecentProjectRecord[] {
  const raw = readItem(STORAGE_KEYS.recent);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RecentProjectRecord =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as { id?: unknown }).id === 'string' &&
        typeof (item as { name?: unknown }).name === 'string' &&
        typeof (item as { target?: unknown }).target === 'string' &&
        typeof (item as { lastModified?: unknown }).lastModified === 'string'
    );
  } catch {
    return [];
  }
}

/**
 * Put a project at the top of the recent list. Entries are matched by id
 * only. They used to be matched by name as well, so two projects that
 * happened to share a display name became one entry and the older one
 * could no longer be reached from the dashboard.
 */
export function saveRecentProject(project: RecentProjectRecord): SaveResult {
  const existing = loadRecentProjects().filter((item) => item.id !== project.id);
  const next = [project, ...existing].slice(0, RECENT_LIMIT);
  return writeItem(STORAGE_KEYS.recent, JSON.stringify(next));
}

/**
 * Take one entry off the recent list. That is all it does: the project's
 * record, the active-project pointer and the provider settings are not
 * touched. Removing an entry used to delete the saved snapshot when the
 * names matched, which was the active project's only copy.
 */
export function removeRecentProject(id: string): SaveResult {
  const next = loadRecentProjects().filter((item) => item.id !== id);
  return writeItem(STORAGE_KEYS.recent, JSON.stringify(next));
}

// ---------------------------------------------------------------------------
// IndexedDB: the project records.
// ---------------------------------------------------------------------------

function openStudioDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available here'));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(STUDIO_DB, STUDIO_DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(PROJECTS_STORE)) req.result.createObjectStore(PROJECTS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolves when the transaction has committed; rejects when it aborted or failed. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Write one project record whole. Resolves only after the transaction has
 * committed: a put whose transaction aborts is a failed save, and the
 * previous revision of the record is untouched.
 */
export async function saveProjectRecord(record: ProjectRecord): Promise<SaveResult> {
  let db: IDBDatabase;
  try {
    db = await openStudioDb();
  } catch (error) {
    return typeof indexedDB === 'undefined' ? NO_STORAGE : { ok: false, ...describeStorageFailure(error) };
  }
  try {
    const tx = db.transaction(PROJECTS_STORE, 'readwrite');
    const store = tx.objectStore(PROJECTS_STORE);
    await request(store.put(record, record.projectId));
    await committed(tx);
    return { ok: true };
  } catch (error) {
    return { ok: false, ...describeStorageFailure(error) };
  } finally {
    db.close();
  }
}

/** The record for a project id, validated, or null when there is none. */
export async function loadProjectRecord(projectId: string): Promise<ProjectRecord | null> {
  let db: IDBDatabase;
  try {
    db = await openStudioDb();
  } catch {
    return null;
  }
  try {
    const tx = db.transaction(PROJECTS_STORE, 'readonly');
    const raw = await request(tx.objectStore(PROJECTS_STORE).get(projectId));
    return isProjectRecord(raw) && raw.projectId === projectId ? raw : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Every saved project, as summaries. An empty list when the store cannot be read. */
export async function listProjectSummaries(): Promise<ProjectSummary[]> {
  let db: IDBDatabase;
  try {
    db = await openStudioDb();
  } catch {
    return [];
  }
  try {
    const tx = db.transaction(PROJECTS_STORE, 'readonly');
    const store = tx.objectStore(PROJECTS_STORE);
    return await new Promise<ProjectSummary[]>((resolve, reject) => {
      const out: ProjectSummary[] = [];
      const cursorReq = store.openCursor();
      cursorReq.onerror = () => reject(cursorReq.error ?? new Error('IndexedDB cursor failed'));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          resolve(out);
          return;
        }
        const value = cursor.value as unknown;
        if (isProjectRecord(value)) {
          out.push({
            projectId: value.projectId,
            name: value.workspace.projectName,
            target: value.workspace.blueprint?.target ?? 'web',
            revision: value.revision,
            savedAt: value.savedAt,
            fileCount: value.files.length,
          });
        }
        cursor.continue();
      };
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Delete one project's record. Nothing else: not the settings, not other records. */
export async function deleteProjectRecord(projectId: string): Promise<SaveResult> {
  let db: IDBDatabase;
  try {
    db = await openStudioDb();
  } catch (error) {
    return typeof indexedDB === 'undefined' ? NO_STORAGE : { ok: false, ...describeStorageFailure(error) };
  }
  try {
    const tx = db.transaction(PROJECTS_STORE, 'readwrite');
    await request(tx.objectStore(PROJECTS_STORE).delete(projectId));
    await committed(tx);
    return { ok: true };
  } catch (error) {
    return { ok: false, ...describeStorageFailure(error) };
  } finally {
    db.close();
  }
}

/** A record's files as the VFS takes them: safe, canonical, de-aliased paths. */
export function decodeRecordFiles(record: ProjectRecord): Array<{ path: string; content: string | Uint8Array }> {
  const decoded: Array<{ path: string; content: string | Uint8Array }> = [];
  const canonicalPaths = new Set<string>();
  for (const file of record.files) {
    const path = normalizeProjectPath(file.path);
    if (!path) continue;
    const canonicalPath = path.toLowerCase();
    if (canonicalPaths.has(canonicalPath)) continue;
    canonicalPaths.add(canonicalPath);
    decoded.push({ path, content: file.content });
  }
  return decoded;
}

/** A record's files as a VFS map, for exporting a saved project without opening it. */
export function recordFilesAsMap(record: ProjectRecord): Map<string, VFSFile> {
  const map = new Map<string, VFSFile>();
  for (const { path, content } of decodeRecordFiles(record)) {
    const original = record.files.find((f) => f.path === path);
    map.set(path, {
      path,
      content,
      mimeType: original?.mimeType ?? 'application/octet-stream',
      lastModified: original?.lastModified ?? record.savedAt,
      lastModifiedBy: original?.lastModifiedBy ?? 'user',
      version: original?.version ?? 1,
    });
  }
  return map;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Whether two records hold the same project content — identity, revision, workspace, files and chat. */
export function sameProjectContent(a: ProjectRecord, b: ProjectRecord): boolean {
  if (a.projectId !== b.projectId || a.revision !== b.revision) return false;
  if (JSON.stringify(a.workspace) !== JSON.stringify(b.workspace)) return false;
  if (JSON.stringify(a.session) !== JSON.stringify(b.session)) return false;
  if (a.files.length !== b.files.length) return false;
  for (let i = 0; i < a.files.length; i++) {
    const x = a.files[i];
    const y = b.files[i];
    if (x.path !== y.path) return false;
    if (typeof x.content === 'string' || typeof y.content === 'string') {
      if (x.content !== y.content) return false;
    } else if (!sameBytes(x.content, y.content)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Migration from the legacy keys.
// ---------------------------------------------------------------------------

export interface LegacyProject {
  workspace: PersistedWorkspace;
  vfs: PersistedVFS | null;
  ai: PersistedAI | null;
}

/** The legacy snapshot, when there is a workspace to anchor it. */
export function loadLegacyProject(): LegacyProject | null {
  const workspace = loadWorkspaceSnapshot();
  if (!workspace || !workspace.projectName) return null;
  return { workspace, vfs: loadVFSSnapshot(), ai: loadAISnapshot() };
}

function newProjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A record built from the legacy keys. The provider settings are left out; see `saveGlobalSettings`. */
export function legacyProjectToRecord(legacy: LegacyProject, now: number): ProjectRecord {
  const projectId = legacy.workspace.projectId || newProjectId();
  const files: PersistedFile[] = legacy.vfs
    ? decodePersistedVFS(legacy.vfs).map(({ path, content }) => {
        const original = legacy.vfs!.files.find((f) => f.path === path);
        return {
          path,
          content,
          mimeType: original?.mimeType ?? 'application/octet-stream',
          lastModified: original?.lastModified ?? now,
          lastModifiedBy: original?.lastModifiedBy === 'ai' ? 'ai' : 'user',
          version: typeof original?.version === 'number' ? original.version : 1,
        };
      })
    : [];
  return {
    projectId,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    revision: 0,
    savedAt: now,
    workspace: { ...legacy.workspace, projectId },
    files,
    session: {
      messages: legacy.ai?.messages ?? [],
      iterationsUsed: legacy.ai?.iterationsUsed ?? 0,
      tokensUsed: legacy.ai?.tokensUsed ?? 0,
      filesChanged: legacy.ai?.filesChanged ?? 0,
    },
  };
}

export type MigrationOutcome =
  | { status: 'none' }
  | { status: 'migrated'; record: ProjectRecord }
  /** The record is handed over from the legacy keys, which are kept because the new record did not commit. */
  | { status: 'kept'; record: ProjectRecord; result: SaveResult };

/**
 * Move the legacy single-slot snapshot into a project record. The old keys
 * are removed only after the new record has been written, read back and
 * found equal — a write that did not commit, or that reads back as
 * something else, leaves them for the next start. The provider settings
 * from the legacy AI key go to the global settings key, and only when
 * there is not one already.
 */
export async function migrateLegacyProject(now = Date.now()): Promise<MigrationOutcome> {
  const legacy = loadLegacyProject();
  if (!legacy) {
    // Provider keys can outlive a project: move them even with nothing to open.
    migrateLegacySettings(loadAISnapshot());
    return { status: 'none' };
  }
  const record = legacyProjectToRecord(legacy, now);
  const settingsMoved = migrateLegacySettings(legacy.ai);
  const written = await saveProjectRecord(record);
  if (!written.ok) return { status: 'kept', record, result: written };
  const readBack = await loadProjectRecord(record.projectId);
  if (!readBack || !sameProjectContent(record, readBack)) {
    return {
      status: 'kept',
      record,
      result: { ok: false, reason: 'error', message: 'The migrated project did not read back as written.' },
    };
  }
  removeItem(STORAGE_KEYS.workspace);
  removeItem(STORAGE_KEYS.vfs);
  // The AI key holds the provider keys as well as the chat; it goes only
  // once both have a new home.
  if (settingsMoved) removeItem(STORAGE_KEYS.ai);
  return { status: 'migrated', record };
}

/** Returns true when the settings key now holds the providers (already, or just written). */
function migrateLegacySettings(ai: PersistedAI | null): boolean {
  if (loadGlobalSettings()) return true;
  if (!ai) return readItem(STORAGE_KEYS.ai) === null;
  return saveGlobalSettings({
    providers: ai.providers,
    activeProviderId: ai.activeProviderId,
    modelProfile: ai.modelProfile,
    maxIterations: ai.maxIterations,
    tokenBudget: ai.tokenBudget,
  }).ok;
}
