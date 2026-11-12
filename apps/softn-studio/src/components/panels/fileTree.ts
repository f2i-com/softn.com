/**
 * The Files panel's tree, apart from how it is drawn: the rows that are shown,
 * in order, and what the panel remembers about a project's folders.
 *
 * A project's files are a flat list of paths; a folder is whatever paths share
 * a start. Two things follow. A folder with nothing in it is in no file, so
 * the one a person has just made lives here until something is put in it. And
 * which folders are open is nobody's business but the panel's: it was kept in
 * the component, so every folder a person closed was open again each time the
 * panel was, and it is remembered now, by project, in this browser.
 */

import { isPrivatePath } from '../../lib/paths';
import { movedPath, type FileMove } from '../../lib/fileRefs';

export interface TreeRow {
  path: string;
  name: string;
  isDir: boolean;
  /** 0 at the top of the project. */
  depth: number;
  /** The folder it is in: '' at the top. */
  parent: string;
  /** A folder that is showing what is in it. */
  open: boolean;
  /** How many files a folder holds, at any depth. */
  count: number;
  /** Where it is among the rows of its folder, from 1, and how many they are: for a screen reader. */
  position: number;
  setSize: number;
  /** Studio's own: the builder/ folder and what is in it. */
  isPrivate: boolean;
}

