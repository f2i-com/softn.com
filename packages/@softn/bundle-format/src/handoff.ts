/**
 * Handing a bundle from one page of the site to another.
 *
 * Builder and Studio make bundles; the runtime runs them and the directory
 * publishes them. All four are pages of one origin, and a page cannot give
 * another a file — so a bundle to pass along is staged in this origin's
 * IndexedDB and the page that opens next takes it.
 *
 * Every hand-off is addressed. Staging mints an unguessable id, records the
 * bytes with their SHA-256, the page they are for and the moment they were
 * staged, and puts only the id in the receiver's address. The receiver
 * claims the record by id, in one transaction, and the claim is not counted
 * until that transaction has committed: an aborted transaction is a failed
 * delivery, not a delivered bundle. A record for another page is left where
 * it is; one older than the TTL is thrown away unread; bytes whose digest
 * no longer matches are refused. So two editors staging at once each reach
 * their own receiver with their own bytes, which one shared "pending" slot
 * — the previous design — could not promise: whichever page opened next
 * took whatever bytes were last put there.
 *
 * The directory's publish page reads the same store without depending on
 * this package (apps/softn-site/src/lib/handoff.ts): the database, store
 * and record shape below are the contract, and both sides carry them. A
 * test in the site checks the two agree.
 *
 * In development the four apps can run on separate ports — separate
 * origins — and share no storage. A producer notices that before staging
 * and says so, rather than opening a receiver that finds nothing.
 */

export const HANDOFF_DB = 'softn-handoff';
export const HANDOFF_DB_VERSION = 2;
export const HANDOFF_STORE = 'bundles';
export const HANDOFF_TTL_MS = 10 * 60 * 1000;
/** The query parameter carrying the hand-off id. */
export const HANDOFF_PARAM = 'handoff';

export type HandoffDestination = 'publish' | 'runtime';
export type HandoffSource = 'builder' | 'studio' | 'runtime';

export interface BundleHandoff {
  id: string;
  bytes: Uint8Array;
  /** The bundle's name, for the file name the receiver gives it. */
  name: string;
  /** Where it came from, for the receiver's wording. */
  from: HandoffSource;
  /** The page it is for. */
  to: HandoffDestination;
  /** SHA-256 of `bytes`, hex, as computed when staged. */
  digest: string;
  stagedAt: number;
}

export interface StagedHandoff {
  id: string;
  to: HandoffDestination;
  digest: string;
}

/**
 * Why a claim did not deliver a bundle. `unknown` covers an id that was
 * never staged here and one already taken — by this page a moment ago, or
 * by a duplicate tab. `wrong-destination` leaves the record for the page it
 * is for. `storage` is IndexedDB itself failing, including a transaction
 * that did not commit.
 */
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

/** Resolves when the transaction has committed; rejects when it aborted or failed. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** SHA-256 of the bytes, as lower-case hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const hash = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** An id nobody can guess: 128 bits from the platform's generator. */
function newHandoffId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function isDestination(value: unknown): value is HandoffDestination {
  return value === 'publish' || value === 'runtime';
}

function isSource(value: unknown): value is HandoffSource {
  return value === 'builder' || value === 'studio' || value === 'runtime';
}

/**
 * Stage a bundle for one page. Resolves with the id to put in that page's
 * address, or null where nothing can be staged. Records past their TTL are
 * cleared out on the way, so an abandoned hand-off does not sit in storage
 * for good.
 */
export async function stageBundleHandoff(bytes: Uint8Array, name: string, from: HandoffSource, to: HandoffDestination, now = Date.now()): Promise<StagedHandoff | null> {
  try {
    const digest = await sha256Hex(bytes);
    const id = newHandoffId();
    const db = await openHandoffDb();
    try {
      const tx = db.transaction(HANDOFF_STORE, 'readwrite');
      const store = tx.objectStore(HANDOFF_STORE);
      // A copy into a plain buffer: a view over a larger buffer would store the whole buffer.
      const copy = new Uint8Array(bytes);
      const record: BundleHandoff = { id, bytes: copy, name, from, to, digest, stagedAt: now };
      await request(store.put(record, id));
      await pruneExpired(store, now);
      await committed(tx);
      return { id, to, digest };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Delete every record older than the TTL, and the legacy unaddressed slot. */
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
      const value = cursor.value as Partial<BundleHandoff> | undefined;
      const stagedAt = typeof value?.stagedAt === 'number' ? value.stagedAt : 0;
      if (cursor.key === 'pending' || now - stagedAt > HANDOFF_TTL_MS) cursor.delete();
      cursor.continue();
    };
  });
}

/**
 * The claims this page has made, by id. A React effect under StrictMode
 * runs twice, and a receiver may ask again while its first claim is still
 * in flight: the same id gets the same answer, so a bundle claimed once is
 * not reported missing the second time the same page asks.
 */
