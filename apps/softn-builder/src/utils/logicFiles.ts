/**
 * Which logic file a UI file runs, and what a new logic file starts with.
 *
 * The runtime links logic to markup in exactly one way: a `<logic src>` in the
 * UI file, resolved against that file's own path. Everything in the Builder
 * that shows, edits, previews or exports "the logic" used to answer the
 * question for itself — the Code view inlined a copy of the project's logic,
 * the dock looked for `logic/main.logic` by name, the preview fell back to a
 * project field no export reads — and each answer was wrong for some app,
 * always silently, and always for every Python app. They all ask here now.
 *
 * The language is the file name's, as it is for the runtime: a logic file
 * ending `.py` is Python and everything else is JavaScript.
 */

import type { LogicFileState, UIFileState } from '../types/builder';
import type { RetainedSource } from '../stores/projectStore';
import { editorLanguageFor } from '../components/editor/logicLanguage';

export type LogicLanguage = 'javascript' | 'python';

/** Where a new project keeps its logic, by language. */
export const MAIN_LOGIC_PATHS: Record<LogicLanguage, string> = {
  javascript: 'logic/main.logic',
  python: 'logic/main.py',
};

/** The language a logic file is written in, from its name alone. */
export function logicLanguageOf(path: string): LogicLanguage {
  return editorLanguageFor(path);
}

/**
 * The logic a new project starts with: a counter, so the first preview has
 * state and functions to bind to. The Python one is shaped by the contract in
 * docs/engineering/ZIPP_LANGUAGES.md — every top-level name is state, every
 * top-level `def` is callable, and a function that assigns to state has to
 * say `global` or Python makes a local instead. It avoids augmented
 * assignment and anything else ZIPP's Python subset has not been shown to
 * run, because a starter that fails is the first thing a new author sees.
 */
export function logicStarter(language: LogicLanguage): string {
  if (language === 'python') {
    return `# SoftN logic - Python, run in the ZIPP engine
# Every top-level name is state the markup can read, and every top-level
# function is one it can call. A function that changes state names it with
# \`global\` first, or Python makes a new local of the same name instead.

count = 0


def increment():
    global count
    count = count + 1


def decrement():
    global count
    count = count - 1
`;
  }
  return `// SoftN logic — JavaScript, run in a sandboxed VM
// Define your state, computed values, and functions

let count = 0

function increment() {
  count++
}

function decrement() {
  count--
}
`;
}

/**
 * What a logic file made in the navigator starts with: a comment naming it,
 * in its own language. A `//` header written into a `.py` file is a
 * SyntaxError on its first line, and it is the app's, not the author's.
 */
export function blankLogicFile(path: string): string {
  const name = path.split('/').pop() ?? path;
  return logicLanguageOf(path) === 'python'
    ? `# ${name}\n# SoftN logic - Python, run in the ZIPP engine\n\n`
    : `// ${name}\n// SoftN logic — JavaScript, run in a sandboxed VM\n\n`;
}

function stripSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function parentOf(path: string): string[] {
  const parts = path.split('/');
  parts.pop();
  return parts.filter(Boolean);
}

/** Resolve `importPath` as written in the file at `fromPath`. */
export function resolveImportPath(fromPath: string, importPath: string): string {
  if (importPath.startsWith('@')) {
    // Package import, return as-is
    return importPath;
  }

  const parts = parentOf(fromPath);
  for (const part of importPath.split('/')) {
    if (part === '..') {
      parts.pop();
    } else if (part !== '.' && part !== '') {
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
export function relativeImportPath(fromPath: string, targetPath: string): string {
  const fromParts = parentOf(fromPath);
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

function logicFileAt(logicFiles: ReadonlyMap<string, LogicFileState>, path: string): LogicFileState | undefined {
  for (const file of logicFiles.values()) {
    if (stripSlash(file.path) === path) return file;
  }
  return undefined;
}

/**
 * The `<logic src>` value a UI file's source carries, as written.
 *
 * A file the Builder generates (no source of its own yet) and that has no
 * reference recorded is still linked to `logic/main.logic` when it is
 * `ui/main.ui` and that file exists: sessions saved before new projects
 * recorded the reference relied on the pairing, and export has always
 * written it for them. A file with source of its own means what its source
 * says, and nothing else.
 */
export function logicSrcOf(
  file: Pick<UIFileState, 'path' | 'logicSrc' | 'originalSource'>,
  logicFiles: ReadonlyMap<string, LogicFileState>
): string | undefined {
  if (file.logicSrc) return file.logicSrc;
  if (
    file.originalSource === undefined &&
    stripSlash(file.path) === 'ui/main.ui' &&
    logicFileAt(logicFiles, MAIN_LOGIC_PATHS.javascript)
  ) {
    return '../logic/main.logic';
  }
  return undefined;
}

/** The logic file a UI file links, if it links one that exists. */
export function linkedLogicFile(
  file: Pick<UIFileState, 'path' | 'logicSrc' | 'originalSource'> | undefined,
  logicFiles: ReadonlyMap<string, LogicFileState>
): LogicFileState | undefined {
  if (!file) return undefined;
  const src = logicSrcOf(file, logicFiles);
  if (!src) return undefined;
  return logicFileAt(logicFiles, resolveImportPath(stripSlash(file.path), src));
}

/**
 * The files-store id of the project's entry file: the declared entry followed
 * by id, then by the manifest's path, then `ui/main.ui`, then the only UI file
 * there is. The same rule export uses to write `main`, so what is protected
 * from deletion is what export will need.
 */
export function entryFileId(
  uiFiles: ReadonlyMap<string, UIFileState>,
  source: Pick<RetainedSource, 'mainFileId' | 'manifest'>
): string | null {
  if (source.mainFileId && uiFiles.has(source.mainFileId)) return source.mainFileId;
  const byPath = (path: string) => {
    for (const [id, file] of uiFiles) if (stripSlash(file.path) === path) return id;
    return null;
  };
  const declared = source.manifest && typeof source.manifest.main === 'string' ? stripSlash(source.manifest.main) : null;
  if (declared) return byPath(declared);
  return byPath('ui/main.ui') ?? (uiFiles.size === 1 ? [...uiFiles.keys()][0] : null);
}

/**
 * The logic file the dock beneath the canvas edits: the one the active UI
 * file links, else the one the entry file links. A component file usually
 * has no logic of its own and runs inside the entry's.
 */
export function dockLogicFile(
  activeUIFileId: string | null,
  uiFiles: ReadonlyMap<string, UIFileState>,
  logicFiles: ReadonlyMap<string, LogicFileState>,
  entryId: string | null
): LogicFileState | undefined {
  const active = activeUIFileId ? uiFiles.get(activeUIFileId) : undefined;
  if (active && logicSrcOf(active, logicFiles)) return linkedLogicFile(active, logicFiles);
  return linkedLogicFile(entryId ? uiFiles.get(entryId) : undefined, logicFiles);
}
