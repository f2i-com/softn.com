/**
 * What a person does to the project's files from the Files panel: make one,
 * bring some in from the computer, rename, move, copy, delete.
 *
 * The panel listed the files and opened them; anything else was a request to
 * the AI and a run to wait for. Each action here is one write by the person:
 * one transaction in the file store, so it is one unit in the History panel
 * under a name in plain words ("Renamed logo.png to brand.png"), undone and
 * redone whole, saved by the autosave that follows the store, and in front of
 * the AI at its next run like any other change.
 *
 * What every action holds to:
 *
 *   - nothing is written while a run is working. The AI may be reading or
 *     writing the same files, and a file changing under it is the one thing
 *     neither side can see (lib/handEdit.ts keeps the same rule for a save);
 *   - nothing is written over. A name that is taken is numbered, and the name
 *     the file ended up with is said;
 *   - an app stays one its readers open: the limits in lib/fileRules.ts;
 *   - Studio's own notes (builder/) and, in a hosted editor, migrations that
 *     have run on the app's database are not changed from here;
 *   - a file that pages name is followed by them when it is renamed or moved
 *     (lib/fileRefs.ts), in the same unit, and what could not be followed is
 *     said.
 *
 * An action answers with what was done, in words for the panel to show, or
 * with why it was not, and in that case nothing was changed.
 */

import { appliedMigrationPaths } from './agent/appliedMigrations';
import { bundleSummary } from './exportBundle';
import { followMove, movedPath, namersOf, type FileMove } from './fileRefs';
import {
  ASSETS_FOLDER,
  appLimitReason,
  belongsAtTheTop,
  cleanFileName,
  emptyFileProblem,
  folderOf,
  freeName,
  joinPath,
  keptContent,
  nameOf,
  newPathProblem,
  starterContent,
  takenKeys,
  tooLargeReason,
  typedName,
} from './fileRules';
import { runIsWorking } from './handEdit';
import { canonicalKey, isPrivatePath } from './paths';
import { getBundleEntryPath } from './studioProject';
import { hasUnsavedDraft, useEditStore } from '../stores/editStore';
import { useVFSStore, type VFSChangeRecord } from '../stores/vfsStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import type { VFSFile } from '../types/studio';

export interface FileOpDone {
  ok: true;
  /** What was done, as the History panel names it. */
  label: string;
  /** The sentence the panel shows. */
  said: string;
  /** The unit in the history, for the panel's Undo; null when no file changed. */
  transactionId: string | null;
  /** The row to show and put the focus on afterwards. */
  focus: string | null;
  /** What else the person should know: a name that was changed, a file that still names the old path. */
  notes: string[];
  /** Whether a note is a caution, not just news. */
  caution: boolean;
  /** The move that was made, for what the panel remembers by path (open folders, the cursor). */
  move?: FileMove;
  /** For a copy: what was copied, and where the copy is. */
  copied?: FileMove;
}

export interface FileOpRefused {
  ok: false;
  reason: string;
}

export type FileOpResult = FileOpDone | FileOpRefused;

const refused = (reason: string): FileOpRefused => ({ ok: false, reason });

/** Why nothing is changed by hand just now, or null when it may be. */
export function busyReason(): string | null {
  return runIsWorking() ? 'The AI is working, and may be reading or writing these files. Changes wait until the run stops.' : null;
}

export const PRIVATE_REASON = 'builder/ is where Studio keeps its own notes on the project. They stay with it, are not exported, and are not changed from here.';

/** The files a row stands for: the file, or every file in the folder. */
export function filesUnder(files: ReadonlyMap<string, unknown>, path: string, isDir: boolean): string[] {
  if (!isDir) return files.has(path) ? [path] : [];
  const inside = `${path}/`;
  return [...files.keys()].filter((other) => other.startsWith(inside));
}

/** Whether a row is one of Studio's own: the builder/ folder or anything in it. */
export function isPrivateEntry(path: string): boolean {
  return isPrivatePath(`${path}/`);
}

/** Why these files may not be renamed, moved or deleted, or null. */
function lockedReason(paths: readonly string[], verb: 'renamed' | 'moved' | 'deleted'): string | null {
  if (paths.some((path) => isPrivatePath(path))) return PRIVATE_REASON;
  const applied = new Set(appliedMigrationPaths());
  const ran = paths.find((path) => applied.has(path));
  if (ran) return `${ran} has already run on this app’s database on its host, so it cannot be ${verb}: the host refuses to start when a migration it ran is changed or missing. Put the change in a new migration.`;
  return null;
}

