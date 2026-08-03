import type { AgentTask, Blueprint, ChatMessage, ModelProfile, ProjectBrief, ProviderConfig, RecentProjectRecord, VFSFile } from '../types/studio';

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
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { projectName?: unknown }).projectName !== 'string') {
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
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { providers?: unknown }).providers) ||
      !Array.isArray((parsed as { messages?: unknown }).messages)
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
      content: typeof file.content === 'string'
        ? file.content
        : arrayBufferToBase64(file.content),
    })),
  };
  writeItem(STORAGE_KEYS.vfs, JSON.stringify(payload));
}

export function loadVFSSnapshot(): PersistedVFS | null {
  const raw = readItem(STORAGE_KEYS.vfs);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { files?: unknown }).files)) {
      return null;
    }
    return parsed as PersistedVFS;
  } catch {
    return null;
  }
}

export function decodePersistedVFS(snapshot: PersistedVFS): Array<{ path: string; content: string | Uint8Array }> {
  if (!snapshot || !Array.isArray(snapshot.files)) return [];
  const decoded: Array<{ path: string; content: string | Uint8Array }> = [];
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') continue;
    if (file.kind === 'text') {
      decoded.push({ path: file.path, content: file.content });
      continue;
    }
    if (file.kind !== 'binary') continue;
    try {
      decoded.push({
        path: file.path,
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
    return parsed.filter((item): item is RecentProjectRecord => (
      !!item &&
      typeof item === 'object' &&
      typeof (item as { id?: unknown }).id === 'string' &&
      typeof (item as { name?: unknown }).name === 'string' &&
      typeof (item as { target?: unknown }).target === 'string' &&
      typeof (item as { lastModified?: unknown }).lastModified === 'string'
    ));
  } catch {
    return [];
  }
}

export function saveRecentProject(project: RecentProjectRecord): void {
  const existing = loadRecentProjects().filter(
    (item) => item.id !== project.id && item.name !== project.name,
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
  if (workspace && removed && (workspace.projectId === id || workspace.projectName === removed.name)) {
    try {
      storage.removeItem(STORAGE_KEYS.workspace);
      storage.removeItem(STORAGE_KEYS.ai);
      storage.removeItem(STORAGE_KEYS.vfs);
    } catch {
      // Storage may be revoked while the page is open; removal is best effort.
    }
  }
}
