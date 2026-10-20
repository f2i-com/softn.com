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
  /** App version (sent during auth handshake) */
  appVersion: string;
  /**
   * Optional auth token (the host's SOFTN_AUTH_TOKEN). It is never put on
   * the socket or in its URL: the client trades it at `<wsUrl>/ticket` for a
   * short-lived single-use ticket and connects with `?ticket=`.
   */
  token?: string;
  /** Collections to subscribe to (default: all known collections) */
  collections?: string[];
  /**
   * First reconnection delay in ms (default: 2000). Each failed attempt
   * doubles it, with jitter, up to a minute; a successful connection starts
   * over. A host's `Retry-After` is honoured when it asks for longer.
   */
  reconnectDelay?: number;
  /** Allow insecure ws:// connections (default: false, only for local development) */
  allowInsecureWs?: boolean;
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
 */
type ClientMessage =
  | { type: 'auth'; appVersion: string }
  | { type: 'sync_pull'; collections: string[]; cursor?: PullCursor; lastSync?: string; lastId?: string }
  | { type: 'sync_push'; ops: SyncOp[] }
  | { type: 'subscribe'; collections: string[] };

// ── Server → Client messages ─────────────────────────────

type ServerMessage =
  | { type: 'auth_ok'; clientId: string; serverTime: string }
  | { type: 'auth_error'; reason: string }
  | { type: 'sync_state'; collection: string; records: ServerRecord[]; more?: PullCursor }
  | { type: 'sync_delta'; ops: SyncOp[] }
  | { type: 'sync_ack'; opIds: string[] }
  | { type: 'sync_reject'; opId: string; reason: string }
  | { type: 'sync_retry'; opIds: string[]; reason: string }
  | { type: 'error'; message: string };

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
/** The host closes the socket on a message larger than this (http.rs). */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** `{"type":"sync_push","ops":[...]}` around the ops, with room to spare. */
const PUSH_ENVELOPE_BYTES = 64;
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
/** Names under which the queue and the pull positions are kept (`XDBService.readSyncMeta`). */
const QUEUE_META = 'sync-queue';
const PULLED_META = 'sync-pulled';

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