/** Why a file being edited by hand stops this, or null. A draft with nothing unsaved is closed by the caller. */
function draftReason(paths: readonly string[]): string | null {
  const draft = useEditStore.getState().draft;
  if (!draft || !paths.includes(draft.path) || !hasUnsavedDraft()) return null;
  return `${draft.path} is open in the editor with changes you have not saved. Save or discard them first.`;
}

function closeDraftOn(paths: readonly string[]): void {
  const draft = useEditStore.getState().draft;
  if (draft && paths.includes(draft.path)) useEditStore.getState().close();
}

const sizeOf = (file: VFSFile): number => (typeof file.content === 'string' ? new TextEncoder().encode(file.content).byteLength : file.content.byteLength);

/** A folder as it is said in a sentence. */
const folderWords = (folder: string) => (folder === '' ? 'the top of the project' : folder);

/** One name, two, or "a, b and 3 more". */
function listed(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * A folder as the project already spells it. `assets/Icons` beside
 * `assets/icons` would be two folders in the tree and one on a disk that folds
 * case, so a folder that is there under another spelling is the one used.
 */
export function folderAsSpelled(paths: Iterable<string>, emptyFolders: Iterable<string>, folder: string): string {
  if (folder === '') return '';
  const spelled = new Map<string, string>();
  const note = (path: string) => {
    for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
      const prefix = path.slice(0, at);
      if (!spelled.has(canonicalKey(prefix))) spelled.set(canonicalKey(prefix), prefix);
    }
  };
  for (const path of paths) note(path);
  for (const empty of emptyFolders) note(`${empty}/`);
  const parts = folder.split('/');
  let out = '';
  for (const part of parts) {
    const wanted = out ? `${out}/${part}` : part;
    out = spelled.get(canonicalKey(wanted)) ?? wanted;
  }
  return out;
}

/** Where a picture or other media file goes when no folder was pointed at: the project's assets folder, as it spells it. */
function assetsFolder(files: ReadonlyMap<string, unknown>): string {
  return folderAsSpelled(files.keys(), [], ASSETS_FOLDER);
}

/** Write one unit, and say so where the person's other edits are said. */
function commit(records: VFSChangeRecord[], label: string): string | FileOpRefused {
  let id: string;
  try {
    id = useVFSStore.getState().applyTransaction(records, 'user', undefined, label);
  } catch (err) {
    return refused(`That could not be done, and nothing was changed: ${err instanceof Error ? err.message : String(err)}.`);
  }
  const ws = useWorkspaceStore.getState();
  ws.setDirty(true);
  ws.addConsoleOutput(`[You] ${label}`);
  return id;
}

// ---------------------------------------------------------------------------
// New file
// ---------------------------------------------------------------------------

/** Make an empty text file called `typed` in `folder`. */
export function createFile(folder: string, typed: string, emptyFolders: readonly string[] = []): FileOpResult {
  const busy = busyReason();
  if (busy) return refused(busy);
  const verdict = typedName(typed);
  if (!verdict.ok) return refused(verdict.reason);
  const files = useVFSStore.getState().files;
  const inFolder = folderAsSpelled(files.keys(), emptyFolders, folder);
  const path = joinPath(inFolder, verdict.name);
  if (takenKeys(files.keys(), emptyFolders).has(canonicalKey(path))) return refused(`There is already a ${verdict.name} in ${folderWords(inFolder)}.`);
  const problem = newPathProblem(path) ?? emptyFileProblem(path);
  if (problem) return refused(problem);
  const { files: count, bytes } = bundleSummary(files);
  const limit = appLimitReason(count, bytes, 1, 0);
  if (limit) return refused(limit);
  const label = `Created ${verdict.name}`;
  const id = commit([{ op: 'create', path, content: starterContent(path) }], label);
  if (typeof id !== 'string') return id;
  return { ok: true, label, said: `Created ${path}.`, transactionId: id, focus: path, notes: [], caution: false };
}

/**
 * The path a new folder called `typed` would have in `folder`, or why it
 * cannot be made. A folder with nothing in it is no file, so nothing is
 * written: the panel remembers it until a file is put in it.
 */
