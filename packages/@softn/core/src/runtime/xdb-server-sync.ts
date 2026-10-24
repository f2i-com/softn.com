/**
 * XDB Server Sync — Real-time client-server data synchronization.
 *
 * Connects to a softn-server instance via WebSocket and synchronizes
 * XDB data. The server is the authoritative source of truth.
 *
 * This replaces P2P sync (xdb-sync.ts) when a server URL is configured.
 */

import type { XDBService } from './xdb';

// ── Types ─────────────────────────────────────────────────

export interface ServerSyncConfig {
  /** WebSocket URL for the sync endpoint (e.g. "wss://sync.example.com/sync") */
  wsUrl: string;
  /**
   * The app's version. Not sent: it went in a first `auth` message, which
   * no host reads (the handshake is authenticated before the socket opens).
   * Taken so that callers that pass it keep working.
   */
  appVersion?: string;
  /**
   * Optional auth token (the host's SOFTN_AUTH_TOKEN). It is never put on
   * the socket or in its URL: the client trades it at `<wsUrl>/ticket` for a
   * short-lived single-use ticket and connects with `?ticket=`.
   */
  token?: string;
  /**
   * Collections to sync (default: every collection the store knows, and any
   * it starts using while connected). With a list, records of other
   * collections the server sends are not written here, unless this device
   * writes to that collection itself.
   */
  collections?: string[];
  /**
   * First reconnection delay in ms (default: 2000). Each failed attempt
   * doubles it, with jitter, up to a minute; a successful connection starts
   * over. A host's `Retry-After` is honoured when it asks for longer.
   */
  reconnectDelay?: number;
  /** Allow insecure ws:// connections (default: false, only for local development) */
  allowInsecureWs?: boolean;
  /**
   * How long, in ms, the socket of an app its host is not showing stays open
   * with nothing to send (default: 30000), so that switching tabs and back
   * does not reconnect; see `setAppShown`.
   */
  restAfterMs?: number;
}

/** A sync operation (mutation) sent to/from the server. */
export interface SyncOp {
  id: string;
  collection: string;
  operation: 'create' | 'update' | 'delete';
  recordId: string;
  data?: Record<string, unknown>;
  timestamp: string;
  clientId: string;
}

/** Status of the server sync connection. */
export interface ServerSyncStatus {
  connected: boolean;
  clientId: string | null;
  serverTime: string | null;
}

/**
 * Where a pull of one collection left off. The host reads a collection a
 * page at a time (ten thousand records); the last `sync_state` of a page
 * that was full carries this, and a pull that hands it back as `cursor` is
 * answered with the page after it. A host from before pages sends none.
 */
interface PullCursor {
  at: string;
  id: string;
}

// ── Client → Server messages ─────────────────────────────

/**
 * A pull asks for the whole of each collection (with `cursor`, the page
 * after one), or, with `lastSync` and `lastId`, for what the host received
 * after that point, the records deleted since included. A host that does not
 * read the two answers as it does a whole pull.
 *
 * `subscribe` names the collections whose changes this client wants; a host
 * that reads it sends those, and any the client pulls or pushes to later.
 */
type ClientMessage =
  | { type: 'sync_pull'; collections: string[]; cursor?: PullCursor; lastSync?: string; lastId?: string }
  | { type: 'sync_push'; ops: SyncOp[] }
  | { type: 'subscribe'; collections: string[] };

// ── Server → Client messages ─────────────────────────────

type ServerMessage =
  | { type: 'auth_ok'; clientId: string; serverTime: string }
  | { type: 'sync_state'; collection: string; records: ServerRecord[]; more?: PullCursor }
  | { type: 'sync_delta'; ops: SyncOp[] }
  | { type: 'sync_ack'; opIds: string[] }
  | { type: 'sync_reject'; opId: string; reason: string }
  | { type: 'sync_retry'; opIds: string[]; reason: string }
  | {
      type: 'error';
      message: string;
      /**
       * What the host refused (`'pull'`, with the `collections` it did not
       * send whole, and `retryAfter` seconds when asking again may work).
       * A host from before says neither, and names nothing.
       */
      for?: string;
      collections?: string[];
      retryAfter?: number;
    };

/** The longest wait between reconnection attempts or push retries. */
const MAX_RETRY_DELAY = 60_000;
/**
 * Ops and serialized bytes per `sync_push`. The host refuses a push of more
 * than 1,000 ops and closes the socket on a message over 4 MiB, so a queue
 * that grew while offline has to go out in pieces or never go out at all.
 * Bytes are UTF-8 bytes, as the host counts them: counted in characters, a
 * push of Chinese text was three times the size it was taken for.
 */
const MAX_OPS_PER_PUSH = 500;
const MAX_PUSH_BYTES = 1024 * 1024;
/**
 * The most either side takes in one message. The host closes the socket on
 * a larger one (1009), and this client drops one it is sent, a bound on what
 * a compromised host can make it hold. The host sends a pull and a delta in
 * pieces of 1 MB, and only a record larger than that alone. This client took
 * 2 MB at most, and dropped the one message in which the host sent back
 * several large records it had overruled, keeping the edits that lost.
 */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** `{"type":"sync_push","ops":[...]}` around the ops, with room to spare. */
const PUSH_ENVELOPE_BYTES = 64;
/**
 * How deep the host reads a message's objects and arrays, the message itself
 * the first. A push carries each op two levels down (the message, its
 * `ops`), so an op may be nested this much less two, its own object the first.
 */
const MAX_MESSAGE_DEPTH = 64;
const MAX_OP_DEPTH = MAX_MESSAGE_DEPTH - 2;
/** Distinct collections the host reads in one `sync_pull`; more and it refuses the pull. */
const MAX_PULL_COLLECTIONS = 100;
/**
 * The most records the host sends for one collection of a pull that names a
 * point to start from. Such an answer carries no `more`: one that comes this
 * full may have stopped short, and is asked again from where it ended.
 */
const INCREMENTAL_PULL_ROWS = 10_000;
/** How the host writes its clock, in `auth_ok` and in each record's receipt time. */
const HOST_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** What the host takes as a collection name; a pull naming anything else is answered with an error. */
const SYNCABLE_COLLECTION = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * How long a hidden app's socket stays open with nothing to send: long enough
 * that a look at another tab and back does not cost a ticket, a handshake
 * and a pull of every collection.
 */
const REST_AFTER_MS = 30_000;
/** Names under which the queue and the pull positions are kept (`XDBService.readSyncMeta`). */
const QUEUE_META = 'sync-queue';
const PULLED_META = 'sync-pulled';
/**
 * When this store's changes were last all known to sync: the device's time
 * when the queue was last saved while changes were being listened for. A
 * change made after it, while no client listened (before consent was given,
 * before an async import finished, between a disconnect and a connect), was
 * never queued, and is found by its record's time when the next client
 * connects (`queueUnsyncedChanges`).
 */
const WATCHED_META = 'sync-watched';

/**
 * The limits this client holds to, which the host's own are checked against
 * (`apps/softn-host-rust/sync-protocol.json`, by a test on each side).
 */
export const SYNC_LIMITS = {
  maxMessageBytes: MAX_MESSAGE_BYTES,
  maxOpsPerPush: MAX_OPS_PER_PUSH,
  maxPushBytes: MAX_PUSH_BYTES,
  maxMessageDepth: MAX_MESSAGE_DEPTH,
  maxPullCollections: MAX_PULL_COLLECTIONS,
  pageRows: INCREMENTAL_PULL_ROWS,
  collectionName: SYNCABLE_COLLECTION.source,
} as const;

/**
 * Exponential backoff with "equal jitter": between half and all of
 * `base * 2^attempt`, capped. Many clients cut off at once (a host restart)
 * then come back spread out instead of in one wave.
 */
export function backoffDelay(
  base: number,
  attempt: number,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(MAX_RETRY_DELAY, base * 2 ** Math.min(attempt, 16));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** `Retry-After` in milliseconds, when it is a number of seconds. */
function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers?.get?.('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, 10 * MAX_RETRY_DELAY)
    : 0;
}

/**
 * How far a host's clock is ahead of this device's, in milliseconds, from
 * the `serverTime` its `auth_ok` gave and this device's time when it came.
 * Under a second counts as none: the network's delay is part of any
 * difference, and older hosts give the time in whole seconds.
 */
function clockOffset(serverTime: unknown, now: number): number {
  const server = typeof serverTime === 'string' ? Date.parse(serverTime) : NaN;
  if (!Number.isFinite(server)) return 0;
  const offset = server - now;
  return Math.abs(offset) < 1000 ? 0 : offset;
}

interface ServerRecord {
  id: string;
  collection: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** When the host received the record's last change, by its own clock: where a pull goes on from. */
  serverReceivedAt?: string;
  /** Set on a record deleted since the point a pull named. */
  deleted?: boolean;
}

/** A change made here, to be queued as an op. */
interface LocalChange {
  type: 'create' | 'update' | 'delete';
  collection: string;
  recordId: string;
  data?: Record<string, unknown>;
}

/** A record as the store keeps it (`XDBService.getAllRaw`). */
interface StoredRecord {
  id: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted?: boolean;
}

/** One record's ops go to the host one at a time (see `flushPendingOps`). */
function recordKey(op: SyncOp): string {
  return `${op.collection}\u0000${op.recordId}`;
}

/** Whether `value` nests objects and arrays more than `limit` deep, itself the first. Stops looking past the limit. */
function nestedDeeperThan(value: unknown, limit: number): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (limit <= 0) return true;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (nestedDeeperThan(child, limit - 1)) return true;
  }
  return false;
}

