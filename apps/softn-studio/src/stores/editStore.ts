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
  change: (typed) =>
    set((s) => {
      if (!s.draft) return s;
      // A text box hands its text back with \n alone, whatever the file had: a save of one word
      // in a file written with \r\n wrote every line of it again with the other ending. The
      // draft is kept in the file's own, as the agent's edit_file keeps it (executeTool.ts).
      const text = inEndingsOf(s.draft.baseText, typed);
      return s.draft.text !== text ? { draft: { ...s.draft, text } } : s;
    }),
  close: () => set((s) => (s.draft ? { draft: null } : s)),
}));

let endingsOf: { base: string; shown: string; crlf: boolean } | null = null;

/**
 * What was typed (with \n alone) in the endings of the file it was made from, `base`. What the
 * box showed of the file is the file, whatever its endings. Otherwise a file whose endings are
 * mixed is written with the one most of its lines have, so only its odd lines change: taken as
 * \r\n for any \r\n in it, a file of \n lines with one \r\n line pasted in was written again
 * whole, and a word typed and taken back again was a change to save. Worked out once for the
 * draft's file, not on every key.
 */
function inEndingsOf(base: string, typed: string): string {
  if (endingsOf?.base !== base) {
    let crlf = 0;
    let lf = 0;
    for (let at = base.indexOf('\n'); at !== -1; at = base.indexOf('\n', at + 1)) {
      if (base.charCodeAt(at - 1) === 13) crlf++;
      else lf++;
    }
    endingsOf = { base, shown: asTyped(base), crlf: crlf > lf };
  }
  if (typed === endingsOf.shown) return base;
  return endingsOf.crlf ? typed.replace(/\r?\n/g, '\r\n') : typed;
}

/**
 * A draft's text as a text box holds it: with \n alone. Given the \r\n the draft keeps, React
 * would find the box different on every redraw and write it again, which takes the browser's
 * own Undo in it away.
 */
export function asTyped(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

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
