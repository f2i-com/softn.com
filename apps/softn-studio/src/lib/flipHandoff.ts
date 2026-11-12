/**
 * A project going from Studio to the Builder, and coming back.
 *
 * It travels the road Run and Publish travel (@softn/bundle-format/handoff):
 * the bundle is staged in this origin's hand-off store under an id nobody
 * can guess, with its SHA-256, the page it is for and the moment it was
 * staged, and only the id goes in that page's address. A record past its
 * ten minutes is refused, and cleared out by the next thing staged.
 *
 * A flip asks two things more of that road.
 *
 * The first is that nothing is lost to a reload half way. Run's receiver
 * claims the record and removes it in one step, which is right for a bundle
 * that is only being looked at. Here the record is the work itself until the
 * other side holds it, so the receiver reads it, puts the project where a
 * reload finds it again (the Builder keeps the visit; Studio saves the
 * project), and removes the record only then.
 *
 * The second is that the work comes back to the project it left. With the
 * bundle goes what that takes: which Studio project it is, and a digest of
 * each of its files as Studio held them. They come back with the Builder's
 * changes, so Studio can tell a file it still holds as it sent it from one
 * that was changed there in the meantime, and never puts the Builder's copy
 * over the second without asking.
 *
 * This file is the same in both apps (apps/softn-studio/src/lib and
 * apps/softn-builder/src/utils), as the publish page carries its own copy of
 * the hand-off contract: the database, the store, the record and the
 * addresses are what the two sides agree on, and a test in each app holds
 * the two copies equal. Its home is @softn/editor-shared once the two
 * destinations are added to the shared hand-off.
 */

import { HANDOFF_DB, HANDOFF_DB_VERSION, HANDOFF_PARAM, HANDOFF_STORE, HANDOFF_TTL_MS, sameOriginTarget, sha256Hex } from '@softn/bundle-format/handoff';
import { randomUUID } from '@softn/bundle-format/crypto';

export { sameOriginTarget };

export type FlipSide = 'studio' | 'builder';

/** A file's path in the bundle, and the SHA-256 of its bytes in hex. */
export type FileDigests = Record<string, string>;

/** What Studio sends with the bundle. */
export interface FlipOut {
  kind: 'open';
  /** The Studio project the bundle is of, which is where its changes come back to. */
  projectId: string;
  /** Each of the project's files as Studio held it when it was handed over. */
  sent: FileDigests;
}

/** What the Builder sends back with its bundle. */
export interface FlipBack {
  kind: 'return';
  projectId: string;
  /** The files of the bundle that are to replace Studio's, or be added to it. */
  changed: string[];
  /** The files Studio has that the person took out in the Builder. */
  deleted: string[];
  /** Studio's own digests of the files named above, as it sent them: absent for a file it did not have. */
  sent: FileDigests;
}

export interface FlipRecord {
  id: string;
  bytes: Uint8Array;
  /** The project's name, as the side that staged it calls it. */
  name: string;
  from: FlipSide;
  to: FlipSide;
  /** SHA-256 of `bytes`, hex, as computed when staged. */
  digest: string;
  stagedAt: number;
  flip: FlipOut | FlipBack;
}

/** Why a read did not give a record. `unknown`: never staged here, or taken already. */
export type FlipFailure = 'no-id' | 'unknown' | 'expired' | 'wrong-destination' | 'corrupt' | 'storage';

export type FlipRead = { ok: true; record: FlipRecord } | { ok: false; reason: FlipFailure };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available here'));
      return;
    }
    const req = indexedDB.open(HANDOFF_DB, HANDOFF_DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(HANDOFF_STORE)) req.result.createObjectStore(HANDOFF_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolves when the transaction has committed; rejects when it aborted or failed. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Delete every record older than the ten minutes, as staging a bundle for Run does. */
function pruneExpired(store: IDBObjectStore, now: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cursorReq = store.openCursor();
    cursorReq.onerror = () => reject(cursorReq.error ?? new Error('IndexedDB cursor failed'));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve();
        return;
      }
      const value = cursor.value as { stagedAt?: unknown } | undefined;
      const stagedAt = typeof value?.stagedAt === 'number' ? value.stagedAt : 0;
      if (now - stagedAt > HANDOFF_TTL_MS) cursor.delete();
      cursor.continue();
    };
  });
}