/** A lone half of a UTF-16 pair, which is not text: a slice through an emoji leaves one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * `value` with every string, keys too, as text the host's JSON reader takes:
 * a lone half of a UTF-16 pair is U+FFFD. `JSON.stringify` writes one as
 * `\ud83d`, which serde_json refuses, and it refused the whole push for it.
 * Called only on a value nested no deeper than an op may be.
 */
function wellFormed(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(LONE_SURROGATE, '�');
  if (Array.isArray(value)) return value.map(wellFormed);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key.replace(LONE_SURROGATE, '�')] = wellFormed(child);
    return out;
  }
  return value;
}

/** The length of `text` in UTF-8, which is what the host's limits count. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Whether (at, id) comes after `place` in the host's order of receipt. */
function receivedAfter(at: string, id: string, place: PullCursor | undefined): boolean {
  return !place || at > place.at || (at === place.at && id > place.id);
}

/**
 * Where a connection's pull starts: a millisecond before the place, which
 * the host's clock marks to the millisecond. A record the host received
 * later in the place's own millisecond, with an id that sorts before the
 * last one read, came after it and sorts before it: asked for from the place
 * itself, it was in no pull, ever. The millisecond is read again instead.
 */
function askFrom(place: PullCursor): PullCursor {
  const at = HOST_TIME.test(place.at) ? Date.parse(place.at) : NaN;
  return Number.isFinite(at) ? { at: new Date(at - 1).toISOString(), id: '' } : place;
}

function isPullCursor(value: unknown): value is PullCursor {
  const cursor = value as PullCursor | null;
  return !!cursor && typeof cursor.at === 'string' && typeof cursor.id === 'string';
}

/** An op read back from storage, if it still has the shape of one. */
function savedOp(value: unknown): SyncOp | null {
  const op = value as Partial<SyncOp> | null;
  if (!op || typeof op !== 'object') return null;
  if (typeof op.id !== 'string' || typeof op.collection !== 'string' || typeof op.recordId !== 'string') return null;
  if (op.operation !== 'create' && op.operation !== 'update' && op.operation !== 'delete') return null;
  if (typeof op.timestamp !== 'string') return null;
  if (op.data !== undefined && (typeof op.data !== 'object' || op.data === null || Array.isArray(op.data))) return null;
  return {
    id: op.id,
    collection: op.collection,
    operation: op.operation,
    recordId: op.recordId,
    ...(op.data !== undefined ? { data: op.data } : {}),
    timestamp: op.timestamp,
    clientId: typeof op.clientId === 'string' ? op.clientId : 'unknown',
  };
}

/** What the store offers for keeping sync state between page loads, if it offers it. */
interface SyncMetaStore {
  readSyncMeta(name: string): string | null;
  writeSyncMeta(name: string, value: string | null): void;
}

// ── Tickets ──────────────────────────────────────────────

/**
 * Where a host issues sync tickets: the sync URL's own path plus `/ticket`,
 * over HTTP(S), with no query. `wss://h/sync` is `https://h/sync/ticket`, and
 * a multi-tenant host's `wss://h/app/sync` is `https://h/app/sync/ticket`.
 */
export function syncTicketUrl(wsUrl: string): string {
  const base = typeof location === 'undefined' ? undefined : location.href;
  const url = new URL(wsUrl, base);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  url.pathname = url.pathname.replace(/\/+$/, '') + '/ticket';
  url.search = '';
  url.hash = '';
  return url.toString();
}

// ── XDB Server Sync ──────────────────────────────────────

export class XDBServerSync {
  private ws: WebSocket | null = null;
  private xdb: XDBService;
  private config: ServerSyncConfig;
  private clientId: string | null = null;
  private serverTime: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Failed connection attempts since the last successful one. */
  private reconnectAttempts = 0;
  /** Ops not yet sent. */
  private pendingOps = new Map<string, SyncOp>();
  /**
   * Ops sent and not yet answered. The host answers every op: `sync_ack`
   * (stored), `sync_reject` (refused for good) or `sync_retry` (not stored
   * this time — a full disk, a failing hook, a busy database). Until then an
   * op is not done; dropping it on send lost every retried op.
   */
  private inflightOps = new Map<string, SyncOp>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempts = 0;
  private opCounter = 0;
  /**
   * Part of every op id this client makes. Ids were the time and a counter
   * that starts again with each page, so two devices could make the same
   * one, and the host knows an op sent again by its id.
   */
  private readonly opTag = Math.random().toString(36).slice(2, 8) || 'x';
  /**
   * How far the host's clock is ahead of this device's, in milliseconds, as
   * its `auth_ok` said (`serverTime`); 0 until one has.
   */
  private clockOffset = 0;
  /**
   * When each op not yet sent was made, by this device's clock. It is
   * stamped in the host's time when it is first sent: the host weighs an
   * edit by its stamp against the record's last change, and stamps what it
   * writes itself (a hook's `db.update`) by its own clock, so an edit from
   * a device whose clock was behind lost to any such write made in the gap.
   */
  private madeAt = new Map<string, number>();
  /**
   * What else bounds an op's stamp. `asIs`: an op the startup scan found,
   * whose time is the record's own stamp, already in whatever clock wrote it
   * (a record heard from the host carries the host's). The host's offset was
   * added to it as to a time of this device's: every record heard from a
   * host whose clock ran a second or more ahead went back on the next load
   * stamped that much later than its edit, past edits other devices made
   * since, and its old data replaced theirs. `floor`: the stamp the change
   * left on its record (XDBService stamps an edit after the copy it edits),
   * which the op is never stamped before; stamped with this clock alone, an
   * edit made just after a write it had heard lost to it on the host.
   */
  private stampOf = new Map<string, { floor?: number; asIs?: boolean }>();
  /**
   * Ops this client is done with since it last saved the queue: answered, refused, or replaced
   * by a newer op of their record. The saved queue is the app's, which another tab of it saves
   * into too, so what is saved leaves out these and keeps every other op found there (`save`).
   */
  private finished = new Set<string>();
  /**
   * Deletes for records removed for good here while nothing listened (`queueUnsyncedChanges`).
   * The host may never have had the record (made and removed here before it was sent), and
   * refuses the delete as not found: that is the removal done, not a change refused.
   */
  private removals = new Set<string>();
  /**
   * The newest op queued for each record, by `recordKey`: an update not yet
   * sent is replaced by the next update or delete of its record, rather than
   * waiting its turn behind it (one op per record at a time).
   */
  private lastOpFor = new Map<string, string>();
  /**
   * Where the last pull of each collection ended on this host: the receipt
   * time and id of the newest record it brought. The next pull asks for what
   * came after, which includes the records deleted since; a pull of the whole
   * collection lists live records only, so a record deleted while this device
   * was away stayed here for good.
   */
  private pulled = new Map<string, PullCursor>();
  /**
   * For a collection with no place yet, the host's time when the first
   * connection that pulled it whole was authenticated (`auth_ok`). A whole
   * pull lists live records only: a record this device has from a delta, or
   * from a connection whose pull never finished, may have been deleted
   * before the newest record such a pull brings, and a place set there
   * passed over its deletion for good. A whole pull places the collection no
   * later than this, and every change since, deletions included, comes in
   * the next pull; when the floor is older than the connection, it is asked
   * for with the whole pull as well.
   */
  private floors = new Map<string, string>();
  /**
   * Collections a record of which could not be written here during this
   * connection's pull (a full store, or a message too large to take): where
   * they were pulled to stays put, so the next pull brings that record again
   * instead of going on past it.
   */
  private pullStuck = new Set<string>();
  /**
   * Collections a record of which this connection's pull passed over,
   * because an edit made here is still waiting on the server's answer. Their
   * place stays before it, as for `pullStuck`: the place used to move on past
   * the record, and when the answer that would have put it right never came
   * (a message this client dropped), no later pull brought it again. The
   * pull itself goes on (`readTo`).
   */
  private pullHeld = new Set<string>();
  /** How far this connection's pull of each collection has read, whatever was written here. */
  private readTo = new Map<string, PullCursor>();
  /**
   * The records, by collection, a live version of which reached this client
   * on this connection: a delta written here, or the acknowledgement of an
   * edit made here. A pull's records are read while the host goes on taking
   * edits, and the host sends a pull's pieces and the stream of edits on one
   * socket in no fixed order, so a piece read before an edit could arrive
   * after that edit's delta (or after this client's own edit was answered)
   * and put the older record back; this client's next edit then sent it to
   * the host whole. The connection hears every edit from its start, so once
   * a record has come live, a pull's copy of it is never newer, and is passed
   * over. A new connection starts again (`onAuthenticated`).
   */
  private heardLive = new Map<string, Set<string>>();
  /** Records received per collection of a pull that named a point to start from. */
  private sincePulled = new Map<string, number>();
  /**
   * The device's time up to which every change made here is in the queue or
   * answered (`WATCHED_META`); null when this store has never been synced,
   * and every record in it is one the server has yet to be sent.
   */
  private watched: number | null = null;
  /** Collections this client has written to: with a `collections` list, these are its own as well. */
  private written = new Set<string>();
  /** Collections pulled on this connection; a first write to another pulls it (`pullOnFirstUse`). */
  private pulledHere = new Set<string>();
  /** The collections this connection pulled when it was authenticated. */
  private connectionCollections: string[] = [];
  /** Collections whose pull the host refused for now, to be asked for again after a backoff. */
  private pullRetry = new Set<string>();
  private pullRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pullRetryAttempts = 0;
  /** Whether the names in `collections` the host would refuse have been said. */
  private warnedNames = false;
  /** Whether the queue or the pull positions changed since they were last saved. */
  private queueDirty = false;
  private pulledDirty = false;
  private saveScheduled = false;
  private connected = false;
  private destroyed = false;
  private xdbUnsubscribe: (() => void) | null = null;
  private initialPullDone = false;
  /**
   * The ticket request in flight, by number. A disconnect() moves the number
   * on, so a ticket that arrives after it opens nothing.
   */
  private ticketAttempt = 0;
  private ticketPending = false;
  /** connect() was called, and disconnect() not since. */
  private started = false;
  /**
   * Whether the app's host is showing it (`setAppShown`). A hidden app keeps
   * its socket only while it has something to send, and for `restAfterMs`
   * after: it is opened for a change the app makes, and closed again once
   * the change is answered.
   */
  private shown = true;
  private restTimer: ReturnType<typeof setTimeout> | null = null;

