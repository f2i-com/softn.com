/**
 * Project Store - Manages project metadata, logic source, collections, and assets
 *
 * Also the project's identity and revision, and what was read from the
 * bundle that the Builder does not model.
 *
 * Identity and revision: a save used to await the file write and then mark
 * the project clean, whatever had happened in between. An edit made while
 * the write was pending was marked clean without ever reaching a file, and
 * a save begun on one project could mark clean the project opened after it.
 * Every change that dirties the project now also advances `revision`, and a
 * save marks clean only the (projectId, revision) it captured before it
 * built anything — see utils/saveProject.ts.
 *
 * Retained source: the export rebuilt a manifest from six fields and threw
 * the rest away — the declared entry file (replaced by a filename search for
 * "main.ui"), window and runtime settings, forward-compatible fields, the
 * `server` group and every archive entry the Builder had no model for. The
 * manifest as read and the entries the Builder does not model are kept here
 * and written back on export; the export patches only what the Builder
 * edits. Nothing is executed or granted from the retained entries: they are
 * opaque bytes, validated by the same bounded reader as everything else.
 */

import { create } from 'zustand';
import type { CollectionDef, AssetFile } from '../types/builder';
import { emptyDeclaration, type PermissionDeclaration } from '../utils/permissions';

/** Everything an opened bundle carried that the Builder keeps opaque. */
export interface RetainedSource {
  /** The manifest.json as parsed from the bundle, untouched. Null for a project made here. */
  manifest: Record<string, unknown> | null;
  /** Validated archive entries the Builder does not model, path → bytes, written back verbatim. */
  extraEntries: Map<string, Uint8Array>;
  /** The files-store id of the declared entry file, so a rename follows it; null when unknown. */
  mainFileId: string | null;
  /** Where each collection's .xdb was in the archive, by collection name. */
  xdbPaths: Map<string, string>;
  /** Where the icon was in the archive, when the manifest named one. */
  iconPath: string | null;
}

export function emptyRetainedSource(): RetainedSource {
  return { manifest: null, extraEntries: new Map(), mainFileId: null, xdbPaths: new Map(), iconPath: null };
}

let projectCounter = 0;

/** A project id: unique per workspace, never reused within a page's life. */
export function newProjectId(): string {
  projectCounter += 1;
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `project_${projectCounter}_${random}`;
}

interface ProjectStore {
  // Project metadata
  name: string;
  version: string;
  description: string;
  icon: string | null;
  themeMode: 'light' | 'dark' | 'system';

  /**
   * What the app declares it needs: written to permission.json on export,
   * read back from it on open. Nothing declared is nothing granted.
   */
  permissions: PermissionDeclaration;

  // Logic source (.logic — JavaScript)
  logicSource: string;

  // XDB collections
  collections: CollectionDef[];

  // Asset files
  assets: AssetFile[];

  // Project state
  isDirty: boolean;
  filePath: string | null;

  /** Which workspace this is. Changes whenever the workspace is replaced. */
  projectId: string;
  /** Advances on every change that dirties the project. */
  revision: number;
  /**
   * Advances whenever the workspace is replaced: new project, open, restore.
   * A remote open captures it before fetching and refuses to commit if it
   * has moved, whether or not the fetch honoured its abort signal.
   */
  workspaceGeneration: number;

  /** What the opened bundle carried that the Builder does not model. */
  source: RetainedSource;

  // Actions - Metadata
  setName: (name: string) => void;
  setVersion: (version: string) => void;
  setDescription: (description: string) => void;
  setIcon: (icon: string | null) => void;
  setThemeMode: (mode: 'light' | 'dark' | 'system') => void;
  setPermissions: (permissions: PermissionDeclaration) => void;

  // Actions - Logic
  setLogicSource: (source: string) => void;

  // Actions - Collections
  addCollection: (name?: string) => void;
  updateCollection: (index: number, updates: Partial<CollectionDef>) => void;
  deleteCollection: (index: number) => void;

  // Actions - Assets
  addAsset: (asset: AssetFile) => void;
  setAssets: (assets: AssetFile[]) => void;
  deleteAsset: (name: string) => void;

  // Actions - Project
  setFilePath: (path: string | null) => void;
  markDirty: () => void;
  markClean: () => void;
  /**
   * Mark clean only if the project is still the one, at the revision, that
   * was saved. Returns whether it was.
   */
  markCleanIf: (projectId: string, revision: number) => boolean;
  /** Keep what an opened bundle carried, without treating it as an edit. */
  setSource: (source: RetainedSource) => void;
  /** A new workspace: new id, revision 0, generation advanced. Not an edit. */
  newWorkspace: () => void;
  reset: () => void;

  // Serialization
  toJSON: () => SerializedProject;
  fromJSON: (data: SerializedProject) => void;
}

