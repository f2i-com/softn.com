import { create } from 'zustand';

/**
 * What was copied or cut in the Files panel, waiting to be pasted.
 *
 * Kept in a store, not in the panel: the rail shows one panel at a time, so a
 * file copied before looking at History would have been forgotten by the time
 * the Files panel was back. It is this panel's own clipboard, not the
 * computer's: a browser page cannot put a file on that. The path is written
 * there as text when the browser allows, so it can be pasted into the chat.
 */
export interface FileClip {
  mode: 'copy' | 'cut';
  path: string;
  isDir: boolean;
  /** The project it was taken in: what was copied in one project is not pasted into another. */
  projectId: string | null;
}

interface FilesPanelState {
  clip: FileClip | null;
  setClip(clip: FileClip | null): void;
}

export const useFilesPanelStore = create<FilesPanelState>((set) => ({
  clip: null,
  setClip: (clip) => set({ clip }),
}));