  /** Event listeners */
  private listeners = {
    connect: [] as Array<() => void>,
    disconnect: [] as Array<() => void>,
    error: [] as Array<(err: string) => void>,
    reject: [] as Array<(opId: string, reason: string) => void>,
  };

  constructor(xdb: XDBService, config: ServerSyncConfig) {
    this.xdb = xdb;
    this.config = config;
    this.restore();
  }

  /** Start the sync connection. */
  connect(): void {
    if (this.ws || this.ticketPending) return;
    this.destroyed = false;
    // Queue local mutations from now on, not from the first auth_ok: what the
    // app writes before the socket is up is exactly what "accumulated while
    // offline" means, and it used to be dropped. And first, what was written
    // while nothing listened: the app writes before the client exists (it
    // starts after consent, and after an async import), and such a record
    // never reached the server, which then refused every later edit of it.
    if (!this.xdbUnsubscribe) {
      this.queueUnsyncedChanges();
      this.listenForLocalChanges();
      this.saveSoon();
    }
    // Started only now: what the scan above queued opens the one socket
    // below, not a second through wakeToSend.
    this.started = true;
    // An app started behind another tab, with nothing to send, opens nothing:
    // it connects when it is shown, or when it writes something.
    if (!this.shown && !this.hasUnsent()) return;
    if (this.ws || this.ticketPending || this.reconnectTimer) return;
    this.createConnection();
  }

  /**
   * Say whether the app's host is showing it. A hidden app's socket closes
   * once nothing is waiting to be sent or answered, `restAfterMs` after that,
   * and no remote change reaches it meanwhile; what it writes is still
   * queued, and opens the socket to be sent. Shown again, it connects and
   * pulls what changed while it was away. Every app open in SoftN Web kept a
   * socket to its sync host, behind whichever tab was on screen.
   */
  setAppShown(shown: boolean): void {
    if (this.shown === shown) return;
    this.shown = shown;
    this.clearRestTimer();
    if (!this.started) return;
    if (!shown) {
      this.restSoon();
      return;
    }
    // A reconnect waiting out a backoff (a host's Retry-After among them) is
    // left to it.
    if (!this.ws && !this.ticketPending && !this.reconnectTimer) this.createConnection();
  }

  /** Whether any change made here is still to be sent or answered. */
  private hasUnsent(): boolean {
    return this.pendingOps.size > 0 || this.inflightOps.size > 0;
  }

  private clearRestTimer(): void {
    if (this.restTimer) clearTimeout(this.restTimer);
    this.restTimer = null;
  }

  /** Hidden: close the socket `restAfterMs` from now, if nothing is waiting by then. */
  private restSoon(): void {
    if (this.shown || !this.started || this.destroyed) return;
    this.clearRestTimer();
    this.restTimer = setTimeout(() => {
      this.restTimer = null;
      if (this.shown || this.hasUnsent()) return;
      this.closeSocket();
    }, this.config.restAfterMs ?? REST_AFTER_MS);
  }

  /**
   * Close the socket and what is waiting on it, and go on listening for the
   * app's changes: unlike disconnect(), the queue stays live, so a change
   * made while resting (a hard delete among them, which no later scan finds)
   * is queued and opens the socket again.
   */
  private closeSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearPullRetry();
    this.requeueInflight();
    this.save();
    this.ticketAttempt++;
    this.ticketPending = false;
    const wasConnected = this.connected;
    if (this.ws) {
      // Cleared first, as in disconnect(): the socket's own onclose then
      // leaves the state alone and schedules nothing.
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
    this.connected = false;
    this.clientId = null;
    if (wasConnected) this.listeners.disconnect.forEach((fn) => fn());
  }

  /** Hidden and resting: open the socket for a change to send, once. */
  private wakeToSend(): void {
    if (this.shown || !this.started || this.destroyed) return;
    if (this.ws || this.ticketPending || this.reconnectTimer) return;
    this.createConnection();
  }