export interface SerializedProject {
  name: string;
  version: string;
  description: string;
  icon: string | null;
  themeMode: 'light' | 'dark' | 'system';
  permissions?: PermissionDeclaration;
  logicSource: string;
  collections: CollectionDef[];
}

const DEFAULT_LOGIC = `// SoftN logic — JavaScript, run in a sandboxed VM
// Define your state, computed values, and functions

let count = 0

function increment() {
  count++
}

function decrement() {
  count--
}
`;

/** The part of every edit that marks the project dirty and advances its revision. */
function touch(state: { revision: number }): { isDirty: true; revision: number } {
  return { isDirty: true, revision: state.revision + 1 };
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  name: 'Untitled App',
  version: '1.0.0',
  description: '',
  icon: null,
  themeMode: 'light',
  permissions: emptyDeclaration(),
  logicSource: DEFAULT_LOGIC,
  collections: [],
  assets: [],
  isDirty: false,
  filePath: null,
  projectId: newProjectId(),
  revision: 0,
  workspaceGeneration: 0,
  source: emptyRetainedSource(),

  setName: (name) => {
    set((state) => ({ name, ...touch(state) }));
  },

  setVersion: (version) => {
    set((state) => ({ version, ...touch(state) }));
  },

  setDescription: (description) => {
    set((state) => ({ description, ...touch(state) }));
  },

  setIcon: (icon) => {
    set((state) => ({ icon, ...touch(state) }));
  },

  setPermissions: (permissions) => {
    set((state) => ({ permissions, ...touch(state) }));
  },

  setThemeMode: (mode) => {
    set((state) => ({ themeMode: mode, ...touch(state) }));
  },

  setLogicSource: (source) => {
    set((state) => ({ logicSource: source, ...touch(state) }));
  },

  addCollection: (name) => {
    const baseName = name || 'collection';
    let finalName = baseName;
    let counter = 1;

    const state = get();
    while (state.collections.some((c) => c.name === finalName)) {
      finalName = `${baseName}_${counter}`;
      counter++;
    }

    set((state) => ({
      collections: [
        ...state.collections,
        {
          name: finalName,
          alias: finalName,
          fields: [],
          seedData: [],
        },
      ],
      ...touch(state),
    }));
  },

  updateCollection: (index, updates) => {
    set((state) => {
      const newCollections = [...state.collections];
      if (index >= 0 && index < newCollections.length) {
        newCollections[index] = { ...newCollections[index], ...updates };
      }
      return { collections: newCollections, ...touch(state) };
    });
  },

  deleteCollection: (index) => {
    set((state) => ({
      collections: state.collections.filter((_, i) => i !== index),
      ...touch(state),
    }));
  },

  addAsset: (asset) => {
    set((state) => ({
      assets: [...state.assets.filter((a) => a.name !== asset.name), asset],
      ...touch(state),
    }));
  },

  setAssets: (assets) => {
    set((state) => ({ assets: [...assets], ...touch(state) }));
  },

  deleteAsset: (name) => {
    set((state) => ({
      assets: state.assets.filter((a) => a.name !== name),
      ...touch(state),
    }));
  },

  setFilePath: (path) => {
    set({ filePath: path });
  },

  markDirty: () => {
    set((state) => touch(state));
  },

  markClean: () => {
    set({ isDirty: false });
  },

  markCleanIf: (projectId, revision) => {
    const state = get();
    if (state.projectId !== projectId || state.revision !== revision) return false;
    set({ isDirty: false });
    return true;
  },

  setSource: (source) => {
    set({ source });
  },

  newWorkspace: () => {
    set((state) => ({
      projectId: newProjectId(),
      revision: 0,
      workspaceGeneration: state.workspaceGeneration + 1,
      isDirty: false,
      filePath: null,
    }));
  },

  reset: () => {
    set((state) => ({
      name: 'Untitled App',
      version: '1.0.0',
      description: '',
      icon: null,
      themeMode: 'light',
      permissions: emptyDeclaration(),
      logicSource: DEFAULT_LOGIC,
      collections: [],
      assets: [],
      isDirty: false,
      filePath: null,
      projectId: newProjectId(),
      revision: 0,
      workspaceGeneration: state.workspaceGeneration + 1,
      source: emptyRetainedSource(),
    }));
  },

  toJSON: () => {
    const state = get();
    return {
      name: state.name,
      version: state.version,
      description: state.description,
      icon: state.icon,
      themeMode: state.themeMode,
      permissions: state.permissions,
      logicSource: state.logicSource,
      collections: state.collections,
    };
  },

  fromJSON: (data) => {
    set({
      name: data.name || 'Untitled App',
      version: data.version || '1.0.0',
      description: data.description || '',
      icon: data.icon || null,
      themeMode: data.themeMode || 'light',
      permissions: data.permissions ? { ...emptyDeclaration(), ...data.permissions } : emptyDeclaration(),
      logicSource: data.logicSource || '',
      collections: data.collections || [],
      isDirty: false,
    });
  },
}));