export function newFolderPath(folder: string, typed: string, emptyFolders: readonly string[] = []): { ok: true; path: string } | FileOpRefused {
  const verdict = typedName(typed);
  if (!verdict.ok) return refused(verdict.reason);
  const files = useVFSStore.getState().files;
  const inFolder = folderAsSpelled(files.keys(), emptyFolders, folder);
  const path = joinPath(inFolder, verdict.name);
  if (isPrivatePath(`${path}/`)) return refused(PRIVATE_REASON);
  if (takenKeys(files.keys(), emptyFolders).has(canonicalKey(path))) return refused(`There is already a ${verdict.name} in ${folderWords(inFolder)}.`);
  return { ok: true, path };
}

// ---------------------------------------------------------------------------
// Files from the computer
// ---------------------------------------------------------------------------

/** As much of a `File` as is used. */
export interface PickedFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  type?: string;
  lastModified?: number;
}

export interface IncomingFile {
  file: PickedFile;
  /** The name to keep it under, when its own says nothing (a pasted picture). */
  name?: string;
  /** The folders it came in, for a folder that was dropped: `icons/small`. */
  within?: string;
}

export interface AddedFiles {
  /** Where each file is now, and the name it came with. */
  added: Array<{ path: string; given: string }>;
  /** Why each file that was not added was not. */
  refused: string[];
  /** The unit and what it is called, when anything was added. */
  done: FileOpDone | null;
}

/**
 * Bring files in from the person's computer: into `folder`, or with `null`
 * where each belongs by its kind (a page, logic or settings file at the top of
 * the project, a picture or anything else with the assets). One that is too
 * large, cannot be read or would take the app past what a bundle may hold is
 * left out and said; the others are added all the same, as one unit.
 */
export async function addFiles(incoming: readonly IncomingFile[], folder: string | null, emptyFolders: readonly string[] = []): Promise<AddedFiles> {
  const out: AddedFiles = { added: [], refused: [], done: null };
  const busy = busyReason();
  if (busy) {
    out.refused.push(busy);
    return out;
  }
  // Read first: it takes time, and the project may change meanwhile.
  const read: Array<{ given: string; name: string; within: string; bytes: Uint8Array }> = [];
  for (const { file, name, within } of incoming) {
    const given = name ?? file.name;
    const tooLarge = tooLargeReason(given, file.size);
    if (tooLarge) {
      out.refused.push(tooLarge);
      continue;
    }
    try {
      read.push({ given, name: cleanFileName(given), within: within ?? '', bytes: new Uint8Array(await file.arrayBuffer()) });
    } catch (err) {
      out.refused.push(`${given} could not be read${err instanceof Error && err.message ? `: ${err.message}` : '.'}`);
    }
  }
  if (read.length === 0) return out;
  // A run that began while the files were being read has the project now.
  const began = busyReason();
  if (began) {
    out.refused.push(began);
    return out;
  }

  const files = useVFSStore.getState().files;
  const taken = takenKeys(files.keys(), emptyFolders);
  const summary = bundleSummary(files);
  let count = summary.files;
  let bytes = summary.bytes;
  const records: VFSChangeRecord[] = [];
  const notes: string[] = [];
  const folders = new Set<string>();
  for (const item of read) {
    const base = folder ?? (belongsAtTheTop(item.name) ? '' : assetsFolder(files));
    const inner = item.within.split('/').filter(Boolean).map(cleanFileName).join('/');
    const target = folderAsSpelled(files.keys(), emptyFolders, inner ? joinPath(base, inner) : base);
    const name = freeName(taken, target, item.name);
    const path = joinPath(target, name);
    const problem = newPathProblem(path);
    if (problem) {
      out.refused.push(problem);
      continue;
    }
    const kept = keptContent(path, item.bytes);
    if (!kept.ok) {
      out.refused.push(kept.reason);
      continue;
    }
    const limit = appLimitReason(count, bytes, 1, item.bytes.byteLength);
    if (limit) {
      out.refused.push(`${item.given} was left out. ${limit}`);
      continue;
    }
    count += 1;
    bytes += item.bytes.byteLength;
    taken.add(canonicalKey(path));
    records.push({ op: 'create', path, content: kept.content });
    out.added.push({ path, given: item.given });
    folders.add(target);
    if (name !== item.name) notes.push(`There was already a ${item.name} in ${folderWords(target)}, so this one is ${name}.`);
    else if (name !== item.given) notes.push(`${item.given} is kept as ${name}.`);
  }
  if (records.length === 0) return out;

  const one = out.added.length === 1;
  const label = one ? `Added ${nameOf(out.added[0].path)}` : `Added ${out.added.length} files`;
  const where = folders.size === 1 ? ` to ${folderWords([...folders][0])}` : '';
  const id = commit(records, label);
  if (typeof id !== 'string') {
    out.added = [];
    out.refused.push(id.reason);
    return out;
  }
  out.done = { ok: true, label, said: `${label}${where}.`, transactionId: id, focus: out.added[0].path, notes, caution: false };
  return out;
}

