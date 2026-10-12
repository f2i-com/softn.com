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
import { logicStarter, type LogicLanguage } from '../utils/logicFiles';
import { readThemeMode } from '../utils/themeMode';

/** Everything an opened bundle carried that the Builder keeps opaque. */
export interface RetainedSource {
  /**
   * The manifest.json as parsed from the bundle. Null for a project made
   * here. Untouched but for its `pages` list, where it has one: that names
   * UI files, and follows them as they are renamed, moved and deleted
   * (utils/manifestPages.ts).
   */
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

  /**
   * The Python packages a Python app asks the runtime for, written to
   * `config.python.packages` in manifest.json and read back from it: today
   * only `torch`. The composer refuses an `import torch` the manifest does
   * not declare, so an app that uses it has to say so.
   */
  pythonPackages: string[];

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

  /**
   * Whether the project is again what was last kept (utils/savedPoint.ts),
   * asked at each edit. Null when nothing is known to be kept, and then only
   * a save makes the project clean. Dropped with the workspace.
   */
  isAsKept: (() => boolean) | null;

  // Actions - Metadata
  setName: (name: string) => void;
  setVersion: (version: string) => void;
  setDescription: (description: string) => void;
  setIcon: (icon: string | null) => void;
  setThemeMode: (mode: 'light' | 'dark' | 'system') => void;
  setPermissions: (permissions: PermissionDeclaration) => void;
  setPythonPackages: (packages: string[]) => void;

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
  /**
   * An edit has been made: the revision advances, and the project is unsaved
   * unless it is now what was last kept. Called once the edit has landed,
   * so that it is judged on the project as it now is.
   */
  markDirty: () => void;
  markClean: () => void;
  /**
   * Mark clean only if the project is still the one, at the revision, that
   * was saved. Returns whether it was.
   */
  markCleanIf: (projectId: string, revision: number) => boolean;
  /**
   * Clean if the project is what was last kept, with no edit made: for a
   * save whose file holds an earlier revision than the project has now.
   */
  settle: () => void;
  /** Keep what an opened bundle carried, without treating it as an edit. */
  setSource: (source: RetainedSource) => void;
  /** Hold each edit from now on against `isAsKept`, or against nothing. */
  holdAgainst: (isAsKept: (() => boolean) | null) => void;
  /** A new workspace: new id, revision 0, generation advanced. Not an edit. */
  newWorkspace: () => void;
  /** A new, empty project whose logic is in `language` (JavaScript unless said). */
  reset: (language?: LogicLanguage) => void;

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
  /** Absent in sessions written before the setting existed: none. */
  pythonPackages?: string[];
  logicSource: string;
  collections: CollectionDef[];
}

/**
 * The project's own copy of its logic, which only the single-file export and
 * a preview with no UI file at all still read. A Python project has no
 * JavaScript logic, so its copy is empty; its logic is its `.py` file.
 */
function defaultLogicSource(language: LogicLanguage): string {
  return language === 'javascript' ? logicStarter('javascript') : '';
}

export const useProjectStore = create<ProjectStore>((set, get) => {
  /** An edit of the project's own fields: made, and then marked. */
  const edit = (change: Partial<ProjectStore> | ((state: ProjectStore) => Partial<ProjectStore>)) => {
    set(change);
    get().markDirty();
  };
  return ({
  name: 'Untitled App',
  version: '1.0.0',
  description: '',
  icon: null,
  themeMode: 'light',
  permissions: emptyDeclaration(),
  pythonPackages: [],
  logicSource: defaultLogicSource('javascript'),
  collections: [],
  assets: [],
  isDirty: false,
  filePath: null,
  projectId: newProjectId(),
  revision: 0,
  workspaceGeneration: 0,
  source: emptyRetainedSource(),
  isAsKept: null,

  setName: (name) => {
    edit({ name });
  },

  setVersion: (version) => {
    edit({ version });
  },

  setDescription: (description) => {
    edit({ description });
  },

  setIcon: (icon) => {
    edit({ icon });
  },

  setPermissions: (permissions) => {
    edit({ permissions });
  },

  setPythonPackages: (packages) => {
    edit({ pythonPackages: [...new Set(packages)] });
  },

  setThemeMode: (mode) => {
    edit({ themeMode: mode });
  },

  setLogicSource: (source) => {
    edit({ logicSource: source });
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

    edit((state) => ({
      collections: [
        ...state.collections,
        {
          name: finalName,
          alias: finalName,
          fields: [],
          seedData: [],
        },
      ],
    }));
  },

  updateCollection: (index, updates) => {
    edit((state) => {
      const newCollections = [...state.collections];
      if (index >= 0 && index < newCollections.length) {
        newCollections[index] = { ...newCollections[index], ...updates };
      }
      return { collections: newCollections };
    });
  },

  deleteCollection: (index) => {
    edit((state) => ({
      collections: state.collections.filter((_, i) => i !== index),
    }));
  },

  addAsset: (asset) => {
    edit((state) => ({
      assets: [...state.assets.filter((a) => a.name !== asset.name), asset],
    }));
  },

  setAssets: (assets) => {
    edit({ assets: [...assets] });
  },

  deleteAsset: (name) => {
    edit((state) => ({
      assets: state.assets.filter((a) => a.name !== name),
    }));
  },

  setFilePath: (path) => {
    set({ filePath: path });
  },

  markDirty: () => {
    const asKept = get().isAsKept?.() ?? false;
    set((state) => ({ isDirty: !asKept, revision: state.revision + 1 }));
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

  settle: () => {
    if (get().isAsKept?.()) set({ isDirty: false });
  },

  setSource: (source) => {
    set({ source });
  },

  holdAgainst: (isAsKept) => {
    set({ isAsKept });
  },

  newWorkspace: () => {
    set((state) => ({
      projectId: newProjectId(),
      revision: 0,
      workspaceGeneration: state.workspaceGeneration + 1,
      isDirty: false,
      filePath: null,
      isAsKept: null,
    }));
  },

  reset: (language = 'javascript') => {
    set((state) => ({
      name: 'Untitled App',
      version: '1.0.0',
      description: '',
      icon: null,
      themeMode: 'light',
      permissions: emptyDeclaration(),
      pythonPackages: [],
      logicSource: defaultLogicSource(language),
      collections: [],
      assets: [],
      isDirty: false,
      filePath: null,
      projectId: newProjectId(),
      revision: 0,
      workspaceGeneration: state.workspaceGeneration + 1,
      source: emptyRetainedSource(),
      isAsKept: null,
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
      pythonPackages: state.pythonPackages,
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
      // A record from before the theme was kept has none: see utils/themeMode.ts.
      themeMode: readThemeMode(data.themeMode),
      permissions: data.permissions ? { ...emptyDeclaration(), ...data.permissions } : emptyDeclaration(),
      pythonPackages: Array.isArray(data.pythonPackages) ? data.pythonPackages.filter((name) => typeof name === 'string') : [],
      logicSource: data.logicSource || '',
      collections: data.collections || [],
      isDirty: false,
    });
  },
  });
});
