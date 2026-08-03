import { create } from 'zustand';
import type { VFSFile, VFSEvent } from '../types/studio';

interface VFSState {
  files: Map<string, VFSFile>;
  history: VFSEvent[];
  undoStack: VFSEvent[];

  createFile(path: string, content: string | Uint8Array, source?: 'user' | 'ai'): void;
  batchCreateFiles(entries: Array<{ path: string; content: string | Uint8Array }>, source?: 'user' | 'ai'): void;
  /** Restore a saved project without recording it as work the user just did. */
  hydrateFiles(entries: Array<{ path: string; content: string | Uint8Array }>): void;
  updateFile(path: string, content: string | Uint8Array, source?: 'user' | 'ai'): void;
  patchFile(path: string, search: string, replace: string, source?: 'user' | 'ai'): boolean;
  deleteFile(path: string, source?: 'user' | 'ai'): void;
  readFile(path: string): string | Uint8Array | null;
  listFiles(prefix?: string): string[];
  getSnapshot(): Map<string, VFSFile>;
  undoLast(): void;
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

const MAX_HISTORY = 200;

function capHistory(history: VFSEvent[]): VFSEvent[] {
  return history.length > MAX_HISTORY ? history.slice(-MAX_HISTORY) : history;
}

function snapshotContent(content: VFSFile['content'] | undefined): VFSFile['content'] | undefined {
  return content instanceof Uint8Array ? content.slice() : content;
}

export const useVFSStore = create<VFSState>((set, get) => ({
  files: new Map(),
  history: [],
  undoStack: [],

  createFile(path, content, source = 'user') {
    set((s) => {
      const files = new Map(s.files);
      const file: VFSFile = {
        path,
        content,
        mimeType: mimeFor(path),
        lastModified: Date.now(),
        lastModifiedBy: source,
        version: 1,
      };
      files.set(path, file);
      const event: VFSEvent = { type: 'create', path, timestamp: Date.now(), source };
      return { files, history: capHistory([...s.history, event]) };
    });
  },

  hydrateFiles(entries) {
    // Restoring a saved project is not something the user did, so it is not
    // something they can undo. batchCreateFiles was used for this, and it
    // records a `create` event per file — so after a reload the History panel
    // listed the whole project as recent work and three presses of Undo deleted
    // it, file by file, with the project having existed a moment earlier and no
    // way back. The files are placed; the history starts empty, because nothing
    // has happened yet in this session.
    set(() => {
      const files = new Map<string, VFSFile>();
      const now = Date.now();
      for (const { path, content } of entries) {
        files.set(path, {
          path,
          content,
          mimeType: mimeFor(path),
          lastModified: now,
          lastModifiedBy: 'user',
          version: 1,
        });
      }
      return { files, history: [], undoStack: [] };
    });
  },

  batchCreateFiles(entries, source = 'user') {
    set((s) => {
      const files = new Map(s.files);
      const events: VFSEvent[] = [...s.history];
      const now = Date.now();
      for (const { path, content } of entries) {
        files.set(path, {
          path,
          content,
          mimeType: mimeFor(path),
          lastModified: now,
          lastModifiedBy: source,
          version: 1,
        });
        events.push({ type: 'create', path, timestamp: now, source });
      }
      return { files, history: capHistory(events) };
    });
  },

  updateFile(path, content, source = 'user') {
    set((s) => {
      const files = new Map(s.files);
      const existing = files.get(path);
      const prev = existing?.content;
      const file: VFSFile = {
        path,
        content,
        mimeType: mimeFor(path),
        lastModified: Date.now(),
        lastModifiedBy: source,
        version: (existing?.version ?? 0) + 1,
      };
      files.set(path, file);
      const event: VFSEvent = {
        type: 'update',
        path,
        timestamp: Date.now(),
        source,
        previousContent: snapshotContent(prev),
      };
      return { files, history: capHistory([...s.history, event]) };
    });
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
    set((s) => {
      const files = new Map(s.files);
      const existing = files.get(path);
      if (!existing) return s;
      files.delete(path);
      const event: VFSEvent = {
        type: 'delete',
        path,
        timestamp: Date.now(),
        source,
        previousContent: snapshotContent(existing.content),
      };
      return { files, history: capHistory([...s.history, event]) };
    });
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
      const last = s.history[s.history.length - 1];
      const files = new Map(s.files);
      if (last.type === 'create') {
        files.delete(last.path);
      } else if (last.type === 'delete' && last.previousContent !== undefined) {
        // Re-create the deleted file
        files.set(last.path, {
          path: last.path,
          content: last.previousContent,
          mimeType: mimeFor(last.path),
          lastModified: Date.now(),
          lastModifiedBy: 'user',
          version: 1,
        });
      } else if (last.previousContent !== undefined) {
        const existing = files.get(last.path);
        if (existing) {
          files.set(last.path, { ...existing, content: last.previousContent });
        }
      }
      return {
        files,
        history: s.history.slice(0, -1),
        undoStack: [...s.undoStack, last],
      };
    });
  },

  revertAIChanges() {
    set((s) => {
      const files = new Map(s.files);
      const remaining: VFSEvent[] = [];
      // Walk backwards, undo all consecutive AI events
      const reversed = [...s.history].reverse();
      let undoing = true;
      for (const ev of reversed) {
        if (undoing && ev.source === 'ai') {
          if (ev.type === 'create') {
            files.delete(ev.path);
          } else if (ev.type === 'delete' && ev.previousContent !== undefined) {
            // Re-create the deleted file
            files.set(ev.path, {
              path: ev.path,
              content: ev.previousContent,
              mimeType: mimeFor(ev.path),
              lastModified: Date.now(),
              lastModifiedBy: 'user',
              version: 1,
            });
          } else if (ev.previousContent !== undefined) {
            const existing = files.get(ev.path);
            if (existing) {
              files.set(ev.path, { ...existing, content: ev.previousContent });
            }
          }
        } else {
          undoing = false;
          remaining.unshift(ev);
        }
      }
      return { files, history: remaining };
    });
  },

  reset() {
    set({ files: new Map(), history: [], undoStack: [] });
  },
}));