/** One record's ops go to the host one at a time (see `flushPendingOps`). */
function recordKey(op: SyncOp): string {
  return `${op.collection}\u0000${op.recordId}`;
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
   * connection's pull (a full store): where they were pulled to stays put, so
   * the next pull brings that record again instead of going on past it.
   */
  private pullStuck = new Set<string>();
  /** Records received per collection of a pull that named a point to start from. */
  private sincePulled = new Map<string, number>();
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
    // offline" means, and it used to be dropped.
    this.listenForLocalChanges();
    this.createConnection();
  }

  /** Disconnect and stop syncing. */
  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.requeueInflight();
    if (this.xdbUnsubscribe) {
      this.xdbUnsubscribe();
      this.xdbUnsubscribe = null;
    }
    // Saved now, not at the end of the task: whoever opens the store next
    // (a remount, a reload) reads what this one leaves.
    this.save();
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

  /** Maximum inbound message size (2MB). Prevents memory exhaustion from
   *  a compromised or malicious server sending oversized payloads. */
  private static readonly MAX_MESSAGE_SIZE = 2 * 1024 * 1024;

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
    ws.onopen = () => {
      if (this.ws !== ws) return;
      // The handshake was authenticated before the upgrade; this names the
      // app's version and nothing else. The token is never sent on the socket.
      this.send({ type: 'auth', appVersion: this.config.appVersion });
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      try {
        const raw = event.data as string;
        if (raw.length > XDBServerSync.MAX_MESSAGE_SIZE) {
          console.warn('[XDBServerSync] Message too large, discarding:', raw.length);
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
      // Whatever was unanswered goes again on the next connection.
      this.requeueInflight();
      this.listeners.disconnect.forEach((fn) => fn());
      if (!this.destroyed) {
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

      case 'auth_error':
        this.listeners.error.forEach((fn) => fn(msg.reason));
        this.ws?.close();
        break;

      case 'sync_state':
        this.handleSyncState(msg.collection, msg.records, msg.more);
        break;

      case 'sync_delta':
        this.handleSyncDelta(msg.ops);
        break;

      case 'sync_ack':
        for (const id of Array.isArray(msg.opIds) ? msg.opIds : []) {
          if (this.inflightOps.delete(id)) this.queueChanged();
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
        // A push the host could not take at all ("server busy", "timed
        // out") names no ops. Anything sent and unanswered is tried again
        // later; replaying one that did land is harmless (create and update
        // merge by record id, delete is a delete).
        if (this.inflightOps.size > 0) {
          this.requeueInflight();
          this.scheduleRetry();
        }
        break;
    }
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
    const collections = this.config.collections ?? this.getKnownCollections();

    if (collections.length > 0) {
      // Subscribe to live updates
      this.send({ type: 'subscribe', collections });

      // Pull initial state
      this.pullStuck.clear();
      this.sincePulled.clear();
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
        op.timestamp = new Date(made + this.clockOffset).toISOString();
        this.madeAt.delete(op.id);
      }
      const size = utf8Length(JSON.stringify(op)) + 1;
      if (PUSH_ENVELOPE_BYTES + size > MAX_MESSAGE_BYTES) {
        this.refuseOp(op, size);
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
    const changed = this.unansweredChanges();
    const list = Array.isArray(records) ? records : [];
    let place = this.pulled.get(collection);
    let moved = false;
    // A collection pulled whole on this connection is placed no later than
    // its floor (`floors`), whichever pull this message answers.
    const floor = this.floors.get(collection);
    for (const record of list) {
      if (!record || typeof record.id !== 'string') continue;
      // One record that could not be written here (a full store) threw out
      // of this loop: the rest of the pull was never written, and the first
      // pull never counted as done, so nothing made here was pushed again.
      // It is passed over, and the pull goes on.
      try {
        this.applyPulled(collection, record, changed.get(`${collection}\u0000${record.id}`));
      } catch (err) {
        if (!this.pullStuck.has(collection)) {
          console.warn(`[XDBServerSync] A record of "${collection}" from the server could not be saved here; the next pull brings it again:`, err);
        }
        this.pullStuck.add(collection);
        continue;
      }
      // Records the host has no receipt time for come first in a whole pull
      // and are not in a pull from a point; they mark no place.
      const at = record.serverReceivedAt;
      if (typeof at !== 'string' || at === '' || this.pullStuck.has(collection)) continue;
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
        if (total >= INCREMENTAL_PULL_ROWS && moved && place && !this.pullStuck.has(collection)) {
          this.sincePulled.set(collection, 0);
          this.send({ type: 'sync_pull', collections: [collection], lastSync: place.at, lastId: place.id });
        } else {
          this.sincePulled.set(collection, total);
        }
      }
    }
    this.initialPullDone = true;
    this.flushPendingOps();
  }

  /** One record of a pull, written here unless a change made here is still waiting on it. */
  private applyPulled(collection: string, record: ServerRecord, here: 'update' | 'delete' | undefined): void {
    if (record.deleted === true) {
      // Deleted on the host since this device last pulled. A change made
      // here to it is answered by the host with the record as it stands,
      // deleted, so there is nothing here to wait for.
      this.xdb.deleteFromServer(collection, record.id);
      return;
    }
    if (here === 'update') return;
    if (typeof record.data !== 'object' || record.data === null || Array.isArray(record.data)) return;
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
  }

  /** Apply live deltas from other clients. */
  private handleSyncDelta(ops: SyncOp[]): void {
    // The host sends this device the record as it stands for an op of its
    // own that it did not apply, from "server" and under that op's id. A
    // delete answered so is answered, whether its acknowledgement comes
    // before the record or after it: kept hidden until the acknowledgement,
    // a record sent first stayed hidden until the next full pull.
    const list = (Array.isArray(ops) ? ops : []).filter(
      (op): op is SyncOp => !!op && typeof op.recordId === 'string' && typeof op.collection === 'string'
    );
    const answered = new Set(list.filter((op) => op.clientId === 'server').map((op) => op.id));
    const changed = this.unansweredChanges(answered);
    for (const op of list) {
      const here = changed.get(`${op.collection}\u0000${op.recordId}`);
      const deletedHere = here === 'delete';
      // Another device's edit to a record edited here is left to the answer
      // to this device's edit: the host weighs the two, and sends the record
      // as it stands if the edit made here lost.
      if (here === 'update' && op.operation !== 'delete') continue;
      // One op that cannot be written here (a full store) no longer takes
      // the rest of the delta with it.
      try {
        this.applyDelta(op, deletedHere);
      } catch (err) {
        console.warn(`[XDBServerSync] A change to "${op.collection}" from the server could not be saved here:`, err);
      }
    }
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

  /** Handle a rejected sync operation — remove from pending and notify. */
  private handleSyncReject(opId: string, reason: string): void {
    this.pendingOps.delete(opId);
    this.inflightOps.delete(opId);
    this.madeAt.delete(opId);
    this.queueChanged();
    this.listeners.reject.forEach((fn) => fn(opId, reason));
    // TODO: rollback optimistic update
    // The record's next op, if there is one, was waiting for this answer.
    this.flushPendingOps();
  }

  /**
   * An op the host can never take: a push of it alone is larger than the
   * host lets a message be, and it closes the socket on one. Sent anyway, it
   * went first after every reconnect and closed that socket too, and nothing
   * queued behind it ever reached the host. It is dropped and reported as
   * the host reports an op it refuses for good.
   */
  private refuseOp(op: SyncOp, bytes: number): void {
    this.pendingOps.delete(op.id);
    this.madeAt.delete(op.id);
    this.queueChanged();
    const reason = `This change to "${op.collection}" is ${bytes} bytes, more than the sync host takes in one message (${MAX_MESSAGE_BYTES}); it was not sent.`;
    console.warn(`[XDBServerSync] ${reason}`);
    this.listeners.reject.forEach((fn) => fn(op.id, reason));
  }

  /** Listen for local XDB mutations and push them to the server. */
  private listenForLocalChanges(): void {
    if (this.xdbUnsubscribe) return;

    // Subscribe to XDB events. When the local app creates/updates/deletes
    // a record, we push the mutation to the server.
    this.xdbUnsubscribe = this.xdb.onMutation((event) => {
      // Don't re-push mutations that came from the server
      if (event.source === 'server') return;

      const made = Date.now();
      // The counter starts again with each page, and ops restored from the
      // last one are in the queue: an id one of them has is not given again.
      let opId: string;
      do {
        opId = `op_${made}_${++this.opCounter}`;
      } while (this.pendingOps.has(opId) || this.inflightOps.has(opId));
      const op: SyncOp = {
        id: opId,
        collection: event.collection,
        operation: event.type as 'create' | 'update' | 'delete',
        recordId: event.recordId,
        data: event.data,
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
        this.madeAt.delete(before.id);
      }

      // Queued whether or not the socket is up. The connected check used to
      // come first, so a mutation made offline was never queued at all and
      // the "flush on reconnect" step had nothing to flush.
      this.pendingOps.set(opId, op);
      this.madeAt.set(opId, made);
      this.lastOpFor.set(key, opId);
      this.queueChanged();
      this.flushPendingOps();
    });
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
    try {
      const saved = JSON.parse(meta.readSyncMeta(QUEUE_META) ?? 'null') as { ops?: unknown } | null;
      const ops = saved?.ops;
      for (const entry of Array.isArray(ops) ? ops : []) {
        const op = savedOp(entry);
        if (!op || this.pendingOps.has(op.id)) continue;
        this.pendingOps.set(op.id, op);
        // Not sent yet: stamped in the host's time when it is (flushPendingOps).
        const made = (entry as { made?: unknown }).made;
        if (typeof made === 'number' && Number.isFinite(made)) this.madeAt.set(op.id, made);
        this.lastOpFor.set(recordKey(op), op.id);
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
    const meta = this.meta();
    if (!meta) return;
    if (this.queueDirty) {
      // Every op not yet answered, in the order it would go: those sent first.
      const ops = [...this.inflightOps.values(), ...this.pendingOps.values()].map((op) => {
        const made = this.madeAt.get(op.id);
        return made === undefined ? op : { ...op, made };
      });
      try {
        meta.writeSyncMeta(QUEUE_META, ops.length > 0 ? JSON.stringify({ v: 1, ops }) : null);
        this.queueDirty = false;
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
      if (!this.destroyed) {
        this.createConnection();
      }
    }, delay);
  }
}