  /** Disconnect and stop syncing. */
  disconnect(): void {
    this.destroyed = true;
    this.started = false;
    this.clearRestTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.clearPullRetry();
    this.requeueInflight();
    // Saved now, not at the end of the task: whoever opens the store next
    // (a remount, a reload) reads what this one leaves, and where listening
    // stopped (saved while still listening).
    this.save();
    if (this.xdbUnsubscribe) {
      this.xdbUnsubscribe();
      this.xdbUnsubscribe = null;
    }
    const wasConnected = this.connected;
    this.ticketAttempt++;
    this.ticketPending = false;
    if (this.ws) {
      // Cleared before close(): the socket's own onclose sees it is no longer
      // the current socket and leaves the state alone, so a connect() that
      // follows is not undone by the old socket closing late.
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
    this.connected = false;
    this.clientId = null;
    if (wasConnected) this.listeners.disconnect.forEach((fn) => fn());
  }

  /** Get the current connection status. */
  get status(): ServerSyncStatus {
    return {
      connected: this.connected,
      clientId: this.clientId,
      serverTime: this.serverTime,
    };
  }

  /** Register an event listener. */
  on(event: keyof typeof this.listeners, fn: (...args: unknown[]) => void): void {
    (this.listeners[event] as Array<(...args: unknown[]) => void>).push(fn);
  }

  // ── Internal ───────────────────────────────────────────

  private createConnection(): void {
    // Enforce wss:// in production to prevent MitM. Allow ws:// only when
    // explicitly opted in (local development against localhost).
    // URL schemes are case-insensitive: `WS://` dials the same plaintext
    // socket `ws://` does, and used to walk past this check.
    const url = this.config.wsUrl;
    if (/^ws:\/\//i.test(url) && !this.config.allowInsecureWs) {
      const host = new URL(url.replace(/^ws:\/\//i, 'http://')).hostname;
      if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '[::1]') {
        this.listeners.error.forEach((fn) =>
          fn(
            'Insecure ws:// connections are blocked outside localhost. Use wss:// or set allowInsecureWs for development.'
          )
        );
        return;
      }
    }

    // A host with a token authenticates the handshake itself, before any
    // message: the socket used to open bare and send the token in a first
    // `auth` message, which the host never reads, so every client with a
    // token was refused. The token buys a ticket; the ticket opens the socket.
    if (this.config.token) {
      void this.connectWithTicket(url, this.config.token);
      return;
    }
    this.openSocket(url);
  }

  /** Trade the token for a ticket, then open the socket with it. */
  private async connectWithTicket(url: string, token: string): Promise<void> {
    const attempt = ++this.ticketAttempt;
    this.ticketPending = true;
    const stale = () => this.destroyed || attempt !== this.ticketAttempt;
    let ticket: unknown;
    try {
      const response = await fetch(syncTicketUrl(url), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'omit',
        cache: 'no-store',
      });
      if (stale()) return;
      if (!response.ok) {
        this.ticketPending = false;
        this.listeners.error.forEach((fn) =>
          fn(`The sync host refused a ticket (HTTP ${response.status}).`)
        );
        // A refused token stays refused; anything else may be passing — a
        // 429 or 503 says how long to wait, and waiting less only earns
        // another one.
        if (response.status !== 401 && response.status !== 403) {
          this.scheduleReconnect(retryAfterMs(response));
        }
        return;
      }
      ticket = ((await response.json()) as { ticket?: unknown } | null)?.ticket;
    } catch {
      if (stale()) return;
      this.ticketPending = false;
      this.listeners.error.forEach((fn) => fn('The sync host could not be reached for a ticket.'));
      this.scheduleReconnect();
      return;
    }
    if (stale()) return;
    this.ticketPending = false;
    if (typeof ticket !== 'string' || ticket === '') {
      this.listeners.error.forEach((fn) =>
        fn('The sync host answered the ticket request without a ticket.')
      );
      this.scheduleReconnect();
      return;
    }
    const target = new URL(url, typeof location === 'undefined' ? undefined : location.href);
    target.searchParams.set('ticket', ticket);
    this.openSocket(target.toString());
  }

  private openSocket(url: string): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    // Every handler checks it still belongs to the current socket. After a
    // disconnect()+connect(), or a reconnect racing a slow close, the old
    // socket's onclose used to null out the new one and schedule a second
    // reconnect, leaving two live sockets behind.
    //
    // Nothing is sent on open: the handshake was authenticated before the
    // upgrade, and the host speaks first (`auth_ok`). An `auth` message with
    // the app's version used to go here, which no host reads.

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      try {
        const raw = event.data as string;
        // Counted in characters, which are never more than the bytes the
        // host counts.
        if (raw.length > MAX_MESSAGE_BYTES) {
          console.warn('[XDBServerSync] Message too large, discarding:', raw.length);
          // A piece of a pull that was not taken: its collection stays where
          // it was pulled to, so the next pull brings these records again.
          const pulled = /^\{"type":"sync_state","collection":"([A-Za-z0-9_-]{1,64})"/.exec(raw.slice(0, 120));
          if (pulled) this.pullStuck.add(pulled[1]);
          return;
        }
        const msg = JSON.parse(raw) as Record<string, unknown>;
        if (!msg || typeof msg.type !== 'string') {
          console.warn('[XDBServerSync] Invalid message structure, discarding');
          return;
        }
        this.handleMessage(msg as ServerMessage);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.ws = null;
      // Whatever was unanswered goes again on the next connection, which
      // pulls every collection again too.
      this.requeueInflight();
      this.clearPullRetry();
      this.listeners.disconnect.forEach((fn) => fn());
      // A hidden app goes back only for something to send.
      if (!this.destroyed && (this.shown || this.hasUnsent())) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'auth_ok':
        this.clientId = msg.clientId;
        this.serverTime = msg.serverTime;
        this.clockOffset = clockOffset(msg.serverTime, Date.now());
        this.connected = true;
        this.reconnectAttempts = 0;
        this.listeners.connect.forEach((fn) => fn());
        this.onAuthenticated();
        break;

      case 'sync_state':
        this.handleSyncState(msg.collection, msg.records, msg.more);
        break;

      case 'sync_delta':
        this.handleSyncDelta(msg.ops);
        break;

      case 'sync_ack':
        for (const id of Array.isArray(msg.opIds) ? msg.opIds : []) {
          // The record as edited here is the host's now (`heardLive`).
          const op = this.inflightOps.get(id) ?? this.pendingOps.get(id);
          if (op) this.noteHeardLive(op.collection, op.recordId);
          // Put back in the queue by an error that was not about it, and
          // not sent again yet: it is done, and is not sent again. It used
          // to go again once the error had moved it, and the host applied
          // and broadcast it a second time.
          if (this.inflightOps.delete(id) || this.pendingOps.delete(id)) {
            this.forgetMade(id);
            this.finished.add(id);
            this.removals.delete(id);
            this.queueChanged();
          }
        }
        this.retryAttempts = 0;
        // A record's next op waited for this answer.
        this.flushPendingOps();
        break;

      case 'sync_reject':
        this.handleSyncReject(msg.opId, msg.reason);
        break;

      case 'sync_retry':
        this.handleSyncRetry(Array.isArray(msg.opIds) ? msg.opIds : []);
        break;

      case 'error':
        this.listeners.error.forEach((fn) => fn(msg.message));
        this.handleError(msg);
        break;
    }
    // Hidden, and everything this app made is answered: the socket rests
    // `restAfterMs` from now, unless the app writes again before then.
    if (!this.shown && this.ws && !this.restTimer && !this.hasUnsent()) this.restSoon();
  }

  /**
   * What the host could not do. A host that says what it refused (`for`)
   * refuses a pull with the collections it did not send, and they are asked
   * for again; the pushes in flight are left alone, since a push it cannot
   * take is answered `sync_retry` with its ops. A host from before says
   * nothing: a refusal that came before the first pull was answered is taken
   * for that pull (no push goes before it), and anything else for the pushes
   * in flight, which go again. "Server busy" for the first pull used to leave
   * the pull unasked for good, and every push waiting behind it; and an
   * error that answered a pull sent the pushes in flight again.
   */
  private handleError(msg: Extract<ServerMessage, { type: 'error' }>): void {
    if (msg.for === 'pull') {
      if (typeof msg.retryAfter === 'number' && msg.retryAfter >= 0) {
        const collections = Array.isArray(msg.collections) ? msg.collections.filter((c) => typeof c === 'string') : [];
        this.retryPull(collections.length > 0 ? collections : this.connectionCollections, msg.retryAfter * 1000);
      }
      return;
    }
    if (msg.for === undefined && !this.initialPullDone && this.connected && this.connectionCollections.length > 0) {
      this.retryPull(this.connectionCollections, 0);
    }
    // A push the host could not take at all names no ops. Anything sent and
    // unanswered is tried again later; one that did land is acknowledged
    // and not applied again (the host knows it by its id).
    if (this.inflightOps.size > 0) {
      this.requeueInflight();
      this.scheduleRetry();
    }
  }

  /** Ask for these collections again after a backoff, and at least `atLeastMs`. */
  private retryPull(collections: string[], atLeastMs: number): void {
    for (const collection of collections) this.pullRetry.add(collection);
    if (this.destroyed || this.pullRetryTimer || this.pullRetry.size === 0) return;
    const delay = Math.max(backoffDelay(this.config.reconnectDelay ?? 2000, this.pullRetryAttempts++), Math.min(atLeastMs, 10 * MAX_RETRY_DELAY));
    this.pullRetryTimer = setTimeout(() => {
      this.pullRetryTimer = null;
      const again = [...this.pullRetry];
      this.pullRetry.clear();
      if (!this.connected) return;
      for (const pull of this.pullsFor(again)) this.send(pull);
    }, delay);
  }

  private clearPullRetry(): void {
    if (this.pullRetryTimer) clearTimeout(this.pullRetryTimer);
    this.pullRetryTimer = null;
    this.pullRetry.clear();
  }

  /** Put unanswered ops back at the front of the queue, in the order sent. */
  private requeueInflight(): void {
    if (this.inflightOps.size === 0) return;
    this.pendingOps = new Map([...this.inflightOps, ...this.pendingOps]);
    this.inflightOps.clear();
  }

  /**
   * The host did not store these ops this time: queue them and try later.
   * Back at the front of the queue they are still ahead of every later op of
   * their records, none of which has been sent (see `flushPendingOps`).
   */
  private handleSyncRetry(opIds: string[]): void {
    const retry = new Map<string, SyncOp>();
    for (const id of opIds) {
      const op = this.inflightOps.get(id);
      if (op) {
        this.inflightOps.delete(id);
        retry.set(id, op);
      }
    }
    if (retry.size === 0) return;
    this.pendingOps = new Map([...retry, ...this.pendingOps]);
    this.scheduleRetry();
  }

  /** Flush again after a backoff, rather than straight into the same refusal. */
  private scheduleRetry(): void {
    if (this.destroyed || this.retryTimer) return;
    const delay = backoffDelay(this.config.reconnectDelay ?? 2000, this.retryAttempts++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flushPendingOps();
    }, delay);
  }

