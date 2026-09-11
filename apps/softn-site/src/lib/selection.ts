/**
 * The bundle(s) the publish form has been given, as one versioned state.
 *
 * The form used to keep the chosen File and its inspection as two separate
 * states, set at two separate moments: the File the instant it was picked,
 * the inspection when the read finished. Pick A, pick B while A is still
 * being read, and A's read finishing last put A's manifest under B's name —
 * and A's name in the form, with B's bytes queued to upload. A batch read
 * every file at once with no admission check, so a folder of large bundles
 * was loaded whole into memory before anything could refuse it.
 *
 * Here a selection is one object — the files, what the inspector said about
 * each, and whether the whole is still being read — stamped with a
 * generation. Every asynchronous result carries the generation it was
 * started under and is dropped if the visitor has chosen again since. The
 * limits are checked on `File.size` before any byte is read, and reads run
 * a few at a time. A hand-off from Builder or Studio reserves a generation
 * before its bytes arrive, so a late hand-off cannot replace a file the
 * visitor chose in the meantime.
 *
 * Nothing here knows about React; the page subscribes.
 */

import { inspectBundle, type Inspection } from './inspectBundle';

/**
 * The most a single bundle file may be, as sent: the directory refuses a
 * larger upload (`maxBundleBytes` in apps/softn-api/lib/http.php, 32 MB by
 * default), so there is no point reading one into memory here. The
 * inspector's own limits are on the unpacked contents and are applied
 * after the read.
 */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** The most bundles a folder drop may hold; the batch view lists them one by one and publishes them in order. */
export const MAX_BATCH_FILES = 50;
/** The most a batch may weigh together: what a browser tab is asked to hold while the batch is inspected. */
export const MAX_BATCH_BYTES = 256 * 1024 * 1024;
/** How many files are read and inspected at once. Inspection unpacks the archive, so this bounds memory too. */
export const INSPECT_CONCURRENCY = 3;

export interface SelectionLimits {
  maxFileBytes: number;
  maxBatchFiles: number;
  maxBatchBytes: number;
}

export const DEFAULT_LIMITS: SelectionLimits = { maxFileBytes: MAX_FILE_BYTES, maxBatchFiles: MAX_BATCH_FILES, maxBatchBytes: MAX_BATCH_BYTES };

/** `inspecting`: bytes still being read; `ready`: publishable; `rejected`: the read failed or the inspector found something the directory refuses. */
export type SelectionStatus = 'inspecting' | 'ready' | 'rejected';

export interface SelectionItem {
  file: File;
  /** What the inspector said. Present for `ready`, and for a `rejected` bundle that opened but will be refused. */
  info: Inspection | null;
  status: SelectionStatus;
  /** Why it was rejected: the inspector's first error, or the read failure. */
  error?: string;
  /** SHA-256 of the bytes, when whoever supplied the file vouched for one (a hand-off). */
  digest?: string;
}

export interface SelectionState {
  /** Bumped by every new choice; results from an older generation are discarded. */
  generation: number;
  mode: 'none' | 'single' | 'batch';
  items: SelectionItem[];
}

export type Admission = { ok: true } | { ok: false; reason: string };

export type SelectionOutcome =
  /** The limits refused it before anything was read; the previous selection stands. */
  | { outcome: 'rejected'; reason: string }
  /** The visitor chose again before this finished; nothing of it is shown. */
  | { outcome: 'superseded' }
  /** Every item is ready or rejected, and this is still the current selection. */
  | { outcome: 'settled'; generation: number };

export interface SelectOptions {
  /** A generation taken with `reserve()` before the files existed; the selection is dropped if a newer one has started since. */
  ticket?: number;
  /** A digest the supplier vouches for, recorded on a single file. */
  digest?: string;
}

export interface SelectionController {
  state(): SelectionState;
  subscribe(listener: (state: SelectionState) => void): () => void;
  /** The current generation, which a `reserve()` may have moved past what `state()` shows. */
  generation(): number;
  /** Take the next generation for a selection whose bytes are still on their way. */
  reserve(): number;
  /** Choose these files. The limits are checked first; then each file is read and inspected, a few at a time. */
  select(files: File[], options?: SelectOptions): Promise<SelectionOutcome>;
  /** Read and inspect one item again, leaving the others as they are. */
  retry(index: number): Promise<void>;
  /** Nothing chosen. Anything still being read is discarded when it arrives. */
  clear(): void;
}

