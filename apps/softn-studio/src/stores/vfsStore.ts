import { create } from 'zustand';
import type { VFSFile, VFSEvent } from '../types/studio';
import { findAlias, resolveProjectPath } from '../lib/paths';

/**
 * A record in a transaction: one file, one operation. A create must not
 * find the path; an update or delete must. The store checks every record
 * before it touches anything, so a transaction is all or nothing.
 */
export interface VFSChangeRecord {
  op: 'create' | 'update' | 'delete';
  path: string;
  content?: string | Uint8Array;
}

export type RevertResult = { ok: true; paths: string[] } | { ok: false; reason: string };

interface VFSState {
  files: Map<string, VFSFile>;
  history: VFSEvent[];
  /** Undone units, most recent last, each event carrying its after-image so redo is exact. */
  undoStack: VFSEvent[];
  /**
   * The highest version each path has held in this session, kept across a
   * delete. A version is what an AI reply is checked against: the reply
   * carries the version it was built on, and the write is refused when the
   * file's version differs. A re-created file used to start at v1 again —
   * the number a reply built on the original v1 carried — so the check
   * passed and the reply replaced content the model had never seen. The
   * floor makes every version a path is given higher than any it has had,
   * and neither undo nor redo lowers it.
   */
  versionFloor: Map<string, number>;

  /** Create a file. Throws if the path exists: an overwrite is an update, and is recorded as one. */
  createFile(path: string, content: string | Uint8Array, source?: 'user' | 'ai'): void;
  /** Create many files as one undo unit — an import is one thing that happened, not hundreds. */
  batchCreateFiles(entries: Array<{ path: string; content: string | Uint8Array }>, source?: 'user' | 'ai'): void;
  /** Restore a saved project without recording it as work the user just did. */
  hydrateFiles(entries: Array<{ path: string; content: string | Uint8Array }>): void;
  /** Replace a file's content. Throws if the path does not exist: there is no before-image to keep. */
  updateFile(path: string, content: string | Uint8Array, source?: 'user' | 'ai'): void;
  patchFile(path: string, search: string, replace: string, source?: 'user' | 'ai'): boolean;
  deleteFile(path: string, source?: 'user' | 'ai'): void;
  /**
   * Apply records as one unit under one id: every record is checked first,
   * and an invalid one means nothing is written. Returns the id.
   */
  applyTransaction(records: VFSChangeRecord[], source?: 'user' | 'ai', transactionId?: string): string;
  /**
   * Put back what one transaction changed, wherever it sits in the history,
   * provided nothing later touched the same files. Not redoable.
   */
  revertTransaction(transactionId: string): RevertResult;
  readFile(path: string): string | Uint8Array | null;
  listFiles(prefix?: string): string[];
  getSnapshot(): Map<string, VFSFile>;
  /** Undo the most recent unit, whole. */
  undoLast(): void;
  /** Redo the most recently undone unit, whole. Unavailable once a new edit follows an undo. */
  redoLast(): void;
  /** Undo every trailing unit an AI turn made, stopping at the first unit that was not. */
  revertAIChanges(): void;
  reset(): void;
}

function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ui: 'text/x-softn-ui',
    logic: 'text/x-softn-logic',
    xdb: 'application/json',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    svg: 'image/svg+xml',
    md: 'text/markdown',
  };
  return map[ext] ?? 'application/octet-stream';
}

export const MAX_HISTORY = 200;

/**
 * Trim history to the cap by dropping whole units from the oldest end. A
 * unit is never cut in the middle: an undo that put back half an AI turn
 * would be worse than no undo. If the newest unit is itself larger than the
 * cap it stays whole and the cap is exceeded for as long as it is the only
 * unit left.
 */
function pruneHistory(history: VFSEvent[]): VFSEvent[] {
  let start = 0;
  while (history.length - start > MAX_HISTORY) {
    const end = unitEnd(history, start);
    if (end >= history.length) break;
    start = end;
  }
  return start === 0 ? history : history.slice(start);
}

/** The index one past the unit that begins at `start`. */
function unitEnd(events: VFSEvent[], start: number): number {
  const id = events[start].transactionId;
  let end = start + 1;
  if (id === undefined) return end;
  while (end < events.length && events[end].transactionId === id) end++;
  return end;
}

/** The index where the unit that ends at the tail of `events` begins. */
function unitStart(events: VFSEvent[]): number {
  const id = events[events.length - 1].transactionId;
  let start = events.length - 1;
  if (id === undefined) return start;
  while (start > 0 && events[start - 1].transactionId === id) start--;
  return start;
}

function snapshotContent(content: VFSFile['content']): VFSFile['content'] {
  return content instanceof Uint8Array ? content.slice() : content;
}

/** A copy of a file that shares no buffer with the store or the caller. */
function snapshotFile(file: VFSFile): VFSFile {
  return { ...file, content: snapshotContent(file.content) };
}