interface Node {
  name: string;
  path: string;
  isDir: boolean;
  children: Map<string, Node>;
  count: number;
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The rows the tree shows: folders before files, each by name with numbers in
 * their order (page-2 before page-10), and Studio's own folder last, since it
 * is not the app's. What is inside a closed folder is not a row.
 */
export function buildRows(paths: Iterable<string>, emptyFolders: Iterable<string>, isOpen: (path: string, depth: number) => boolean): TreeRow[] {
  const root: Node = { name: '', path: '', isDir: true, children: new Map(), count: 0 };
  const place = (path: string, asFolder: boolean) => {
    const parts = path.split('/');
    let at = root;
    let walked = '';
    parts.forEach((part, index) => {
      walked = walked ? `${walked}/${part}` : part;
      const last = index === parts.length - 1;
      const isDir = !last || asFolder;
      // A file and a folder of one name are two rows: the export says which has to go.
      const key = `${isDir ? 'd' : 'f'}:${part}`;
      let next = at.children.get(key);
      if (!next) {
        next = { name: part, path: walked, isDir, children: new Map(), count: 0 };
        at.children.set(key, next);
      }
      if (!asFolder && !last) next.count += 1;
      at = next;
    });
  };
  for (const path of paths) place(path, false);
  for (const folder of emptyFolders) place(folder, true);

  const rows: TreeRow[] = [];
  const walk = (node: Node, depth: number) => {
    const children = [...node.children.values()].sort((a, b) => {
      const aPrivate = depth === 0 && a.isDir && isPrivatePath(`${a.path}/`);
      const bPrivate = depth === 0 && b.isDir && isPrivatePath(`${b.path}/`);
      if (aPrivate !== bPrivate) return aPrivate ? 1 : -1;
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return byName.compare(a.name, b.name);
    });
    children.forEach((child, index) => {
      const open = child.isDir && isOpen(child.path, depth);
      rows.push({
        path: child.path,
        name: child.name,
        isDir: child.isDir,
        depth,
        parent: node.path,
        open,
        count: child.count,
        position: index + 1,
        setSize: children.length,
        isPrivate: isPrivatePath(`${child.path}/`),
      });
      if (open) walk(child, depth + 1);
    });
  };
  walk(root, 0);
  return rows;
}

/** What the panel remembers of a project's folders. */
export interface TreeMemory {
  /** Folders opened by hand, or to show a file. */
  open: string[];
  /** Folders at the top of the project that were closed by hand: they start open. */
  closed: string[];
  /** Folders the person made that have nothing in them yet. */
  empty: string[];
}

export const NO_MEMORY: TreeMemory = { open: [], closed: [], empty: [] };

/**
 * Whether a folder shows what is in it: one that was opened, and at the top
 * of the project every folder that was not closed. Studio's own notes start
 * closed, since they are not what a person comes to the panel for.
 */
export function folderIsOpen(memory: TreeMemory, path: string, depth: number): boolean {
  if (memory.open.includes(path)) return true;
  return depth === 0 && !memory.closed.includes(path) && !isPrivatePath(`${path}/`);
}

/** `memory` with `path` open or closed. */
export function withFolder(memory: TreeMemory, path: string, open: boolean): TreeMemory {
  return {
    ...memory,
    open: open ? [...new Set([...memory.open, path])] : memory.open.filter((other) => other !== path),
    closed: open ? memory.closed.filter((other) => other !== path) : [...new Set([...memory.closed, path])],
  };
}

/** `memory` with every folder `path` is in open, so its row is shown. The same memory when they all are. */
export function withRevealed(memory: TreeMemory, path: string): TreeMemory {
  const parts = path.split('/').slice(0, -1);
  let next = memory;
  parts.forEach((_, index) => {
    const folder = parts.slice(0, index + 1).join('/');
    if (!folderIsOpen(next, folder, index)) next = withFolder(next, folder, true);
  });
  return next;
}

/** `memory` after a file or folder moved: what it remembers by path follows. */
export function withMoved(memory: TreeMemory, move: FileMove): TreeMemory {
  const follow = (paths: string[]) => [...new Set(paths.map((path) => movedPath(path, { ...move, folder: true })))];
  return { open: follow(memory.open), closed: follow(memory.closed), empty: follow(memory.empty) };
}

/** `memory` without the folder at `path` or anything remembered inside it. */
export function withoutFolder(memory: TreeMemory, path: string): TreeMemory {
  const outside = (other: string) => other !== path && !other.startsWith(`${path}/`);
  return { open: memory.open.filter(outside), closed: memory.closed.filter(outside), empty: memory.empty.filter(outside) };
}

/**
 * The folders of `empty` that still have nothing in them. One that a file was
 * put in is a folder like any other, and is no longer remembered as empty.
 */
export function stillEmpty(empty: readonly string[], paths: Iterable<string>): string[] {
  if (empty.length === 0) return [];
  const all = [...paths];
  return empty.filter((folder) => !all.some((path) => path.startsWith(`${folder}/`)));
}

const STORAGE_KEY = 'softn.studio.files-panel';
/** As many projects as the home page lists. */
const REMEMBERED_PROJECTS = 12;

type Stored = Record<string, TreeMemory & { at: number }>;

/** What is remembered in this tab, whether or not the browser lets anything be kept. */
const inThisTab = new Map<string, TreeMemory>();

function readStored(): Stored {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/** What was remembered for a project: in this tab first, then what this browser kept. */
export function loadTreeMemory(projectId: string | null): TreeMemory {
  const key = projectId ?? '';
  const here = inThisTab.get(key);
  if (here) return here;
  const kept = projectId ? readStored()[projectId] : undefined;
  return kept ? { open: strings(kept.open), closed: strings(kept.closed), empty: strings(kept.empty) } : NO_MEMORY;
}

/** Keep what is remembered for a project. Best effort: a browser that keeps nothing still has this tab. */
export function saveTreeMemory(projectId: string | null, memory: TreeMemory): void {
  inThisTab.set(projectId ?? '', memory);
  if (!projectId) return;
  try {
    // This project, and the most recent of the others: never dropped for being saved in the
    // same moment as twelve more.
    const others = Object.entries(readStored())
      .filter(([id]) => id !== projectId)
      .sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, REMEMBERED_PROJECTS - 1);
    const kept: Stored = Object.fromEntries(others);
    kept[projectId] = { ...memory, at: Date.now() };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Kept for this tab only.
  }
}

/** The file whose folders the panel last opened to show it, by project. */
const lastRevealed = new Map<string, string>();

/**
 * Whether `path` is the file the panel last opened folders for in this
 * project; it is from now on. A folder closed by hand stays closed until
 * another file is shown: opening the panel again is not another file.
 */
export function alreadyRevealed(projectId: string | null, path: string): boolean {
  const key = projectId ?? '';
  if (lastRevealed.get(key) === path) return true;
  lastRevealed.set(key, path);
  return false;
}

/** Forget what this tab remembers: for a test that starts from nothing. */
export function forgetTreeMemory(): void {
  inThisTab.clear();
  lastRevealed.clear();
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing was kept.
  }
}