const claims = new Map<string, Promise<HandoffResult>>();

/**
 * Claim the hand-off with this id for this page. Claiming removes the
 * record; the removal is only counted once the transaction has committed.
 */
export function takeBundleHandoff(id: string | null, to: HandoffDestination, now = Date.now()): Promise<HandoffResult> {
  if (!id) return Promise.resolve({ ok: false, reason: 'no-id' });
  const key = `${to}:${id}`;
  const existing = claims.get(key);
  if (existing) return existing;
  const claim = claimHandoff(id, to, now);
  claims.set(key, claim);
  return claim;
}

/** Forget what this page has claimed; for tests, and for a page that starts over. */
export function resetHandoffClaims(): void {
  claims.clear();
}

async function claimHandoff(id: string, to: HandoffDestination, now: number): Promise<HandoffResult> {
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
    const valid = raw.bytes instanceof Uint8Array && typeof raw.name === 'string' && typeof raw.stagedAt === 'number' && typeof raw.digest === 'string' && isDestination(raw.to);
    if (!valid) {
      // Not a record this protocol wrote: take it out of the way.
      await request(store.delete(id)).catch(() => undefined);
      await committed(tx).catch(() => undefined);
      return { ok: false, reason: 'corrupt' };
    }
    if (raw.to !== to) {
      // Meant for another page. Left for it.
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
    const digest = await sha256Hex(raw.bytes!);
    if (digest !== raw.digest) return { ok: false, reason: 'corrupt' };
    const from = isSource(raw.from) ? raw.from : 'runtime';
    return { ok: true, handoff: { id, bytes: raw.bytes!, name: raw.name!, from, to, digest, stagedAt: raw.stagedAt! } };
  } finally {
    db.close();
  }
}

/**
 * The address of the page that should take a staged bundle. The publish
 * page is the site's /publish route — not its root, which the site's own
 * router shows as the home page; the runtime takes `?open=handoff` at its
 * root. Base paths join without doubled or missing slashes whether given
 * as `/`, `/web/`, `/site/prefix` or a full development origin.
 */
export function handoffUrl(base: string, to: HandoffDestination, id: string): string {
  const root = base.replace(/\/+$/, '');
  const query = new URLSearchParams();
  if (to === 'publish') {
    query.set('from', 'handoff');
    query.set(HANDOFF_PARAM, id);
    return `${root}/publish?${query}`;
  }
  query.set('open', 'handoff');
  query.set(HANDOFF_PARAM, id);
  return `${root}/?${query}`;
}

/**
 * The hand-off id a receiver was opened with, or null when the address is
 * not a hand-off for this page. Reads the marker the producer wrote for
 * this destination and the id beside it; a marker with no id is a hand-off
 * with nothing to claim, reported as such by `takeBundleHandoff`.
 */
export function handoffIdFrom(search: string, to: HandoffDestination): { opened: boolean; id: string | null } {
  const params = new URLSearchParams(search);
  const marker = to === 'publish' ? params.get('from') : params.get('open');
  if (marker !== 'handoff') return { opened: false, id: null };
  const id = params.get(HANDOFF_PARAM);
  return { opened: true, id: id && /^[A-Za-z0-9-]{16,64}$/.test(id) ? id : null };
}

/**
 * Whether a receiver at `target` shares this page's origin — the only case
 * in which it can see what this page stages. Relative targets always do.
 */
export function sameOriginTarget(target: string, origin: string = typeof location !== 'undefined' ? location.origin : ''): boolean {
  try {
    return new URL(target, origin || 'http://localhost').origin === (origin || 'http://localhost');
  } catch {
    return false;
  }
}

/** What to tell the person at the receiving page. */
export function describeHandoffFailure(reason: HandoffFailure, to: HandoffDestination): string {
  const page = to === 'publish' ? 'the publish page' : 'the runtime';
  switch (reason) {
    case 'no-id':
    case 'unknown':
      return `Nothing was handed to ${page}: the hand-off was already taken, or was never staged here. Open it from Builder or Studio again, or choose the bundle file.`;
    case 'expired':
      return `The hand-off to ${page} was staged more than ten minutes ago and has been discarded. Open it from Builder or Studio again, or choose the bundle file.`;
    case 'wrong-destination':
      return `That hand-off was made for another page, and has been left for it. Open it from Builder or Studio again for ${page}, or choose the bundle file.`;
    case 'corrupt':
      return `The handed-over bundle did not match what was staged and has been refused. Open it from Builder or Studio again, or choose the bundle file.`;
    case 'storage':
      return `This browser could not read the hand-off from its storage. Export the bundle and choose the file instead.`;
  }
}
