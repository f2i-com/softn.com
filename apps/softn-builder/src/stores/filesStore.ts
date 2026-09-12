/**
 * Files Store - Manages multiple UI and logic files with folder structure
 */

import { create } from 'zustand';
import { useProjectStore } from './projectStore';
import type {
  ProjectFileNode,
  UIFileState,
  LogicFileState,
  AssetFile,
  CanvasElement,
  UIImport,
  LogicImport,
} from '../types/builder';
import { debug } from '../utils/debug';
import { generateSource } from '../utils/sourceGenerator';
import { elementsEqual } from '../utils/elementsEqual';
import { assessSourceFidelity, parseSource } from '../utils/sourceParser';
import { hasSingleAppRoot } from '../utils/sourceFidelity';
import { parse as parseSoftN } from '@softn/core';

function generateId(): string {
  return `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Default initial state for a new UI file
function createEmptyUIFile(id: string, path: string): UIFileState {
  const rootId = `root_${id}`;
  const elements = new Map<string, CanvasElement>([
    [
      rootId,
      {
        id: rootId,
        componentType: 'App',
        props: { theme: 'light' },
        children: [],
        parentId: null,
      },
    ],
  ]);

  return {
    id,
    path,
    elements,
    rootId,
    imports: [],
  };
}

// Default initial state for a new logic file
function createEmptyLogicFile(id: string, path: string): LogicFileState {
  return {
    id,
    path,
    content: `// ${path.split('/').pop()}\n// SoftN logic — JavaScript, run in a sandboxed VM\n\n`,
    imports: [],
    exports: [],
  };
}

// Parse folder path and file name from full path
function parsePath(fullPath: string): { parent: string; name: string } {
  const parts = fullPath.split('/');
  const name = parts.pop() || '';
  const parent = parts.join('/');
  return { parent, name };
}

// Normalize path (remove leading/trailing slashes, handle ..)
function normalizePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

// Resolve relative import path from a source file
function resolveImportPath(fromPath: string, importPath: string): string {
  if (importPath.startsWith('@')) {
    // Package import, return as-is
    return importPath;
  }

  const { parent } = parsePath(fromPath);
  const parts = parent ? parent.split('/') : [];

  const importParts = importPath.split('/');
  for (const part of importParts) {
    if (part === '..') {
      parts.pop();
    } else if (part !== '.') {
      parts.push(part);
    }
  }

  return parts.join('/');
}

/**
 * Express `targetPath` relative to the file at `fromPath`.
 *
 * The inverse of `resolveImportPath`, so a rewritten `<logic src>` keeps the
 * same relative style the author wrote.
 */
function relativeImportPath(fromPath: string, targetPath: string): string {
  const fromParts = (parsePath(fromPath).parent || '').split('/').filter(Boolean);
  const toParts = targetPath.split('/').filter(Boolean);

  let shared = 0;
  while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) {
    shared += 1;
  }

  const up = fromParts.length - shared;
  const down = toParts.slice(shared);
  const prefix = up > 0 ? Array(up).fill('..') : ['.'];
  return [...prefix, ...down].join('/');
}

/**
 * Repoint every `<logic src>` that referred to a file which has just moved.
 *
 * Renaming a logic file used to rewrite only the file's own path, leaving each
 * UI file's `logicSrc` pointing at a name that no longer existed. Nothing
 * downstream treats that as an error: the preview substitutes an empty
 * `<logic>` block "to avoid parse errors", the parser turns a leftover
 * self-closing `<logic src>` into an empty code block, and the renderer
 * replaces every handler that is not a function with a no-op whose warning is
 * gated on `scriptLoaded` — which is false in exactly this case. The result
 * was an app that rendered completely and did nothing at all, with a single
 * console.warn to show for it.
 */
function repointLogicReferences(
  uiFiles: Map<string, UIFileState>,
  oldPath: string,
  newPath: string
): Map<string, UIFileState> {
  const updated = new Map(uiFiles);

  for (const [id, file] of uiFiles) {
    if (!file.logicSrc) continue;
    if (resolveImportPath(file.path, file.logicSrc) !== oldPath) continue;

    const nextSrc = relativeImportPath(file.path, newPath);
    const next: UIFileState = { ...file, logicSrc: nextSrc };

    // Multi-file bundles keep the original text and re-emit the header from
    // it, so the tag in that copy has to be repointed too or export would
    // write the stale path back out.
    if (file.originalSource) {
      next.originalSource = file.originalSource.replace(
        /(<logic\s+src=")([^"]*)(")/,
        `$1${nextSrc}$3`
      );
    }

    updated.set(id, next);
  }

  return updated;
}

/**
 * Whether the file's template is a single `<App>` element, so the root the
 * canvas holds is the author's and not the wrapper parseSource adds around
 * several roots. Asked of the parser rather than a regular expression: a
 * file whose first root is `<App>` but which has a second root beside it
 * also got the wrapper, and writing `<App>` around both would nest them.
 */
