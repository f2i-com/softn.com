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
} from '../types/builder';
import { debug } from '../utils/debug';
import { elementsEqual } from '../utils/elementsEqual';
import { assessSourceFidelity, parseSource } from '../utils/sourceParser';
import { writeBack } from '../utils/sourceFrame';
import { withImportLines } from '../utils/pageImports';
import { pagesFollowing } from '../utils/manifestPages';
import { changeDataDeclarations, type CollectionChange } from '../utils/dataDeclarations';
import {
  MAIN_LOGIC_PATHS,
  blankLogicFile,
  entryFileId,
  linkedLogicFile,
  logicStarter,
  relativeImportPath,
  resolveImportPath,
  type LogicLanguage,
} from '../utils/logicFiles';
import { applyInlineLogicMove, planInlineLogicMove, takenPaths, type InlineLogicMove } from '../utils/inlineLogic';
import { isPythonLogicPath, parse as parseSoftN, pythonModuleName, type SoftNDocument } from '@softn/core';
import { randomId } from '../utils/ids';

const generateId = (): string => randomId('file_');

/**
 * The folder at `path` in `nodes`, made with every folder above it that is
 * not there yet; null for the top of the project.
 *
 * A file or a folder was put under the folder of its path when there was
 * one, and under nothing when there was not. "New UI file" as a component
 * makes `ui/components/row.ui`, and a new project has no `ui/components`: the
 * file was made, opened in a tab, written into the export, and was nowhere
 * in the Files panel, which draws what each folder holds. With its tab
 * closed there was no way back to it.
 */
function folderAt(nodes: Map<string, ProjectFileNode>, path: string): string | null {
  let parentId: string | null = null;
  let at = '';
  for (const part of path.split('/').filter(Boolean)) {
    at = at ? `${at}/${part}` : part;
    let found: string | null = null;
    for (const [nodeId, node] of nodes) {
      if (node.type === 'folder' && node.path === at) {
        found = nodeId;
        break;
      }
    }
    if (!found) {
      found = generateId();
      nodes.set(found, { id: found, name: part, path: at, type: 'folder', parentId, children: [] });
      const parent = parentId ? nodes.get(parentId) : undefined;
      if (parentId && parent) nodes.set(parentId, { ...parent, children: [...(parent.children ?? []), found] });
    }
    parentId = found;
  }
  return parentId;
}