  /** Called after successful auth — subscribe, pull state, flush offline ops. */
  private onAuthenticated(): void {
    const collections = this.syncedCollections();
    this.connectionCollections = collections;
    this.pulledHere = new Set(collections);
    this.pullStuck.clear();
    this.pullHeld.clear();
    this.readTo.clear();
    this.heardLive.clear();
    this.sincePulled.clear();
    this.clearPullRetry();
    this.pullRetryAttempts = 0;

    // The collections whose changes this client wants. A host that reads it
    // sends those, and any this client pulls or pushes to later; with none
    // named yet, it sends nothing until this client uses a collection. One
    // that does not read it sends everything, as before.
    this.send({ type: 'subscribe', collections });

    if (collections.length > 0) {
      // Pull initial state
      for (const pull of this.pullsFor(collections)) this.send(pull);
    } else {
      // Nothing to pull is a pull that is done. Left false, no local
      // mutation was ever pushed for an app whose first record is still to
      // be written.
      this.initialPullDone = true;
    }

    // Flush any mutations that accumulated while offline. Ops queued before
    // the first pull wait for it, and go out from handleSyncState.
    this.flushPendingOps();

    // Listen for local XDB mutations and push them to the server
    this.listenForLocalChanges();
  }

  /**
   * The collections this client syncs: its `collections` list, or every one
   * the store knows. Only names the host takes: it refuses a pull naming any
   * other, and a refused name in the app's own list is said once, here.
   */
  private syncedCollections(): string[] {
    const listed = this.config.collections;
    if (!listed) return this.getKnownCollections();
    const usable = listed.filter((name) => typeof name === 'string' && SYNCABLE_COLLECTION.test(name));
    if (usable.length !== listed.length && !this.warnedNames) {
      this.warnedNames = true;
      console.warn('[XDBServerSync] Collections the sync host does not take (letters, digits, "-" and "_", at most 64) are not synced:', listed.filter((name) => !usable.includes(name)));
    }
    return [...new Set(usable)];
  }

  /** Whether records of `collection` the server sends are written here (`collections`). */
  private wants(collection: string): boolean {
    const listed = this.config.collections;
    return !listed || listed.includes(collection) || this.written.has(collection);
  }

  /**
   * A collection this client writes to for the first time on this
   * connection, with no `collections` list: the rest of it is pulled now.
   * A collection was pulled only when the client connected, so one first
   * used after that was not pulled until the next connection.
   */
  private pullOnFirstUse(collection: string): void {
    if (this.config.collections || !this.connected || this.pulledHere.has(collection)) return;
    if (!SYNCABLE_COLLECTION.test(collection)) return;
    this.pulledHere.add(collection);
    for (const pull of this.pullsFor([collection])) this.send(pull);
  }

  /**
   * The pulls that bring each collection up to date: from where its last
   * pull ended when there was one, else the whole of it, never more
   * collections in one than the host reads (it refuses the whole pull).
   * Names the host would refuse are left out when they come from storage
   * rather than the app's own list.
   */
  private pullsFor(collections: string[]): ClientMessage[] {
    const pulls: ClientMessage[] = [];
    const whole: string[] = [];
    const since: ClientMessage[] = [];
    const now = typeof this.serverTime === 'string' && HOST_TIME.test(this.serverTime) ? this.serverTime : null;
    for (const collection of new Set(collections)) {
      const place = this.pulled.get(collection);
      if (place) {
        const from = askFrom(place);
        since.push({ type: 'sync_pull', collections: [collection], lastSync: from.at, lastId: from.id });
        this.sincePulled.set(collection, 0);
        if (this.floors.delete(collection)) this.pulledDirty = true;
      } else {
        whole.push(collection);
        const floor = this.floors.get(collection);
        if (now !== null && (floor === undefined || now < floor)) {
          this.floors.set(collection, now);
          this.pulledDirty = true;
        } else if (floor !== undefined && now !== null && floor < now) {
          // An earlier connection asked for it whole and had no answer, and
          // may have brought records by deltas: what changed since then,
          // deletions included, comes with the whole pull.
          const from = askFrom({ at: floor, id: '' });
          since.push({ type: 'sync_pull', collections: [collection], lastSync: from.at, lastId: from.id });
          this.sincePulled.set(collection, 0);
        }
      }
    }
    if (this.pulledDirty) this.saveSoon();
    for (let i = 0; i < whole.length; i += MAX_PULL_COLLECTIONS) {
      pulls.push({ type: 'sync_pull', collections: whole.slice(i, i + MAX_PULL_COLLECTIONS) });
    }
    return [...pulls, ...since];
  }

  /**
   * Push every queued op, in pieces the host accepts, and hold each until
   * the host answers it (see `inflightOps`). An acknowledged op is done, so a
   * reconnect replays only what was never answered, not the session.
   *
   * A record has one op in flight at a time; its next op goes once the host
   * has answered the one before. The host answers each op of a push on its
   * own, and may ask for one to be sent again while it applies the next: a
   * create it could not store this time, followed by an update of the same
   * record, left the update refused ("not found") and lost once the create
   * was stored on the retry, or a delete undone the same way.
   */
  private flushPendingOps(): void {
    if (!this.connected || !this.initialPullDone || this.pendingOps.size === 0) return;
    // A retry is waiting out a backoff; new ops go with it.
    if (this.retryTimer) return;
    const busy = new Set<string>();
    for (const op of this.inflightOps.values()) busy.add(recordKey(op));
    let batch: SyncOp[] = [];
    let bytes = PUSH_ENVELOPE_BYTES;
    const sendBatch = (): boolean => {
      if (batch.length === 0) return true;
      if (!this.send({ type: 'sync_push', ops: batch })) return false;
      for (const op of batch) {
        this.pendingOps.delete(op.id);
        this.inflightOps.set(op.id, op);
      }
      this.queueChanged();
      batch = [];
      bytes = PUSH_ENVELOPE_BYTES;
      return true;
    };
    for (const op of Array.from(this.pendingOps.values())) {
      const key = recordKey(op);
      if (busy.has(key)) continue;
      // Stamped now: an op queued before auth knew no client id, nor the
      // host's time. An op sent before keeps the time it was sent with.
      op.clientId = this.clientId ?? op.clientId;
      const made = this.madeAt.get(op.id);
      if (made !== undefined) {
        const how = this.stampOf.get(op.id);
        const at = how?.asIs ? made : Math.max(made + this.clockOffset, how?.floor ?? -Infinity);
        op.timestamp = new Date(at).toISOString();
        this.forgetMade(op.id);
      }
      // A push the host cannot read is refused whole, with every op in it,
      // and the client sent the same push again for ever after: one change
      // nested past what the host reads, or holding half an emoji, stopped
      // every change behind it reaching the host.
      if (nestedDeeperThan(op, MAX_OP_DEPTH)) {
        this.refuseOp(op, `This change to "${op.collection}" is nested more than ${MAX_OP_DEPTH - 1} levels deep, deeper than the sync host reads; it was not sent.`);
        continue;
      }
      if (op.data !== undefined) op.data = wellFormed(op.data) as SyncOp['data'];
      const size = utf8Length(JSON.stringify(op)) + 1;
      if (PUSH_ENVELOPE_BYTES + size > MAX_MESSAGE_BYTES) {
        this.refuseOp(op, `This change to "${op.collection}" is ${size} bytes, more than the sync host takes in one message (${MAX_MESSAGE_BYTES}); it was not sent.`);
        continue;
      }
      if (batch.length > 0 && (batch.length >= MAX_OPS_PER_PUSH || bytes + size > MAX_PUSH_BYTES)) {
        if (!sendBatch()) return;
      }
      batch.push(op);
      bytes += size;
      busy.add(key);
    }
    sendBatch();
  }

  /**
   * The records this device has edited or deleted and the server has not yet
   * answered for, by `collection` and id, each with whether it was deleted
   * here. Until the server answers, the record stays as it is here whatever
   * the server sends for it; once it has, what it sends is the record (see
   * `XDBService.upsertFromServer`). `answered` are ops the server is
   * answering now with their records as they stand.
   *
   * The host answers a pull before it reads a push sent after it, so a pull
   * on reconnect came back with a record as it was before the edit queued
   * offline, and wrote over it; the host never sends a pusher its own edit,
   * so the old value stayed, and the next edit sent it back to the server. A
   * create is not held: one sent again after its acknowledgement was lost is
   * acknowledged with nothing more, and the pull is what puts it right.
   */
  private unansweredChanges(answered: ReadonlySet<string> = new Set()): Map<string, 'update' | 'delete'> {
    const changed = new Map<string, 'update' | 'delete'>();
    for (const ops of [this.pendingOps, this.inflightOps]) {
      for (const op of ops.values()) {
        if (op.operation === 'create' || answered.has(op.id)) continue;
        const key = `${op.collection}\u0000${op.recordId}`;
        // Nothing is edited here after it is deleted, so a delete is the last word.
        if (changed.get(key) !== 'delete') changed.set(key, op.operation);
      }
    }
    return changed;
  }

