/**
 * History Store - Manages undo/redo history
 */

import { create } from 'zustand';
import type { CanvasElement, HistoryEntry } from '../types/builder';

interface HistoryStore {
  past: HistoryEntry[];
  future: HistoryEntry[];
  maxSize: number;

  // Actions
  push: (elements: Map<string, CanvasElement>, rootId: string) => void;
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

  push: (elements, rootId) => {
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
      };
    });
  },

  undo: (current) => {
    const state = get();
    if (state.past.length === 0) return null;

    const previous = state.past[state.past.length - 1];

    set((state) => ({
      past: state.past.slice(0, -1),
      // The state being left, not the one being restored. Pushing `previous`
      // here made redo hand back where it already was, so the newest state was
      // unrecoverable while Redo stayed enabled.
      future: [current, ...state.future],
    }));

    return previous;
  },

  redo: (current) => {
    const state = get();
    if (state.future.length === 0) return null;

    const next = state.future[0];

    set((state) => ({
      past: [...state.past, current],
      future: state.future.slice(1),
    }));

    return next;
  },

  clear: () => {
    set({ past: [], future: [] });
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
