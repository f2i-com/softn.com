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

// ── Client → Server messages ─────────────────────────────

type ClientMessage =
  | { type: 'auth'; appVersion: string }
  | { type: 'sync_pull'; collections: string[] }
  | { type: 'sync_push'; ops: SyncOp[] }
  | { type: 'subscribe'; collections: string[] };

// ── Server → Client messages ─────────────────────────────

type ServerMessage =
  | { type: 'auth_ok'; clientId: string; serverTime: string }
  | { type: 'auth_error'; reason: string }
  | { type: 'sync_state'; collection: string; records: ServerRecord[] }
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
 */
const MAX_OPS_PER_PUSH = 500;
const MAX_PUSH_BYTES = 1024 * 1024;

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

interface ServerRecord {
  id: string;
  collection: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
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
    } catch (e) {
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
        this.handleSyncState(msg.collection, msg.records);
        break;

      case 'sync_delta':
        this.handleSyncDelta(msg.ops);
        break;

      case 'sync_ack':
        for (const id of Array.isArray(msg.opIds) ? msg.opIds : []) this.inflightOps.delete(id);
        this.retryAttempts = 0;
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

  /** The host did not store these ops this time: queue them and try later. */
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
      this.send({ type: 'sync_pull', collections });
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
   * Push every queued op, in pieces the host accepts, and hold each until
   * the host answers it (see `inflightOps`). An acknowledged op is done, so a
   * reconnect replays only what was never answered, not the session.
   */
  private flushPendingOps(): void {
    if (!this.connected || !this.initialPullDone || this.pendingOps.size === 0) return;
    // A retry is waiting out a backoff; new ops go with it.
    if (this.retryTimer) return;
    let batch: SyncOp[] = [];
    let bytes = 0;
    const sendBatch = (): boolean => {
      if (batch.length === 0) return true;
      if (!this.send({ type: 'sync_push', ops: batch })) return false;
      for (const op of batch) {
        this.pendingOps.delete(op.id);
        this.inflightOps.set(op.id, op);
      }
      batch = [];
      bytes = 0;
      return true;
    };
    for (const op of Array.from(this.pendingOps.values())) {
      // Stamped now: an op queued before auth knew no client id.
      op.clientId = this.clientId ?? op.clientId;
      const size = JSON.stringify(op).length + 1;
      if (batch.length > 0 && (batch.length >= MAX_OPS_PER_PUSH || bytes + size > MAX_PUSH_BYTES)) {
        if (!sendBatch()) return;
      }
      batch.push(op);
      bytes += size;
    }
    sendBatch();
  }

  /** Replace local collection data with the server's authoritative state. */
  private handleSyncState(collection: string, records: ServerRecord[]): void {
    // Apply each record from the server to the local XDB.
    // We use a batch approach: clear local data and re-insert.
    // For Phase 2, we use a simpler approach: upsert each record.
    for (const record of records) {
      this.xdb.upsertFromServer(collection, {
        id: record.id,
        collection: record.collection,
        data: record.data,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    }
    this.initialPullDone = true;
    this.flushPendingOps();
  }

  /** Apply live deltas from other clients. */
  private handleSyncDelta(ops: SyncOp[]): void {
    for (const op of ops) {
      switch (op.operation) {
        case 'create':
          if (op.data) {
            this.xdb.upsertFromServer(op.collection, {
              id: op.recordId,
              collection: op.collection,
              data: op.data,
              createdAt: op.timestamp,
              updatedAt: op.timestamp,
            });
          }
          break;
        case 'update':
          if (op.data) {
            this.xdb.upsertFromServer(op.collection, {
              id: op.recordId,
              collection: op.collection,
              data: op.data,
              createdAt: '',
              updatedAt: op.timestamp,
            });
          }
          break;
        case 'delete':
          this.xdb.deleteFromServer(op.collection, op.recordId);
          break;
      }
    }
  }

  /** Handle a rejected sync operation — remove from pending and notify. */
  private handleSyncReject(opId: string, reason: string): void {
    this.pendingOps.delete(opId);
    this.inflightOps.delete(opId);
    this.listeners.reject.forEach((fn) => fn(opId, reason));
    // TODO: rollback optimistic update
  }

  /** Listen for local XDB mutations and push them to the server. */
  private listenForLocalChanges(): void {
    if (this.xdbUnsubscribe) return;

    // Subscribe to XDB events. When the local app creates/updates/deletes
    // a record, we push the mutation to the server.
    this.xdbUnsubscribe = this.xdb.onMutation((event) => {
      // Don't re-push mutations that came from the server
      if (event.source === 'server') return;

      const opId = `op_${Date.now()}_${++this.opCounter}`;
      const op: SyncOp = {
        id: opId,
        collection: event.collection,
        operation: event.type as 'create' | 'update' | 'delete',
        recordId: event.recordId,
        data: event.data,
        timestamp: new Date().toISOString(),
        clientId: this.clientId ?? 'unknown',
      };

      // Queued whether or not the socket is up. The connected check used to
      // come first, so a mutation made offline was never queued at all and
      // the "flush on reconnect" step had nothing to flush.
      this.pendingOps.set(opId, op);
      this.flushPendingOps();
    });
  }

  /** Get known collection names from the local XDB. */
  private getKnownCollections(): string[] {
    // If the XDB has a method to list collections, use it.
    // Otherwise return an empty array (user must specify in config).
    // Not every XDB implementation can list its collections, so this asks
    // rather than assumes.
    const listing = this.xdb as { getCollections?: () => string[] };
    if (typeof listing.getCollections === 'function') {
      return listing.getCollections();
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
