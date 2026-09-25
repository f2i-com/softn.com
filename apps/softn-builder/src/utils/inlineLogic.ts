/**
 * Moving a UI file's inline `<logic>` block into a logic file of its own.
 *
 * Before the Code view generated `<logic src>`, it showed a new file's source
 * with the project's logic inlined, and the first keystroke there saved that
 * copy as the file's source. Sessions saved then still hold it: `ui/main.ui`
 * carries a `<logic>…</logic>` block and links no file, so the dock says there
 * is no logic to edit, while the preview and export go on running the block.
 *
 * The runtime is happy with inline logic, and an authored bundle may use it
 * on purpose, so nothing here runs on a bundle by itself. A restored session
 * is migrated only when the move loses nothing (see {@link planInlineLogicMove}
 * with `lossless`); anything else is left as it is, and the dock offers the
 * move as a button that never overwrites a file someone wrote.
 */

import type { LogicFileState, ProjectFileNode, UIFileState } from '../types/builder';
import { isPythonLogicPath } from '@softn/core';
import {
  MAIN_LOGIC_PATHS,
  blankLogicFile,
  logicStarter,
  relativeImportPath,
  resolveImportPath,
  type LogicLanguage,
} from './logicFiles';

/**
 * Every `<logic>` tag, self-closing or with a body — the composer's own
 * pattern, so what counts as a block here is what the runtime runs.
 */
const LOGIC_TAG = /<logic\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/logic\s*>)/gi;

export interface InlineLogicBlock {
  /** The whole tag, as it appears in the source. */
  tag: string;
  /** The code between the tags, exactly. */
  code: string;
  language: LogicLanguage;
}

/**
 * The one inline `<logic>` block a UI file's source holds, or null.
 *
 * Null too when the file also links a file with `<logic src>`, or holds more
 * than one block: the runtime would run each of them, and which of them a
 * single file should get is not something to guess.
 */