  /**
   * Apply one message of a pull: each record upserted, each one the host
   * says was deleted since the point the pull named removed, and that
   * point moved on to the newest record written here.
   */
  private handleSyncState(collection: string, records: ServerRecord[], more?: PullCursor): void {
    if (typeof collection !== 'string') return;
    // Not one of this client's collections (`collections`): not written here.
    if (!this.wants(collection)) return;
    const changed = this.unansweredChanges();
    const list = Array.isArray(records) ? records : [];
    let place = this.pulled.get(collection);
    let moved = false;
    // A collection pulled whole on this connection is placed no later than
    // its floor (`floors`), whichever pull this message answers.
    const floor = this.floors.get(collection);
    const live = this.heardLive.get(collection);
    for (const record of list) {
      if (!record || typeof record.id !== 'string') continue;
      // Records the host has no receipt time for come first in a whole pull
      // and are not in a pull from a point; they mark no place.
      const at = typeof record.serverReceivedAt === 'string' ? record.serverReceivedAt : '';
      if (at !== '') this.readTo.set(collection, { at, id: record.id });
      // One record that could not be written here (a full store) threw out
      // of this loop: the rest of the pull was never written, and the first
      // pull never counted as done, so nothing made here was pushed again.
      // It is passed over, and the pull goes on. So is one this connection
      // has had live: what is here is no older (`heardLive`).
      try {
        if (!live?.has(record.id) && !this.applyPulled(collection, record, changed.get(`${collection}\u0000${record.id}`))) {
          this.pullHeld.add(collection);
          continue;
        }
      } catch (err) {
        if (!this.pullStuck.has(collection)) {
          console.warn(`[XDBServerSync] A record of "${collection}" from the server could not be saved here; the next pull brings it again:`, err);
        }
        this.pullStuck.add(collection);
        continue;
      }
      if (at === '' || this.pullStuck.has(collection) || this.pullHeld.has(collection)) continue;
      const mark = floor !== undefined && receivedAfter(at, record.id, { at: floor, id: '' }) ? { at: floor, id: '' } : { at, id: record.id };
      if (receivedAfter(mark.at, mark.id, place)) {
        place = mark;
        moved = true;
      }
    }
    // A whole pull that found nothing marks no place, and every later pull
    // was whole again, so a record that came by a delta and was deleted
    // while this device was away stayed here. The floor marks it instead.
    if (!place && list.length === 0 && !isPullCursor(more) && floor !== undefined) {
      place = { at: floor, id: '' };
      moved = true;
    }
    if (moved && place) {
      this.pulled.set(collection, place);
      this.pulledDirty = true;
      this.saveSoon();
    }
    if (isPullCursor(more)) {
      // The page was full, so the collection goes on: ask for the rest. A
      // collection past one page used to stop here, at its oldest ten
      // thousand records, on every device that ever pulled it. (A whole
      // pull, so not one the count below is for.)
      this.sincePulled.delete(collection);
      this.send({ type: 'sync_pull', collections: [collection], cursor: { at: more.at, id: more.id } });
    } else {
      const counted = this.sincePulled.get(collection);
      if (counted !== undefined) {
        const total = counted + list.length;
        // Asked again from where this pull read to, which is past the place
        // when a record was passed over (`pullHeld`): from the place itself,
        // the same page came back for as long as that record waited.
        const from = this.readTo.get(collection);
        if (total >= INCREMENTAL_PULL_ROWS && from && !this.pullStuck.has(collection)) {
          this.sincePulled.set(collection, 0);
          this.send({ type: 'sync_pull', collections: [collection], lastSync: from.at, lastId: from.id });
        } else {
          this.sincePulled.set(collection, total);
        }
      }
    }
    this.pullRetryAttempts = 0;
    this.initialPullDone = true;
    // The device has what the server sent: a record it wrote is not one made here.
    this.saveSoon();
    this.flushPendingOps();
  }