// ---------------------------------------------------------------------------
// Rename and move
// ---------------------------------------------------------------------------

/** manifest.json and permission.json are found by their names, at the top of the project. */
function fixedPlaceReason(path: string, isDir: boolean): string | null {
  if (isDir) return null;
  if (path === 'manifest.json') return 'manifest.json keeps its name and its place at the top of the project: it is how the app is found, and what names its main page.';
  if (path === 'permission.json') return 'permission.json keeps its name and its place at the top of the project: it is where the app says what it may use.';
  return null;
}

/** Put the file or folder at `from` at `to`, with everything that names it following, as one unit. */
function relocate(from: string, isDir: boolean, to: string, label: string, said: string, notes: string[]): FileOpResult {
  const vfs = useVFSStore.getState();
  const files = vfs.files;
  const affected = filesUnder(files, from, isDir);
  const move: FileMove = { from, to, folder: isDir };
  if (affected.length === 0) {
    // A folder with nothing in it: no file moves, and the panel renames what it remembers.
    return { ok: true, label, said, transactionId: null, focus: to, notes, caution: false, move };
  }
  const stopped = lockedReason(affected, label.startsWith('Renamed') ? 'renamed' : 'moved') ?? draftReason(affected);
  if (stopped) return refused(stopped);

  const entryBefore = getBundleEntryPath(files);
  const followed = followMove(files, move);
  const moving = new Set(affected);
  const records: VFSChangeRecord[] = [];
  // Every delete first: the old names are free before the new ones are taken, so a change of
  // case alone (Logo.png to logo.png) is not a clash with the file being renamed.
  for (const path of affected) records.push({ op: 'delete', path });
  for (const path of affected) {
    records.push({ op: 'create', path: movedPath(path, move), content: followed.texts.get(path) ?? files.get(path)!.content });
  }
  for (const [path, text] of followed.texts) {
    if (!moving.has(path)) records.push({ op: 'update', path, content: text });
  }
  const id = commit(records, label);
  if (typeof id !== 'string') return id;

  closeDraftOn(affected);
  // The canvas goes on showing the file it showed.
  const ws = useWorkspaceStore.getState();
  if (ws.activeFilePath && movedPath(ws.activeFilePath, move) !== ws.activeFilePath) ws.setActiveFilePath(movedPath(ws.activeFilePath, move));

  let caution = false;
  const movedTo = new Set(affected.map((path) => movedPath(path, move)));
  const others = followed.followed.filter((path) => !movedTo.has(path));
  if (others.length > 0) notes.push(`${listed(others)} ${others.length === 1 ? 'names' : 'name'} ${isDir ? 'what is in it' : 'it'} as ${to} now.`);
  if (followed.stillNames.length > 0) {
    caution = true;
    notes.push(`${listed(followed.stillNames)} still ${followed.stillNames.length === 1 ? 'names' : 'name'} ${from}, in a way Studio does not rewrite. Change it there by hand, or ask the AI to.`);
  }
  // A main page the manifest does not name is found by where it is; moved, another is found, or none.
  const entryAfter = getBundleEntryPath(useVFSStore.getState().files);
  if (entryBefore && movedPath(entryBefore, move) !== entryBefore && entryAfter !== movedPath(entryBefore, move)) {
    caution = true;
    notes.push(`The app opened on ${entryBefore}, which manifest.json does not name. It ${entryAfter ? `opens on ${entryAfter} now` : 'has no page to open on now'}: set "main" in manifest.json to choose, or undo this.`);
  }
  return { ok: true, label, said, transactionId: id, focus: to, notes, caution, move };
}

