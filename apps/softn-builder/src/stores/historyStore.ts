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
  undo: () => HistoryEntry | null;
  redo: () => HistoryEntry | null;
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

  undo: () => {
    const state = get();
    if (state.past.length === 0) return null;

    const previous = state.past[state.past.length - 1];

    set((state) => {
      const newPast = state.past.slice(0, -1);
      return {
        past: newPast,
        future: [previous, ...state.future],
      };
    });

    // Return the state to restore (the entry we just removed from past)
    return previous;
  },

  redo: () => {
    const state = get();
    if (state.future.length === 0) return null;

    const next = state.future[0];

    set((state) => ({
      past: [...state.past, next],
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