const isSide = (value: unknown): value is FlipSide => value === 'studio' || value === 'builder';

const isDigests = (value: unknown): value is FileDigests =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((digest) => typeof digest === 'string');

const isPaths = (value: unknown): value is string[] => Array.isArray(value) && value.every((path) => typeof path === 'string');

function isFlip(value: unknown): value is FlipOut | FlipBack {
  const flip = value as { kind?: unknown; projectId?: unknown; sent?: unknown; changed?: unknown; deleted?: unknown } | null;
  if (!flip || typeof flip !== 'object' || typeof flip.projectId !== 'string' || !isDigests(flip.sent)) return false;
  if (flip.kind === 'open') return true;
  return flip.kind === 'return' && isPaths(flip.changed) && isPaths(flip.deleted);
}

/**
 * Stage a bundle for the other editor. Resolves with the id to put in its
 * address, or null where nothing can be staged.
 */
export async function stageFlip(bytes: Uint8Array, name: string, to: FlipSide, flip: FlipOut | FlipBack, now = Date.now()): Promise<string | null> {
  try {
    const digest = await sha256Hex(bytes);
    const id = randomUUID();
    const db = await openDb();
    try {
      const tx = db.transaction(HANDOFF_STORE, 'readwrite');
      const store = tx.objectStore(HANDOFF_STORE);
      // A copy into a plain buffer: a view over a larger buffer would store the whole buffer.
      const record: FlipRecord = { id, bytes: new Uint8Array(bytes), name, from: to === 'builder' ? 'studio' : 'builder', to, digest, stagedAt: now, flip };
      await request(store.put(record, id));
      await pruneExpired(store, now);
      await committed(tx);
      return id;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * The record staged under this id for this side, left where it is: the
 * receiver removes it (`removeFlip`) once it holds the project.
 */
export async function readFlip(id: string | null, to: FlipSide, now = Date.now()): Promise<FlipRead> {
  if (!id) return { ok: false, reason: 'no-id' };
  let raw: Partial<FlipRecord> | undefined;
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(HANDOFF_STORE, 'readonly');
      raw = (await request(tx.objectStore(HANDOFF_STORE).get(id))) as Partial<FlipRecord> | undefined;
    } finally {
      db.close();
    }
  } catch {
    return { ok: false, reason: 'storage' };
  }
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'unknown' };
  // A bundle staged for the runtime or the publish page is theirs, and is left for them.
  if (!isSide(raw.to) || raw.to !== to) return { ok: false, reason: 'wrong-destination' };
  const valid = raw.bytes instanceof Uint8Array && typeof raw.name === 'string' && typeof raw.stagedAt === 'number' && typeof raw.digest === 'string' && isSide(raw.from) && isFlip(raw.flip);
  if (!valid) return { ok: false, reason: 'corrupt' };
  if (now - raw.stagedAt! > HANDOFF_TTL_MS) return { ok: false, reason: 'expired' };
  if ((await sha256Hex(raw.bytes!)) !== raw.digest) return { ok: false, reason: 'corrupt' };
  return { ok: true, record: { id, bytes: raw.bytes!, name: raw.name!, from: raw.from!, to, digest: raw.digest!, stagedAt: raw.stagedAt!, flip: raw.flip! } };
}

/** Remove a record the receiver now holds the project of. Never throws: one left behind expires. */
export async function removeFlip(id: string): Promise<void> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(HANDOFF_STORE, 'readwrite');
      await request(tx.objectStore(HANDOFF_STORE).delete(id));
      await committed(tx);
    } finally {
      db.close();
    }
  } catch {
    // Left where it is, it is refused after its ten minutes and cleared by the next staging.
  }
}

/** The digest of each entry, by path. */
export async function digestFiles(entries: Iterable<readonly [string, Uint8Array]>): Promise<FileDigests> {
  const digests: FileDigests = {};
  for (const [path, bytes] of entries) digests[path] = await sha256Hex(bytes);
  return digests;
}

// --- Addresses ----------------------------------------------------------------

