import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { assetObjectUrl } from '@softn/core';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../../stores';
import { useFilesPanelStore, type FileClip } from '../../stores/filesPanelStore';
import { mediaKindFor } from '../canvas/MediaView';
import { bundleSummary } from '../../lib/exportBundle';
import {
  PRIVATE_REASON,
  addFiles,
  busyReason,
  copyEntry,
  createFile,
  deleteEntry,
  filesUnder,
  isPrivateEntry,
  moveEntry,
  moveRefusal,
  newFolderPath,
  planDeletion,
  renameEntry,
  undoFileOp,
  type FileOpResult,
  type IncomingFile,
} from '../../lib/fileOps';
import { folderOf, nameOf, shortSize, sizeWords, typedName } from '../../lib/fileRules';
import { downloadEntry, incomingFromDrop, incomingFromPaste } from '../../lib/fileTransfer';
import { confirmShowing } from '../../lib/handEdit';
import { getBundleEntryPath } from '../../lib/studioProject';
import type { VFSFile } from '../../types/studio';
import { FileMenu, type FileMenuItem, type FileMenuPlace } from './FileMenu';
import { Glyph, fileKind } from './fileGlyphs';
import {
  alreadyRevealed,
  buildRows,
  folderIsOpen,
  loadTreeMemory,
  saveTreeMemory,
  stillEmpty,
  withFolder,
  withMoved,
  withRevealed,
  withoutFolder,
  type TreeMemory,
  type TreeRow,
} from './fileTree';
import '../../styles/files.css';

/**
 * The project's files, as a file manager.
 *
 * The panel was a list: it showed the files and opened one. Adding a picture,
 * renaming a page or deleting a leftover meant asking the AI and waiting for a
 * run. A person can now run a project from here: make a file or a folder,
 * bring files in (a button, a drop, a paste), rename, duplicate, copy, cut,
 * paste, move by dragging, download and delete, each from a row's menu
 * (right-click, the row's "more" button, the menu key), and most from the
 * keyboard. What an action may do and what it is called in the history is in
 * lib/fileOps.ts; this is what is seen and pressed.
 *
 * Two things are marked and are not the same. The file on the canvas
 * (`aria-current`) is the workspace's active file, and the panel only shows
 * it: opening the panel never changes it. The row the keyboard is on
 * (`aria-selected`) is the panel's own, and is where a paste or a new file
 * goes.
 *
 * While the AI is working the panel is for looking: a file can be opened,
 * copied and downloaded, and anything that would change the project waits,
 * with the reason said above the tree.
 */

const sizes = new WeakMap<VFSFile, number>();

/** A file's size in bytes, worked out once for each version of it. */
function bytesOf(file: VFSFile): number {
  const known = sizes.get(file);
  if (known !== undefined) return known;
  const size = typeof file.content === 'string' ? new TextEncoder().encode(file.content).byteLength : file.content.byteLength;
  sizes.set(file, size);
  return size;
}

/** A picture larger than this is drawn as the picture sign, not decoded whole for sixteen pixels of it. */
const THUMBNAIL_LIMIT = 4 * 1024 * 1024;

/** A picture as its own small self beside its name. */
const Thumbnail: React.FC<{ path: string; content: string | Uint8Array }> = ({ path, content }) => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    try {
      made = assetObjectUrl(path, content);
    } catch {
      // No way to draw it here: the sign for a picture stands in.
    }
    setUrl(made);
    return () => {
      if (made?.startsWith('blob:')) URL.revokeObjectURL(made);
    };
  }, [path, content]);
  if (!url) return <span className="st-tree-kind"><Glyph name="picture" /></span>;
  return <img className="st-tree-thumb" src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setUrl(null)} />;
};

type Editing =
  | { kind: 'rename'; path: string; isDir: boolean; value: string; problem: string | null }
  | { kind: 'new-file' | 'new-folder'; folder: string; value: string; problem: string | null };

interface Notice {
  tone: 'done' | 'caution' | 'refused';
  /** What was done, in a few words that stand out; a reason or a hint is a sentence to read, and does not. */
  headline?: boolean;
  text: string;
  lines: string[];
  /** The unit Undo takes back, and what it was called. */
  undo: { id: string; label: string } | null;
}

interface Ask {
  path: string;
  isDir: boolean;
  title: string;
  lines: string[];
}

interface MenuState {
  /** The row it is for; null for the project itself (the empty space, the bar's "more"). */
  path: string | null;
  place: FileMenuPlace;
  opener: HTMLElement | null;
}

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '') ? '⌘' : 'Ctrl+';

const BUSY_NOTE = 'The AI is working: changes wait until the run stops.';

/**
 * Put text on the computer's clipboard, where the browser allows. Through a
 * copy the page makes itself first: that works at once, in the press that
 * asked for it, and on a page that is not served over https, where the newer
 * way is not offered at all. Then by the newer way.
 */