/** The next version for `path`: above what it has now and above anything it has had. The floor is raised in place. */
function nextVersion(floor: Map<string, number>, path: string, existing: VFSFile | undefined): number {
  const version = Math.max(existing?.version ?? 0, floor.get(path) ?? 0) + 1;
  floor.set(path, version);
  return version;
}

function newTransactionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Apply the inverse of one event to `files`. */
function undoEvent(files: Map<string, VFSFile>, event: VFSEvent, floor: Map<string, number>): void {
  if (event.type === 'create') {
    files.delete(event.path);
  } else if (event.previous) {
    files.set(event.path, snapshotFile(event.previous));
  } else if (event.type === 'delete' && event.previousContent !== undefined) {
    // An event recorded before before-images carried metadata.
    files.set(event.path, {
      path: event.path,
      content: snapshotContent(event.previousContent),
      mimeType: mimeFor(event.path),
      lastModified: Date.now(),
      lastModifiedBy: 'user',
      version: nextVersion(floor, event.path, undefined),
    });
  } else if (event.previousContent !== undefined) {
    const existing = files.get(event.path);
    if (existing) files.set(event.path, { ...existing, content: snapshotContent(event.previousContent) });
  }
}

/**
 * Undo the unit at the tail of `history`, in place on `files`. Returns the
 * unit's events with their after-images, in original order, for the redo
 * stack.
 */
function undoTailUnit(files: Map<string, VFSFile>, history: VFSEvent[], floor: Map<string, number>): VFSEvent[] {
  const start = unitStart(history);
  const unit = history.splice(start);
  const undone: VFSEvent[] = unit.map((event) => {
    const current = files.get(event.path);
    return current ? { ...event, after: snapshotFile(current) } : { ...event, after: undefined };
  });
  for (let i = unit.length - 1; i >= 0; i--) undoEvent(files, unit[i], floor);
  return undone;
}

/**
 * Validate records against `files` without touching them; the message names
 * the first problem. A create must be a canonical project path that is not
 * another spelling of a file already there: the store is the last place a
 * path is checked before it exists, so it checks.
 */
function checkRecords(files: Map<string, VFSFile>, records: VFSChangeRecord[]): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.path)) throw new Error(`Transaction names ${record.path} more than once`);
    seen.add(record.path);
    const exists = files.has(record.path);
    if (record.op === 'create') {
      if (exists) throw new Error(`createFile: ${record.path} already exists`);
      if (record.content === undefined) throw new Error(`createFile: ${record.path} has no content`);
      const verdict = resolveProjectPath(record.path);
      if (!verdict.ok) throw new Error(`createFile: ${JSON.stringify(record.path)} is not a project path: ${verdict.reason}`);
      if (verdict.path !== record.path) throw new Error(`createFile: ${JSON.stringify(record.path)} is not canonical; use ${verdict.path}`);
      const alias = findAlias(record.path, files.keys()) ?? findAlias(record.path, seen);
      if (alias !== null) throw new Error(`createFile: ${record.path} is the same file as ${alias} on a case-insensitive disk`);
    } else if (record.op === 'update') {
      if (!exists) throw new Error(`updateFile: no such file ${record.path}`);
      if (record.content === undefined) throw new Error(`updateFile: ${record.path} has no content`);
    } else if (!exists) {
      throw new Error(`deleteFile: no such file ${record.path}`);
    }
  }
}