/** The query parameter naming the Studio project a flip is of. */
export const FLIP_PROJECT_PARAM = 'project';

const ID = /^[A-Za-z0-9-]{16,64}$/;
const PROJECT = /^[\w.:-]{1,128}$/;

/**
 * The address that takes a flip: the other editor's own page, told where the
 * person came from. The Builder is given the id of what was staged for it.
 * Studio is given the project to open, and the id when there are changes to
 * bring in; with none, it opens the project and that is all.
 */
export function flipUrl(base: string, to: FlipSide, what: { id?: string | null; projectId?: string | null }): string {
  const query = new URLSearchParams();
  query.set('from', to === 'builder' ? 'studio' : 'builder');
  if (what.projectId) query.set(FLIP_PROJECT_PARAM, what.projectId);
  if (what.id) query.set(HANDOFF_PARAM, what.id);
  return `${base.replace(/\/+$/, '')}/?${query}`;
}

/** What a page was opened with by the other editor, or null when it was not. */
export function flipFrom(search: string, to: FlipSide): { id: string | null; projectId: string | null } | null {
  const params = new URLSearchParams(search);
  if (params.get('from') !== (to === 'builder' ? 'studio' : 'builder')) return null;
  const id = params.get(HANDOFF_PARAM);
  const projectId = params.get(FLIP_PROJECT_PARAM);
  return { id: id && ID.test(id) ? id : null, projectId: projectId && PROJECT.test(projectId) ? projectId : null };
}

/** The address's query with what a flip put there taken out, for the address bar once it is taken. */
export function withoutFlip(search: string): string {
  const params = new URLSearchParams(search);
  for (const name of ['from', HANDOFF_PARAM, FLIP_PROJECT_PARAM]) params.delete(name);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

// --- Taken ----------------------------------------------------------------------

/**
 * Which return of each Studio project was the last to reach it. The Builder
 * keeps the work it handed back until it is told so here: a return Studio
 * never took (the tab closed on the way, the ten minutes ran out) is still
 * work that is only in the Builder, and is not opened over without a word.
 */
export const FLIP_TAKEN_KEY = 'softn.flip.taken.v1';
const TAKEN_KEPT = 24;

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;

/** This origin's own store, where a page may use it. */
function ownStore(): KeyStore | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function takenMap(storage: KeyStore): Array<[string, string]> {
  try {
    const list = JSON.parse(storage.getItem(FLIP_TAKEN_KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((pair): pair is [string, string] => Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') : [];
  } catch {
    return [];
  }
}

/** Studio holds what the return `returnId` of this project brought. */
export function noteFlipTaken(projectId: string, returnId: string, storage: KeyStore | undefined = ownStore()): void {
  if (!storage) return;
  try {
    const rest = takenMap(storage).filter(([id]) => id !== projectId);
    storage.setItem(FLIP_TAKEN_KEY, JSON.stringify([...rest, [projectId, returnId]].slice(-TAKEN_KEPT)));
  } catch {
    // Not noted: the Builder asks before it opens Studio's copy over that work, which is the safe side.
  }
}

/** The last return of this project that reached Studio, or null. */
export function flipTaken(projectId: string, storage: KeyStore | undefined = ownStore()): string | null {
  if (!storage) return null;
  try {
    return takenMap(storage).find(([id]) => id === projectId)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** What to tell the person when a flip could not be read. */
export function describeFlipFailure(reason: FlipFailure, to: FlipSide): string {
  const other = to === 'builder' ? 'Studio' : 'the Builder';
  const again = to === 'builder' ? 'Go back to Studio and choose Open in Builder again.' : 'Open the Builder again and choose Back to Studio: your changes are still there.';
  switch (reason) {
    case 'no-id':
    case 'unknown':
      return `Nothing from ${other} is waiting here: it was taken already, or was never handed over. ${again}`;
    case 'expired':
      return `What ${other} handed over waited more than ten minutes and was let go. ${again}`;
    case 'wrong-destination':
      return `That hand-off was made for another page, and has been left for it. ${again}`;
    case 'corrupt':
      return `What ${other} handed over did not match what was staged, and has been refused. ${again}`;
    case 'storage':
      return `This browser could not read what ${other} handed over from its storage. ${again}`;
  }
}
