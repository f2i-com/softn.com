/**
 * First-screen asset warm-up: inflate what the app is about to ask for,
 * before it asks, off the main thread where a Worker exists.
 *
 * `asset(path)` is synchronous and stays so — a template uses its result in
 * the same expression — so an entry not yet held is inflated on the main
 * thread the moment it is asked for. This module gets there first for the
 * paths the composed source names by literal and then the manifest's asset
 * list, within the first-screen bounds (bundleProcessor.ts,
 * `firstScreenAssets`): a worker receives one copy of the archive, inflates a
 * step's worth of names at a time, and transfers the bytes back; the archive
 * verifies each against its central directory before keeping it. A path the
 * app asks for while its step is still in flight is simply read on the main
 * thread, and whichever lands first fills the memo.
 *
 * What this does not do is reduce what was downloaded. The whole archive is
 * fetched and digested before any of this runs, because the bundle's identity
 * and its integrity are computed over all of its bytes; docs/BUNDLE_LOADING.md
 * says what a partial-fetch design would need instead.
 */

import type { BundleArchive } from '@softn/core';
import type { ZipWorkerRequest, ZipWorkerResponse } from './zipWorker';

/**
 * How long one step may take before the worker is presumed wedged and the
 * warm-up falls back to the main thread. Generous: a step is two megabytes,
 * and this only has to catch a worker that will never answer.
 */
const STEP_TIMEOUT_MS = 20_000;

interface Inflater {
  extract(names: string[]): Promise<Map<string, Uint8Array>>;
  terminate(): void;
}

function mark(name: string): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark(name);
  }
}

/**
 * A worker holding its own copy of `bytes`, or undefined where there is no
 * Worker (tests, Node, a browser with workers disabled) or one cannot be made.
 * Every failure after construction — a load error, a message the worker could
 * not answer, a step that never comes back — rejects the pending step, after
 * which `BundleArchive.warm` reads the rest itself.
 */
function createWorkerInflater(bytes: Uint8Array): Inflater | undefined {
  if (typeof Worker !== 'function') return undefined;
  let worker: Worker;
  try {
    worker = new Worker(new URL('./zipWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    return undefined;
  }

  const pending = new Map<
    number,
    { resolve: (entries: Map<string, Uint8Array>) => void; reject: (err: Error) => void }
  >();
  let nextId = 0;
  let dead: Error | null = null;

  const fail = (err: Error): void => {
    if (dead) return;
    dead = err;
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
    worker.terminate();
  };

  worker.onerror = (event) => fail(new Error(event.message || 'zip worker failed'));
  worker.onmessageerror = () => fail(new Error('zip worker sent a message that could not be read'));
  worker.onmessage = (event: MessageEvent<ZipWorkerResponse>) => {
    const message = event.data;
    if (!message || typeof message.id !== 'number') return;
    const step = pending.get(message.id);
    if (!step) return;
    pending.delete(message.id);
    if ('error' in message) step.reject(new Error(message.error));
    else step.resolve(new Map(message.entries));
  };

  // One copy, made here rather than by structured clone: cloning a view
  // copies its whole underlying buffer, which for a view over a larger
  // allocation is more than the archive. The copy is then transferred, so
  // the worker's copy costs one archive and the main thread keeps its own.
  const copy = bytes.slice();
  const open: ZipWorkerRequest = { type: 'open', bytes: copy };
  worker.postMessage(open, [copy.buffer as ArrayBuffer]);

  return {
    extract(names) {
      return new Promise((resolve, reject) => {
        if (dead) {
          reject(dead);
          return;
        }
        const id = nextId++;
        const timer = setTimeout(
          () => fail(new Error(`zip worker did not answer within ${STEP_TIMEOUT_MS} ms`)),
          STEP_TIMEOUT_MS
        );
        pending.set(id, {
          resolve: (entries) => {
            clearTimeout(timer);
            resolve(entries);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        const request: ZipWorkerRequest = { type: 'extract', id, names };
        worker.postMessage(request);
      });
    },
    terminate() {
      fail(new Error('zip worker terminated'));
    },
  };
}

export interface FirstScreenWarmup {
  /** Settles when the warm-up has finished, stopped, or given up; never rejects. */
  readonly done: Promise<void>;
  /** Stop at the next step. Releasing the archive stops it too. */
  abort(): void;
}

/**
 * Start inflating `names` from `archive` ahead of the app. Returns at once;
 * nothing here is awaited by the open path, and the app renders while the
 * worker works. The worker holds its copy of `bytes` only until the warm-up
 * settles.
 */
export function warmFirstScreen(
  archive: BundleArchive,
  bytes: Uint8Array,
  names: string[]
): FirstScreenWarmup {
  // Decided here rather than left to warm(): a worker costs a copy of the
  // archive, which is not worth making for names already held.
  const pending = archive.released
    ? []
    : names.filter((name) => archive.has(name) && !archive.isRead(name));
  if (pending.length === 0) {
    return { done: Promise.resolve(), abort: () => undefined };
  }
  const controller = new AbortController();
  const inflater = createWorkerInflater(bytes);
  mark('softn:asset-warm:start');
  const done = archive
    .warm(pending, {
      signal: controller.signal,
      extract: inflater ? (step) => inflater.extract(step) : undefined,
    })
    .catch((err: unknown) => {
      // A corrupt entry, or a release mid-flight, is the app's to discover on
      // the read that touches it; the warm-up only ever ran ahead of that.
      if (controller.signal.aborted || archive.released) return;
      console.warn('[SoftN Web] First-screen asset warm-up stopped early:', err);
    })
    .finally(() => {
      inflater?.terminate();
      mark('softn:asset-warm:end');
    });
  return { done, abort: () => controller.abort() };
}
