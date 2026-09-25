/**
 * History Store - Manages undo/redo history
 */

import { create } from 'zustand';
import { useProjectStore } from './projectStore';
import type { CanvasElement, HistoryEntry } from '../types/builder';

/**
 * How long a pause ends a run of edits to one field. Typing `handleSubmit()`
 * into a handler field was fourteen undo steps — a quarter of the history —
 * because the panel pushed one per keystroke; a run of edits to the same
 * field is one step now, ended by a pause this long, by leaving the field,
 * or by any other change.
 */
export const COALESCE_MS = 1000;

interface HistoryStore {
  past: HistoryEntry[];
  future: HistoryEntry[];
  maxSize: number;
  /** The key of the last push, while a run of edits under it may continue. */
  coalesceKey: string | null;
  /** When that run last saw an edit. */
  coalescedAt: number;

  // Actions
  /**
   * Record the state before an edit. With a `key` (one field of one
   * element), an edit that follows another under the same key within
   * {@link COALESCE_MS} joins its step instead of adding one: undo returns
   * to before the run began.
   */
  push: (elements: Map<string, CanvasElement>, rootId: string, key?: string) => void;
  /** End the current run, so the next keyed edit starts a step of its own. */
  endCoalescing: () => void;
  /**
   * Step back, handing over the state being left so it can be stepped into
   * again. Callers push *before* mutating, so the store never holds the
   * current state and has to be told it.
   */
  undo: (current: HistoryEntry) => HistoryEntry | null;
  redo: (current: HistoryEntry) => HistoryEntry | null;
  clear: () => void;

  // State checks
  canUndo: () => boolean;
  canRedo: () => boolean;

  // History size
  setMaxSize: (size: number) => void;
}

// Snapshot element map while preserving structural sharing of element objects.
function cloneElements(elements: Map<string, CanvasElement>): Map<string, CanvasElement> {
  return new Map(elements);
}

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  past: [],
  future: [],
  maxSize: 50,
  coalesceKey: null,
  coalescedAt: 0,

  push: (elements, rootId, key) => {
    const now = Date.now();
    const current = get();
    if (key !== undefined && current.coalesceKey === key && current.past.length > 0 && now - current.coalescedAt < COALESCE_MS) {
      set({ coalescedAt: now, future: [] });
      return;
    }

    const entry: HistoryEntry = {
      elements: cloneElements(elements),
      rootId,
      timestamp: Date.now(),
    };

    set((state) => {
      const newPast = [...state.past, entry];

      // Trim to max size
      while (newPast.length > state.maxSize) {
        newPast.shift();
      }

      return {
        past: newPast,
        future: [], // Clear future when new action is performed
        coalesceKey: key ?? null,
        coalescedAt: now,
      };
    });
  },

  undo: (current) => {
    const state = get();
    if (state.past.length === 0) return null;

    const previous = state.past[state.past.length - 1];

    set((state) => ({
      coalesceKey: null,
      past: state.past.slice(0, -1),
      // The state being left, not the one being restored. Pushing `previous`
      // here made redo hand back where it already was, so the newest state was
      // unrecoverable while Redo stayed enabled.
      future: [current, ...state.future],
    }));

    useProjectStore.getState().markDirty();
    return previous;
  },

  redo: (current) => {
    const state = get();
    if (state.future.length === 0) return null;

    const next = state.future[0];

    set((state) => ({
      coalesceKey: null,
      past: [...state.past, current],
      future: state.future.slice(1),
    }));

    useProjectStore.getState().markDirty();
    return next;
  },

  endCoalescing: () => {
    if (get().coalesceKey !== null) set({ coalesceKey: null });
  },

  clear: () => {
    set({ past: [], future: [], coalesceKey: null });
  },

  canUndo: () => {
    return get().past.length > 0;
  },

  canRedo: () => {
    return get().future.length > 0;
  },

  setMaxSize: (size) => {
    set((state) => {
      let newPast = state.past;
      while (newPast.length > size) {
        newPast = newPast.slice(1);
      }
      return { maxSize: size, past: newPast };
    });
  },
}));