// Default initial state for a new UI file
function createEmptyUIFile(id: string, path: string, logicSrc?: string): UIFileState {
  const rootId = `root_${id}`;
  const elements = new Map<string, CanvasElement>([
    [
      rootId,
      {
        id: rootId,
        componentType: 'App',
        props: { theme: 'system' },
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
    ...(logicSrc ? { logicSrc } : {}),
  };
}

// Default initial state for a new logic file
function createEmptyLogicFile(id: string, path: string): LogicFileState {
  return {
    id,
    path,
    content: blankLogicFile(path),
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

/**
 * What a file is read as, from the file as it stands: its text with the
 * elements and imports the text was read into. Nothing for a page made on
 * the canvas, which has no text of its own.
 *
 * The first canvas edit writes a page's template again in the Builder's
 * own layout, and Undo put the elements back and not the text: a page
 * edited and undone to the start was some hundreds of bytes shorter than
 * it had been opened, with its blank lines gone. While a file keeps this,
 * a canvas that is these elements and imports again is this text again
 * (updateUIFile).
 */
function baselineOf(file: UIFileState): UIFileState['baseline'] {
  if (file.originalSource === undefined) return undefined;
  return { source: file.originalSource, elements: file.elements, rootId: file.rootId, imports: file.imports };
}

function sameImportList(a: readonly UIImport[], b: readonly UIImport[]): boolean {
  return a.length === b.length && a.every((imp, at) => imp.name === b[at].name && imp.source === b[at].source);
}

/**
 * The files after a change that wrote into a page's text from outside the
 * canvas and Code: a page it imports renamed, its logic file moved, a
 * collection renamed in Data, its inline logic moved to a file. What the
 * page was read as has to say the same, or Undo would bring the old path or
 * the old name back with the old text. A page that was still its read text
 * is read as the new text; one the canvas had already rewritten has
 * nothing to go back to, and keeps nothing.
 */
function baselinesFollowing(before: Map<string, UIFileState>, after: Map<string, UIFileState>): Map<string, UIFileState> {
  let next: Map<string, UIFileState> | null = null;
  for (const [id, file] of after) {
    const was = before.get(id);
    if (!was || !was.baseline || file.baseline !== was.baseline) continue;
    const linked = file.logicSrc !== was.logicSrc && file.originalSource === was.originalSource;
    if (!linked && file.originalSource === was.originalSource && sameImportList(file.imports, was.imports)) continue;
    // A logic file linked from the panel is written into the page at its
    // next edit; the text as read has no such line, and is not gone back to.
    const untouched = !linked && was.originalSource === was.baseline.source && file.elements === was.elements;
    next ??= new Map(after);
    next.set(id, { ...file, baseline: untouched ? baselineOf(file) : undefined });
  }
  return next ?? after;
}

/**
 * The tree with the file `id` marked as changed. The same tree when it is
 * marked already: a new one is every part of the workspace that shows the
 * files drawn again, and the logic dock and Code view mark a file at every
 * key typed into it.
 */
function markedChanged(nodes: Map<string, ProjectFileNode>, id: string): Map<string, ProjectFileNode> {
  const node = nodes.get(id);
  if (!node || node.isDirty) return nodes;
  return new Map(nodes).set(id, { ...node, isDirty: true });
}

/** A path mapped through a move of `from` (a file or a folder) to `to`. */
function movedPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return path;
}

/** Every `<logic src="…">` in a source, with either quote. */
const LOGIC_SRC_ATTRIBUTE = /(<logic\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi;

/**
 * Every `<script src="…">` and `<link href="…">` in a source: a page written
 * as HTML names its code and its stylesheets so, from where the page is, as
 * `<logic src>` names its code.
 */
const SCRIPT_SRC_ATTRIBUTE = /(<script\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi;
const LINK_HREF_ATTRIBUTE = /(<link\b[^>]*?\bhref\s*=\s*)(["'])([^"']*)\2/gi;

/** An address on another site, or of no file: `https:`, `//cdn…`, `data:`, `#top`. */
const ELSEWHERE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * Every `<import … from="…">` in a source, with either quote, and with or
 * without the `=`: the parser and the composer read `from "./x.ui"` as the
 * same import (core, UI_IMPORT_PATTERN), and a rename has to follow both.
 * This one also takes the `{ A, B }` form of the names, which that pattern
 * does not, so it is its own; the spelling of `from` is kept the same.
 */
const IMPORT_FROM_ATTRIBUTE = /(<import\b[^>]*?\bfrom\s*=?\s*)(["'])([^"']*)\2/gi;

/**
 * Keep every `<logic src>` pointing at the file it meant, after a rename or
 * a move changed where the logic file is, where the UI file holding the tag
 * is, or both.
 *
 * Renaming a logic file used to rewrite only the file's own path, leaving each
 * UI file's `logicSrc` pointing at a name that no longer existed. Nothing
 * downstream treats that as an error: the preview substitutes an empty
 * `<logic>` block "to avoid parse errors", the parser turns a leftover
 * self-closing `<logic src>` into an empty code block, and the renderer
 * replaces every handler that is not a function with a no-op whose warning is
 * gated on `scriptLoaded` — which is false in exactly this case. The result
 * was an app that rendered completely and did nothing at all, with a single
 * console.warn to show for it. Moving the UI file itself, or renaming a
 * folder, broke the reference the same way, because the reference is
 * relative to the file that holds it and only the other end was followed.
 *
 * `before` holds each UI file as it was, so every reference is resolved
 * from where it was written; `move` maps a path from before to after. A
 * reference that still resolves to the right file is left as the author
 * wrote it.
 */
function relinkLogicReferences(
  before: Map<string, UIFileState>,
  after: Map<string, UIFileState>,
  move: (path: string) => string
): Map<string, UIFileState> {
  const updated = new Map(after);

  // The value to write in place of `src`, or null when `src` still resolves.
  const relinked = (src: string, oldFilePath: string, newFilePath: string): string | null => {
    const target = move(resolveImportPath(oldFilePath, src));
    if (resolveImportPath(newFilePath, src) === target) return null;
    // Spelled as the author spelled it: `main.js` becomes `app.js`, not `./app.js`.
    const path = relativeImportPath(newFilePath, target);
    return src.startsWith('./') || !path.startsWith('./') ? path : path.slice(2);
  };

  for (const [id, file] of after) {
    const oldFilePath = before.get(id)?.path ?? file.path;
    const next: UIFileState = { ...file };
    let changed = false;

    if (file.logicSrc) {
      const src = relinked(file.logicSrc, oldFilePath, file.path);
      if (src !== null) {
        next.logicSrc = src;
        changed = true;
      }
    }

    // A page a file imports is found the same way and goes stale the same
    // way: by the imported page being renamed or moved, or by this one being
    // moved. Only `<logic src>` used to be followed.
    if (file.imports?.some((imp) => relinked(imp.source, oldFilePath, file.path) !== null)) {
      next.imports = file.imports.map((imp) => {
        const source = relinked(imp.source, oldFilePath, file.path);
        return source === null ? imp : { ...imp, source };
      });
      changed = true;
    }

    // Multi-file bundles keep the original text and re-emit the header from
    // it, so every tag in that copy has to be repointed too or export would
    // write the stale path back out.
    if (file.originalSource) {
      const repoint = (tag: string, head: string, quote: string, src: string) => {
        if (src.trim() === '' || ELSEWHERE.test(src.trim())) return tag;
        const replacement = relinked(src, oldFilePath, file.path);
        return replacement === null ? tag : `${head}${quote}${replacement}${quote}`;
      };
      const source = file.originalSource
        .replace(LOGIC_SRC_ATTRIBUTE, repoint)
        .replace(SCRIPT_SRC_ATTRIBUTE, repoint)
        .replace(LINK_HREF_ATTRIBUTE, repoint)
        .replace(IMPORT_FROM_ATTRIBUTE, repoint);
      if (source !== file.originalSource) {
        next.originalSource = source;
        changed = true;
      }
    }

    if (changed) updated.set(id, next);
  }

  return updated;
}

/** Why nothing new can be put at `path`: a file or folder is already there. */
function pathTakenReason(
  nodes: Map<string, ProjectFileNode>,
  path: string,
  exceptId?: string
): string | null {
  for (const node of nodes.values()) {
    if (node.id !== exceptId && node.path === path) {
      return `${path} already exists. Choose another name.`;
    }
  }
  return null;
}

/**
 * Why a logic file cannot have this path as a Python module, or null.
 *
 * A `.py` file's name is its module name — Python imports by name, not by
 * path — so the runtime refuses a name Python cannot import (`my-helpers`),
 * one the runtime itself uses (`softn`, or a standard-library module its own
 * `softn.py` imports, such as `json`), and two files with the same name in
 * different folders. The composer's refusal came at preview or export, as an
 * error about the whole app; here it comes when the name is typed.
 */
function pythonNameReason(
  logicFiles: Map<string, LogicFileState>,
  path: string,
  exceptId?: string
): string | null {
  if (!isPythonLogicPath(path)) return null;
  let module: string;
  try {
    module = pythonModuleName(path);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  for (const other of logicFiles.values()) {
    if (other.id === exceptId || !isPythonLogicPath(other.path)) continue;
    if (parsePath(other.path).name.slice(0, -'.py'.length) === module) {
      return `${other.path} is already the Python module ${module}; Python imports by module name, so each .py file needs its own name.`;
    }
  }
  return null;
}

/**
 * Why a node cannot be deleted, or null.
 *
 * The protected files are the entry file and the logic it links. Both used to
 * be protected by id — `main_ui` and `main_logic`, the ids a new project gets
 * — but an opened bundle's files get generated ids, so an opened app's entry
 * file could be deleted, and export then refused to write the app at all.
 * The entry is found the way export finds it.
 */
function deletionRefusedReason(
  nodes: Map<string, ProjectFileNode>,
  uiFiles: Map<string, UIFileState>,
  logicFiles: Map<string, LogicFileState>,
  id: string
): string | null {
  const node = nodes.get(id);
  if (!node) return null;
  const entryId = entryFileId(uiFiles, useProjectStore.getState().source);
  const entryLogic = linkedLogicFile(entryId ? uiFiles.get(entryId) : undefined, logicFiles);

  const refused = (fileId: string): string | null => {
    if (fileId === entryId) {
      return `${nodes.get(fileId)?.path ?? 'This file'} is the app's entry file; the app cannot start without it.`;
    }
    if (entryLogic && fileId === entryLogic.id) {
      return `${entryLogic.path} is the logic the entry file links (its <script src> or <logic src>). Link another logic file first.`;
    }
    return null;
  };

  if (node.type === 'file') return refused(id);

  const walk = (folderId: string): string | null => {
    for (const childId of nodes.get(folderId)?.children ?? []) {
      const child = nodes.get(childId);
      if (!child) continue;
      const reason = child.type === 'folder' ? walk(childId) : refused(childId);
      if (reason) return reason;
    }
    return null;
  };
  const reason = walk(id);
  return reason ? `The folder ${node.path} cannot be deleted: ${reason}` : null;
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

  // Folder and file actions. Each one that would put two nodes at one path,
  // give a .py file a name Python cannot import, or delete the entry file or
  // the logic it links throws an Error saying so, and changes nothing. Two
  // files at one path used to be accepted, and export kept one of them.
  createFolder: (parentPath: string, name: string) => string;
  deleteFolder: (id: string) => void;
  renameFolder: (id: string, newName: string) => void;

  createFile: (parentPath: string, name: string, type: 'ui' | 'logic') => string;
  deleteFile: (id: string) => void;
  renameFile: (id: string, newName: string) => void;
  /** Move a file into `newParentPath`, renaming it too when `newName` is given. */
  moveFile: (id: string, newParentPath: string, newName?: string) => void;
  /** Why this file or folder cannot be deleted, or null when it can. */
  deletionRefusedReason: (id: string) => string | null;
  /**
   * The pages, by path, that use this file or something in this folder: a
   * page that imports it with `<import … from>`, or links it with `<logic
   * src>`. What is left pointing at nothing when it is deleted.
   */
  usersOf: (id: string) => string[];

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
   *
   * With `imports`, the page's imports are written with its elements: what
   * the canvas holds for a page that had one dropped on it from the palette
   * (utils/pageImports.ts). `writtenImports` names those the Builder wrote,
   * which are the only ones it takes out of the page's source again.
   */
  updateUIFile: (id: string, elements: Map<string, CanvasElement>, rootId: string, imports?: UIImport[], writtenImports?: string[]) => void;
  /**
   * Set the elements the canvas was given for this file without treating
   * it as an edit — for the copy the app makes on open, so the first flush
   * compares equal to it and the file's original source is left alone.
   */
  syncUIFileElements: (id: string, elements: Map<string, CanvasElement>, rootId: string) => void;
  updateUIFileLogicSrc: (id: string, logicSrc: string | undefined) => void;
  updateUIFileSource: (id: string, source: string) => void;
  /**
   * A collection was added, renamed or removed in Data: say so in the
   * `<data>` block of each page that keeps its own source. The block stands
   * outside the template, so a page's tree is left as it is.
   */
  applyCollectionChange: (change: CollectionChange) => void;
  updateLogicFile: (id: string, content: string) => void;
  /**
   * Move a UI file's inline `<logic>` block into a logic file and link it
   * with `<logic src>`. A file that holds other logic is never overwritten:
   * the block goes to a fresh name beside it (`sparedPath` names the file
   * left alone). Throws when the file has no single inline block to move.
   */
  moveInlineLogicToFile: (uiFileId: string) => InlineLogicMove;
  markFileDirty: (id: string, dirty: boolean) => void;

  // Path resolution
  resolveImportPath: (fromPath: string, importPath: string) => string;
  getFileByPath: (path: string) => ProjectFileNode | undefined;
  getNodeByPath: (path: string) => ProjectFileNode | undefined;

  // Bulk operations
  /** A new project's files, with its logic in `language` (JavaScript unless said). */
  reset: (language?: LogicLanguage) => void;
  loadFromBundle: (
    uiFiles: Map<string, UIFileState>,
    logicFiles: Map<string, LogicFileState>,
    assetFiles?: Map<string, AssetFile>,
    /** The bundle's main page, as the manifest names it; `ui/main.ui` when not said. */
    mainFileId?: string | null
  ) => void;
}

// Initial main.ui file
const mainUIId = 'main_ui';
const mainLogicId = 'main_logic';

// Build initial file tree
function createInitialNodes(language: LogicLanguage): Map<string, ProjectFileNode> {
  const logicPath = MAIN_LOGIC_PATHS[language];
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
    name: parsePath(logicPath).name,
    path: logicPath,
    type: 'file',
    fileType: 'logic',
    parentId: 'folder_logic',
    isDirty: false,
  });

  return nodes;
}

/**
 * A new project's files: `ui/main.ui` linked to its logic, and the logic in
 * the language chosen. The link is recorded rather than implied, so the
 * Code view, the dock, the preview and export all name the same file — and
 * so a Python project, whose logic cannot be anywhere but a linked file, is
 * the same shape as a JavaScript one.
 */
function initialFiles(language: LogicLanguage) {
  const logicPath = MAIN_LOGIC_PATHS[language];
  return {
    nodes: createInitialNodes(language),
    rootFolders: ['folder_ui', 'folder_logic', 'folder_assets'],
    uiFiles: new Map([
      [mainUIId, createEmptyUIFile(mainUIId, 'ui/main.ui', relativeImportPath('ui/main.ui', logicPath))],
    ]),
    logicFiles: new Map<string, LogicFileState>([
      [
        mainLogicId,
        {
          id: mainLogicId,
          path: logicPath,
          content: logicStarter(language),
        },
      ],
    ]),
    assetFiles: new Map<string, AssetFile>(),
    activeFileId: mainUIId as string | null,
    openTabs: [mainUIId],
  };
}

export const useFilesStore = create<FilesStore>((set, get) => {
  const edit: typeof set = (...args) => {
    const before = get();
    set(...(args as Parameters<typeof set>));
    let after = get();
    if (after === before) return;
    // What each page was read as follows a text rewritten from outside it (baselinesFollowing).
    if (after.uiFiles !== before.uiFiles) {
      const uiFiles = baselinesFollowing(before.uiFiles, after.uiFiles);
      if (uiFiles !== after.uiFiles) {
        set({ uiFiles });
        after = get();
      }
    }
    // The manifest's list of pages names UI files, and follows them when
    // one is renamed, moved or deleted (utils/manifestPages.ts).
    if (after.uiFiles !== before.uiFiles) {
      const project = useProjectStore.getState();
      const manifest = pagesFollowing(project.source.manifest, before.uiFiles, after.uiFiles);
      if (manifest !== project.source.manifest) project.setSource({ ...project.source, manifest });
    }
    useProjectStore.getState().markDirty();
  };
  return ({
  ...initialFiles('javascript'),

  createFolder: (parentPath, name) => {
    const id = generateId();
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    const taken = pathTakenReason(get().nodes, fullPath);
    if (taken) throw new Error(taken);

    edit((state) => {
      const newNodes = new Map(state.nodes);

      // The folder it goes in, made if the project has not got it yet.
      const parentId = folderAt(newNodes, parentPath);

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
    const refused = get().deletionRefusedReason(id);
    if (refused) throw new Error(refused);

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
    const current = get();
    const folder = current.nodes.get(id);
    if (!folder || folder.type !== 'folder') return;
    const oldPath = folder.path;
    const { parent } = parsePath(oldPath);
    const newPath = parent ? `${parent}/${newName}` : newName;
    if (newPath === oldPath) return;
    const taken = pathTakenReason(current.nodes, newPath, id);
    if (taken) throw new Error(taken);

    // Every path under the folder, and every path a reference resolves to.
    const move = (path: string) => movedPath(path, oldPath, newPath);

    edit((state) => {
      const newNodes = new Map(state.nodes);

      // Update this folder
      newNodes.set(id, {
        ...folder,
        name: newName,
        path: newPath,
      });

      // Update all descendant paths
      const updateChildPaths = (nodeId: string) => {
        const n = newNodes.get(nodeId);
        if (!n || n.type !== 'folder' || !n.children) return;
        for (const childId of n.children) {
          const child = newNodes.get(childId);
          if (!child) continue;
          newNodes.set(childId, { ...child, path: move(child.path) });
          if (child.type === 'folder') updateChildPaths(childId);
        }
      };

      updateChildPaths(id);

      // Update file content paths
      const newUIFiles = new Map(state.uiFiles);
      const newLogicFiles = new Map(state.logicFiles);
      const newAssetFiles = new Map(state.assetFiles);

      for (const [fileId, file] of newUIFiles) {
        newUIFiles.set(fileId, { ...file, path: move(file.path) });
      }

      for (const [fileId, file] of newLogicFiles) {
        newLogicFiles.set(fileId, { ...file, path: move(file.path) });
      }

      for (const [fileId, file] of newAssetFiles) {
        newAssetFiles.set(fileId, { ...file, name: move(file.name) });
      }

      return {
        nodes: newNodes,
        // A folder holds UI files, logic files or both, so a reference can
        // have either end move, or both.
        uiFiles: relinkLogicReferences(state.uiFiles, newUIFiles, move),
        logicFiles: newLogicFiles,
        assetFiles: newAssetFiles,
      };
    });
  },

  createFile: (parentPath, name, type) => {
    const id = generateId();
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    const current = get();
    const refused =
      pathTakenReason(current.nodes, fullPath) ??
      (type === 'logic' ? pythonNameReason(current.logicFiles, fullPath) : null);
    if (refused) throw new Error(refused);

    edit((state) => {
      const newNodes = new Map(state.nodes);
      const newUIFiles = new Map(state.uiFiles);
      const newLogicFiles = new Map(state.logicFiles);

      // The folder it goes in, made if the project has not got it yet.
      const parentId = folderAt(newNodes, parentPath);

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
    const refused = get().deletionRefusedReason(id);
    if (refused) throw new Error(refused);

    edit((state) => {
      const node = state.nodes.get(id);
      if (!node || node.type !== 'file') return state;

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
    const node = get().nodes.get(id);
    if (!node || node.type !== 'file') return;
    const { parent } = parsePath(node.path);
    get().moveFile(id, parent, newName);
  },

  moveFile: (id, newParentPath, newName) => {
    const current = get();
    const node = current.nodes.get(id);
    if (!node || node.type !== 'file') return;
    const name = newName ?? node.name;
    const newPath = newParentPath ? `${newParentPath}/${name}` : name;
    if (newPath === node.path) return;
    const refused =
      pathTakenReason(current.nodes, newPath, id) ??
      (node.fileType === 'logic' ? pythonNameReason(current.logicFiles, newPath, id) : null);
    if (refused) throw new Error(refused);

    edit((state) => {
      const newNodes = new Map(state.nodes);

      // Find new parent folder
      let newParentId: string | null = null;
      for (const [nodeId, n] of newNodes) {
        if (n.type === 'folder' && n.path === newParentPath) {
          newParentId = nodeId;
          break;
        }
      }

      if (newParentId !== node.parentId) {
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
      }

      // Update node
      newNodes.set(id, {
        ...node,
        name,
        path: newPath,
        parentId: newParentId,
      });

      // Update file content path
      const newUIFiles = new Map(state.uiFiles);
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
      } else if (node.fileType === 'asset') {
        const file = newAssetFiles.get(id);
        if (file) {
          newAssetFiles.set(id, { ...file, name: newPath });
        }
      }

      return {
        nodes: newNodes,
        // Every `<logic src>` that pointed at a moved logic file has to follow
        // it, and a moved UI file's own reference is relative to where it now
        // is — or the app renders perfectly and every button is inert.
        uiFiles: relinkLogicReferences(state.uiFiles, newUIFiles, (path) => movedPath(path, node.path, newPath)),
        logicFiles: newLogicFiles,
        assetFiles: newAssetFiles,
      };
    });
  },

  deletionRefusedReason: (id) => {
    const state = get();
    return deletionRefusedReason(state.nodes, state.uiFiles, state.logicFiles, id);
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
      // The tree the file's own text is read as, where the file is still that text.
      const baseline = file.baseline && file.originalSource === file.baseline.source ? { ...file.baseline, elements, rootId } : file.baseline;
      newUIFiles.set(id, { ...file, elements, rootId, baseline });
      return { uiFiles: newUIFiles };
    });
  },

  updateUIFile: (id, elements, rootId, imports, writtenImports) => {
    // Marked once the file holds the edit (projectStore, markDirty).
    let edited = false;
    set((state) => {
      const file = state.uiFiles.get(id);
      if (!file) return state;
      const sameImports =
        imports === undefined ||
        (imports.length === file.imports.length && imports.every((imp, at) => imp.name === file.imports[at].name && imp.source === file.imports[at].source));

      // A flush of an unchanged canvas is not an edit. Every save, export,
      // pre-flight check and tab switch flushes; before this check each one
      // regenerated the file's source from the visual model, so a bundle
      // opened and never touched came out rewritten — comments dropped,
      // grouped expressions flattened, nested blocks collapsed. The original
      // bytes stay authoritative until the tree actually differs.
      if (file.rootId === rootId && sameImports && elementsEqual(file.elements, elements)) return state;

      // The canvas is what the file was read as: the file is that text
      // again, byte for byte, and not the Builder's writing of the same
      // page. This is what "undo everything" comes to, and a property typed
      // back to what it was.
      const read = file.baseline;
      if (read && read.rootId === rootId && sameImportList(imports ?? file.imports, read.imports) && elementsEqual(read.elements, elements)) {
        const restored = new Map(state.uiFiles);
        restored.set(id, {
          ...file,
          elements,
          rootId,
          imports: read.imports,
          ...(writtenImports !== undefined ? { writtenImports } : {}),
          originalSource: read.source,
          sourceFidelity: undefined,
          visualEditBlocked: undefined,
        });
        // Marked as changed like any edit; it is saved again if what it was
        // read as is what was last kept (utils/savedPoint.ts).
        const marked = new Map(state.nodes);
        const own = marked.get(id);
        if (own) marked.set(id, { ...own, isDirty: true });
        edited = true;
        return { uiFiles: restored, nodes: marked };
      }

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

        // The template is written from the canvas elements; what stands
        // before and after it in the file stays as it is (sourceFrame.ts).
        let originalDoc: SoftNDocument | null = null;
        try {
          originalDoc = parseSoftN(nextOriginalSource);
        } catch {
          originalDoc = null;
        }
        if (!originalDoc) {
          // A lossless verdict means the file parsed; this is a source that
          // changed under a cached verdict. Leave it alone and say why.
          const blockedFiles = new Map(state.uiFiles);
          blockedFiles.set(id, {
            ...file,
            sourceFidelity: undefined,
            visualEditBlocked: ['the SoftN parser could not read this file'],
          });
          return { uiFiles: blockedFiles };
        }
        const hadLogic = /<(logic|script)[\s>]/i.test(nextOriginalSource);
        nextOriginalSource = writeBack(nextOriginalSource, originalDoc, elements, rootId);
        if (!hadLogic && file.logicSrc) {
          // A logic file linked since the source was written, in the file's own line endings.
          const eol = nextOriginalSource.includes('\r\n') ? '\r\n' : '\n';
          nextOriginalSource = `<logic src="${file.logicSrc}" />${eol}${eol}${nextOriginalSource}`;
        }
        // The lines of the pages it uses: one for each the canvas gave it
        // that the header has not got, and none the Builder wrote for a use
        // that is gone.
        if (imports !== undefined) nextOriginalSource = withImportLines(nextOriginalSource, imports, writtenImports ?? file.writtenImports ?? []);
      }

      const newUIFiles = new Map(state.uiFiles);
      newUIFiles.set(id, {
        ...file,
        elements,
        rootId,
        ...(imports !== undefined ? { imports } : {}),
        ...(writtenImports !== undefined ? { writtenImports } : {}),
        ...(nextOriginalSource !== undefined ? { originalSource: nextOriginalSource } : {}),
        ...(sourceFidelity !== undefined ? { sourceFidelity } : {}),
        visualEditBlocked: undefined,
      });

      edited = true;
      return { uiFiles: newUIFiles, nodes: markedChanged(state.nodes, id) };
    });
    if (edited) useProjectStore.getState().markDirty();
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
        // What is written in Code is what the file is read as from here on.
        baseline: { source, elements: parsed.elements, rootId: parsed.rootId, imports: parsed.imports },
      });

      return { uiFiles: newUIFiles, nodes: markedChanged(state.nodes, id) };
    });
  },

  applyCollectionChange: (change) => {
    edit((state) => {
      const entry = entryFileId(state.uiFiles, useProjectStore.getState().source);
      let uiFiles: Map<string, UIFileState> | null = null;
      let nodes: Map<string, ProjectFileNode> | null = null;
      for (const [id, file] of state.uiFiles) {
        if (file.originalSource === undefined) continue;
        const next = changeDataDeclarations(file.originalSource, change, id === entry);
        if (next === file.originalSource) continue;
        uiFiles ??= new Map(state.uiFiles);
        uiFiles.set(id, { ...file, originalSource: next, sourceFidelity: undefined });
        nodes ??= new Map(state.nodes);
        const node = nodes.get(id);
        if (node) nodes.set(id, { ...node, isDirty: true });
      }
      return uiFiles && nodes ? { uiFiles, nodes } : state;
    });
  },

  updateLogicFile: (id, content) => {
    edit((state) => {
      const file = state.logicFiles.get(id);
      if (!file) return state;

      const newLogicFiles = new Map(state.logicFiles);
      newLogicFiles.set(id, { ...file, content });

      return { logicFiles: newLogicFiles, nodes: markedChanged(state.nodes, id) };
    });
  },

  moveInlineLogicToFile: (uiFileId) => {
    const state = get();
    const file = state.uiFiles.get(uiFileId);
    if (!file) throw new Error('That UI file is no longer in the project.');
    const move = planInlineLogicMove(file, state.logicFiles, {
      isEntry: entryFileId(state.uiFiles, useProjectStore.getState().source) === uiFileId,
      lossless: false,
      takenPaths: takenPaths(state.nodes, state.logicFiles),
    });
    if (!move) throw new Error(`${file.path} has no single inline <logic> block to move.`);
    edit((current) => applyInlineLogicMove(current, move, generateId));
    return move;
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

  usersOf: (id) => {
    const { nodes, uiFiles } = get();
    const node = nodes.get(id);
    if (!node) return [];
    const within = (path: string) => path === node.path || (node.type === 'folder' && path.startsWith(`${node.path}/`));
    const users: string[] = [];
    for (const file of uiFiles.values()) {
      // What is deleted with it is not left behind to miss it.
      if (within(file.path)) continue;
      const uses = [...file.imports.map((entry) => entry.source), ...(file.logicSrc ? [file.logicSrc] : [])];
      if (uses.some((source) => within(resolveImportPath(file.path, source)))) users.push(file.path);
    }
    return users.sort();
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

  reset: (language = 'javascript') => {
    set(initialFiles(language));
  },

  loadFromBundle: (uiFiles, logicFiles, assetFiles = new Map(), entryId = null) => {
    // Build node tree from loaded files
    const nodes = new Map<string, ProjectFileNode>();
    const rootFolders: string[] = [];

    // Helper to ensure folder exists. Each folder is found by its path in a
    // map of its own and has an id no other node has: `a/b` and `a_b` were
    // given one id, and the second took the first's place in the Files tree,
    // which no longer had the first. The look-up was a search of every node,
    // for each file.
    const folderIds = new Map<string, string>();
    const ensureFolder = (path: string): string => {
      const existingId = folderIds.get(path);
      if (existingId !== undefined) return existingId;

      const { parent, name } = parsePath(path);
      let parentId: string | null = null;

      if (parent) {
        parentId = ensureFolder(parent);
      }

      let id = `folder_${path.replace(/\//g, '_')}`;
      while (nodes.has(id)) id = `${id}_`;
      folderIds.set(path, id);
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
        bundlePath: assetPath,
        name: assetPath,
        type: asset.type,
        data: asset.data,
      });
    }

    // The main page is open: the one the manifest names (`index.html` in a
    // project written as HTML), or `ui/main.ui`. Looking for that path alone
    // left an HTML project open on its page with no file active.
    let mainFileId: string | null = entryId && uiFiles.has(entryId) ? entryId : null;
    for (const [id, file] of uiFiles) {
      if (mainFileId) break;
      if (file.path === 'ui/main.ui') mainFileId = id;
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
      // Each page is read as the text its bundle has for it.
      uiFiles: new Map([...uiFiles].map(([id, file]) => [id, { ...file, baseline: baselineOf(file) }])),
      logicFiles: new Map(logicFiles),
      assetFiles: loadedAssets,
      activeFileId: mainFileId,
      openTabs: mainFileId ? [mainFileId] : [],
    });
  },
});
});
