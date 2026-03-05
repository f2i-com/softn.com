/**
 * Project Store - Manages project metadata, logic source, collections, and assets
 */

import { create } from 'zustand';
import type { CollectionDef, AssetFile } from '../types/builder';

interface ProjectStore {
  // Project metadata
  name: string;
  version: string;
  description: string;
  icon: string | null;
  themeMode: 'light' | 'dark' | 'system';

  // Logic source (FormLogic code)
  logicSource: string;

  // XDB collections
  collections: CollectionDef[];

  // Asset files
  assets: AssetFile[];

  // Project state
  isDirty: boolean;
  filePath: string | null;

  // Actions - Metadata
  setName: (name: string) => void;
  setVersion: (version: string) => void;
  setDescription: (description: string) => void;
  setIcon: (icon: string | null) => void;
  setThemeMode: (mode: 'light' | 'dark' | 'system') => void;

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
  logicSource: string;
  collections: CollectionDef[];
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  name: 'Untitled App',
  version: '1.0.0',
  description: '',
  icon: null,
  themeMode: 'light',
  logicSource: `// FormLogic code goes here
// Define your state, computed values, and functions

let count = 0

function increment() {
  count++
}

function decrement() {
  count--
}
`,
  collections: [],
  assets: [],
  isDirty: false,
  filePath: null,

  setName: (name) => {
    set({ name, isDirty: true });
  },

  setVersion: (version) => {
    set({ version, isDirty: true });
  },

  setDescription: (description) => {
    set({ description, isDirty: true });
  },

  setIcon: (icon) => {
    set({ icon, isDirty: true });
  },

  setThemeMode: (mode) => {
    set({ themeMode: mode, isDirty: true });
  },

  setLogicSource: (source) => {
    set({ logicSource: source, isDirty: true });
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
      isDirty: true,
    }));
  },

  updateCollection: (index, updates) => {
    set((state) => {
      const newCollections = [...state.collections];
      if (index >= 0 && index < newCollections.length) {
        newCollections[index] = { ...newCollections[index], ...updates };
      }
      return { collections: newCollections, isDirty: true };
    });
  },

  deleteCollection: (index) => {
    set((state) => ({
      collections: state.collections.filter((_, i) => i !== index),
      isDirty: true,
    }));
  },

  addAsset: (asset) => {
    set((state) => ({
      assets: [...state.assets.filter((a) => a.name !== asset.name), asset],
      isDirty: true,
    }));
  },

  setAssets: (assets) => {
    set({ assets: [...assets], isDirty: true });
  },

  deleteAsset: (name) => {
    set((state) => ({
      assets: state.assets.filter((a) => a.name !== name),
      isDirty: true,
    }));
  },

  setFilePath: (path) => {
    set({ filePath: path });
  },

  markDirty: () => {
    set({ isDirty: true });
  },

  markClean: () => {
    set({ isDirty: false });
  },

  reset: () => {
    set({
      name: 'Untitled App',
      version: '1.0.0',
      description: '',
      icon: null,
      themeMode: 'light',
      logicSource: `// FormLogic code goes here
// Define your state, computed values, and functions

let count = 0

function increment() {
  count++
}

function decrement() {
  count--
}
`,
      collections: [],
      assets: [],
      isDirty: false,
      filePath: null,
    });
  },

  toJSON: () => {
    const state = get();
    return {
      name: state.name,
      version: state.version,
      description: state.description,
      icon: state.icon,
      themeMode: state.themeMode,
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
      logicSource: data.logicSource || '',
      collections: data.collections || [],
      isDirty: false,
    });
  },
}));
