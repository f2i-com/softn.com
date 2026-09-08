/**
 * Inflates bundle entries off the main thread, for `zipWarmup.ts`.
 *
 * The worker is handed its own copy of the archive once, then asked for names
 * a step at a time. It runs `inflateEntries` — the same index, the same size
 * and checksum checks as a read on the main thread — and posts the bytes back
 * with their buffers in the transfer list, so nothing it produced is copied
 * across. What it posts is not believed: `BundleArchive.warm` verifies every
 * buffer against the central directory again before keeping it. This worker
 * is a way to spend the inflate time elsewhere, not a way to skip the checks.
 *
 * Constructed from app source, not from @softn/core: Vite bundles a worker
 * only for `new Worker(new URL('./zipWorker.ts', import.meta.url), …)` in a
 * module it transforms, and a URL built inside core's dist would point at a
 * file no host serves — the same reason the script runtime's worker needs
 * scripts/core-worker-assets.mjs.
 *
 * The reader comes from `@softn/core/bundle` — core's `dist/bundle/zip.js`,
 * its own tsup entry, named by core's exports map — rather than from the
 * `@softn/core` barrel: through the barrel the worker chunk measured 1.35 MB
 * — yjs, the engine glue, React calls — because the bundler cannot
 * tree-shake past core's side-effectful chunks, and a worker that downloads
 * that much before it can inflate is slower than the main thread it is
 * sparing. Through the entry it is ~10 KB, the reader and fflate.
 */

import { inflateEntries } from '@softn/core/bundle';

interface OpenMessage {
  type: 'open';
  bytes: Uint8Array;
}

interface ExtractMessage {
  type: 'extract';
  id: number;
  names: string[];
}

export type ZipWorkerRequest = OpenMessage | ExtractMessage;

export type ZipWorkerResponse =
  | { id: number; entries: [string, Uint8Array][] }
  | { id: number; error: string };

// The DOM lib types `self` as a Window; only these two members are used, and
// both exist on a worker scope with these shapes.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ZipWorkerRequest>) => void) | null;
  postMessage(message: ZipWorkerResponse, transfer?: Transferable[]): void;
};

let archive: Uint8Array | null = null;

scope.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'open') {
    archive = message.bytes;
    return;
  }
  if (message.type !== 'extract' || typeof message.id !== 'number') return;
  try {
    if (!archive) throw new Error('No archive has been opened in this worker');
    const produced = inflateEntries(archive, Array.isArray(message.names) ? message.names : []);
    const entries: [string, Uint8Array][] = [];
    const transfer: Transferable[] = [];
    for (const [name, bytes] of produced) {
      // inflateEntries returns views that own their buffers, so transferring
      // the buffer moves exactly the entry; a view over something larger
      // would hand the main thread more than it asked for.
      const owned =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes
          : bytes.slice();
      entries.push([name, owned]);
      transfer.push(owned.buffer as ArrayBuffer);
    }
    scope.postMessage({ id: message.id, entries }, transfer);
  } catch (err) {
    scope.postMessage({
      id: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
