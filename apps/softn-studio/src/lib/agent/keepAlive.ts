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
 * behind it. It carries the run's id as well, which is how another tab with
 * the same project open knows the run is being worked on (see the end of
 * this file).
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
      void locks.request(`${RUN_LOCK_NAME}:${tabId}:${runId}`, { mode: 'exclusive' }, () => held).catch(() => {});
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

// --- Runs that are another tab's ---------------------------------------------

/**
 * A run is a chat message, saved with the project, and a tab takes in what
 * another tab saves as it is saved (lib/projectSession.ts). So a run one tab
 * is driving shows in every tab that has the project open, and those tabs do
 * not drive it. Without this they took it for a run their own reload had cut
 * short: "Stopped", with Continue, which starts a second agent on the same
 * files while the first is still at work, or still to be resumed.
 *
 * Two ways of knowing. The lock above, which a tab holds while its run works
 * or waits for the person and which names the run: asked for when a timeline
 * shows such a run, and again every few seconds while it does, so that a tab
 * that has been closed stops counting. And what a save of another tab's
 * brought in: a run still open in it is that tab's from that moment. This is
 * all there is for a run that tab has paused, which holds no lock, and all
 * there is anywhere the browser has no Web Locks (a page not served
 * securely). A paused run so known stays that tab's until a save says it has
 * ended or this page is loaded again; one first met when the project is
 * opened cannot be told from one a reload cut short, and is taken for that.
 */

/** How often the locks are asked for while a run that may be another tab's is on screen. */
export const RUNS_ELSEWHERE_ASKED_EVERY_MS = 3_000;

/** A run another tab is driving: at work there (or waiting for the person), or paused there. */
export type RunElsewhere = 'working' | 'paused';

/** Runs other tabs hold their pages for, as the locks last said. */
let locked: ReadonlySet<string> = new Set();
/** Runs a save of another tab's brought in while they were still open there. */
const seen = new Map<string, RunElsewhere>();
const watchers = new Set<() => void>();
let asking: ReturnType<typeof setInterval> | null = null;

function tellWatchers(): void {
  for (const watcher of watchers) watcher();
}

/** How another tab holds `runId`, as last known, or null when none is known to. */
export function runInAnotherTab(runId: string): RunElsewhere | null {
  return locked.has(runId) ? 'working' : seen.get(runId) ?? null;
}

/** A run a save of another tab's brought in, as that tab left it: open there, or ended. */
export function noteRunFromAnotherTab(runId: string, state: RunElsewhere | 'ended'): void {
  if ((state === 'ended' ? undefined : state) === seen.get(runId)) return;
  if (state === 'ended') seen.delete(runId);
  else seen.set(runId, state);
  tellWatchers();
}

/** Ask which runs other tabs hold their pages for. Where there are no locks to ask, what is known stays. */
async function askForRunsElsewhere(): Promise<void> {
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks || typeof locks.query !== 'function') return;
  try {
    const { held } = await locks.query();
    const mine = `${RUN_LOCK_NAME}:${tabId}:`;
    const next = new Set<string>();
    for (const lock of held ?? []) {
      const name = lock.name ?? '';
      if (!name.startsWith(`${RUN_LOCK_NAME}:`) || name.startsWith(mine)) continue;
      // After the name and the tab's id; a run's id is taken whole, colons and all.
      const runId = name.slice(RUN_LOCK_NAME.length + 1).split(':').slice(1).join(':');
      if (runId) next.add(runId);
    }
    let changed = next.size !== locked.size || [...next].some((id) => !locked.has(id));
    locked = next;
    // A run seen at work whose lock is gone: its tab was closed, or has paused or ended it,
    // which that tab's next save says.
    for (const [runId, state] of seen) {
      if (state !== 'working' || next.has(runId)) continue;
      seen.delete(runId);
      changed = true;
    }
    if (changed) tellWatchers();
  } catch {
    // The locks could not be asked: what is known stays.
  }
}

/**
 * Be told when what is known of other tabs' runs changes, and keep it
 * current for as long as anyone is listening. Returns the way to stop.
 */
export function watchRunsInOtherTabs(watcher: () => void): () => void {
  watchers.add(watcher);
  if (watchers.size === 1) {
    void askForRunsElsewhere();
    asking = setInterval(() => void askForRunsElsewhere(), RUNS_ELSEWHERE_ASKED_EVERY_MS);
  }
  return () => {
    watchers.delete(watcher);
    if (watchers.size === 0 && asking !== null) {
      clearInterval(asking);
      asking = null;
    }
  };
}
