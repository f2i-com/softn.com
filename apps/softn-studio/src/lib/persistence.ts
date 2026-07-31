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

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
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
    window.localStorage.setItem(key, value);
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
  if (!canUseStorage()) return;
  writeItem(STORAGE_KEYS.workspace, JSON.stringify(snapshot));
}

export function loadWorkspaceSnapshot(): PersistedWorkspace | null {
  if (!canUseStorage()) return null;
  const raw = window.localStorage.getItem(STORAGE_KEYS.workspace);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistedWorkspace;
  } catch {
    return null;
  }
}

export function saveAISnapshot(snapshot: PersistedAI): void {
  if (!canUseStorage()) return;
  writeItem(STORAGE_KEYS.ai, JSON.stringify(snapshot));
}

export function loadAISnapshot(): PersistedAI | null {
  if (!canUseStorage()) return null;
  const raw = window.localStorage.getItem(STORAGE_KEYS.ai);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistedAI;
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
  if (!canUseStorage()) return;
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
  if (!canUseStorage()) return null;
  const raw = window.localStorage.getItem(STORAGE_KEYS.vfs);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistedVFS;
  } catch {
    return null;
  }
}

export function decodePersistedVFS(snapshot: PersistedVFS): Array<{ path: string; content: string | Uint8Array }> {
  return snapshot.files.map((file) => ({
    path: file.path,
    content: file.kind === 'text'
      ? file.content
      : Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0)),
  }));
}

export function loadRecentProjects(): RecentProjectRecord[] {
  if (!canUseStorage()) return [];
  const raw = window.localStorage.getItem(STORAGE_KEYS.recent);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as RecentProjectRecord[];
  } catch {
    return [];
  }
}

export function saveRecentProject(project: RecentProjectRecord): void {
  if (!canUseStorage()) return;
  const existing = loadRecentProjects().filter(
    (item) => item.id !== project.id && item.name !== project.name,
  );
  const next = [project, ...existing].slice(0, 8);
  writeItem(STORAGE_KEYS.recent, JSON.stringify(next));
}

export function removeRecentProject(id: string): void {
  if (!canUseStorage()) return;
  const all = loadRecentProjects();
  const removed = all.find((item) => item.id === id);
  const next = all.filter((item) => item.id !== id);
  writeItem(STORAGE_KEYS.recent, JSON.stringify(next));

  // If the removed project matches the currently saved workspace, clear all snapshots
  const workspace = loadWorkspaceSnapshot();
  if (workspace && removed && (workspace.projectId === id || workspace.projectName === removed.name)) {
    window.localStorage.removeItem(STORAGE_KEYS.workspace);
    window.localStorage.removeItem(STORAGE_KEYS.ai);
    window.localStorage.removeItem(STORAGE_KEYS.vfs);
  }
}