/** Give the file or folder at `path` the name `typed`, where it is. */
export function renameEntry(path: string, isDir: boolean, typed: string, emptyFolders: readonly string[] = []): FileOpResult {
  const busy = busyReason();
  if (busy) return refused(busy);
  const fixed = fixedPlaceReason(path, isDir);
  if (fixed) return refused(fixed);
  if (isPrivateEntry(path)) return refused(PRIVATE_REASON);
  const verdict = typedName(typed);
  if (!verdict.ok) return refused(verdict.reason);
  const files = useVFSStore.getState().files;
  const folder = folderOf(path);
  const to = joinPath(folder, verdict.name);
  const was = nameOf(path);
  if (to === path) return { ok: true, label: '', said: '', transactionId: null, focus: path, notes: [], caution: false };
  // Its own name in another case is free to it; any other name that is taken is not.
  const taken = takenKeys([...files.keys()].filter((other) => !(isDir ? other.startsWith(`${path}/`) : other === path)), emptyFolders.filter((empty) => empty !== path && !empty.startsWith(`${path}/`)));
  if (taken.has(canonicalKey(to))) return refused(`There is already a ${verdict.name} in ${folderWords(folder)}.`);
  if (isPrivatePath(`${to}/`)) return refused(PRIVATE_REASON);
  if (!isDir) {
    const problem = newPathProblem(to);
    if (problem) return refused(problem);
  }
  const label = `Renamed ${was} to ${verdict.name}`;
  return relocate(path, isDir, to, label, `${label}.`, []);
}

/** Why the file or folder at `path` cannot be moved into `folder`, or null when it can. */
export function moveRefusal(path: string, isDir: boolean, folder: string): string | null {
  const fixed = fixedPlaceReason(path, isDir);
  if (fixed) return fixed;
  if (isPrivateEntry(path) || (folder !== '' && isPrivateEntry(folder))) return PRIVATE_REASON;
  if (isDir && (folder === path || folder.startsWith(`${path}/`))) return `${nameOf(path)} cannot be moved into itself.`;
  return null;
}