export function inlineLogicOf(source: string | undefined): InlineLogicBlock | null {
  if (!source) return null;
  const blocks: InlineLogicBlock[] = [];
  for (const match of source.matchAll(LOGIC_TAG)) {
    const attributes = match[1] ?? '';
    if (/\bsrc\s*=/i.test(attributes)) return null;
    if (match[2] === undefined) continue;
    const lang = attributes.match(/\blang(?:uage)?\s*=\s*(["'])([^"']*)\1/i)?.[2];
    blocks.push({
      tag: match[0],
      code: match[2],
      language: lang && lang.trim().toLowerCase() === 'python' ? 'python' : 'javascript',
    });
  }
  return blocks.length === 1 && blocks[0].code.trim() !== '' ? blocks[0] : null;
}

/**
 * Python's indentation is the program, and markup indentation is whatever
 * the editor left: the common leading whitespace goes, as `textwrap.dedent`
 * would take it, so a block indented under its tag is valid as a file.
 */
function dedent(code: string): string {
  const lines = code.replace(/^\s*\n/, '').replace(/\s+$/, '').split(/\r?\n/);
  const indents = lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)![0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(Math.min(common, /^[ \t]*/.exec(line)![0].length))).join('\n');
}

/** The SoftN `import "./x.logic"` line, as the composer reads it. */
const IMPORT_LINE = /^([ \t]*import[ \t]+)(["'])([^"'\r\n]+)\2/gm;

/**
 * JavaScript inline logic resolves `import "./x.logic"` against the UI file;
 * the same line in a logic file resolves against that file. Each relative
 * import is rewritten to name the same file from its new home.
 */
function rehomeImports(code: string, fromPath: string, toPath: string): string {
  return code.replace(IMPORT_LINE, (line, head: string, quote: string, path: string) => {
    if (!path.startsWith('./') && !path.startsWith('../')) return line;
    return `${head}${quote}${relativeImportPath(toPath, resolveImportPath(fromPath, path))}${quote}`;
  });
}

/** The file content a moved block becomes, trimmed and ending in one newline. */
function fileContentFor(block: InlineLogicBlock, uiPath: string, logicPath: string): string {
  const code =
    block.language === 'python' ? dedent(block.code) : rehomeImports(block.code.replace(/^\s*\n/, '').replace(/\s+$/, ''), uiPath, logicPath);
  return `${code}\n`;
}

function stripSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function logicFileAt(logicFiles: ReadonlyMap<string, LogicFileState>, path: string): LogicFileState | undefined {
  for (const file of logicFiles.values()) if (stripSlash(file.path) === path) return file;
  return undefined;
}

/**
 * Whether a file holds only what the Builder wrote into it — the starter a
 * new project gets, or the header a new file gets — so replacing it with the
 * block loses nothing anyone typed.
 */
function isGenerated(file: LogicFileState, language: LogicLanguage): boolean {
  const content = file.content.trim();
  return content === '' || content === logicStarter(language).trim() || content === blankLogicFile(file.path).trim();
}

/** The name a UI file's own logic file takes: the entry's is `main`. */
function preferredLogicPath(uiPath: string, language: LogicLanguage, isEntry: boolean): string {
  if (isEntry) return MAIN_LOGIC_PATHS[language];
  const stem = (uiPath.split('/').pop() ?? 'page').replace(/\.[^.]*$/, '');
  // A Python file's name is its module name, so it has to be an identifier;
  // the same spelling is used for JavaScript so the two read alike.
  const name = stem.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=\d)/, '_') || 'page';
  return `logic/${name}${language === 'python' ? '.py' : '.logic'}`;
}

export interface InlineLogicMove {
  uiFileId: string;
  /** Where the logic goes, and the file already there when there is one. */
  logicPath: string;
  existingLogicId?: string;
  /** What that file will hold. */
  content: string;
  /** The UI file's source with the block replaced by the `<logic src>`. */
  source: string;
  logicSrc: string;
  /** A file that was left alone because it held other logic, when one was. */
  sparedPath?: string;
}

export interface PlanOptions {
  /** Whether the UI file is the app's entry, whose logic is `logic/main.*`. */
  isEntry: boolean;
  /**
   * Refuse (return null) rather than go anywhere but the natural file. The
   * dock's button, run by hand, instead writes to a fresh name beside a file
   * that holds other logic.
   */
  lossless: boolean;
  /** Every path already taken by a file or folder. */
  takenPaths: ReadonlySet<string>;
}

/**
 * Where a UI file's inline block would go, and what each file would hold.
 *
 * The block goes into a logic file that already holds exactly its code, else
 * into its natural file (`logic/main.logic`, `main.py` for a Python block, or
 * one named for a page) when that file is missing or holds only what the
 * Builder generated. Anywhere else is a choice: `lossless` says there is
 * none to make, and the button picks a fresh name so both versions survive.
 */
export function planInlineLogicMove(
  uiFile: UIFileState,
  logicFiles: ReadonlyMap<string, LogicFileState>,
  options: PlanOptions
): InlineLogicMove | null {
  const block = inlineLogicOf(uiFile.originalSource);
  if (!block || uiFile.originalSource === undefined) return null;
  const uiPath = stripSlash(uiFile.path);
  const ext = block.language === 'python' ? '.py' : '.logic';

  const moveTo = (logicPath: string, existing?: LogicFileState, sparedPath?: string): InlineLogicMove => {
    const logicSrc = relativeImportPath(uiPath, logicPath);
    return {
      uiFileId: uiFile.id,
      logicPath,
      existingLogicId: existing?.id,
      content: existing && existing.content.trim() === fileContentFor(block, uiPath, logicPath).trim()
        ? existing.content
        : fileContentFor(block, uiPath, logicPath),
      source: uiFile.originalSource!.replace(block.tag, () => `<logic src="${logicSrc}" />`),
      logicSrc,
      ...(sparedPath ? { sparedPath } : {}),
    };
  };

  // A file already holding this very code: link it, and nothing is written.
  for (const file of logicFiles.values()) {
    const path = stripSlash(file.path);
    if (isPythonLogicPath(path) !== (block.language === 'python')) continue;
    if (file.content.trim() === fileContentFor(block, uiPath, path).trim()) return moveTo(path, file);
  }

  const natural = preferredLogicPath(uiPath, block.language, options.isEntry);
  const existing = logicFileAt(logicFiles, natural);
  if (existing && isGenerated(existing, block.language)) return moveTo(natural, existing);
  // The block is the Builder's own starter, copied in by the old Code view,
  // and the file beside it is where the dock kept writing the real work: the
  // most common old session of all. The file is linked as it is and the
  // copy dropped. Moving the copy out instead would have linked a starter
  // and left the author's logic unlinked.
  if (existing && block.code.trim() === logicStarter(block.language).trim()) {
    return { ...moveTo(natural, existing), content: existing.content };
  }
  if (!existing && !options.takenPaths.has(natural) && !pythonNameTaken(natural, logicFiles)) return moveTo(natural);
  if (options.lossless) return null;

  const base = natural.slice(0, -ext.length);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${base}_inline${n === 1 ? '' : `_${n}`}${ext}`;
    if (!options.takenPaths.has(candidate) && !logicFileAt(logicFiles, candidate) && !pythonNameTaken(candidate, logicFiles)) {
      return moveTo(candidate, undefined, existing ? natural : undefined);
    }
  }
  return null;
}

/** Python imports by module name, so a second `main.py` anywhere is a clash. */
function pythonNameTaken(path: string, logicFiles: ReadonlyMap<string, LogicFileState>): boolean {
  if (!isPythonLogicPath(path)) return false;
  const name = path.split('/').pop();
  return [...logicFiles.values()].some((file) => stripSlash(file.path).split('/').pop() === name);
}

export interface FileTables {
  nodes: Map<string, ProjectFileNode>;
  rootFolders: string[];
  uiFiles: Map<string, UIFileState>;
  logicFiles: Map<string, LogicFileState>;
}

/**
 * The file tables with a planned move applied: the logic file written (and
 * its folders and node made when it is new), the UI file's block replaced by
 * the link. The UI file's elements do not change — the block is not part of
 * the tree — and its fidelity is dropped because its source is new.
 */
export function applyInlineLogicMove(
  tables: FileTables,
  move: InlineLogicMove,
  newId: () => string,
  /** Whether the files it touches show as edited: a move made on restore is not an edit. */
  markDirty = true
): FileTables {
  const nodes = new Map(tables.nodes);
  const rootFolders = [...tables.rootFolders];
  const uiFiles = new Map(tables.uiFiles);
  const logicFiles = new Map(tables.logicFiles);

  const folderAt = (path: string): string | null => {
    if (!path) return null;
    for (const node of nodes.values()) if (node.type === 'folder' && node.path === path) return node.id;
    const slash = path.lastIndexOf('/');
    const parentId = folderAt(slash === -1 ? '' : path.slice(0, slash));
    let id = `folder_${path.replace(/\//g, '_')}`;
    while (nodes.has(id)) id = `${id}_`;
    nodes.set(id, { id, name: path.slice(slash + 1), path, type: 'folder', parentId, children: [] });
    if (parentId) {
      const parent = nodes.get(parentId)!;
      nodes.set(parentId, { ...parent, children: [...(parent.children ?? []), id] });
    } else {
      rootFolders.push(id);
    }
    return id;
  };

  let logicId = move.existingLogicId;
  if (logicId) {
    const file = logicFiles.get(logicId)!;
    if (file.content !== move.content) {
      logicFiles.set(logicId, { ...file, content: move.content });
      const node = nodes.get(logicId);
      if (node && markDirty) nodes.set(logicId, { ...node, isDirty: true });
    }
  } else {
    logicId = newId();
    const slash = move.logicPath.lastIndexOf('/');
    const parentId = folderAt(slash === -1 ? '' : move.logicPath.slice(0, slash));
    nodes.set(logicId, {
      id: logicId,
      name: move.logicPath.slice(slash + 1),
      path: move.logicPath,
      type: 'file',
      fileType: 'logic',
      parentId,
      isDirty: markDirty,
    });
    if (parentId) {
      const parent = nodes.get(parentId)!;
      nodes.set(parentId, { ...parent, children: [...(parent.children ?? []), logicId] });
    }
    logicFiles.set(logicId, { id: logicId, path: move.logicPath, content: move.content });
  }

  const uiFile = uiFiles.get(move.uiFileId)!;
  uiFiles.set(move.uiFileId, {
    ...uiFile,
    originalSource: move.source,
    logicSrc: move.logicSrc,
    sourceFidelity: undefined,
    visualEditBlocked: undefined,
  });
  const uiNode = nodes.get(move.uiFileId);
  if (uiNode && markDirty) nodes.set(move.uiFileId, { ...uiNode, isDirty: true });

  return { nodes, rootFolders, uiFiles, logicFiles };
}

/** Every path a file or folder holds, for choosing a name that is free. */
export function takenPaths(nodes: ReadonlyMap<string, ProjectFileNode>, logicFiles: ReadonlyMap<string, LogicFileState>): Set<string> {
  const taken = new Set<string>();
  for (const node of nodes.values()) taken.add(node.path);
  for (const file of logicFiles.values()) taken.add(stripSlash(file.path));
  return taken;
}

/**
 * The UI file whose inline block the dock offers to move, when the dock has
 * no linked file to edit: the active UI file's own block, else — for a file
 * that links nothing and so runs inside the entry's logic — the entry's.
 */
export function dockInlineLogicHolder(
  activeUIFileId: string | null,
  uiFiles: ReadonlyMap<string, UIFileState>,
  entryId: string | null
): UIFileState | undefined {
  const active = activeUIFileId ? uiFiles.get(activeUIFileId) : undefined;
  if (active && inlineLogicOf(active.originalSource)) return active;
  if (active?.logicSrc) return undefined;
  const entry = entryId ? uiFiles.get(entryId) : undefined;
  return entry && inlineLogicOf(entry.originalSource) ? entry : undefined;
}