export const useVFSStore = create<VFSState>((set, get) => ({
  files: new Map(),
  history: [],
  undoStack: [],
  versionFloor: new Map(),

  createFile(path, content, source = 'user') {
    get().applyTransaction([{ op: 'create', path, content }], source);
  },

  hydrateFiles(entries) {
    // Restoring a saved project is not something the user did, so it is not
    // something they can undo. batchCreateFiles was used for this, and it
    // records a `create` event per file — so after a reload the History panel
    // listed the whole project as recent work and three presses of Undo deleted
    // it, file by file, with the project having existed a moment earlier and no
    // way back. The files are placed; the history starts empty, because nothing
    // has happened yet in this session.
    set((s) => {
      const files = new Map<string, VFSFile>();
      const versionFloor = new Map(s.versionFloor);
      const now = Date.now();
      for (const { path, content } of entries) {
        files.set(path, {
          path,
          content,
          mimeType: mimeFor(path),
          lastModified: now,
          lastModifiedBy: 'user',
          version: nextVersion(versionFloor, path, undefined),
        });
      }
      return { files, history: [], undoStack: [], versionFloor };
    });
  },

  batchCreateFiles(entries, source = 'user') {
    get().applyTransaction(
      entries.map(({ path, content }) => ({ op: 'create' as const, path, content })),
      source,
    );
  },

  updateFile(path, content, source = 'user') {
    get().applyTransaction([{ op: 'update', path, content }], source);
  },

  patchFile(path, search, replace, source = 'user') {
    const existing = get().files.get(path);
    if (!existing || typeof existing.content !== 'string') return false;
    const idx = existing.content.indexOf(search);
    if (idx === -1) return false;
    const newContent = existing.content.replace(search, replace);
    get().updateFile(path, newContent, source);
    return true;
  },

  deleteFile(path, source = 'user') {
    // Deleting what is not there is nothing happening, and records nothing.
    if (!get().files.has(path)) return;
    get().applyTransaction([{ op: 'delete', path }], source);
  },

  applyTransaction(records, source = 'user', transactionId) {
    const id = transactionId ?? newTransactionId();
    checkRecords(get().files, records);
    set((s) => {
      const files = new Map(s.files);
      const versionFloor = new Map(s.versionFloor);
      const now = Date.now();
      const events: VFSEvent[] = [];
      for (const record of records) {
        const existing = files.get(record.path);
        if (record.op === 'delete') {
          files.delete(record.path);
          events.push({
            type: 'delete',
            path: record.path,
            timestamp: now,
            source,
            transactionId: id,
            previous: snapshotFile(existing!),
            previousContent: snapshotContent(existing!.content),
          });
          continue;
        }
        const content = record.content!;
        files.set(record.path, {
          path: record.path,
          content,
          mimeType: mimeFor(record.path),
          lastModified: now,
          lastModifiedBy: source,
          version: nextVersion(versionFloor, record.path, existing),
        });
        events.push(
          record.op === 'create'
            ? { type: 'create', path: record.path, timestamp: now, source, transactionId: id }
            : {
                type: 'update',
                path: record.path,
                timestamp: now,
                source,
                transactionId: id,
                previous: snapshotFile(existing!),
                previousContent: snapshotContent(existing!.content),
              },
        );
      }
      // A new edit after an undo makes the undone future unreachable: the
      // files it would restore are not the files that are there now.
      return { files, history: pruneHistory([...s.history, ...events]), undoStack: [], versionFloor };
    });
    return id;
  },

  revertTransaction(transactionId) {
    const s = get();
    const indices = s.history.map((e, i) => (e.transactionId === transactionId ? i : -1)).filter((i) => i >= 0);
    if (indices.length === 0) {
      return { ok: false, reason: 'This turn is no longer in the history: it was undone already, or the history was trimmed past it.' };
    }
    const paths = new Set(indices.map((i) => s.history[i].path));
    const first = indices[0];
    const inTurn = new Set(indices);
    for (let i = first + 1; i < s.history.length; i++) {
      if (inTurn.has(i)) continue;
      const later = s.history[i];
      if (paths.has(later.path)) {
        return { ok: false, reason: `${later.path} was edited after this turn. Undo that edit first, or revert by hand.` };
      }
    }
    set((state) => {
      const files = new Map(state.files);
      const versionFloor = new Map(state.versionFloor);
      for (let k = indices.length - 1; k >= 0; k--) undoEvent(files, state.history[indices[k]], versionFloor);
      const history = state.history.filter((_, i) => !inTurn.has(i));
      // The units after this one still restore correctly (they touch other
      // files), but the undone future no longer describes these files.
      return { files, history, undoStack: [], versionFloor };
    });
    return { ok: true, paths: [...paths] };
  },

  readFile(path) {
    return get().files.get(path)?.content ?? null;
  },

  listFiles(prefix) {
    const paths = Array.from(get().files.keys());
    if (!prefix) return paths;
    return paths.filter((p) => p.startsWith(prefix));
  },

  getSnapshot() {
    return new Map(get().files);
  },

  undoLast() {
    set((s) => {
      if (s.history.length === 0) return s;
      const files = new Map(s.files);
      const history = [...s.history];
      const versionFloor = new Map(s.versionFloor);
      const undone = undoTailUnit(files, history, versionFloor);
      return { files, history, undoStack: [...s.undoStack, ...undone], versionFloor };
    });
  },

  redoLast() {
    set((s) => {
      if (s.undoStack.length === 0) return s;
      const files = new Map(s.files);
      const undoStack = [...s.undoStack];
      const unit = undoStack.splice(unitStart(undoStack));
      const redone: VFSEvent[] = [];
      for (const event of unit) {
        if (event.after) files.set(event.path, snapshotFile(event.after));
        else files.delete(event.path);
        const { after: _after, ...rest } = event;
        redone.push(rest);
      }
      return { files, history: pruneHistory([...s.history, ...redone]), undoStack };
    });
  },

  revertAIChanges() {
    set((s) => {
      const files = new Map(s.files);
      const history = [...s.history];
      const versionFloor = new Map(s.versionFloor);
      const undone: VFSEvent[] = [];
      // Most recent unit undone first, so the redo stack's tail is the unit
      // to redo first: the oldest one undone here.
      while (history.length > 0 && history[history.length - 1].source === 'ai') {
        undone.push(...undoTailUnit(files, history, versionFloor));
      }
      if (undone.length === 0) return s;
      return { files, history, undoStack: [...s.undoStack, ...undone], versionFloor };
    });
  },

  reset() {
    // A reset is a project going away, and with it every version its files
    // had; the floor starts again for whatever is placed next.
    set({ files: new Map(), history: [], undoStack: [], versionFloor: new Map() });
  },
}));
