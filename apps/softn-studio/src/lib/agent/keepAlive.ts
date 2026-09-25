/**
 * Keeping the page alive while a run works.
 *
 * A run lives in this page's memory: its conversation, its pending calls, the
 * request in flight. A browser that freezes or discards a background tab —
 * Chrome's Memory Saver does both — ends it as surely as a reload does. While
 * a run is active the page therefore holds a Web Lock, which Chrome does not
 * freeze or proactively discard a tab for, and asks before it is closed or
 * reloaded. Both are let go the moment the run stops, pauses or ends.
 *
 * The lock's name carries this tab's own id: an exclusive lock that another
 * Studio tab already held would leave this one queued — and unprotected —
 * behind it.
 *
 * Whether the tab was in the background is written to sessionStorage, which
 * outlives a reload of the same tab, so a run found interrupted after a
 * reload can say whether the browser, rather than the person, reloaded it.
 */

export const RUN_LOCK_NAME = 'softn-studio-agent-run';
const HIDDEN_KEY = 'softn-studio:agent-run-hidden';

const tabId = Math.random().toString(36).slice(2, 10);

interface Hold {
  runId: string;
  releaseLock: () => void;
  onBeforeUnload: (event: BeforeUnloadEvent) => void;
  onVisibility: () => void;
  onPageHide: () => void;
}

let hold: Hold | null = null;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function noteHidden(runId: string, hidden: boolean): void {
  const store = storage();
  if (!store) return;
  try {
    if (hidden) store.setItem(HIDDEN_KEY, JSON.stringify({ runId, at: Date.now() }));
    else store.removeItem(HIDDEN_KEY);
  } catch {
    // Storage may be full or blocked; the note is only a courtesy.
  }
}

/** Hold the page for `runId`: a Web Lock and a prompt before unload. Holding it again is a no-op. */
export function holdPageForRun(runId: string): void {
  if (hold?.runId === runId) return;
  releasePageForRun();
  let resolve: () => void = () => {};
  const held = new Promise<void>((r) => {
    resolve = r;
  });
  try {
    const locks = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks && typeof locks.request === 'function') {
      void locks.request(`${RUN_LOCK_NAME}:${tabId}`, { mode: 'exclusive' }, () => held).catch(() => {});
    }
  } catch {
    // No Web Locks here: the prompt below is all the protection there is.
  }
  // A page being unloaded turns hidden on its way out, and browsers disagree on whether that comes
  // before or after pagehide; beforeunload comes first everywhere, so whether the tab was in the
  // background is settled there, and what follows is ignored. A tab the browser discards gets no
  // beforeunload, and keeps the note it wrote when it went to the background.
  let unloading = false;
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    noteHidden(runId, typeof document !== 'undefined' && document.visibilityState === 'hidden');
    unloading = true;
    event.preventDefault();
    // Older browsers show the prompt only when returnValue is set.
    event.returnValue = '';
  };
  const onPageHide = () => {
    unloading = true;
  };
  const onVisibility = () => {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    // A page seen again was not unloaded after all (the person stayed when asked).
    if (!hidden) unloading = false;
    if (!unloading) noteHidden(runId, hidden);
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
  }
  hold = { runId, releaseLock: resolve, onBeforeUnload, onVisibility, onPageHide };
}

/** Let the page go: the run is no longer active. */
export function releasePageForRun(runId?: string): void {
  if (!hold || (runId !== undefined && hold.runId !== runId)) return;
  const current = hold;
  hold = null;
  current.releaseLock();
  if (typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', current.onBeforeUnload);
    window.removeEventListener('pagehide', current.onPageHide);
  }
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', current.onVisibility);
  noteHidden(current.runId, false);
}

/** The run the page is held for, if any. */
export function heldForRun(): string | null {
  return hold?.runId ?? null;
}

/** Whether `runId` was running in a background tab when the page went away. */
export function wasInBackground(runId: string): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const raw = store.getItem(HIDDEN_KEY);
    if (!raw) return false;
    const note = JSON.parse(raw) as { runId?: unknown };
    return note.runId === runId;
  } catch {
    return false;
  }
}
