/**
 * The questions the Builder asks before it does what cannot be taken back,
 * answered in its own dialog (components/feedback/ConfirmDialog.tsx), the same
 * in a browser and in the desktop app.
 *
 * They were `window.confirm`, and in the desktop app nothing was ever asked.
 * Tauri's dialog plugin replaces `window.confirm` with an async function that
 * returns a Promise, and the Builder's window has no dialog permission, so
 * the promise was refused while every caller read the promise itself as a
 * yes: Open and New over unsaved work, deleting a file, a folder or a
 * collection, re-identifying records and the session restore all went ahead
 * without a word. (On v0.0.19, which had the permission, the question showed
 * after the action had been taken.) These questions protect the person from
 * their own click, not from the page, so the page asks them itself.
 *
 * An ask waits in a queue until the dialog is there to show it: one made at
 * startup, before the dialog mounted, is shown when it does, and two made at
 * once are shown one after the other. Each promise settles exactly once.
 */
import { create } from 'zustand';

export interface ConfirmOptions {
  /** The dialog's heading; the message says the rest. */
  title?: string;
  /** The words on the button that goes ahead. */
  confirmLabel?: string;
  /** The words on the button that does not. */
  cancelLabel?: string;
  /** Going ahead loses something: the focus starts on the way back. */
  danger?: boolean;
}

export interface ConfirmRequest {
  id: number;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
}

interface Pending extends ConfirmRequest {
  resolve: (yes: boolean) => void;
}

interface ConfirmState {
  queue: Pending[];
}

export const useConfirmStore = create<ConfirmState>(() => ({ queue: [] }));

let nextId = 1;

/** Ask, and hear yes (true) or no (false). Escape, the overlay and Cancel are no. */
export function askConfirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const request: Pending = {
      id: nextId++,
      title: options.title ?? 'Are you sure?',
      message,
      confirmLabel: options.confirmLabel ?? 'OK',
      cancelLabel: options.cancelLabel ?? 'Cancel',
      danger: options.danger ?? false,
      resolve,
    };
    useConfirmStore.setState((state) => ({ queue: [...state.queue, request] }));
  });
}

/** Answer the ask `id`, once: a second answer, or one for an ask that is gone, does nothing. */
export function answerConfirm(id: number, yes: boolean): void {
  const request = useConfirmStore.getState().queue.find((pending) => pending.id === id);
  if (!request) return;
  useConfirmStore.setState((state) => ({ queue: state.queue.filter((pending) => pending.id !== id) }));
  request.resolve(yes);
}

/** The ask on the screen, if any. */
export function currentConfirm(): ConfirmRequest | null {
  const head = useConfirmStore.getState().queue[0];
  if (!head) return null;
  const { resolve: _resolve, ...request } = head;
  return request;
}