function hadSingleAppRoot(source: string): boolean {
  try {
    return hasSingleAppRoot(parseSoftN(source));
  } catch {
    const template = source
      .replace(/<data>[\s\S]*?<\/data>/gi, '')
      .replace(/<logic>[\s\S]*?<\/logic>/gi, '')
      .replace(/<logic\s+[^>]*\/>/gi, '')
      .replace(/<import\s+[^>]+\/>/gi, '')
      .replace(/<style>[\s\S]*?<\/style>/gi, '')
      .replace(/<component\b[^>]*>[\s\S]*?<\/component>/gi, '')
      .replace(/^\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    return /^<App[\s>]/i.test(template);
  }
}

interface FilesStore {
  // File tree structure
  nodes: Map<string, ProjectFileNode>;
  rootFolders: string[]; // ["ui", "logic", "assets"]

  // File content storage
  uiFiles: Map<string, UIFileState>;
  logicFiles: Map<string, LogicFileState>;
  assetFiles: Map<string, AssetFile>;

  // Editor state
  activeFileId: string | null;
  openTabs: string[];

  // Folder actions
  createFolder: (parentPath: string, name: string) => string;
  deleteFolder: (id: string) => void;
  renameFolder: (id: string, newName: string) => void;

  // File actions
  createFile: (parentPath: string, name: string, type: 'ui' | 'logic') => string;
  deleteFile: (id: string) => void;
  renameFile: (id: string, newName: string) => void;
  moveFile: (id: string, newParentPath: string) => void;

  // Tab actions
  openFile: (id: string) => void;
  closeFile: (id: string) => void;
  setActiveFile: (id: string | null) => void;

  // Content actions
  getUIFile: (id: string) => UIFileState | undefined;
  getLogicFile: (id: string) => LogicFileState | undefined;
  getAssetFile: (id: string) => AssetFile | undefined;
  /**
   * Take the canvas's elements as this file's. A tree equal to the one the
   * file already holds is a flush, not an edit: nothing is regenerated,
   * nothing is marked dirty, and the original source stays as it was.
   */
  updateUIFile: (id: string, elements: Map<string, CanvasElement>, rootId: string) => void;
  /**
   * Set the elements the canvas was given for this file without treating
   * it as an edit — for the copy the app makes on open, so the first flush
   * compares equal to it and the file's original source is left alone.
   */
  syncUIFileElements: (id: string, elements: Map<string, CanvasElement>, rootId: string) => void;
  updateUIFileImports: (id: string, imports: UIImport[]) => void;
  updateUIFileLogicSrc: (id: string, logicSrc: string | undefined) => void;
  updateUIFileSource: (id: string, source: string) => void;
  updateLogicFile: (id: string, content: string) => void;
  updateLogicFileImports: (id: string, imports: LogicImport[]) => void;
  markFileDirty: (id: string, dirty: boolean) => void;

  // Path resolution
  resolveImportPath: (fromPath: string, importPath: string) => string;
  getFileByPath: (path: string) => ProjectFileNode | undefined;
  getNodeByPath: (path: string) => ProjectFileNode | undefined;

  // Bulk operations
  reset: () => void;
  initializeProject: () => void;
  loadFromBundle: (
    uiFiles: Map<string, UIFileState>,
    logicFiles: Map<string, LogicFileState>,
    assetFiles?: Map<string, AssetFile>
  ) => void;
}

// Initial main.ui file
const mainUIId = 'main_ui';
const mainLogicId = 'main_logic';

// Build initial file tree
function createInitialNodes(): Map<string, ProjectFileNode> {
  const nodes = new Map<string, ProjectFileNode>();

  // Root folders
  nodes.set('folder_ui', {
    id: 'folder_ui',
    name: 'ui',
    path: 'ui',
    type: 'folder',
    parentId: null,
    children: [mainUIId],
  });

  nodes.set('folder_logic', {
    id: 'folder_logic',
    name: 'logic',
    path: 'logic',
    type: 'folder',
    parentId: null,
    children: [mainLogicId],
  });

  nodes.set('folder_assets', {
    id: 'folder_assets',
    name: 'assets',
    path: 'assets',
    type: 'folder',
    parentId: null,
    children: [],
  });

  // Main UI file
  nodes.set(mainUIId, {
    id: mainUIId,
    name: 'main.ui',
    path: 'ui/main.ui',
    type: 'file',
    fileType: 'ui',
    parentId: 'folder_ui',
    isDirty: false,
  });

  // Main logic file
  nodes.set(mainLogicId, {
    id: mainLogicId,
    name: 'main.logic',
    path: 'logic/main.logic',
    type: 'file',
    fileType: 'logic',
    parentId: 'folder_logic',
    isDirty: false,
  });

  return nodes;
}

export const useFilesStore = create<FilesStore>((set, get) => {
  const edit: typeof set = (...args) => {
    const before = get();
    set(...(args as Parameters<typeof set>));
    if (get() !== before) useProjectStore.getState().markDirty();
  };
  return ({
  nodes: createInitialNodes(),
  rootFolders: ['folder_ui', 'folder_logic', 'folder_assets'],

  uiFiles: new Map([[mainUIId, createEmptyUIFile(mainUIId, 'ui/main.ui')]]),
  logicFiles: new Map([
    [
      mainLogicId,
      {
        id: mainLogicId,
        path: 'logic/main.logic',
        content: `// SoftN logic — JavaScript, run in a sandboxed VM
// Define your state, computed values, and functions

let count = 0

function increment() {
  count++
}

function decrement() {
  count--
}
`,
        imports: [],
        exports: ['count', 'increment', 'decrement'],
      },
    ],
  ]),
  assetFiles: new Map(),

  activeFileId: mainUIId,
  openTabs: [mainUIId],

  createFolder: (parentPath, name) => {
    const id = generateId();
    const fullPath = parentPath ? `${parentPath}/${name}` : name;

    edit((state) => {
      const newNodes = new Map(state.nodes);

      // Find parent folder
      let parentId: string | null = null;
      for (const [nodeId, node] of newNodes) {
        if (node.type === 'folder' && node.path === parentPath) {
          parentId = nodeId;
          break;
        }
      }

      // Create folder node
      newNodes.set(id, {
        id,
        name,
        path: fullPath,
        type: 'folder',
        parentId,
        children: [],
      });

      // Add to parent's children
      if (parentId) {
        const parent = newNodes.get(parentId);
        if (parent && parent.children) {
          newNodes.set(parentId, {
            ...parent,
            children: [...parent.children, id],
          });
        }
      }

      return { nodes: newNodes };
    });

    return id;
  },

  deleteFolder: (id) => {
    edit((state) => {
      const node = state.nodes.get(id);
      if (!node || node.type !== 'folder') return state;

      const newNodes = new Map(state.nodes);
      const newUIFiles = new Map(state.uiFiles);
      const newLogicFiles = new Map(state.logicFiles);
      const newAssetFiles = new Map(state.assetFiles);
      let newOpenTabs = [...state.openTabs];
      let newActiveFileId = state.activeFileId;

      // Recursively delete all children
      const deleteRecursive = (nodeId: string) => {
        const n = newNodes.get(nodeId);
        if (!n) return;

        if (n.type === 'folder' && n.children) {
          for (const childId of n.children) {
            deleteRecursive(childId);
          }
        } else if (n.type === 'file') {
          // Remove from file content stores
          if (n.fileType === 'ui') {
            newUIFiles.delete(nodeId);
          } else if (n.fileType === 'logic') {
            newLogicFiles.delete(nodeId);
          } else if (n.fileType === 'asset') {
            newAssetFiles.delete(nodeId);
          }
          // Remove from tabs
          newOpenTabs = newOpenTabs.filter((t) => t !== nodeId);
          if (newActiveFileId === nodeId) {
            newActiveFileId = newOpenTabs[0] || null;
          }
        }

        newNodes.delete(nodeId);
      };

      deleteRecursive(id);

      // Remove from parent's children
      if (node.parentId) {
        const parent = newNodes.get(node.parentId);
        if (parent && parent.children) {
          newNodes.set(node.parentId, {
            ...parent,
            children: parent.children.filter((c) => c !== id),
          });
        }
      }

      return {
        nodes: newNodes,
        uiFiles: newUIFiles,
        logicFiles: newLogicFiles,
        assetFiles: newAssetFiles,
        openTabs: newOpenTabs,
        activeFileId: newActiveFileId,
      };
    });
  },

  renameFolder: (id, newName) => {
    edit((state) => {
      const node = state.nodes.get(id);
      if (!node || node.type !== 'folder') return state;

      const newNodes = new Map(state.nodes);
      const oldPath = node.path;
      const { parent } = parsePath(oldPath);
      const newPath = parent ? `${parent}/${newName}` : newName;

      // Update this folder
      newNodes.set(id, {
        ...node,
        name: newName,
        path: newPath,
      });

      // Update all descendant paths
      const updateChildPaths = (nodeId: string, oldBase: string, newBase: string) => {
        const n = newNodes.get(nodeId);
        if (!n) return;

        if (n.type === 'folder' && n.children) {
          for (const childId of n.children) {
            const child = newNodes.get(childId);
            if (child) {
              const childNewPath = child.path.replace(oldBase, newBase);
              newNodes.set(childId, { ...child, path: childNewPath });
              if (child.type === 'folder') {
                updateChildPaths(childId, oldBase, newBase);
              }
            }
          }
        }
      };

      updateChildPaths(id, oldPath, newPath);

      // Update file content paths
      const newUIFiles = new Map(state.uiFiles);
      const newLogicFiles = new Map(state.logicFiles);
      const newAssetFiles = new Map(state.assetFiles);

      for (const [fileId, file] of newUIFiles) {
        if (file.path.startsWith(oldPath + '/')) {
          newUIFiles.set(fileId, {
            ...file,
            path: file.path.replace(oldPath, newPath),
          });
        }
      }

      for (const [fileId, file] of newLogicFiles) {
        if (file.path.startsWith(oldPath + '/')) {
          newLogicFiles.set(fileId, {
            ...file,
            path: file.path.replace(oldPath, newPath),
          });
        }
      }

      for (const [fileId, file] of newAssetFiles) {
        if (file.name.startsWith(oldPath + '/')) {
          newAssetFiles.set(fileId, {
            ...file,
            name: file.name.replace(oldPath, newPath),
          });
        }
      }

      return {
        nodes: newNodes,
        uiFiles: newUIFiles,
        logicFiles: newLogicFiles,
        assetFiles: newAssetFiles,
      };
    });
  },

  createFile: (parentPath, name, type) => {
    const id = generateId();
    const fullPath = parentPath ? `${parentPath}/${name}` : name;

    edit((state) => {
      const newNodes = new Map(state.nodes);
      const newUIFiles = new Map(state.uiFiles);
      const newLogicFiles = new Map(state.logicFiles);

      // Find parent folder
      let parentId: string | null = null;
      for (const [nodeId, node] of newNodes) {
        if (node.type === 'folder' && node.path === parentPath) {
          parentId = nodeId;
          break;
        }
      }

      // Create file node
      newNodes.set(id, {
        id,
        name,
        path: fullPath,
        type: 'file',
        fileType: type,
        parentId,
        isDirty: true,
      });

      // Add to parent's children
      if (parentId) {
        const parent = newNodes.get(parentId);
        if (parent && parent.children) {
          newNodes.set(parentId, {
            ...parent,
            children: [...parent.children, id],
          });
        }
      }

      // Create file content
      if (type === 'ui') {
        newUIFiles.set(id, createEmptyUIFile(id, fullPath));
      } else {
        newLogicFiles.set(id, createEmptyLogicFile(id, fullPath));
      }

      return {
        nodes: newNodes,
        uiFiles: newUIFiles,
        logicFiles: newLogicFiles,
        openTabs: [...state.openTabs, id],
        activeFileId: id,
      };
    });

    return id;
  },

  deleteFile: (id) => {
    edit((state) => {
      const node = state.nodes.get(id);
      if (!node || node.type !== 'file') return state;

      // Prevent deleting main files
      if (id === mainUIId || id === mainLogicId) {
        console.warn('Cannot delete main.ui or main.logic');
        return state;
      }

      const newNodes = new Map(state.nodes);
      const newUIFiles = new Map(state.uiFiles);
      const newLogicFiles = new Map(state.logicFiles);
      const newAssetFiles = new Map(state.assetFiles);

      // Remove from parent's children
      if (node.parentId) {
        const parent = newNodes.get(node.parentId);
        if (parent && parent.children) {
          newNodes.set(node.parentId, {
            ...parent,
            children: parent.children.filter((c) => c !== id),
          });
        }
      }

      // Remove node
      newNodes.delete(id);

      // Remove file content
      if (node.fileType === 'ui') {
        newUIFiles.delete(id);
      } else if (node.fileType === 'logic') {
        newLogicFiles.delete(id);
      } else if (node.fileType === 'asset') {
        newAssetFiles.delete(id);
      }

      // Update tabs
      const newOpenTabs = state.openTabs.filter((t) => t !== id);
      const newActiveFileId =
        state.activeFileId === id ? newOpenTabs[0] || null : state.activeFileId;

      return {
        nodes: newNodes,
        uiFiles: newUIFiles,
        logicFiles: newLogicFiles,
        assetFiles: newAssetFiles,
        openTabs: newOpenTabs,
        activeFileId: newActiveFileId,
      };
    });
  },

  renameFile: (id, newName) => {
    edit((state) => {
      const node = state.nodes.get(id);
      if (!node || node.type !== 'file') return state;

      const { parent } = parsePath(node.path);
      const newPath = parent ? `${parent}/${newName}` : newName;

      const newNodes = new Map(state.nodes);
      newNodes.set(id, {
        ...node,
        name: newName,
        path: newPath,
      });

      // Update file content path
      let newUIFiles = new Map(state.uiFiles);
      const newLogicFiles = new Map(state.logicFiles);
      const newAssetFiles = new Map(state.assetFiles);

      if (node.fileType === 'ui') {
        const file = newUIFiles.get(id);
        if (file) {
          newUIFiles.set(id, { ...file, path: newPath });
        }
      } else if (node.fileType === 'logic') {
        const file = newLogicFiles.get(id);
        if (file) {
          newLogicFiles.set(id, { ...file, path: newPath });
        }
        // Every `<logic src>` that pointed at the old path has to follow it,
        // or the app renders perfectly and every button is inert.
        newUIFiles = repointLogicReferences(newUIFiles, node.path, newPath);
      } else if (node.fileType === 'asset') {
        const file = newAssetFiles.get(id);
        if (file) {
          newAssetFiles.set(id, { ...file, name: newPath });
        }
      }

      return {
        nodes: newNodes,
        uiFiles: newUIFiles,
        logicFiles: newLogicFiles,
        assetFiles: newAssetFiles,
      };
    });
  },

  moveFile: (id, newParentPath) => {
    edit((state) => {
      const node = state.nodes.get(id);
      if (!node || node.type !== 'file') return state;

      const newNodes = new Map(state.nodes);
      const newPath = `${newParentPath}/${node.name}`;

      // Find new parent folder
      let newParentId: string | null = null;
      for (const [nodeId, n] of newNodes) {
        if (n.type === 'folder' && n.path === newParentPath) {
          newParentId = nodeId;
          break;
        }
      }

      // Remove from old parent
      if (node.parentId) {
        const oldParent = newNodes.get(node.parentId);
        if (oldParent && oldParent.children) {
          newNodes.set(node.parentId, {
            ...oldParent,
            children: oldParent.children.filter((c) => c !== id),
          });
        }
      }

      // Add to new parent
      if (newParentId) {
        const newParent = newNodes.get(newParentId);
        if (newParent && newParent.children) {
          newNodes.set(newParentId, {
            ...newParent,
            children: [...newParent.children, id],
          });
        }
      }

      // Update node
      newNodes.set(id, {
        ...node,
        path: newPath,
        parentId: newParentId,
      });

      // Update file content path
      let newUIFiles = new Map(state.uiFiles);
      const newLogicFiles = new Map(state.logicFiles);
      const newAssetFiles = new Map(state.assetFiles);

      if (node.fileType === 'ui') {
        const file = newUIFiles.get(id);
        if (file) {
          newUIFiles.set(id, { ...file, path: newPath });
        }
      } else if (node.fileType === 'logic') {
        const file = newLogicFiles.get(id);
        if (file) {
          newLogicFiles.set(id, { ...file, path: newPath });
        }
        // Every `<logic src>` that pointed at the old path has to follow it,
        // or the app renders perfectly and every button is inert.
        newUIFiles = repointLogicReferences(newUIFiles, node.path, newPath);
      } else if (node.fileType === 'asset') {
        const file = newAssetFiles.get(id);
        if (file) {
          newAssetFiles.set(id, { ...file, name: newPath });
        }
      }

      return {
        nodes: newNodes,
        uiFiles: newUIFiles,
        logicFiles: newLogicFiles,
        assetFiles: newAssetFiles,
      };
    });
  },

  openFile: (id) => {
    set((state) => {
      if (state.openTabs.includes(id)) {
        return { activeFileId: id };
      }
      return {
        openTabs: [...state.openTabs, id],
        activeFileId: id,
      };
    });
  },

  closeFile: (id) => {
    set((state) => {
      const newOpenTabs = state.openTabs.filter((t) => t !== id);
      let newActiveFileId = state.activeFileId;

      if (state.activeFileId === id) {
        // Find the tab to switch to
        const currentIndex = state.openTabs.indexOf(id);
        if (currentIndex > 0) {
          newActiveFileId = state.openTabs[currentIndex - 1];
        } else if (newOpenTabs.length > 0) {
          newActiveFileId = newOpenTabs[0];
        } else {
          newActiveFileId = null;
        }
      }

      return {
        openTabs: newOpenTabs,
        activeFileId: newActiveFileId,
      };
    });
  },

  setActiveFile: (id) => {
    set({ activeFileId: id });
  },

  getUIFile: (id) => {
    return get().uiFiles.get(id);
  },

  getLogicFile: (id) => {
    return get().logicFiles.get(id);
  },

  getAssetFile: (id) => {
    return get().assetFiles.get(id);
  },

  syncUIFileElements: (id, elements, rootId) => {
    set((state) => {
      const file = state.uiFiles.get(id);
      if (!file) return state;
      const newUIFiles = new Map(state.uiFiles);
      newUIFiles.set(id, { ...file, elements, rootId });
      return { uiFiles: newUIFiles };
    });
  },

  updateUIFile: (id, elements, rootId) => {
    set((state) => {
      const file = state.uiFiles.get(id);
      if (!file) return state;

      // A flush of an unchanged canvas is not an edit. Every save, export,
      // pre-flight check and tab switch flushes; before this check each one
      // regenerated the file's source from the visual model, so a bundle
      // opened and never touched came out rewritten — comments dropped,
      // grouped expressions flattened, nested blocks collapsed. The original
      // bytes stay authoritative until the tree actually differs.
      if (file.rootId === rootId && elementsEqual(file.elements, elements)) return state;

      // Only regenerate originalSource when the file already had one (loaded
      // from a bundle or set via SourceView).  For files that never had
      // originalSource (new files) leave it undefined so the preview uses
      // generateSource directly.
      //
      // Smart merge: preserve all non-template blocks (logic, data, imports,
      // styles) from the original source and only replace the template
      // portion with the newly generated template from the canvas.
      let nextOriginalSource = file.originalSource;
      let sourceFidelity = file.sourceFidelity;
      if (nextOriginalSource !== undefined) {
        // The visual model is narrower than the language. Before the file
        // is regenerated from it, ask whether that loses anything the
        // source holds — a comment, an expression the parser stops reading
        // part way through, text between child elements, a header block
        // the splice below does not carry. If it does, the original bytes
        // stay authoritative and the edit is recorded as blocked, with the
        // reasons, so the editor can say this file is edited as source.
        // Regenerating anyway is exactly the silent loss BLD-01 forbids.
        sourceFidelity ??= assessSourceFidelity(nextOriginalSource);
        if (!sourceFidelity.lossless) {
          const blockedFiles = new Map(state.uiFiles);
          blockedFiles.set(id, {
            ...file,
            sourceFidelity,
            visualEditBlocked: [...sourceFidelity.reasons],
          });
          return { uiFiles: blockedFiles };
        }

        // Detect whether the original source had an <App> root element.
        // If not (e.g. Header.ui, Dashboard.ui), the parser added a
        // synthetic App wrapper which we must NOT persist back.
        const originalHadAppRoot = hadSingleAppRoot(nextOriginalSource);

        // Generate template-only from the canvas elements
        const generatedTemplate = generateSource(elements, rootId, '', [], {
          skipRootAppWrapper: !originalHadAppRoot,
        });

        // Extract non-template header blocks from the current originalSource
        const headerBlocks: string[] = [];

        // Component declaration: <component name="…">…</component>
        const componentBlocks = Array.from(
          nextOriginalSource.matchAll(/<component\b[^>]*>[\s\S]*?<\/component>|<component\b[^>]*\/>/gi)
        ).map((m) => m[0]);
        for (const block of componentBlocks) {
          headerBlocks.push(block);
        }

        // Logic: <logic src="..." /> (external reference)
        const logicSrcBlock = nextOriginalSource.match(
          /<logic\s+src=["'][^"']+["']\s*\/>/i
        );
        // Logic: <logic>...</logic> (inline)
        const inlineLogicBlock = nextOriginalSource.match(
          /<logic>[\s\S]*?<\/logic>/i
        );
        if (logicSrcBlock) {
          headerBlocks.push(logicSrcBlock[0]);
        } else if (inlineLogicBlock) {
          headerBlocks.push(inlineLogicBlock[0]);
        } else if (file.logicSrc) {
          headerBlocks.push(`<logic src="${file.logicSrc}" />`);
        }

        // Imports
        const importBlocks = Array.from(
          nextOriginalSource.matchAll(
            /<import\s+(?:\{\s*[^}]+\s*\}|\w+)\s+from=["'][^"']+["']\s*\/>/gi
          )
        ).map((m) => m[0]);
        if (importBlocks.length > 0) {
          headerBlocks.push(importBlocks.join('\n'));
        }

        // Data blocks
        const dataBlocks = Array.from(
          nextOriginalSource.matchAll(/<data>[\s\S]*?<\/data>/gi)
        ).map((m) => m[0]);
        for (const block of dataBlocks) {
          headerBlocks.push(block);
        }

        // Style blocks
        const styleBlocks = Array.from(
          nextOriginalSource.matchAll(/<style>[\s\S]*?<\/style>/gi)
        ).map((m) => m[0]);
        for (const block of styleBlocks) {
          headerBlocks.push(block);
        }

        if (headerBlocks.length > 0) {
          nextOriginalSource = [...headerBlocks, generatedTemplate]
            .join('\n\n')
            .trim();
        } else {
          nextOriginalSource = generatedTemplate;
        }
      }

      const newUIFiles = new Map(state.uiFiles);
      newUIFiles.set(id, {
        ...file,
        elements,
        rootId,
        ...(nextOriginalSource !== undefined ? { originalSource: nextOriginalSource } : {}),
        ...(sourceFidelity !== undefined ? { sourceFidelity } : {}),
        visualEditBlocked: undefined,
      });

      // Mark as dirty
      const newNodes = new Map(state.nodes);
      const node = newNodes.get(id);
      if (node) {
        newNodes.set(id, { ...node, isDirty: true });
      }

      useProjectStore.getState().markDirty();
      return { uiFiles: newUIFiles, nodes: newNodes };
    });
  },

  updateUIFileImports: (id, imports) => {
    edit((state) => {
      const file = state.uiFiles.get(id);
      if (!file) return state;

      const newUIFiles = new Map(state.uiFiles);
      newUIFiles.set(id, { ...file, imports });

      return { uiFiles: newUIFiles };
    });
  },

  updateUIFileLogicSrc: (id, logicSrc) => {
    edit((state) => {
      const file = state.uiFiles.get(id);
      if (!file) return state;

      const newUIFiles = new Map(state.uiFiles);
      newUIFiles.set(id, { ...file, logicSrc });

      return { uiFiles: newUIFiles };
    });
  },

  updateUIFileSource: (id, source) => {
    edit((state) => {
      const file = state.uiFiles.get(id);
      if (!file || file.originalSource === source) return state;
      const parsed = parseSource(source);

      const newUIFiles = new Map(state.uiFiles);
      // New source, new fidelity: it is computed again on the next visual
      // edit, and a previously refused edit no longer describes this text.
      newUIFiles.set(id, {
        ...file,
        originalSource: source,
        sourceFidelity: undefined,
        elements: parsed.elements,
        rootId: parsed.rootId,
        imports: parsed.imports,
        logicSrc: parsed.logicSrc,
        visualEditBlocked: undefined,
      });

      // Mark as dirty
      const newNodes = new Map(state.nodes);
      const node = newNodes.get(id);
      if (node) {
        newNodes.set(id, { ...node, isDirty: true });
      }

      return { uiFiles: newUIFiles, nodes: newNodes };
    });
  },

  updateLogicFile: (id, content) => {
    edit((state) => {
      const file = state.logicFiles.get(id);
      if (!file) return state;

      const newLogicFiles = new Map(state.logicFiles);
      newLogicFiles.set(id, {
        ...file,
        content,
        // Re-parse imports and exports
        imports: parseLogicImports(content),
        exports: parseLogicExports(content),
      });

      // Mark as dirty
      const newNodes = new Map(state.nodes);
      const node = newNodes.get(id);
      if (node) {
        newNodes.set(id, { ...node, isDirty: true });
      }

      return { logicFiles: newLogicFiles, nodes: newNodes };
    });
  },

  updateLogicFileImports: (id, imports) => {
    edit((state) => {
      const file = state.logicFiles.get(id);
      if (!file) return state;

      const newLogicFiles = new Map(state.logicFiles);
      newLogicFiles.set(id, { ...file, imports });

      return { logicFiles: newLogicFiles };
    });
  },

  markFileDirty: (id, dirty) => {
    set((state) => {
      const newNodes = new Map(state.nodes);
      const node = newNodes.get(id);
      if (node && node.type === 'file') {
        newNodes.set(id, { ...node, isDirty: dirty });
      }
      return { nodes: newNodes };
    });
  },

  resolveImportPath: (fromPath, importPath) => {
    return resolveImportPath(fromPath, importPath);
  },

  getFileByPath: (path) => {
    const normalizedPath = normalizePath(path);
    for (const [, node] of get().nodes) {
      if (node.type === 'file' && node.path === normalizedPath) {
        return node;
      }
    }
    return undefined;
  },

  getNodeByPath: (path) => {
    const normalizedPath = normalizePath(path);
    for (const [, node] of get().nodes) {
      if (node.path === normalizedPath) {
        return node;
      }
    }
    return undefined;
  },

  reset: () => {
    set({
      nodes: createInitialNodes(),
      rootFolders: ['folder_ui', 'folder_logic', 'folder_assets'],
      uiFiles: new Map([[mainUIId, createEmptyUIFile(mainUIId, 'ui/main.ui')]]),
      logicFiles: new Map([
        [
          mainLogicId,
          {
            id: mainLogicId,
            path: 'logic/main.logic',
            content: `// SoftN logic — JavaScript, run in a sandboxed VM
// Define your state, computed values, and functions

let count = 0

function increment() {
  count++
}

function decrement() {
  count--
}
`,
            imports: [],
            exports: ['count', 'increment', 'decrement'],
          },
        ],
      ]),
      assetFiles: new Map(),
      activeFileId: mainUIId,
      openTabs: [mainUIId],
    });
  },

  initializeProject: () => {
    // Create default folder structure
    const state = get();

    // Check if components folder exists
    let hasComponentsFolder = false;
    let hasPagesFolder = false;
    let hasUtilsFolder = false;

    for (const [, node] of state.nodes) {
      if (node.path === 'ui/components') hasComponentsFolder = true;
      if (node.path === 'ui/pages') hasPagesFolder = true;
      if (node.path === 'logic/utils') hasUtilsFolder = true;
    }

    if (!hasComponentsFolder) {
      get().createFolder('ui', 'components');
    }
    if (!hasPagesFolder) {
      get().createFolder('ui', 'pages');
    }
    if (!hasUtilsFolder) {
      get().createFolder('logic', 'utils');
    }
  },

  loadFromBundle: (uiFiles, logicFiles, assetFiles = new Map()) => {
    // Build node tree from loaded files
    const nodes = new Map<string, ProjectFileNode>();
    const rootFolders: string[] = [];

    // Helper to ensure folder exists
    const ensureFolder = (path: string): string => {
      const existingNode = Array.from(nodes.values()).find(
        (n) => n.type === 'folder' && n.path === path
      );
      if (existingNode) return existingNode.id;

      const { parent, name } = parsePath(path);
      let parentId: string | null = null;

      if (parent) {
        parentId = ensureFolder(parent);
      }

      const id = `folder_${path.replace(/\//g, '_')}`;
      nodes.set(id, {
        id,
        name,
        path,
        type: 'folder',
        parentId,
        children: [],
      });

      if (parentId) {
        const parentNode = nodes.get(parentId);
        if (parentNode && parentNode.children) {
          parentNode.children.push(id);
        }
      } else {
        rootFolders.push(id);
      }

      return id;
    };

    // Always create standard roots for consistent navigator layout
    ensureFolder('ui');
    ensureFolder('logic');
    ensureFolder('assets');

    // Add UI files
    for (const [id, file] of uiFiles) {
      const { parent, name } = parsePath(file.path);
      const parentId = parent ? ensureFolder(parent) : null;

      nodes.set(id, {
        id,
        name,
        path: file.path,
        type: 'file',
        fileType: 'ui',
        parentId,
        isDirty: false,
      });

      if (parentId) {
        const parentNode = nodes.get(parentId);
        if (parentNode && parentNode.children) {
          parentNode.children.push(id);
        }
      }
    }

    // Add logic files
    for (const [id, file] of logicFiles) {
      const { parent, name } = parsePath(file.path);
      const parentId = parent ? ensureFolder(parent) : null;

      nodes.set(id, {
        id,
        name,
        path: file.path,
        type: 'file',
        fileType: 'logic',
        parentId,
        isDirty: false,
      });

      if (parentId) {
        const parentNode = nodes.get(parentId);
        if (parentNode && parentNode.children) {
          parentNode.children.push(id);
        }
      }
    }

    // Add asset files
    const loadedAssets = new Map<string, AssetFile>();
    for (const [assetPath, asset] of assetFiles) {
      const fileId = generateId();
      const { parent, name } = parsePath(assetPath);
      const parentId = parent ? ensureFolder(parent) : null;

      nodes.set(fileId, {
        id: fileId,
        name,
        path: assetPath,
        type: 'file',
        fileType: 'asset',
        parentId,
        isDirty: false,
      });

      if (parentId) {
        const parentNode = nodes.get(parentId);
        if (parentNode && parentNode.children) {
          parentNode.children.push(fileId);
        }
      }

      loadedAssets.set(fileId, {
        name: assetPath,
        type: asset.type,
        data: asset.data,
      });
    }

    // Find main UI file to open
    let mainFileId: string | null = null;
    for (const [id, file] of uiFiles) {
      if (file.path === 'ui/main.ui') {
        mainFileId = id;
        break;
      }
    }

    debug('[loadFromBundle] Loaded:', {
      folders: rootFolders.length,
      nodes: nodes.size,
      uiFiles: uiFiles.size,
      logicFiles: logicFiles.size,
      assetFiles: loadedAssets.size,
    });

    // Create new Map instances to ensure zustand detects the state change
    set({
      nodes: new Map(nodes),
      rootFolders: [...rootFolders],
      uiFiles: new Map(uiFiles),
      logicFiles: new Map(logicFiles),
      assetFiles: loadedAssets,
      activeFileId: mainFileId,
      openTabs: mainFileId ? [mainFileId] : [],
    });
  },
});
});

// Helper function to parse imports from logic code
function parseLogicImports(content: string): LogicImport[] {
  const imports: LogicImport[] = [];
  const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const names = match[1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    const source = match[2];
    imports.push({ names, source });
  }

  return imports;
}

// Helper function to parse exports from logic code
function parseLogicExports(content: string): string[] {
  const exports: string[] = [];

  // Match: export function name
  const funcRegex = /export\s+function\s+(\w+)/g;
  let match;
  while ((match = funcRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }

  // Match: export const/let/var name
  const varRegex = /export\s+(?:const|let|var)\s+(\w+)/g;
  while ((match = varRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }

  return exports;
}
