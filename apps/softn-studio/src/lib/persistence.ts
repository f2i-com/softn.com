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

const STORAGE_KEYS = {
  workspace: 'softn.studio.workspace.v1',
  ai: 'softn.studio.ai.v1',
  vfs: 'softn.studio.vfs.v1',
  recent: 'softn.studio.recent.v1',
} as const;

type PersistedWorkspace = {
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

type PersistedAI = {
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

type PersistedVFS = {
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

const WORKSPACE_MODES = new Set(['describe', 'structure', 'design', 'data', 'logic', 'test']);
const LEFT_PANELS = new Set(['pages', 'history', 'ai', 'settings', 'files']);
const DEVICE_PRESETS = new Set(['desktop', 'tablet', 'mobile']);
const TARGETS = new Set(['web', 'desktop', 'dual']);
const STYLES = new Set(['clean', 'bold', 'minimal', 'playful', 'dark']);
const BLUEPRINT_FIELD_TYPES = new Set(['string', 'number', 'boolean', 'date', 'array', 'object']);
const RELATIONSHIP_TYPES = new Set(['one-to-one', 'one-to-many', 'many-to-many']);

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

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Accessing the property itself can throw in privacy-restricted contexts.
    return null;
  }
}

function readItem(key: string): string | null {
  try {
    return getStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist one key, and survive a full disk.
 *
 * These writes were unguarded. localStorage throws QuotaExceededError once the
 * origin's few megabytes are used up — which importing one large bundle does —
 * and the throw escaped an autosave effect, so React unmounted the tree and
 * Studio went blank. The project was still in memory a moment earlier and there
 * was no way back to it. Autosave failing is a thing to be told about, not a
 * thing to lose the work over: it returns false and the caller can say so.
 */
function writeItem(key: string, value: string): boolean {
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch (error) {
    const quota = error instanceof DOMException && /quota/i.test(error.name + error.message);
    console.warn(
      quota
        ? `[SoftN Studio] Autosave failed: this project is larger than the browser will store. Export it to keep it.`
        : '[SoftN Studio] Autosave failed:',
      error
    );
    return false;
  }
}

export function saveWorkspaceSnapshot(snapshot: PersistedWorkspace): void {
  writeItem(STORAGE_KEYS.workspace, JSON.stringify(snapshot));
}

export function loadWorkspaceSnapshot(): PersistedWorkspace | null {
  const raw = readItem(STORAGE_KEYS.workspace);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      typeof parsed.projectName !== 'string' ||
      !isNullableString(parsed.projectId) ||
      !isPersistedBrief(parsed.brief) ||
      !isBlueprint(parsed.blueprint) ||
      !Array.isArray(parsed.taskGraph) ||
      !parsed.taskGraph.every(isAgentTask) ||
      typeof parsed.blueprintApproved !== 'boolean' ||
      !WORKSPACE_MODES.has(String(parsed.mode)) ||
      !(parsed.leftPanel === null || LEFT_PANELS.has(String(parsed.leftPanel))) ||
      typeof parsed.leftPanelExpanded !== 'boolean' ||
      typeof parsed.rightSidebarOpen !== 'boolean' ||
      typeof parsed.bottomDrawerOpen !== 'boolean' ||
      parsed.bottomTab !== 'log' ||
      typeof parsed.advancedMode !== 'boolean' ||
      !isNullableString(parsed.activePageId) ||
      !isNullableString(parsed.activeFilePath) ||
      !isNullableString(parsed.selectedComponentId) ||
      !DEVICE_PRESETS.has(String(parsed.devicePreset)) ||
      typeof parsed.zoom !== 'number' ||
      !Number.isFinite(parsed.zoom) ||
      !['light', 'dark'].includes(String(parsed.themePreview)) ||
      !isStringArray(parsed.consoleOutput)
    ) {
      return null;
    }
    return parsed as PersistedWorkspace;
  } catch {
    return null;
  }
}

export function saveAISnapshot(snapshot: PersistedAI): void {
  writeItem(STORAGE_KEYS.ai, JSON.stringify(snapshot));
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

function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function saveVFSSnapshot(files: Map<string, VFSFile>): void {
  const payload: PersistedVFS = {
    files: Array.from(files.values()).map((file) => ({
      path: file.path,
      mimeType: file.mimeType,
      lastModified: file.lastModified,
      lastModifiedBy: file.lastModifiedBy,
      version: file.version,
      kind: typeof file.content === 'string' ? 'text' : 'binary',
      content: typeof file.content === 'string' ? file.content : arrayBufferToBase64(file.content),
    })),
  };
  writeItem(STORAGE_KEYS.vfs, JSON.stringify(payload));
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

export function saveRecentProject(project: RecentProjectRecord): void {
  const existing = loadRecentProjects().filter(
    (item) => item.id !== project.id && item.name !== project.name
  );
  const next = [project, ...existing].slice(0, 8);
  writeItem(STORAGE_KEYS.recent, JSON.stringify(next));
}

export function removeRecentProject(id: string): void {
  const storage = getStorage();
  if (!storage) return;
  const all = loadRecentProjects();
  const removed = all.find((item) => item.id === id);
  const next = all.filter((item) => item.id !== id);
  writeItem(STORAGE_KEYS.recent, JSON.stringify(next));

  // If the removed project matches the currently saved workspace, clear all snapshots
  const workspace = loadWorkspaceSnapshot();
  if (
    workspace &&
    removed &&
    (workspace.projectId === id || workspace.projectName === removed.name)
  ) {
    try {
      storage.removeItem(STORAGE_KEYS.workspace);
      storage.removeItem(STORAGE_KEYS.ai);
      storage.removeItem(STORAGE_KEYS.vfs);
    } catch {
      // Storage may be revoked while the page is open; removal is best effort.
    }
  }
}
