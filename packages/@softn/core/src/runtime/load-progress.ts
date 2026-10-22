/**
 * What the page is downloading to run its apps, for a host to show while it
 * waits: the app's bundle, the script engine, the torch package, and the
 * on-demand components (docs/engineering/COMPONENT_LOADING.md).
 *
 * One list for the page. Each download is an item under an id that says what
 * it is (`engine`, `bundle:<address>`, `components:charts`): its bytes so far
 * and, when they are known, its total. A component's chunk is reached through
 * import(), which tells nothing of its bytes, so it has no total; it is there
 * to be named. Starting an id that is already in flight joins it, and it is
 * done when every start has finished; starting it again once done begins it
 * afresh (a retry).
 *
 * Listeners are told at most once an animation frame, however many chunks
 * arrive: a 6.5 MB engine is hundreds of them.
 */

export interface LoadProgressItem {
  id: string;
  /** What the download is, as the host may name it: `engine`, `bundle`, `torch`, or a component feature. */
  kind: 'engine' | 'bundle' | 'torch' | 'components';
  /** For a component chunk, its feature (`charts`, `controls`, …); for a bundle, the app's name if known. */
  name?: string;
  /** Bytes so far: 0 for what is not counted in bytes. */
  loaded: number;
  /** Bytes in all, when known. */
  total?: number;
  done: boolean;
  failed: boolean;
  /** performance.now() when it started. */
  startedAt: number;
}

export interface LoadProgressHandle {
  /** Count `bytes` more as arrived. */
  advance(bytes: number): void;
  /** This start is over; the item is done when every start of it is. */
  finish(): void;
  /** This start failed; the item is done, and failed. */
  fail(): void;
}

interface Tracked {
  item: LoadProgressItem;
  pending: number;
}

/** The downloads kept at most; finished ones beyond it are forgotten, oldest first. */
const MAX_ITEMS = 64;
const tracked = new Map<string, Tracked>();
const listeners = new Set<() => void>();
let snapshot: readonly LoadProgressItem[] = [];
/** Cancels the notice scheduled for the next frame, while there is one. */
let scheduled: (() => void) | null = null;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function notify(): void {
  snapshot = [...tracked.values()].map((entry) => entry.item);
  if (scheduled) return;
  const run = () => {
    scheduled = null;
    for (const listener of [...listeners]) listener();
  };
  if (typeof requestAnimationFrame === 'function') {
    const frame = requestAnimationFrame(run);
    scheduled = () => cancelAnimationFrame(frame);
  } else {
    const timer = setTimeout(run, 16);
    scheduled = () => clearTimeout(timer);
  }
}

/**
 * Begin (or join) a download. `total` is its size in bytes, when known.
 */
export function trackLoad(
  id: string,
  kind: LoadProgressItem['kind'],
  options: { name?: string; total?: number } = {}
): LoadProgressHandle {
  let entry = tracked.get(id);
  if (!entry || entry.item.done) {
    // A long session opens many apps: what finished longest ago goes first.
    if (!entry && tracked.size >= MAX_ITEMS) {
      for (const [key, old] of tracked) {
        if (tracked.size < MAX_ITEMS) break;
        if (old.item.done) tracked.delete(key);
      }
    }
    entry = {
      item: { id, kind, name: options.name, loaded: 0, total: options.total, done: false, failed: false, startedAt: now() },
      pending: 0,
    };
    tracked.set(id, entry);
  }
  const current = entry;
  current.pending++;
  let over = false;
  notify();
  const update = (change: Partial<LoadProgressItem>) => {
    // A start that belongs to an item since replaced (a retry) changes nothing.
    if (tracked.get(id) !== current) return;
    current.item = { ...current.item, ...change };
    notify();
  };
  return {
    advance(bytes) {
      if (over || !(bytes > 0)) return;
      update({ loaded: current.item.loaded + bytes });
    },
    finish() {
      if (over) return;
      over = true;
      current.pending--;
      if (current.pending === 0) update({ done: true, loaded: Math.max(current.item.loaded, current.item.total ?? 0) });
    },
    fail() {
      if (over) return;
      over = true;
      current.pending--;
      update({ done: true, failed: true });
    },
  };
}

/**
 * Count a response's body as it arrives, without reading it: a clone is
 * read, so the response itself goes on to whoever takes it, unchanged (its
 * address included, which WebAssembly.compileStreaming keys its code cache
 * by). The handle is finished when the clone's body ends, failed if it fails.
 */
export function countResponse(response: Response, handle: LoadProgressHandle): void {
  let body: ReadableStream<Uint8Array> | null;
  try {
    body = response.clone().body;
  } catch {
    handle.finish();
    return;
  }
  if (!body) {
    handle.finish();
    return;
  }
  const reader = body.getReader();
  const pump = (): Promise<void> =>
    reader.read().then(({ done, value }) => {
      if (done) {
        handle.finish();
        return;
      }
      handle.advance(value?.byteLength ?? 0);
      return pump();
    });
  pump().catch(() => handle.fail());
}

/**
 * The size of a response's body as it will be read, when the server says so:
 * its Content-Length, unless the body is compressed in transit, when that
 * length is the compressed one and the bytes read are more.
 */
export function responseBodyLength(response: Response): number | undefined {
  const encoding = response.headers.get('Content-Encoding');
  if (encoding && encoding !== 'identity') return undefined;
  const length = Number(response.headers.get('Content-Length'));
  return Number.isFinite(length) && length > 0 ? length : undefined;
}

/** Every download of this page, in the order they started; replaced, not changed, on each update. */
export function loadProgressItems(): readonly LoadProgressItem[] {
  return snapshot;
}

/** Be told when the list changes, at most once a frame. Returns the way to stop. */
export function subscribeLoadProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For tests: forget every download. */
export function resetLoadProgressForTests(): void {
  tracked.clear();
  snapshot = [];
  scheduled?.();
  scheduled = null;
}