/** Move the file or folder at `path` into `folder` ('' is the top of the project). */
export function moveEntry(path: string, isDir: boolean, folder: string, emptyFolders: readonly string[] = []): FileOpResult {
  const busy = busyReason();
  if (busy) return refused(busy);
  const files = useVFSStore.getState().files;
  const into = folderAsSpelled(files.keys(), emptyFolders, folder);
  const stopped = moveRefusal(path, isDir, into);
  if (stopped) return refused(stopped);
  const was = nameOf(path);
  if (folderOf(path) === into) return refused(`${was} is already in ${folderWords(into)}.`);
  const name = freeName(takenKeys(files.keys(), emptyFolders), into, was, isDir);
  const to = joinPath(into, name);
  if (!isDir) {
    const problem = newPathProblem(to);
    if (problem) return refused(problem);
  }
  const notes = name === was ? [] : [`There was already a ${was} in ${folderWords(into)}, so it is ${name} there.`];
  const label = `Moved ${was} to ${folderWords(into)}`;
  return relocate(path, isDir, to, label, `${label}.`, notes);
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** Put a copy of the file or folder at `path` in `folder`, under the first name that is free there. */
export function copyEntry(path: string, isDir: boolean, folder: string, emptyFolders: readonly string[] = [], verb: 'Copied' | 'Duplicated' = 'Copied'): FileOpResult {
  const busy = busyReason();
  if (busy) return refused(busy);
  const files = useVFSStore.getState().files;
  const into = folderAsSpelled(files.keys(), emptyFolders, folder);
  if (isPrivateEntry(path) || (into !== '' && isPrivateEntry(into))) return refused(PRIVATE_REASON);
  if (isDir && (into === path || into.startsWith(`${path}/`))) return refused(`${nameOf(path)} cannot be copied into itself.`);
  const sources = filesUnder(files, path, isDir);
  const was = nameOf(path);
  const name = freeName(takenKeys(files.keys(), emptyFolders), into, was, isDir);
  const to = joinPath(into, name);
  const copy: FileMove = { from: path, to, folder: isDir };
  const label = verb === 'Duplicated' ? `Duplicated ${was}` : `Copied ${was} to ${folderWords(into)}`;
  const said = verb === 'Duplicated' ? `Duplicated ${was}: the copy is ${name}.` : `${label}${name === was ? '' : ` as ${name}`}.`;
  if (sources.length === 0) {
    // A folder with nothing in it: the panel makes another.
    return { ok: true, label, said, transactionId: null, focus: to, notes: [], caution: false, copied: copy };
  }
  let adding = 0;
  for (const source of sources) adding += sizeOf(files.get(source)!);
  const { files: count, bytes } = bundleSummary(files);
  const limit = appLimitReason(count, bytes, sources.length, adding);
  if (limit) return refused(limit);
  const records: VFSChangeRecord[] = [];
  for (const source of sources) {
    const target = movedPath(source, copy);
    const problem = newPathProblem(target);
    if (problem) return refused(problem);
    const content = files.get(source)!.content;
    records.push({ op: 'create', path: target, content: typeof content === 'string' ? content : content.slice() });
  }
  const id = commit(records, label);
  if (typeof id !== 'string') return id;
  return { ok: true, label, said, transactionId: id, focus: to, notes: [], caution: false, copied: copy };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface DeletionPlan {
  /** How many files would go. */
  count: number;
  /** What the app loses with them, each in a sentence. Empty for a file nothing depends on. */
  warnings: string[];
}

/** What deleting the file or folder at `path` would take away, or why it may not be deleted. */
export function planDeletion(path: string, isDir: boolean): ({ ok: true } & DeletionPlan) | FileOpRefused {
  const busy = busyReason();
  if (busy) return refused(busy);
  const files = useVFSStore.getState().files;
  const going = filesUnder(files, path, isDir);
  const stopped = (isPrivateEntry(path) ? PRIVATE_REASON : null) ?? lockedReason(going, 'deleted') ?? draftReason(going);
  if (stopped) return refused(stopped);
  const warnings: string[] = [];
  const set = new Set(going);
  if (set.has('manifest.json')) warnings.push('manifest.json names the app and its main page. Without it the app cannot be run, published or exported.');
  const entry = getBundleEntryPath(files);
  if (entry && set.has(entry)) warnings.push(`${entry} is the app’s main page: the app opens on it.`);
  if (set.has('permission.json')) warnings.push('permission.json is where the app says what it may use, such as the network or the camera. Without it the app is allowed none of that.');
  const namers = namersOf(files, path, isDir);
  if (namers.length > 0) {
    warnings.push(`${listed(namers)} ${namers.length === 1 ? 'names' : 'name'} ${isDir ? 'what is in it' : 'it'}, and will be left asking for a file that is not there.`);
  }
  return { ok: true, count: going.length, warnings };
}

/** Delete the file or folder at `path`. */
export function deleteEntry(path: string, isDir: boolean): FileOpResult {
  const plan = planDeletion(path, isDir);
  if (!plan.ok) return plan;
  const files = useVFSStore.getState().files;
  const going = filesUnder(files, path, isDir);
  const was = nameOf(path);
  const label = isDir ? `Deleted the folder ${was}` : `Deleted ${was}`;
  const said = isDir ? `Deleted the folder ${was}${going.length > 0 ? ` and the ${going.length === 1 ? 'file' : `${going.length} files`} in it` : ''}.` : `Deleted ${path}.`;
  if (going.length === 0) return { ok: true, label, said, transactionId: null, focus: null, notes: [], caution: false };
  const id = commit(going.map((file) => ({ op: 'delete' as const, path: file })), label);
  if (typeof id !== 'string') return id;
  closeDraftOn(going);
  return { ok: true, label, said, transactionId: id, focus: null, notes: [], caution: false };
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * Take back one of the units made here: the newest change when it is that one,
 * and otherwise that unit alone, where nothing later touched its files.
 * Answers why it could not be, or null when it was.
 */
export function undoFileOp(transactionId: string): string | null {
  const busy = busyReason();
  if (busy) return busy;
  const vfs = useVFSStore.getState();
  const history = vfs.history;
  if (history.length > 0 && history[history.length - 1].transactionId === transactionId) {
    vfs.undoLast();
  } else {
    const result = vfs.revertTransaction(transactionId);
    if (!result.ok) return result.reason;
  }
  useWorkspaceStore.getState().setDirty(true);
  return null;
}