export interface SelectionDeps {
  read?: (file: File) => Promise<ArrayBuffer>;
  inspect?: (bytes: Uint8Array) => Inspection;
  limits?: SelectionLimits;
  concurrency?: number;
}

function fmt(n: number): string {
  return n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MB` : `${Math.round(n / 1024)} KB`;
}

/** Whether these files may be read at all, from their sizes alone. */
export function admit(files: File[], limits: SelectionLimits = DEFAULT_LIMITS): Admission {
  if (files.length > limits.maxBatchFiles) {
    return { ok: false, reason: `That is ${files.length} bundles; the page takes at most ${limits.maxBatchFiles} at once.` };
  }
  let total = 0;
  for (const f of files) {
    if (f.size > limits.maxFileBytes) {
      return { ok: false, reason: `${f.name} is ${fmt(f.size)}; the directory takes bundles up to ${fmt(limits.maxFileBytes)}.` };
    }
    total += f.size;
  }
  if (total > limits.maxBatchBytes) {
    return { ok: false, reason: `Those bundles are ${fmt(total)} together; the page takes at most ${fmt(limits.maxBatchBytes)} at once.` };
  }
  return { ok: true };
}

export function isSettled(state: SelectionState): boolean {
  return state.items.every((it) => it.status !== 'inspecting');
}

/** How many items are still being read. */
export function pendingCount(state: SelectionState): number {
  return state.items.filter((it) => it.status === 'inspecting').length;
}

const EMPTY: SelectionState = { generation: 0, mode: 'none', items: [] };

export function createSelectionController(deps: SelectionDeps = {}): SelectionController {
  const read = deps.read ?? ((f: File) => f.arrayBuffer());
  const inspect = deps.inspect ?? inspectBundle;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const concurrency = Math.max(1, deps.concurrency ?? INSPECT_CONCURRENCY);

  let state: SelectionState = EMPTY;
  let generation = 0;
  const listeners = new Set<(s: SelectionState) => void>();

  const set = (next: SelectionState) => {
    state = next;
    for (const l of listeners) l(state);
  };

  const inspectOne = async (file: File, digest?: string): Promise<SelectionItem> => {
    let info: Inspection;
    try {
      info = inspect(new Uint8Array(await read(file)));
    } catch (err) {
      return { file, info: null, status: 'rejected', error: err instanceof Error ? err.message : String(err), digest };
    }
    return { file, info, status: info.problem ? 'rejected' : 'ready', error: info.problem ?? undefined, digest };
  };

  // Only applied while `gen` is still the current generation; a result for
  // an older choice is dropped on the floor.
  const apply = (gen: number, index: number, item: SelectionItem) => {
    if (gen !== generation) return;
    set({ ...state, items: state.items.map((it, i) => (i === index ? item : it)) });
  };

  const runPool = async (gen: number, indexes: number[], work: (index: number) => Promise<void>) => {
    let next = 0;
    const worker = async () => {
      while (next < indexes.length && gen === generation) {
        const index = indexes[next++];
        await work(index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, indexes.length) }, worker));
  };

  return {
    state: () => state,
    generation: () => generation,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reserve() {
      generation += 1;
      return generation;
    },
    async select(files, options = {}) {
      if (options.ticket !== undefined && options.ticket !== generation) return { outcome: 'superseded' };
      const admission = admit(files, limits);
      if (!admission.ok) return { outcome: 'rejected', reason: admission.reason };
      const gen = options.ticket ?? (generation += 1);
      const digest = files.length === 1 ? options.digest : undefined;
      set({
        generation: gen,
        mode: files.length === 1 ? 'single' : 'batch',
        items: files.map((file) => ({ file, info: null, status: 'inspecting', digest })),
      });
      await runPool(
        gen,
        files.map((_, i) => i),
        async (i) => apply(gen, i, await inspectOne(files[i], digest)),
      );
      return gen === generation ? { outcome: 'settled', generation: gen } : { outcome: 'superseded' };
    },
    async retry(index) {
      const gen = generation;
      const current = state.items[index];
      if (!current) return;
      apply(gen, index, { ...current, info: null, status: 'inspecting', error: undefined });
      apply(gen, index, await inspectOne(current.file, current.digest));
    },
    clear() {
      generation += 1;
      set({ generation, mode: 'none', items: [] });
    },
  };
}
