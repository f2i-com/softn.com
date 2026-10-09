import { create } from 'zustand';

/**
 * A file being edited by hand: what the person has typed, and what the file
 * was when they began. The file's version and text at that moment are what a
 * save is checked against (lib/handEdit.ts): the agent, or this project open
 * in another tab, may write the file while the draft is open, and a save must
 * never put the draft over a write it was not made from.
 *
 * Kept in a store, not in the editor, so that it outlasts the editor: a run
 * starting, a panel opening or the canvas redrawing does not lose what was
 * typed, and anything that would take the person away from it can ask first.
 */
export interface HandDraft {
  path: string;
  text: string;
  /** The file's version when editing began (or when the file was last reloaded into the draft). */
  baseVersion: number;
  /** Its text then. */
  baseText: string;
}

interface EditState {
  draft: HandDraft | null;
  open(draft: HandDraft): void;
  change(text: string): void;
  close(): void;
}

export const useEditStore = create<EditState>((set) => ({
  draft: null,
  open: (draft) => set({ draft }),
  change: (text) => set((s) => (s.draft && s.draft.text !== text ? { draft: { ...s.draft, text } } : s)),
  close: () => set((s) => (s.draft ? { draft: null } : s)),
}));

/** Whether there is a draft with something in it that is not in the file. */
export function hasUnsavedDraft(): boolean {
  const draft = useEditStore.getState().draft;
  return draft !== null && draft.text !== draft.baseText;
}

// Closing the tab or reloading the page would lose a draft that is not saved: the browser
// asks. Asked from here and not from the editor, which is not on the page whenever the canvas
// is not (a phone shows one panel at a time), while the draft still is.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (!hasUnsavedDraft()) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
