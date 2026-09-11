/**
 * A bundle handed to this page by Builder or Studio.
 *
 * Both editors stage a bundle in this origin's IndexedDB, addressed to this
 * page under an unguessable id, and open `/publish?from=handoff&handoff=ID`;
 * this claims it. The database, store, record shape and address are the
 * contract with `packages/@softn/core/src/bundle/handoff.ts`, which this
 * repeats rather than imports: the site does not depend on the engine. A
 * test here checks the two agree.
 *
 * A claim removes the record, and the removal only counts once its
 * transaction has committed. A record addressed to the runtime is left for
 * the runtime; one older than ten minutes is thrown away unread; bytes
 * whose digest no longer matches are refused. The same id asked for twice
 * by this page — StrictMode runs an effect twice — gets the same answer.
 */

export const HANDOFF_DB = 'softn-handoff';
export const HANDOFF_DB_VERSION = 2;
export const HANDOFF_STORE = 'bundles';
export const HANDOFF_TTL_MS = 10 * 60 * 1000;
export const HANDOFF_PARAM = 'handoff';

export type HandoffDestination = 'publish' | 'runtime';
export type HandoffSource = 'builder' | 'studio' | 'runtime';

export interface BundleHandoff {
  id: string;
  bytes: Uint8Array;
  name: string;
  from: HandoffSource;
  to: HandoffDestination;
  digest: string;
  stagedAt: number;
}

export type HandoffFailure = 'unknown' | 'expired' | 'wrong-destination' | 'corrupt' | 'storage' | 'no-id';
export type HandoffResult = { ok: true; handoff: BundleHandoff } | { ok: false; reason: HandoffFailure };

function openHandoffDb(): Promise<IDBDatabase> {
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

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

const claims = new Map<string, Promise<HandoffResult>>();

/** Claim the hand-off with this id for the publish page. */
export function takeBundleHandoff(id: string | null, now = Date.now()): Promise<HandoffResult> {
  if (!id) return Promise.resolve({ ok: false, reason: 'no-id' });
  const existing = claims.get(id);
  if (existing) return existing;
  const claim = claimHandoff(id, now);
  claims.set(id, claim);
  return claim;
}

/** For tests, and for a page that starts over. */
export function resetHandoffClaims(): void {
  claims.clear();
}

async function claimHandoff(id: string, now: number): Promise<HandoffResult> {
  let db: IDBDatabase;
  try {
    db = await openHandoffDb();
  } catch {
    return { ok: false, reason: 'storage' };
  }
  try {
    const tx = db.transaction(HANDOFF_STORE, 'readwrite');
    const store = tx.objectStore(HANDOFF_STORE);
    let raw: Partial<BundleHandoff> | undefined;
    try {
      raw = (await request(store.get(id))) as Partial<BundleHandoff> | undefined;
    } catch {
      return { ok: false, reason: 'storage' };
    }
    if (!raw || typeof raw !== 'object') {
      await committed(tx).catch(() => undefined);
      return { ok: false, reason: 'unknown' };
    }
    const valid =
      raw.bytes instanceof Uint8Array && typeof raw.name === 'string' && typeof raw.stagedAt === 'number' && typeof raw.digest === 'string' && (raw.to === 'publish' || raw.to === 'runtime');
    if (!valid) {
      await request(store.delete(id)).catch(() => undefined);
      await committed(tx).catch(() => undefined);
      return { ok: false, reason: 'corrupt' };
    }
    if (raw.to !== 'publish') {
      await committed(tx).catch(() => undefined);
      return { ok: false, reason: 'wrong-destination' };
    }
    try {
      await request(store.delete(id));
      await committed(tx);
    } catch {
      return { ok: false, reason: 'storage' };
    }
    if (now - raw.stagedAt! > HANDOFF_TTL_MS) return { ok: false, reason: 'expired' };
    if ((await sha256Hex(raw.bytes!)) !== raw.digest) return { ok: false, reason: 'corrupt' };
    const from = raw.from === 'builder' || raw.from === 'studio' || raw.from === 'runtime' ? raw.from : 'runtime';
    return { ok: true, handoff: { id, bytes: raw.bytes!, name: raw.name!, from, to: 'publish', digest: raw.digest!, stagedAt: raw.stagedAt! } };
  } finally {
    db.close();
  }
}

/** Whether this page was opened to take a hand-off, and the id it was given. */
export function handoffIdFrom(search = window.location.search): { opened: boolean; id: string | null } {
  const params = new URLSearchParams(search);
  if (params.get('from') !== 'handoff') return { opened: false, id: null };
  const id = params.get(HANDOFF_PARAM);
  return { opened: true, id: id && /^[A-Za-z0-9-]{16,64}$/.test(id) ? id : null };
}

/** Whether this page was opened to take a hand-off. */
export function openedForHandoff(search = window.location.search): boolean {
  return handoffIdFrom(search).opened;
}

export function describeHandoffFailure(reason: HandoffFailure): string {
  switch (reason) {
    case 'no-id':
    case 'unknown':
      return 'Nothing was handed to the publish page: the hand-off was already taken, or was never staged here. Open it from Builder or Studio again, or choose the bundle file.';
    case 'expired':
      return 'The hand-off was staged more than ten minutes ago and has been discarded. Open it from Builder or Studio again, or choose the bundle file.';
    case 'wrong-destination':
      return 'That hand-off was made for the runtime, and has been left for it. Publish from Builder or Studio again, or choose the bundle file.';
    case 'corrupt':
      return 'The handed-over bundle did not match what was staged and has been refused. Open it from Builder or Studio again, or choose the bundle file.';
    case 'storage':
      return 'This browser could not read the hand-off from its storage. Export the bundle and choose the file instead.';
  }
}