  /**
   * One record of a pull, written here unless a change made here is still
   * waiting on it; false when it was passed over for that reason.
   */
  private applyPulled(collection: string, record: ServerRecord, here: 'update' | 'delete' | undefined): boolean {
    if (record.deleted === true) {
      // Deleted on the host since this device last pulled. A change made
      // here to it is answered by the host with the record as it stands,
      // deleted, so there is nothing here to wait for.
      this.xdb.deleteFromServer(collection, record.id);
      return true;
    }
    if (here === 'update') return false;
    if (typeof record.data !== 'object' || record.data === null || Array.isArray(record.data)) return true;
    this.xdb.upsertFromServer(
      collection,
      {
        id: record.id,
        collection: record.collection,
        data: record.data,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
      here === 'delete'
    );
    return true;
  }

  /** Apply live deltas from other clients. */
  private handleSyncDelta(ops: SyncOp[]): void {
    // The host sends this device the record as it stands for an op of its
    // own that it did not apply, from "server" and under that op's id. A
    // delete answered so is answered, whether its acknowledgement comes
    // before the record or after it: kept hidden until the acknowledgement,
    // a record sent first stayed hidden until the next full pull. The same
    // goes for an op a hook on the host changed, and for an update or a
    // delete it refused, whose records it sends as stored.
    const list = (Array.isArray(ops) ? ops : []).filter(
      (op): op is SyncOp =>
        !!op && typeof op.recordId === 'string' && typeof op.collection === 'string' && this.wants(op.collection)
    );
    if (list.length === 0) return;
    // The device has what the server sent: a record it wrote is not one made here.
    this.saveSoon();
    const answered = new Set(list.filter((op) => op.clientId === 'server').map((op) => op.id));
    const changed = this.unansweredChanges(answered);
    for (const op of list) {
      const here = changed.get(`${op.collection}\u0000${op.recordId}`);
      const deletedHere = here === 'delete';
      // Another device's edit to a record edited here is left to the answer
      // to this device's edit: the host weighs the two, and sends the record
      // as it stands if the edit made here lost.
      if (here === 'update' && op.operation !== 'delete') {
        this.noteHeardLive(op.collection, op.recordId);
        continue;
      }
      // One op that cannot be written here (a full store) no longer takes
      // the rest of the delta with it. Nor is it heard live: a pull may
      // still bring it.
      try {
        this.applyDelta(op, deletedHere);
        this.noteHeardLive(op.collection, op.recordId);
      } catch (err) {
        console.warn(`[XDBServerSync] A change to "${op.collection}" from the server could not be saved here:`, err);
      }
    }
  }

  /** How many records of one collection `heardLive` keeps; past that, a pull's copy is written as before. */
  private static readonly HEARD_LIVE_KEPT = 50_000;

  private noteHeardLive(collection: string, id: string): void {
    let ids = this.heardLive.get(collection);
    if (!ids) this.heardLive.set(collection, (ids = new Set()));
    if (ids.size < XDBServerSync.HEARD_LIVE_KEPT) ids.add(id);
  }

  /** One op of a delta, written here. */
  private applyDelta(op: SyncOp, deletedHere: boolean): void {
    switch (op.operation) {
      case 'create':
        if (op.data) {
          this.xdb.upsertFromServer(
            op.collection,
            {
              id: op.recordId,
              collection: op.collection,
              data: op.data,
              createdAt: op.timestamp,
              updatedAt: op.timestamp,
            },
            deletedHere
          );
        }
        break;
      case 'update':
        if (op.data) {
          this.xdb.upsertFromServer(
            op.collection,
            {
              id: op.recordId,
              collection: op.collection,
              data: op.data,
              createdAt: '',
              updatedAt: op.timestamp,
            },
            deletedHere
          );
        }
        break;
      case 'delete':
        this.xdb.deleteFromServer(op.collection, op.recordId);
        break;
    }
  }

  /** Forget when an op was made and what bounds its stamp: it is stamped, answered or gone. */
  private forgetMade(id: string): void {
    this.madeAt.delete(id);
    this.stampOf.delete(id);
  }

  /** Handle a rejected sync operation — remove from pending and notify. */
  private handleSyncReject(opId: string, reason: string): void {
    // A removal of a record the host never had (xdb's NotFound): done, as the host keeps no copy.
    const removed = this.removals.delete(opId) && /\bRecord not found\b/.test(String(reason));
    if (!removed) this.noteRefused(this.pendingOps.get(opId) ?? this.inflightOps.get(opId), reason);
    this.pendingOps.delete(opId);
    this.inflightOps.delete(opId);
    this.forgetMade(opId);
    this.finished.add(opId);
    this.queueChanged();
    if (removed) {
      this.flushPendingOps();
      return;
    }
    this.listeners.reject.forEach((fn) => fn(opId, reason));
    // The change stays here as it was made; this client keeps no copy of
    // the record from before it. The host puts it right: for an update or a
    // delete it refuses, it sends the record as it stands (a delta under
    // this op's id, applied as any answer is), and the copy here is the
    // server's again. A refused create is left here, where the app is told
    // of it: the server has no record to send back, and deleting what the
    // person made is not this client's call. A host from before sends the
    // record only for an update of a deleted record.
    // The record's next op, if there is one, was waiting for this answer.
    this.flushPendingOps();
  }

  /**
   * An op the host can never take: a push of it alone is larger than the
   * host lets a message be, and it closes the socket on one, or nested
   * deeper than it reads. Sent anyway, it went first after every reconnect
   * and was refused again, and nothing queued behind it ever reached the
   * host. It is dropped and reported as the host reports an op it refuses
   * for good.
   */
  private refuseOp(op: SyncOp, reason: string): void {
    this.pendingOps.delete(op.id);
    this.forgetMade(op.id);
    this.finished.add(op.id);
    this.removals.delete(op.id);
    this.queueChanged();
    console.warn(`[XDBServerSync] ${reason}`);
    this.noteRefused(op, reason);
    this.listeners.reject.forEach((fn) => fn(op.id, reason));
  }

  /**
   * A change the host will not take, said where the person sees it: the
   * storage status the app's notice bar watches. It was said only to `reject`
   * listeners, and the one host component (SoftNWithXDB) listens for `error`,
   * so a refused create stayed on this device and every later edit of it was
   * refused as unknown, and a refused update was undone by the record the
   * host sent back, with nothing shown either time.
   */
  private noteRefused(op: SyncOp | undefined, reason: string): void {
    const what = op ? `A change to "${op.collection}"` : 'A change';
    this.xdb._noteIssue({
      kind: 'sync-refused',
      ...(op ? { collection: op.collection } : {}),
      message: `${what} was not taken by the sync host (${String(reason).slice(0, 200)}). It is kept on this device only, or the host's copy has replaced it.`,
    });
  }

  /** Listen for local XDB mutations and push them to the server. */
  private listenForLocalChanges(): void {
    if (this.xdbUnsubscribe) return;

    // Subscribe to XDB events. When the local app creates/updates/deletes
    // a record, we push the mutation to the server.
    this.xdbUnsubscribe = this.xdb.onMutation((event) => {
      // Don't re-push mutations that came from the server
      if (event.source === 'server') return;
      if (event.type !== 'create' && event.type !== 'update' && event.type !== 'delete') return;
      this.pullOnFirstUse(event.collection);
      // Just after the copy the change was made after, when that was ahead of
      // this clock (XDBService's `after`): the op is not stamped before it. It
      // was the record's new stamp, read back for every change: the whole
      // collection parsed once a record (an import of thousands held the tab
      // for seconds), and, being this clock's time, ahead of the host's on a
      // device whose clock ran fast, where the offset is to put it.
      const after = typeof event.after === 'string' ? Date.parse(event.after) : NaN;
      this.queueChange(
        { type: event.type, collection: event.collection, recordId: event.recordId, data: event.data },
        Date.now(),
        Number.isFinite(after) ? { floor: after + 1 } : undefined
      );
    });
  }

  /**
   * Queue one change made here at `made` (this device's time, unless `how`
   * says it is a record's own stamp), and push what can go. `removal`: a
   * delete for a record removed for good while nothing listened (`removals`).
   */
  private queueChange(change: LocalChange, made: number, how?: { floor?: number; asIs?: boolean }, removal = false): void {
    // The counter starts again with each page, and ops restored from the
    // last one are in the queue: an id one of them has is not given again.
    let opId: string;
    do {
      opId = `op_${made}_${this.opTag}_${++this.opCounter}`;
    } while (this.pendingOps.has(opId) || this.inflightOps.has(opId));
    const op: SyncOp = {
      id: opId,
      collection: change.collection,
      operation: change.type,
      recordId: change.recordId,
      data: change.data,
      // In the host's time once it is sent (flushPendingOps).
      timestamp: new Date(made).toISOString(),
      clientId: this.clientId ?? 'unknown',
    };

    // An update of this record still waiting to be sent says nothing the
    // newer change does not: an update carries the record's whole data,
    // and a delete ends it. The newer one takes its place.
    const key = recordKey(op);
    const before = this.pendingOps.get(this.lastOpFor.get(key) ?? '');
    if (before && before.operation === 'update' && this.madeAt.has(before.id) && op.operation !== 'create') {
      this.pendingOps.delete(before.id);
      this.forgetMade(before.id);
      this.finished.add(before.id);
    }

    // Queued whether or not the socket is up. The connected check used to
    // come first, so a mutation made offline was never queued at all and
    // the "flush on reconnect" step had nothing to flush.
    this.pendingOps.set(opId, op);
    this.madeAt.set(opId, made);
    if (how) this.stampOf.set(opId, how);
    if (removal) this.removals.add(opId);
    this.lastOpFor.set(key, opId);
    this.written.add(change.collection);
    this.queueChanged();
    this.flushPendingOps();
    // A hidden app at rest opens its socket to send this.
    this.wakeToSend();
  }

  /**
   * Queue what was written here while no client listened: every record of
   * the synced collections changed since `watched`, or, in a store never
   * synced, every record it holds. A record created since then is a create;
   * one created before, an update or a delete of a record the server has.
   * (One created and deleted since never reached the server, and is let be.)
   * Each goes at the time it was made, as a change listened for would have.
   *
   * Records the server sent carry the times of the edits that made them; one
   * made after `watched` by another device's clock is sent back as it is, an
   * update the host takes with nothing changed. A record the server already
   * has, in a store never synced (a backup of a synced store opened on a new
   * device), is a create the host acknowledges and does not apply.
   */
  private queueUnsyncedChanges(): void {
    const store = this.xdb as {
      getAllRaw?: (collection: string) => unknown;
      takeFirstUnheardChange?: () => number | null;
      takeUnheardRemovals?: () => Array<{ collection: string; id: string; at: number }>;
    };
    // And no later than the first change this page made while nothing listened: another tab
    // of the app moves the mark on with its own saves, past such a change.
    const unheard = typeof store.takeFirstUnheardChange === 'function' ? store.takeFirstUnheardChange() : null;
    // And what this page removed for good meanwhile, which leaves nothing to look for.
    const removedBy = new Map<string, Array<{ id: string; at: number }>>();
    for (const { collection, id, at } of typeof store.takeUnheardRemovals === 'function' ? store.takeUnheardRemovals() : []) {
      const list = removedBy.get(collection);
      if (list) list.push({ id, at });
      else removedBy.set(collection, [{ id, at }]);
    }
    if (typeof store.getAllRaw !== 'function') return;
    const since = this.watched === null || unheard === null ? this.watched : Math.min(this.watched, unheard);
    const found: Array<{ made: number; change: LocalChange }> = [];
    const gone: Array<{ made: number; change: LocalChange }> = [];
    // In any collection a change heard here would be sent for, listed or not:
    // a clear takes its collection off the store's list, and its removals went
    // unsent with no `collections` to name it.
    for (const [collection, removals] of removedBy) {
      if (!SYNCABLE_COLLECTION.test(collection)) continue;
      let records: unknown;
      try {
        records = store.getAllRaw(collection);
      } catch {
        continue;
      }
      // A record made again since it was removed goes as itself.
      const held = new Set((Array.isArray(records) ? (records as Array<Partial<StoredRecord> | null>) : []).map((record) => record?.id));
      for (const { id, at } of removals) {
        if (!held.has(id)) gone.push({ made: at, change: { type: 'delete', collection, recordId: id } });
      }
    }
    for (const collection of this.syncedCollections()) {
      let records: unknown;
      try {
        records = store.getAllRaw(collection);
      } catch {
        continue;
      }
      for (const record of Array.isArray(records) ? (records as Array<Partial<StoredRecord> | null>) : []) {
        if (!record || typeof record.id !== 'string') continue;
        const updated = Date.parse(String(record.updated_at));
        if (since !== null && !(updated >= since)) continue;
        const made = Number.isFinite(updated) ? updated : Date.now();
        // What the queue holds for this record already says as much.
        const queued = this.pendingOps.get(this.lastOpFor.get(`${collection}\u0000${record.id}`) ?? '');
        if (queued && (this.madeAt.get(queued.id) ?? Date.parse(queued.timestamp)) >= made) continue;
        const created = Date.parse(String(record.created_at));
        const createdSince = since === null || !(created < since);
        const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data : {};
        if (record.deleted === true) {
          if (!createdSince) found.push({ made, change: { type: 'delete', collection, recordId: record.id } });
        } else {
          found.push({ made, change: { type: createdSince ? 'create' : 'update', collection, recordId: record.id, data } });
        }
      }
    }
    found.sort((a, b) => a.made - b.made);
    // Stamped with the record's own time as it is: not this device's, so no
    // offset is added to it.
    for (const { made, change } of found) this.queueChange(change, made, { asIs: true });
    // At the time each was removed, by this device's clock.
    for (const { made, change } of gone) this.queueChange(change, made, undefined, true);
  }

  // ── Kept between page loads ────────────────────────────

  /**
   * The store's own storage for the queue and the pull positions, when it
   * offers one. A queue held in memory alone was lost with the page: an
   * edit made offline and the app then closed never reached the host, and
   * the next pull wrote the host's copy over it.
   */
  private meta(): SyncMetaStore | null {
    const store = this.xdb as Partial<SyncMetaStore>;
    return typeof store.readSyncMeta === 'function' && typeof store.writeSyncMeta === 'function'
      ? (store as SyncMetaStore)
      : null;
  }

  /** Take up what the last page left: its unanswered ops, and where its pulls ended on this host. */
  private restore(): void {
    const meta = this.meta();
    if (!meta) return;
    // Where listening stopped. A store an older client synced has a queue
    // or a place and no such mark: what it missed it missed, and nothing is
    // looked for (rather than every record it holds sent again).
    const watched = Number(meta.readSyncMeta(WATCHED_META) ?? NaN);
    if (Number.isFinite(watched)) this.watched = watched;
    else if (meta.readSyncMeta(QUEUE_META) !== null || meta.readSyncMeta(PULLED_META) !== null) this.watched = Infinity;
    try {
      const saved = JSON.parse(meta.readSyncMeta(QUEUE_META) ?? 'null') as { ops?: unknown } | null;
      const ops = saved?.ops;
      for (const entry of Array.isArray(ops) ? ops : []) {
        const op = savedOp(entry);
        if (!op || this.pendingOps.has(op.id)) continue;
        this.pendingOps.set(op.id, op);
        // Not sent yet: stamped in the host's time when it is (flushPendingOps).
        const { made, floor, asIs, removal } = entry as { made?: unknown; floor?: unknown; asIs?: unknown; removal?: unknown };
        if (removal === true) this.removals.add(op.id);
        if (typeof made === 'number' && Number.isFinite(made)) {
          this.madeAt.set(op.id, made);
          if (asIs === true) this.stampOf.set(op.id, { asIs: true });
          else if (typeof floor === 'number' && Number.isFinite(floor)) this.stampOf.set(op.id, { floor });
        }
        this.lastOpFor.set(recordKey(op), op.id);
        // Its collection is this client's own, whatever `collections` lists:
        // the host's answer to the op is written here.
        this.written.add(op.collection);
      }
    } catch {
      // Unreadable: there is nothing it can be trusted to say.
    }
    try {
      const saved = JSON.parse(meta.readSyncMeta(PULLED_META) ?? 'null') as { url?: unknown; collections?: unknown; floors?: unknown } | null;
      // Positions are the host's own times: another host's mean nothing here.
      if (saved?.url === this.config.wsUrl && saved.collections && typeof saved.collections === 'object') {
        for (const [collection, place] of Object.entries(saved.collections as Record<string, unknown>)) {
          if (isPullCursor(place)) this.pulled.set(collection, { at: place.at, id: place.id });
        }
        for (const [collection, floor] of Object.entries((saved.floors ?? {}) as Record<string, unknown>)) {
          if (typeof floor === 'string' && HOST_TIME.test(floor)) this.floors.set(collection, floor);
        }
      }
    } catch {
      // Unreadable: every collection is pulled whole, as on a first visit.
    }
  }

  /** The queue changed: saved at the end of this task, once however many changes it made. */
  private queueChanged(): void {
    this.queueDirty = true;
    this.saveSoon();
  }

  private saveSoon(): void {
    if (this.saveScheduled) return;
    this.saveScheduled = true;
    const run = () => {
      if (this.saveScheduled) this.save();
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else void Promise.resolve().then(run);
  }

  /** Write what changed. A write the storage refuses is tried again with the next change. */
  private save(): void {
    this.saveScheduled = false;
    // Listening, everything changed here up to now is in the queue or
    // answered: once the queue is saved, that is where a later scan starts.
    const now = Date.now();
    const meta = this.meta();
    if (!meta) {
      if (this.xdbUnsubscribe) this.watched = now;
      return;
    }
    if (this.queueDirty) {
      // Every op not yet answered, in the order it would go: those sent first.
      // Each with when it was made by this device's clock, which an op already sent and
      // stamped in the host's time has back once the offset is taken off.
      // An op sent keeps that time beside it (`madeHere`), for another tab to order it by: its
      // stamp is in the host's time, and a create sent before an edit another tab made of its
      // record after it went after that edit when the host's clock ran ahead.
      const mine = [...this.inflightOps.values(), ...this.pendingOps.values()].map((op) => {
        const made = this.madeAt.get(op.id);
        const removal = this.removals.has(op.id) ? { removal: true } : {};
        if (made !== undefined) return { entry: { ...op, made, ...this.stampOf.get(op.id), ...removal } as unknown, at: made };
        const madeHere = Date.parse(op.timestamp) - this.clockOffset;
        return { entry: { ...op, ...removal, ...(Number.isFinite(madeHere) ? { madeHere } : {}) } as unknown, at: madeHere };
      });
      // The queue is saved under the app's name, and another tab of the app saves its own
      // there: each wrote its queue over the other's, so a change one tab made offline was gone
      // once the other saved (with nothing left to send, it saved none), and the next visit
      // never sent it. What another client saved is kept as it was, but for what this one is
      // done with. The next client to start sends it all: one still open sends its own as well,
      // and the host answers an op it has had again without applying it again, and keeps the
      // newer of two edits by their stamps.
      const own = new Set([...this.inflightOps.keys(), ...this.pendingOps.keys()]);
      let others: Array<{ entry: unknown; at: number }> = [];
      try {
        const saved = JSON.parse(meta.readSyncMeta(QUEUE_META) ?? 'null') as { ops?: unknown } | null;
        others = (Array.isArray(saved?.ops) ? saved.ops : []).flatMap((entry) => {
          const op = savedOp(entry);
          if (op === null || own.has(op.id) || this.finished.has(op.id)) return [];
          const { made, madeHere } = entry as { made?: unknown; madeHere?: unknown };
          const at = typeof made === 'number' ? made : typeof madeHere === 'number' ? madeHere : Date.parse(op.timestamp);
          return [{ entry, at }];
        });
      } catch {
        // Unreadable: there is nothing it can be trusted to say.
      }
      // In the order they were made, each client's own order kept: another tab's ops put
      // ahead of this one's sent its edit of a record before this tab's create of it, which
      // the host refused (the record was not there) and the create then undid.
      const ops: unknown[] = [];
      let i = 0;
      let j = 0;
      const time = (at: number) => (Number.isFinite(at) ? at : -Infinity);
      while (i < others.length || j < mine.length) {
        if (j >= mine.length || (i < others.length && time(others[i].at) <= time(mine[j].at))) ops.push(others[i++].entry);
        else ops.push(mine[j++].entry);
      }
      try {
        meta.writeSyncMeta(QUEUE_META, ops.length > 0 ? JSON.stringify({ v: 1, ops }) : null);
        this.queueDirty = false;
        // Not in what is saved now; one found there later is another client's, still to go.
        this.finished.clear();
      } catch (err) {
        console.warn('[XDBServerSync] Changes waiting for the server could not be saved for the next visit:', err);
      }
    }
    if (this.pulledDirty) {
      try {
        meta.writeSyncMeta(PULLED_META, JSON.stringify({
          v: 1,
          url: this.config.wsUrl,
          collections: Object.fromEntries(this.pulled),
          floors: Object.fromEntries(this.floors),
        }));
        this.pulledDirty = false;
      } catch {
        // The next pull is whole instead; nothing is lost.
      }
    }
    // Not moved on while the queue is unsaved: a change in it that is lost
    // with the page is then found again by the next scan.
    if (this.xdbUnsubscribe && !this.queueDirty) {
      try {
        meta.writeSyncMeta(WATCHED_META, String(now));
        this.watched = now;
      } catch {
        // The next scan starts earlier, and sends again what was answered.
      }
    }
  }

  /** Get known collection names from the local XDB. */
  private getKnownCollections(): string[] {
    // If the XDB has a method to list collections, use it.
    // Otherwise return an empty array (user must specify in config).
    // Not every XDB implementation can list its collections, so this asks
    // rather than assumes.
    const listing = this.xdb as { getCollections?: () => string[] };
    if (typeof listing.getCollections === 'function') {
      // Only names the host takes: it answers a pull naming any other with
      // an error, and the store may hold collections that were never synced.
      return listing.getCollections().filter((name) => SYNCABLE_COLLECTION.test(name));
    }
    return [];
  }

  /** Send on an open socket; false when there was none to send on. */
  private send(msg: ClientMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /**
   * Try again after a backoff: `reconnectDelay` doubling per failed attempt,
   * with jitter, up to a minute — and never sooner than a host's
   * `Retry-After`. A fixed delay kept a flapping client at 30 ticket
   * requests a minute, past the host's limit, into an endless run of 429s.
   */
  private scheduleReconnect(atLeastMs = 0): void {
    if (this.destroyed || this.reconnectTimer) return;
    const backoff = backoffDelay(this.config.reconnectDelay ?? 2000, this.reconnectAttempts++);
    const delay = Math.max(backoff, atLeastMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Hidden since, with nothing left to send: it waits to be shown.
      if (!this.destroyed && (this.shown || this.hasUnsent())) {
        this.createConnection();
      }
    }, delay);
  }
}
