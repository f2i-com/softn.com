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
  /** Optional auth token */
  token?: string;
  /** Collections to subscribe to (default: all known collections) */
  collections?: string[];
  /** Reconnection delay in ms (default: 2000) */
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
  | { type: 'auth'; token?: string; appVersion: string }
  | { type: 'sync_pull'; collections: string[] }
  | { type: 'sync_push'; ops: SyncOp[] }
  | { type: 'subscribe'; collections: string[] };

// ── Server → Client messages ─────────────────────────────

type ServerMessage =
  | { type: 'auth_ok'; clientId: string; serverTime: string }
  | { type: 'auth_error'; reason: string }
  | { type: 'sync_state'; collection: string; records: ServerRecord[] }
  | { type: 'sync_delta'; ops: SyncOp[] }
  | { type: 'sync_reject'; opId: string; reason: string }
  | { type: 'error'; message: string };

interface ServerRecord {
  id: string;
  collection: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ── XDB Server Sync ──────────────────────────────────────

export class XDBServerSync {
  private ws: WebSocket | null = null;
  private xdb: XDBService;
  private config: ServerSyncConfig;
  private clientId: string | null = null;
  private serverTime: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingOps = new Map<string, SyncOp>();
  private opCounter = 0;
  private connected = false;
  private destroyed = false;
  private xdbUnsubscribe: (() => void) | null = null;
  private initialPullDone = false;

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
    if (this.ws) return;
    this.destroyed = false;
    this.createConnection();
  }

  /** Disconnect and stop syncing. */
  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.xdbUnsubscribe) {
      this.xdbUnsubscribe();
      this.xdbUnsubscribe = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.clientId = null;
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
    const url = this.config.wsUrl;
    if (url.startsWith('ws://') && !this.config.allowInsecureWs) {
      const host = new URL(url.replace('ws://', 'http://')).hostname;
      if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
        this.listeners.error.forEach((fn) => fn('Insecure ws:// connections are blocked outside localhost. Use wss:// or set allowInsecureWs for development.'));
        return;
      }
    }

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.send({
        type: 'auth',
        token: this.config.token,
        appVersion: this.config.appVersion,
      });
    };

    this.ws.onmessage = (event) => {
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

    this.ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      this.listeners.disconnect.forEach((fn) => fn());
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'auth_ok':
        this.clientId = msg.clientId;
        this.serverTime = msg.serverTime;
        this.connected = true;
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

      case 'sync_reject':
        this.handleSyncReject(msg.opId, msg.reason);
        break;

      case 'error':
        this.listeners.error.forEach((fn) => fn(msg.message));
        break;
    }
  }

  /** Called after successful auth — subscribe, pull state, flush offline ops. */
  private onAuthenticated(): void {
    const collections = this.config.collections ?? this.getKnownCollections();

    if (collections.length > 0) {
      // Subscribe to live updates
      this.send({ type: 'subscribe', collections });

      // Pull initial state
      this.send({ type: 'sync_pull', collections });
    }

    // Flush any mutations that accumulated while offline
    if (this.pendingOps.size > 0) {
      const ops = Array.from(this.pendingOps.values());
      this.send({ type: 'sync_push', ops });
    }

    // Listen for local XDB mutations and push them to the server
    this.listenForLocalChanges();
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
    this.listeners.reject.forEach((fn) => fn(opId, reason));
    // TODO: rollback optimistic update
  }

  /** Listen for local XDB mutations and push them to the server. */
  private listenForLocalChanges(): void {
    if (this.xdbUnsubscribe) return;

    // Subscribe to XDB events. When the local app creates/updates/deletes
    // a record, we push the mutation to the server.
    this.xdbUnsubscribe = this.xdb.onMutation((event) => {
      if (!this.connected || !this.initialPullDone) return;

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

      this.pendingOps.set(opId, op);
      this.send({ type: 'sync_push', ops: [op] });
    });
  }

  /** Get known collection names from the local XDB. */
  private getKnownCollections(): string[] {
    // If the XDB has a method to list collections, use it.
    // Otherwise return an empty array (user must specify in config).
    if (typeof (this.xdb as any).getCollections === 'function') {
      return (this.xdb as any).getCollections() as string[];
    }
    return [];
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = this.config.reconnectDelay ?? 2000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed) {
        this.createConnection();
      }
    }, delay);
  }
}