async function copyText(text: string): Promise<boolean> {
  let copied = false;
  const fill = (event: ClipboardEvent) => {
    event.clipboardData?.setData('text/plain', text);
    event.preventDefault();
    copied = true;
  };
  try {
    document.addEventListener('copy', fill, true);
    if (typeof document.execCommand === 'function') document.execCommand('copy');
  } catch {
    // Not offered here.
  } finally {
    document.removeEventListener('copy', fill, true);
  }
  if (copied) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const FilesPanel: React.FC = () => {
  const files = useVFSStore((s) => s.files);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const setActiveFilePath = useWorkspaceStore((s) => s.setActiveFilePath);
  const projectId = useWorkspaceStore((s) => s.projectId);
  const busy = useAIStore((s) => s.agentState === 'building');
  const clip = useFilesPanelStore((s) => s.clip);
  const setClip = useFilesPanelStore((s) => s.setClip);

  // What the panel remembers of this project's folders: which are open, and the ones a person
  // made that hold nothing yet. Another project is another memory.
  const [memory, setMemory] = useState<TreeMemory>(() => loadTreeMemory(projectId));
  const [cursor, setCursor] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  /** The folder a drag would land in: '' for the project, by kind or at its top. */
  const [dropAt, setDropAt] = useState<string | undefined>(undefined);
  const [, redraw] = useState(0);

  // Another project opened under the panel: its own folders, and nothing left over from the
  // last one (a name half typed, a question about a file that is not in this project).
  const [memoryOf, setMemoryOf] = useState(projectId);
  if (memoryOf !== projectId) {
    setMemoryOf(projectId);
    setMemory(loadTreeMemory(projectId));
    setCursor(null);
    setMenu(null);
    setEditing(null);
    setNotice(null);
    setAsk(null);
  }
  const kept = useRef(memory);
  useEffect(() => {
    if (kept.current === memory) return;
    kept.current = memory;
    saveTreeMemory(projectId, memory);
  }, [memory, projectId]);

  const treeRef = useRef<HTMLDivElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const pickInto = useRef<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const wantFocus = useRef<{ path: string; tries: number } | null>(null);
  const dragging = useRef<{ path: string; isDir: boolean } | null>(null);
  const typedAhead = useRef({ text: '', at: 0 });
  // Whether the panel is still there when something it waited for comes back. Set in the
  // effect as well as cleared: in development React runs each effect, undoes it and runs it
  // again, and a flag only ever cleared stayed cleared, so nothing read from a file was shown.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const hintId = useId();
  const askTitleId = useId();
  const askBodyId = useId();

  const paths = useMemo(() => [...files.keys()], [files]);
  const empty = useMemo(() => stillEmpty(memory.empty, paths), [memory.empty, paths]);
  const rows = useMemo(() => buildRows(paths, empty, (path, depth) => folderIsOpen(memory, path, depth)), [paths, empty, memory]);
  // "In the bundle" is said of what Export bundle will write, counted from its own plan: a
  // project made here keeps its brief and plan under builder/, which the export leaves out.
  const bundle = useMemo(() => bundleSummary(files), [files]);
  const entryPath = useMemo(() => getBundleEntryPath(files), [files]);
  // The file showing on the canvas: the workspace's active file, and with none (or one that
  // is gone) the bundle's entry, which is what the canvas falls back to. The panel marks it
  // and nothing more. It used to keep a selection of its own, empty each time the panel was
  // opened, and on finding none made the entry the workspace's active file: opening the panel,
  // or reloading with it open, put the main page on the canvas in place of the file the
  // person had chosen, and counted as a change to the project.
  const shownPath = useMemo(() => (activeFilePath && files.has(activeFilePath) ? activeFilePath : entryPath), [activeFilePath, files, entryPath]);

  // The folders the file showing is in are opened, so that it can be seen. A folder closed
  // by hand stays closed until another file is shown.
  useEffect(() => {
    if (!shownPath || alreadyRevealed(projectId, shownPath)) return;
    setMemory((was) => withRevealed(was, shownPath));
  }, [shownPath, projectId]);

  // What async work and listeners read: the newest of each.
  const now = useRef({ empty, editing, menu, rows });
  now.current = { empty, editing, menu, rows };

  // A row that has just been made or moved is given the focus once it is drawn.
  useLayoutEffect(() => {
    const want = wantFocus.current;
    if (!want) return;
    const index = rows.findIndex((row) => row.path === want.path);
    if (index < 0) {
      // Its folder may be opening; a row that never comes is let go of.
      if (--want.tries <= 0) wantFocus.current = null;
      return;
    }
    wantFocus.current = null;
    treeRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`)?.focus();
  });

  // The question before a delete starts on Cancel: Enter pressed again does not delete.
  useEffect(() => {
    if (ask) cancelRef.current?.focus();
  }, [ask]);

  // A closed folder a drag rests on opens, so the drag can go further in.
  useEffect(() => {
    if (!dropAt) return;
    const row = rows.find((other) => other.path === dropAt && other.isDir);
    if (!row || row.open) return;
    const timer = setTimeout(() => setMemory((was) => withFolder(was, dropAt, true)), 650);
    return () => clearTimeout(timer);
  }, [dropAt, rows]);

  const rowOf = (path: string | null): TreeRow | undefined => (path === null ? undefined : rows.find((row) => row.path === path));
  const cursorRow = rowOf(cursor);
  /** The one row Tab stops on: the keyboard's, else the file showing, else the first. */
  const stop = cursorRow?.path ?? rowOf(shownPath)?.path ?? rows[0]?.path ?? null;

  /** The folder a new file, a new folder or a paste of the panel's own goes to: the row's, or the one it is in. */
  const folderAt = (row: TreeRow | undefined | null): string => (row ? (row.isDir ? row.path : row.parent) : '');
  /** Where files from the computer go: the folder pointed at, and with none where each belongs by kind. */
  const folderForIncoming = (row: TreeRow | undefined | null): string | null => folderAt(row) || null;

  const focusRow = (path: string) => {
    setCursor(path);
    setMemory((was) => withRevealed(was, path));
    wantFocus.current = { path, tries: 3 };
    redraw((n) => n + 1);
  };

  const refuse = (reason: string) => setNotice({ tone: 'refused', text: reason, lines: [], undo: null });
  const tell = (text: string) => setNotice({ tone: 'done', text, lines: [], undo: null });

  /** Say what an action did or why it did not, and bring what the panel remembers by path into step. */
  const settle = (result: FileOpResult, options: { focus?: boolean; emptied?: string } = {}): boolean => {
    if (!result.ok) {
      refuse(result.reason);
      return false;
    }
    if (result.said !== '') {
      setNotice({
        tone: result.caution ? 'caution' : 'done',
        headline: true,
        text: result.said,
        lines: result.notes,
        undo: result.transactionId ? { id: result.transactionId, label: result.label } : null,
      });
    }
    const { move, copied } = result;
    if (move) {
      setMemory((was) => withMoved(was, move));
      const cut = useFilesPanelStore.getState().clip;
      if (cut && (cut.path === move.from || cut.path.startsWith(`${move.from}/`))) setClip(null);
    }
    // A copy of a folder with nothing in it is another such folder: there is no file to copy.
    if (copied && result.transactionId === null) setMemory((was) => ({ ...was, empty: [...new Set([...was.empty, copied.to])] }));
    // A folder a person has just emptied stays, as it would on a disk, until it is deleted.
    const emptied = options.emptied;
    if (emptied && !isPrivateEntry(emptied) && filesUnder(useVFSStore.getState().files, emptied, true).length === 0) {
      setMemory((was) => ({ ...was, empty: [...new Set([...was.empty, emptied])] }));
    }
    if (result.focus) {
      if (options.focus === false) setCursor(result.focus);
      else focusRow(result.focus);
    }
    return true;
  };

  const openFile = (path: string) => {
    // Another file takes the canvas from the one being edited by hand: a draft that is not
    // saved is asked about first.
    if (!confirmShowing(path)) return;
    setActiveFilePath(path);
  };

  const toggle = (row: TreeRow) => setMemory((was) => withFolder(was, row.path, !row.open));

  // ── Names: rename, new file, new folder ─────────────────────────────────

  const endEdit = () => {
    now.current.editing = null;
    setEditing(null);
  };

  const startRename = (row: TreeRow) => {
    // Asked as a rename to the name it has: nothing changes, and what may not be renamed says why.
    const allowed = renameEntry(row.path, row.isDir, row.name, empty);
    if (!allowed.ok) {
      refuse(allowed.reason);
      return;
    }
    setCursor(row.path);
    setEditing({ kind: 'rename', path: row.path, isDir: row.isDir, value: row.name, problem: null });
  };

  const startNew = (kind: 'new-file' | 'new-folder', folder: string) => {
    const stopped = busyReason() ?? (folder !== '' && isPrivateEntry(folder) ? PRIVATE_REASON : null);
    if (stopped) {
      refuse(stopped);
      return;
    }
    if (folder !== '') setMemory((was) => withFolder(withRevealed(was, folder), folder, true));
    setEditing({ kind, folder, value: '', problem: null });
  };

  /** Give the name that was typed. By Enter a refusal keeps the box open with the reason; by a click elsewhere it is said below. */
  const commitEdit = (how: 'enter' | 'blur') => {
    const edit = now.current.editing;
    if (!edit) return;
    const refused = (reason: string) => {
      if (how === 'enter') {
        setEditing({ ...edit, problem: reason });
      } else {
        endEdit();
        refuse(reason);
      }
    };
    const typed = edit.value.trim();
    if (edit.kind === 'rename') {
      if (typed === '' || typed === nameOf(edit.path)) {
        endEdit();
        if (how === 'enter') focusRow(edit.path);
        return;
      }
      const result = renameEntry(edit.path, edit.isDir, typed, now.current.empty);
      if (!result.ok) {
        refused(result.reason);
        return;
      }
      endEdit();
      settle(result, { focus: how === 'enter' });
      return;
    }
    if (typed === '') {
      endEdit();
      if (how === 'enter' && edit.folder !== '') focusRow(edit.folder);
      return;
    }
    if (edit.kind === 'new-file') {
      const result = createFile(edit.folder, typed, now.current.empty);
      if (!result.ok) {
        refused(result.reason);
        return;
      }
      endEdit();
      settle(result, { focus: how === 'enter' });
      // A file that was just made is the one to work on.
      if (result.focus && confirmShowing(result.focus)) setActiveFilePath(result.focus);
      return;
    }
    const made = newFolderPath(edit.folder, typed, now.current.empty);
    if (!made.ok) {
      refused(made.reason);
      return;
    }
    endEdit();
    setMemory((was) => ({ ...was, empty: [...new Set([...was.empty, made.path])] }));
    if (how === 'enter') focusRow(made.path);
    else setCursor(made.path);
    tell(`Made the folder ${nameOf(made.path)}. A bundle holds files, not folders: it is part of the app once a file is in it.`);
  };

  const cancelEdit = () => {
    const edit = now.current.editing;
    endEdit();
    if (edit?.kind === 'rename') focusRow(edit.path);
    else if (edit && edit.folder !== '') focusRow(edit.folder);
    else treeRef.current?.focus();
  };

  /** Under the box: the name the file will really have, or why it cannot have that one. */
  const hint = (edit: Editing): { text: string; tone: 'said' | 'refused' } | null => {
    if (edit.problem) return { text: edit.problem, tone: 'refused' };
    if (edit.value.trim() === '') {
      if (edit.kind === 'new-file') return { text: 'A name with its ending, such as about.html or notes.txt.', tone: 'said' };
      return null;
    }
    const verdict = typedName(edit.value);
    if (!verdict.ok) return { text: verdict.reason, tone: 'refused' };
    return verdict.changed ? { text: `It will be named ${verdict.name}.`, tone: 'said' } : null;
  };

  // ── Files from the computer ─────────────────────────────────────────────

  const bringIn = async (incoming: IncomingFile[], folder: string | null) => {
    if (incoming.length === 0) return;
    const result = await addFiles(incoming, folder, now.current.empty);
    if (!mounted.current) return;
    if (!result.done) {
      setNotice({ tone: 'refused', text: result.refused[0] ?? 'Nothing was added.', lines: result.refused.slice(1), undo: null });
      return;
    }
    setNotice({
      tone: result.refused.length > 0 ? 'caution' : 'done',
      headline: true,
      text: result.done.said,
      lines: [...result.done.notes, ...result.refused],
      undo: result.done.transactionId ? { id: result.done.transactionId, label: result.done.label } : null,
    });
    if (result.done.focus) focusRow(result.done.focus);
  };

  const pick = (folder: string | null) => {
    const stopped = busyReason() ?? (folder && isPrivateEntry(folder) ? PRIVATE_REASON : null);
    if (stopped) {
      refuse(stopped);
      return;
    }
    pickInto.current = folder;
    pickRef.current?.click();
  };

  // ── Copy, cut, paste ────────────────────────────────────────────────────

  const hold = (row: TreeRow, mode: FileClip['mode']) => {
    // What may not be moved may not be cut; Studio's notes are not copied into the app either.
    const stopped = row.isPrivate ? PRIVATE_REASON : mode === 'cut' ? busyReason() ?? moveRefusal(row.path, row.isDir, row.parent === '' ? 'elsewhere' : '') : null;
    if (stopped) {
      refuse(stopped);
      return;
    }
    setClip({ mode, path: row.path, isDir: row.isDir, projectId });
    // The path, as text, where the browser allows: it also takes the place of files copied
    // elsewhere, which a paste would otherwise bring in instead of this one.
    void copyText(row.path);
    tell(mode === 'copy'
      ? `Copied ${row.name}. Paste it into a folder with ${MOD}V or the folder’s menu.`
      : `Cut ${row.name}. It moves to where you paste it.`);
  };

  /** What was copied or cut here, if it is this project's and still there. */
  const liveClip = (): FileClip | null => {
    const held = useFilesPanelStore.getState().clip;
    if (!held || held.projectId !== projectId) return null;
    const there = held.isDir ? filesUnder(files, held.path, true).length > 0 || empty.includes(held.path) : files.has(held.path);
    return there ? held : null;
  };

  const pasteClip = (held: FileClip, folder: string) => {
    if (held.mode === 'copy') {
      settle(copyEntry(held.path, held.isDir, folder, empty));
      return;
    }
    if (settle(moveEntry(held.path, held.isDir, folder, empty), { emptied: folderOf(held.path) })) setClip(null);
  };

  const nothingToPaste = () => tell(`There is nothing here to paste yet. Copy or cut a file in this panel, or copy a picture and press ${MOD}V while the panel has the focus.`);

  /** Paste, chosen from a menu: the panel's own clipboard, else a picture on the computer's, where the browser lets a page read it. */
  const pasteFromMenu = async (row: TreeRow | null) => {
    const held = liveClip();
    if (held) {
      pasteClip(held, folderAt(row));
      return;
    }
    const stopped = busyReason();
    if (stopped) {
      refuse(stopped);
      return;
    }
    try {
      const pictures: File[] = [];
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((other) => other.startsWith('image/'));
        if (!type) continue;
        const ending = type === 'image/jpeg' ? 'jpg' : type === 'image/svg+xml' ? 'svg' : type.slice('image/'.length);
        pictures.push(new File([await item.getType(type)], `image.${ending}`, { type, lastModified: Date.now() }));
      }
      if (pictures.length > 0) {
        await bringIn(incomingFromPaste({ files: pictures }), folderForIncoming(row));
        return;
      }
    } catch {
      // The browser does not let this page read the clipboard: Ctrl+V still does.
    }
    if (mounted.current) nothingToPaste();
  };

  /** Ctrl+V with the panel in focus: files or a picture copied elsewhere, else what was copied or cut here. */
  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]') || ask) return;
    const incoming = incomingFromPaste(event.clipboardData);
    if (incoming.length > 0) {
      event.preventDefault();
      const stopped = busyReason();
      if (stopped) refuse(stopped);
      else void bringIn(incoming, folderForIncoming(cursorRow));
      return;
    }
    const held = liveClip();
    if (held) {
      event.preventDefault();
      pasteClip(held, folderAt(cursorRow));
      return;
    }
    // Text is not made into a file: nothing says what it should be called or what kind it is.
    if ((event.clipboardData?.getData('text/plain') ?? '').trim() !== '') {
      tell('The clipboard holds text, not a file, so nothing was added. To keep it as a file, make one with New file and paste the text into it.');
    } else {
      nothingToPaste();
    }
  };

  // ── Duplicate, delete, download, copy path, undo ────────────────────────

  const duplicate = (row: TreeRow) => settle(copyEntry(row.path, row.isDir, row.parent, empty, 'Duplicated'));

  const deleteNow = (path: string, isDir: boolean) => {
    const index = rows.findIndex((row) => row.path === path);
    // The focus goes to the row after what is going, else the one before it.
    const neighbour = rows.slice(index + 1).find((row) => !row.path.startsWith(`${path}/`)) ?? rows[index - 1];
    if (!settle(deleteEntry(path, isDir), { emptied: folderOf(path) })) return;
    if (isDir) setMemory((was) => withoutFolder(was, path));
    const held = useFilesPanelStore.getState().clip;
    if (held && (held.path === path || held.path.startsWith(`${path}/`))) setClip(null);
    if (neighbour) focusRow(neighbour.path);
    else treeRef.current?.focus();
  };

  /** Delete, asking first where the app would lose something by it: History can undo it either way. */
  const remove = (row: TreeRow) => {
    const plan = planDeletion(row.path, row.isDir);
    if (!plan.ok) {
      refuse(plan.reason);
      return;
    }
    if (plan.warnings.length === 0 && (!row.isDir || plan.count === 0)) {
      deleteNow(row.path, row.isDir);
      return;
    }
    const holds = row.isDir ? [`It holds ${plan.count === 1 ? '1 file' : `${plan.count} files`}, and they go with it.`] : [];
    setAsk({
      path: row.path,
      isDir: row.isDir,
      title: row.isDir ? `Delete the folder ${row.name}?` : `Delete ${row.name}?`,
      lines: [...holds, ...plan.warnings, 'History can undo this.'],
    });
  };

  const closeAsk = (confirmed: boolean) => {
    const asked = ask;
    setAsk(null);
    if (!asked) return;
    if (confirmed) deleteNow(asked.path, asked.isDir);
    else focusRow(asked.path);
  };

  const download = (row: TreeRow) => {
    const stopped = downloadEntry(files, row.path, row.isDir);
    if (stopped) refuse(stopped);
  };

  const copyPath = async (row: TreeRow) => {
    const done = await copyText(row.path);
    if (!mounted.current) return;
    if (done) tell(`Copied the path ${row.path}.`);
    else refuse(`This browser did not let the path be copied. It is ${row.path}.`);
  };

  const undo = (unit: { id: string; label: string }) => {
    const stopped = undoFileOp(unit.id);
    if (stopped) refuse(stopped);
    else tell(`Undone: ${unit.label}. History can redo it.`);
  };

  /** Ctrl+Z in the tree takes back the newest change only when it was made here: an AI turn is undone from History, on purpose. */
  const undoNewest = () => {
    const history = useVFSStore.getState().history;
    const newest = history[history.length - 1];
    if (newest?.label && newest.source === 'user' && newest.transactionId) undo({ id: newest.transactionId, label: newest.label });
    else tell(history.length === 0 ? 'There is nothing to undo.' : 'The newest change was not made in this panel. History can undo it.');
  };

  // ── The menu ────────────────────────────────────────────────────────────

  const openMenu = (row: TreeRow | null, place: FileMenuPlace, opener: HTMLElement | null) => {
    if (row) setCursor(row.path);
    setMenu({ path: row?.path ?? null, place, opener });
  };

  const closeMenu = (restoreFocus: boolean) => {
    const was = now.current.menu;
    setMenu(null);
    if (restoreFocus) was?.opener?.focus();
  };

  /** Under a button or a row, for a menu opened by a press or from the keyboard. */
  const below = (element: HTMLElement, inset = 0): FileMenuPlace => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + inset, y: rect.bottom + 2 };
  };

  const itemsFor = (row: TreeRow | null): FileMenuItem[] => {
    const off = busy ? BUSY_NOTE : null;
    const folder = folderAt(row);
    const make: FileMenuItem[] = [
      { id: 'new-file', label: 'New file', glyph: 'new-file', disabled: off, onSelect: () => startNew('new-file', folder) },
      { id: 'new-folder', label: 'New folder', glyph: 'new-folder', disabled: off, onSelect: () => startNew('new-folder', folder) },
      { id: 'add', label: row ? 'Add files here' : 'Add files', glyph: 'add', disabled: off, onSelect: () => pick(row ? folder : null) },
      { id: 'paste', label: 'Paste', glyph: 'paste', keys: `${MOD}V`, disabled: off, onSelect: () => void pasteFromMenu(row) },
    ];
    if (!row) return make;
    const change: FileMenuItem[] = [
      { id: 'rename', label: 'Rename', glyph: 'rename', keys: 'F2', disabled: off, onSelect: () => startRename(row) },
      { id: 'duplicate', label: 'Duplicate', glyph: 'duplicate', keys: `${MOD}D`, disabled: off, onSelect: () => duplicate(row) },
      { id: 'copy', label: 'Copy', glyph: 'copy', keys: `${MOD}C`, onSelect: () => hold(row, 'copy') },
      { id: 'cut', label: 'Cut', glyph: 'cut', keys: `${MOD}X`, disabled: off, onSelect: () => hold(row, 'cut') },
    ];
    const take: FileMenuItem[] = [
      { id: 'download', label: row.isDir ? 'Download as a zip' : 'Download', glyph: 'download', group: true, onSelect: () => download(row) },
      { id: 'copy-path', label: 'Copy path', glyph: 'path', onSelect: () => void copyPath(row) },
      { id: 'delete', label: 'Delete', glyph: 'delete', keys: 'Del', danger: true, group: true, disabled: off, onSelect: () => remove(row) },
    ];
    if (row.isDir) {
      change[0] = { ...change[0], group: true };
      return [...make, ...change, ...take];
    }
    return [{ id: 'open', label: 'Open', glyph: 'open', keys: 'Enter', onSelect: () => openFile(row.path) }, ...change, ...take];
  };

  // ── Keys on the tree ────────────────────────────────────────────────────

  const moveTo = (index: number) => {
    const row = rows[index];
    if (!row) return;
    setCursor(row.path);
    const element = treeRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`);
    element?.focus();
    element?.scrollIntoView?.({ block: 'nearest' });
  };

  const onTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // A row's keys are for the row itself: not for the box a name is typed in, nor its "more" button.
    const element = target.closest<HTMLElement>('[data-row]');
    if (target !== event.currentTarget && target !== element) return;
    const index = element ? Number(element.dataset.row) : -1;
    const row = index >= 0 ? rows[index] : undefined;
    const mod = event.ctrlKey || event.metaKey;
    const done = () => event.preventDefault();

    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      done();
      if (row && element) openMenu(row, below(element, 24), element);
      else openMenu(null, below(event.currentTarget, 12), event.currentTarget);
      return;
    }
    if (mod && !event.altKey && !event.shiftKey) {
      const key = event.key.toLowerCase();
      if (key === 'z') {
        done();
        undoNewest();
      } else if (row && key === 'c') {
        // Words selected in the notice below are what Ctrl+C is for then, not the row.
        if ((window.getSelection()?.toString() ?? '') !== '') return;
        done();
        hold(row, 'copy');
      } else if (row && key === 'x') {
        done();
        hold(row, 'cut');
      } else if (row && key === 'd') {
        done();
        duplicate(row);
      } else if (row && event.key === 'Backspace') {
        done();
        remove(row);
      }
      // Ctrl+V is not taken here: the paste that follows it carries what is pasted.
      return;
    }
    if (event.altKey) return;

    switch (event.key) {
      case 'ArrowDown':
        done();
        moveTo(index < 0 ? 0 : Math.min(index + 1, rows.length - 1));
        return;
      case 'ArrowUp':
        done();
        moveTo(index < 0 ? rows.length - 1 : Math.max(index - 1, 0));
        return;
      case 'Home':
        done();
        moveTo(0);
        return;
      case 'End':
        done();
        moveTo(rows.length - 1);
        return;
      case 'ArrowRight':
        if (!row?.isDir) return;
        done();
        if (!row.open) toggle(row);
        else if ((rows[index + 1]?.depth ?? -1) > row.depth) moveTo(index + 1);
        return;
      case 'ArrowLeft': {
        if (!row) return;
        done();
        if (row.isDir && row.open) toggle(row);
        else if (row.parent !== '') moveTo(rows.findIndex((other) => other.path === row.parent));
        return;
      }
      case 'Enter':
      case ' ':
        if (!row) return;
        done();
        if (row.isDir) toggle(row);
        else openFile(row.path);
        return;
      case 'F2':
        if (!row) return;
        done();
        startRename(row);
        return;
      case 'Delete':
        if (!row) return;
        done();
        remove(row);
        return;
      case 'Escape':
        if (useFilesPanelStore.getState().clip?.mode === 'cut') {
          done();
          setClip(null);
          tell('Nothing is cut any more.');
        }
        return;
      default:
    }
    // A letter goes to the next name that starts with what was typed: quickly, more than one letter.
    if (event.key.length === 1 && event.key !== ' ' && rows.length > 0) {
      const at = Date.now();
      const letter = event.key.toLowerCase();
      const text = at - typedAhead.current.at < 700 ? typedAhead.current.text + letter : letter;
      // One letter, typed again and again, steps through the names that start with it; other
      // letters after it narrow the name down, and stay on a row that still matches.
      const stepping = [...text].every((other) => other === letter);
      const wanted = stepping ? letter : text;
      typedAhead.current = { text: wanted, at };
      const from = stepping ? index + 1 : Math.max(index, 0);
      for (let step = 0; step < rows.length; step++) {
        const candidate = (from + step) % rows.length;
        if (rows[candidate].name.toLowerCase().startsWith(wanted)) {
          done();
          moveTo(candidate);
          return;
        }
      }
    }
  };

  // ── Dragging: files from the computer in, a row onto a folder ──────────

  /** The folder under the pointer: a folder's own row, or the folder a file's row is in. */
  const folderUnder = (target: EventTarget): string => {
    const element = (target as HTMLElement).closest?.<HTMLElement>('[data-row]');
    return folderAt(element ? rows[Number(element.dataset.row)] : null);
  };

  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    const own = dragging.current;
    const fromComputer = !own && Array.from(event.dataTransfer.types ?? []).includes('Files');
    if (!own && !fromComputer) return;
    // Always taken: a file let fall on the page would be opened by the browser in Studio's place.
    event.preventDefault();
    const folder = folderUnder(event.target);
    const refused = busy || (own ? moveRefusal(own.path, own.isDir, folder) !== null || folderOf(own.path) === folder : folder !== '' && isPrivateEntry(folder));
    event.dataTransfer.dropEffect = refused ? 'none' : own ? 'move' : 'copy';
    setDropAt(refused ? undefined : folder);
  };

  const onDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(undefined);
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const own = dragging.current;
    const fromComputer = !own && Array.from(event.dataTransfer.types ?? []).includes('Files');
    if (!own && !fromComputer) return;
    event.preventDefault();
    setDropAt(undefined);
    dragging.current = null;
    const folder = folderUnder(event.target);
    if (own) {
      // Let go where it was picked up: nothing was meant by it.
      if (folderOf(own.path) === folder) return;
      settle(moveEntry(own.path, own.isDir, folder, empty), { emptied: folderOf(own.path) });
      return;
    }
    const stopped = busyReason();
    if (stopped) {
      refuse(stopped);
      return;
    }
    // Read at once: the browser empties the drop when this returns.
    const incoming = incomingFromDrop(event.dataTransfer);
    void incoming.then((list) => {
      if (!mounted.current) return;
      if (list.length === 0) refuse('Nothing in that drop could be read as a file.');
      else void bringIn(list, folder || null);
    });
  };

  // ── What is drawn ───────────────────────────────────────────────────────

  const menuRow = menu ? rowOf(menu.path) ?? null : null;
  const newAt = editing && editing.kind !== 'rename' ? editing : null;
  const editHint = editing ? hint(editing) : null;
  const liveCut = clip && clip.mode === 'cut' && clip.projectId === projectId ? clip.path : null;

  const nameBox = (label: string) => editing && (
      <input
        className="st-tree-input"
        aria-label={label}
        aria-invalid={editHint?.tone === 'refused' ? true : undefined}
        aria-describedby={editHint ? hintId : undefined}
        value={editing.value}
        autoFocus
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        // The name without its ending is what is usually changed.
        ref={(element) => {
          if (!element || element.dataset.chosen) return;
          element.dataset.chosen = 'true';
          const dot = editing.kind === 'rename' && !editing.isDir ? editing.value.lastIndexOf('.') : -1;
          element.setSelectionRange(0, dot > 0 ? dot : editing.value.length);
        }}
        onChange={(event) => setEditing({ ...editing, value: event.target.value, problem: null })}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            commitEdit('enter');
          } else if (event.key === 'Escape') {
            event.preventDefault();
            cancelEdit();
          }
        }}
        onBlur={() => commitEdit('blur')}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      />
  );

  const hintRow = (indent: number) => (
    <div className="st-tree-hint" id={hintId} role="presentation" aria-live="polite" data-tone={editHint?.tone} style={{ paddingLeft: indent }}>
      {editHint?.text}
    </div>
  );

  const indentOf = (depth: number) => 8 + depth * 14;

  /** The row a name is typed into for a file or folder that is not made yet. */
  const newRow = (depth: number) => newAt && (
    <React.Fragment key="new">
      <div className="st-tree-item" role="treeitem" aria-level={depth + 1} aria-selected={false} aria-label={newAt.kind === 'new-file' ? 'New file' : 'New folder'} style={{ paddingLeft: indentOf(depth) }}>
        <span className="st-tree-twist" />
        <span className="st-tree-kind"><Glyph name={newAt.kind === 'new-file' ? 'file' : 'folder'} /></span>
        {nameBox(newAt.kind === 'new-file' ? 'Name of the new file' : 'Name of the new folder')}
      </div>
      {hintRow(indentOf(depth) + 34)}
    </React.Fragment>
  );

  const bar = (
    <div className="st-files-bar" role="toolbar" aria-label="Add to the project">
      <button
        type="button"
        className="st-btn st-btn-sm"
        aria-disabled={busy || undefined}
        title={busy ? BUSY_NOTE : 'Add pictures and other files from this computer. You can also drop them on the panel, or paste a picture.'}
        onClick={() => pick(null)}
      >
        <Glyph name="add" size={15} />
        Add files
      </button>
      <button type="button" className="st-files-tool" aria-label="New file" title={busy ? BUSY_NOTE : 'New file'} aria-disabled={busy || undefined} onClick={() => startNew('new-file', folderAt(cursorRow))}>
        <Glyph name="new-file" />
      </button>
      <button type="button" className="st-files-tool" aria-label="New folder" title={busy ? BUSY_NOTE : 'New folder'} aria-disabled={busy || undefined} onClick={() => startNew('new-folder', folderAt(cursorRow))}>
        <Glyph name="new-folder" />
      </button>
      <button
        type="button"
        className="st-files-tool"
        aria-label="More for the project’s files"
        title="More: new file, new folder, add files, paste"
        aria-haspopup="menu"
        aria-expanded={menu !== null && menu.path === null}
        data-menu-opener
        onClick={(event) => (menu && menu.path === null ? closeMenu(false) : openMenu(null, below(event.currentTarget), event.currentTarget))}
      >
        <Glyph name="more" />
      </button>
    </div>
  );

  const summary = (
    <p className="st-files-foot">
      <span className="num">{bundle.files}</span> file{bundle.files !== 1 ? 's' : ''} in the bundle, <span className="num">{sizeWords(bundle.bytes)}</span>.
      {bundle.privateFiles > 0 && ` ${bundle.privateFiles} more under builder/ ${bundle.privateFiles === 1 ? 'is' : 'are'} Studio’s notes: kept with the project, not exported.`}
    </p>
  );

  const nothingYet = rows.length === 0 && !newAt;

  return (
    <div className="st-files" onPaste={onPaste}>
      <input
        ref={pickRef}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = '';
          void bringIn(picked.map((file) => ({ file })), pickInto.current);
        }}
      />
      {bar}
      {busy && (
        <p className="st-files-busy" role="status">
          <span><strong>The AI is working.</strong> Files can be opened, copied and downloaded. Adding, renaming, moving and deleting wait until the run stops.</span>
        </p>
      )}

      {nothingYet ? (
        <div
          ref={treeRef}
          className="st-files-empty"
          tabIndex={-1}
          data-drop={dropAt !== undefined ? 'true' : undefined}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu(null, { x: event.clientX, y: event.clientY }, event.currentTarget);
          }}
        >
          <Glyph name="folder-open" size={26} />
          <strong>No files yet</strong>
          <span>Describe an app to the AI and its files appear here, or start with your own.</span>
          <div className="st-files-empty-actions">
            <button type="button" className="st-btn st-btn-sm" aria-disabled={busy || undefined} onClick={() => startNew('new-file', '')}>
              <Glyph name="new-file" size={15} />
              New file
            </button>
            <button type="button" className="st-btn st-btn-sm" aria-disabled={busy || undefined} onClick={() => pick(null)}>
              <Glyph name="add" size={15} />
              Add files
            </button>
          </div>
          <span>You can also drop files here, or paste a picture.</span>
        </div>
      ) : (
        <div
          ref={treeRef}
          className="st-tree"
          role="tree"
          aria-label="Project files"
          tabIndex={-1}
          data-drop={dropAt === '' ? 'true' : undefined}
          onKeyDown={onTreeKeyDown}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onContextMenu={(event) => {
            // A right-click that a row did not take: the empty space, for the project itself.
            event.preventDefault();
            openMenu(null, { x: event.clientX, y: event.clientY }, event.currentTarget);
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setCursor(null);
          }}
        >
          {newAt && newAt.folder === '' && newRow(0)}
          {rows.map((row, index) => {
            const file = row.isDir ? undefined : files.get(row.path);
            const size = file ? bytesOf(file) : 0;
            const kind = row.isDir ? null : fileKind(row.path);
            const renaming = editing?.kind === 'rename' && editing.path === row.path;
            const current = !row.isDir && row.path === shownPath;
            const isEmpty = row.isDir && row.count === 0;
            const isMain = !row.isDir && row.path === entryPath;
            const picture = file && mediaKindFor(row.path) === 'image' && size <= THUMBNAIL_LIMIT ? file : null;
            const dot = row.isDir ? -1 : row.name.lastIndexOf('.');
            const said = row.isDir
              ? `${row.name}, folder, ${isEmpty ? 'empty' : row.count === 1 ? '1 file' : `${row.count} files`}${row.isPrivate && row.depth === 0 ? ', Studio’s notes, not exported' : ''}`
              : `${row.name}, ${kind!.word}, ${sizeWords(size)}${isMain ? ', the main page' : ''}${current ? ', on the canvas' : ''}`;
            return (
              <React.Fragment key={`${row.isDir ? 'd' : 'f'}:${row.path}`}>
                <div
                  className="st-tree-item"
                  role="treeitem"
                  data-row={index}
                  data-path={row.path}
                  tabIndex={row.path === stop ? 0 : -1}
                  aria-level={row.depth + 1}
                  aria-posinset={row.position}
                  aria-setsize={row.setSize}
                  aria-expanded={row.isDir ? row.open : undefined}
                  aria-selected={row.path === cursor}
                  aria-current={current ? 'true' : undefined}
                  aria-label={`${said}${liveCut === row.path ? ', cut' : ''}`}
                  title={row.isDir ? row.path : `${row.path} · ${sizeWords(size)}`}
                  data-cut={liveCut !== null && (row.path === liveCut || row.path.startsWith(`${liveCut}/`)) ? 'true' : undefined}
                  data-drop={row.isDir && dropAt === row.path ? 'true' : undefined}
                  draggable={!busy && !row.isPrivate && !renaming}
                  style={{ paddingLeft: indentOf(row.depth) }}
                  onFocus={(event) => {
                    if (event.target === event.currentTarget) setCursor(row.path);
                  }}
                  onClick={() => {
                    if (renaming) return;
                    setCursor(row.path);
                    if (row.isDir) toggle(row);
                    else openFile(row.path);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (renaming) return;
                    openMenu(row, { x: event.clientX, y: event.clientY }, event.currentTarget);
                  }}
                  onDragStart={(event) => {
                    dragging.current = { path: row.path, isDir: row.isDir };
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', row.path);
                  }}
                  onDragEnd={() => {
                    dragging.current = null;
                    setDropAt(undefined);
                  }}
                >
                  <span className="st-tree-twist">{row.isDir && <Glyph name="chevron" size={12} />}</span>
                  {row.isDir ? (
                    <span className="st-tree-kind"><Glyph name={row.open ? 'folder-open' : 'folder'} /></span>
                  ) : picture ? (
                    <Thumbnail path={row.path} content={picture.content} />
                  ) : (
                    <span className="st-tree-kind" data-language={kind!.language ? 'true' : undefined}><Glyph name={kind!.glyph} /></span>
                  )}
                  {renaming ? nameBox(`New name for ${row.name}`) : (
                    <>
                      <span className="st-tree-name">
                        {dot > 0 ? (
                          <>
                            {row.name.slice(0, dot)}
                            <span className={kind?.language ? 'ext lang' : 'ext'}>{row.name.slice(dot)}</span>
                          </>
                        ) : row.name}
                      </span>
                      {/* Studio's own folder, said where it is listed: it is in the project and not in the bundle. */}
                      {row.isDir && row.depth === 0 && row.isPrivate && <span className="st-tree-tag">not exported</span>}
                      {isMain && <span className="st-tree-tag">main page</span>}
                      {isEmpty && <span className="st-tree-tag">empty</span>}
                      {row.isDir && !isEmpty && <span className="st-tree-meta" title={row.count === 1 ? '1 file' : `${row.count} files`}>{row.count}</span>}
                      {file && typeof file.content !== 'string' && <span className="st-tree-meta">{shortSize(size)}</span>}
                      <button
                        type="button"
                        className="st-files-tool st-tree-more"
                        // With the row in the tab order, so a keyboard without a menu key reaches the menu too.
                        tabIndex={row.path === stop ? 0 : -1}
                        aria-label={`More actions for ${row.name}`}
                        title="More"
                        aria-haspopup="menu"
                        aria-expanded={menu !== null && menu.path === row.path}
                        data-menu-opener
                        draggable={false}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (menu && menu.path === row.path) closeMenu(false);
                          else openMenu(row, below(event.currentTarget), event.currentTarget);
                        }}
                      >
                        <Glyph name="more" />
                      </button>
                    </>
                  )}
                </div>
                {renaming && hintRow(indentOf(row.depth) + 34)}
                {newAt && row.isDir && newAt.folder === row.path && newRow(row.depth + 1)}
              </React.Fragment>
            );
          })}
        </div>
      )}

      <div className="st-files-said" role="status" aria-live="polite">
        {notice && (
          <div className="st-files-notice" data-tone={notice.tone} data-long={notice.lines.length > 0 ? 'true' : undefined}>
            <div className="st-files-notice-text">
              {notice.headline ? <strong>{notice.text}</strong> : <span className="lead">{notice.text}</span>}
              {notice.lines.map((line, index) => <span key={index}>{line}</span>)}
            </div>
            {notice.undo && (
              <button type="button" className="st-btn st-btn-sm" aria-disabled={busy || undefined} title={busy ? BUSY_NOTE : 'Take this back'} onClick={() => undo(notice.undo!)}>
                <Glyph name="undo" size={13} />
                Undo
              </button>
            )}
            <button type="button" className="st-files-tool" aria-label="Dismiss" title="Dismiss" onClick={() => setNotice(null)}>
              <Glyph name="close" size={13} />
            </button>
          </div>
        )}
      </div>
      {!nothingYet && summary}

      {menu && (
        <FileMenu
          title={menuRow ? menuRow.path : 'Project files'}
          items={itemsFor(menuRow)}
          place={menu.place}
          note={busy ? BUSY_NOTE : null}
          onClose={closeMenu}
        />
      )}

      {ask && (
        <div className="st-files-ask-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) closeAsk(false); }}>
          <div
            className="st-files-ask"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={askTitleId}
            aria-describedby={askBodyId}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') {
                event.preventDefault();
                closeAsk(false);
              } else if (event.key === 'Tab') {
                // Two buttons, and the focus stays between them while the question stands.
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button'));
                const at = buttons.indexOf(document.activeElement as HTMLElement);
                event.preventDefault();
                buttons[(at + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
              }
            }}
          >
            <h3 id={askTitleId}>{ask.title}</h3>
            <div id={askBodyId}>
              {ask.lines.map((line, index) => <p key={index}>{line}</p>)}
            </div>
            <div className="st-files-ask-actions">
              <button ref={cancelRef} type="button" className="st-btn st-btn-sm" onClick={() => closeAsk(false)}>Cancel</button>
              <button type="button" className="st-btn st-btn-sm st-btn-danger" onClick={() => closeAsk(true)}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
