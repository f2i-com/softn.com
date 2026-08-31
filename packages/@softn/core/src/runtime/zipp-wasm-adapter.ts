/**
 * zipp WASM Adapter
 *
 * Runs `.logic` on zipp — a clean-sheet JavaScript engine (Rust, compiled to
 * WebAssembly) — behind the same API `SoftNScriptRuntime` used for the
 * FormLogic VM. Swapping engines is a one-line change in `vm-adapter.ts`.
 *
 * Two differences from FormLogic are load-bearing and are handled here rather
 * than pushed onto callers:
 *
 * - **zipp brings its own preamble.** `window`, `navigator`, `localStorage`,
 *   `db` and `host` were FormLogic VM builtins; in zipp they are ordinary JS
 *   declared by the engine's own preamble. Callers must therefore NOT prepend
 *   `let window = {}` — see {@link ZIPP_BRIDGE_PREAMBLE}.
 * - **zipp buffers console output** instead of writing it straight to the
 *   browser console. Every re-entry drains that buffer here, so `console.log`
 *   in `.logic` still reaches devtools and the buffer cannot grow unbounded.
 */

import initWasm, { Engine, zipp_install_panic_hook } from '../../wasm-zipp/zipp_wasm.js';

import type { DBNamespace } from './script-runtime';
import { sanitizeArgs } from './vm-args';

// ============================================================================
// WASM initialization
// ============================================================================

let wasmReady: Promise<void> | null = null;

function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm().then(() => {
      // Without this a Rust panic inside the engine surfaces as a bare
      // `unreachable` trap with no message or stack — undiagnosable from
      // devtools. With it, panics reach console.error intact.
      zipp_install_panic_hook();
    });
  }
  return wasmReady;
}

// ============================================================================
// Bridge preamble
// ============================================================================

/**
 * Source prepended to `.logic` files before compilation — empty for zipp.
 *
 * The FormLogic adapter prepended `let window = {}; let navigator = {};` to
 * create the objects its VM then filled in. zipp's engine preamble already
 * declares both (plus `localStorage`, `db` and `host`), so prepending them
 * again is a hard `SyntaxError: Identifier 'window' has already been declared`
 * and every script fails to compile.
 */
export const ZIPP_BRIDGE_PREAMBLE = '';

// ============================================================================
// Symbol types (matching the FormLogic adapter)
// ============================================================================

export type SymbolScope = 'function' | 'variable';

export interface SymbolInfo {
  index: number;
  scope: SymbolScope;
}

// ============================================================================
// Synchronous host capabilities
// ============================================================================

/*
 * zipp v0.0.1 separated a bridge handle from authority over it: installing a
 * bridge grants nothing, and `setSyncHostCapabilities` replaces (never unions)
 * the allowlist, which freezes the moment `initScript` starts. So the names
 * live beside the `register*` method that installs the object serving them,
 * every registration accumulates into one pending set, and
 * {@link ZippWasmAdapter.initializeScript} flushes that set in a single call as
 * the last thing before compilation.
 *
 * Keeping the grant in the adapter rather than in each host is deliberate: a
 * host that wires a bridge and forgets the grant gets `SecurityError:
 * synchronous host capability denied` from the guest's first `db.query`, and
 * the parked Web Worker host would have shipped that way unnoticed. Here it
 * cannot happen — wiring is the grant.
 *
 * The engine rejects an unknown name and drops the whole update with it, so
 * these lists are coupled to the engine release vendored in `wasm-zipp/`
 * (v0.0.1, zipp commit 96dac4e). A rename upstream surfaces as a throw before
 * `initScript` rather than as a silent denial at runtime.
 */

/** Everything `db.*` in the preamble can reach. Served by `setDbBridge`. */
const DB_SYNC_OPS = [
  'db.query',
  'db.get',
  'db.create',
  'db.update',
  'db.delete',
  'db.hardDelete',
  'db.startSync',
  'db.stopSync',
  'db.getSyncStatus',
  'db.getSavedSyncRoom',
] as const;

/** Everything `localStorage.*` can reach. Served by `setLocalStorageBridge`. */
const LOCAL_STORAGE_SYNC_OPS = [
  'ls.getItem',
  'ls.setItem',
  'ls.removeItem',
  'ls.clear',
] as const;

/** Everything `navigator.clipboard.*` can reach. Served by `setClipboardBridge`. */
const CLIPBOARD_SYNC_OPS = ['nav.clipboardWrite', 'nav.clipboardRead'] as const;

// ============================================================================
// ZippWasmAdapter
// ============================================================================

/**
 * Wraps the zipp `Engine` with the API `SoftNScriptRuntime` and the worker
 * runtime expect.
 */
export class ZippWasmAdapter {
  private wasm: Engine;
  private symbolMap: Map<string, SymbolInfo> = new Map();
  private _initialized = false;
  private _disposed = false;
  private _terminated = false;
  /** Names accumulated by `register*` calls, flushed once before `initScript`. */
  private pendingSyncCapabilities = new Set<string>();

  private constructor(wasm: Engine) {
    this.wasm = wasm;
  }

  /** Create a new adapter instance. Must be awaited. */
  static async create(): Promise<ZippWasmAdapter> {
    await ensureWasm();
    return new ZippWasmAdapter(new Engine());
  }

  /**
   * Forward anything the script printed to the browser console.
   *
   * zipp accumulates `console.log`/`info`/`debug`/`error` output inside the VM
   * and hands it over on request, so this must run after every re-entry.
   * `takeOutput` merges the out and error streams, so the original severity is
   * not recoverable and everything is reported at log level.
   */
  private flushOutput(): void {
    if (this._disposed || this._terminated) return;
    let lines: string[];
    try {
      lines = (this.wasm.takeOutput() as string[]) || [];
    } catch {
      return;
    }
    for (const line of lines) console.log(line);
  }

  /**
   * Register the DB bridge. zipp's `db.*` preamble functions call these
   * methods synchronously from inside VM execution, so none of them may await.
   *
   * All ten operations are granted, `db.startSync` included. Sync authority
   * already lives in `createDBNamespace.startSync`, which refuses without
   * `sync.enabled` and says "Choose Allow in the permission bar" — withholding
   * the operation here would fire first and replace that with an opaque
   * `SecurityError` throw that abandons the rest of the caller's function
   * mid-way (TexasHoldem resumes a saved room and then keeps going).
   */
  registerDBBridge(db: DBNamespace): void {
    for (const op of DB_SYNC_OPS) this.pendingSyncCapabilities.add(op);

    // The engine sends "" for an omitted room; the DB namespace wants undefined.
    const room = (r: string | undefined) => (r ? r : undefined);

    this.wasm.setDbBridge({
      query: (collection: string, filter?: Record<string, unknown>) => {
        try {
          return db.query(collection, filter ?? undefined);
        } catch (e) {
          console.error('[zipp bridge] db.query error:', e);
          return [];
        }
      },
      create: (collection: string, data: Record<string, unknown>) => {
        // Let write errors reach the VM boundary so the script can surface them.
        return db.create(collection, data || {});
      },
      update: (id: string, data: Record<string, unknown>) => {
        return db.update(id, data || {});
      },
      hardDelete: (collection: string, id: string) => {
        db.hardDelete(collection, id);
      },
      get: (collection: string, id: string) => {
        try {
          return db.get(collection, id);
        } catch (e) {
          console.error('[zipp bridge] db.get error:', e);
          return null;
        }
      },
      startSync: (r: string) => {
        try {
          db.startSync(r);
        } catch (e) {
          console.error('[zipp bridge] db.startSync error:', e);
        }
      },
      stopSync: (r?: string) => {
        try {
          db.stopSync(room(r));
        } catch (e) {
          console.error('[zipp bridge] db.stopSync error:', e);
        }
      },
      getSyncStatus: (r?: string) => {
        try {
          return db.getSyncStatus(room(r));
        } catch (e) {
          console.error('[zipp bridge] db.getSyncStatus error:', e);
          return { connected: false, peers: 0, room: '', peerId: '' };
        }
      },
      getSavedSyncRoom: () => {
        try {
          return db.getSavedSyncRoom();
        } catch {
          return null;
        }
      },
      delete: (id: string) => {
        db.delete(id);
      },
    });
  }

  /**
   * Register the localStorage bridge, delegating to real browser storage with
   * app-scoped key prefixing so two bundles cannot read each other's keys.
   *
   * `navigator.clipboard` used to be served from this same object — the old
   * engine routed `nav.*` to the localStorage bridge. v0.0.1 refuses to, so it
   * moved to {@link registerClipboardBridge}.
   */
  registerLocalStorageBridge(appId?: string): void {
    for (const op of LOCAL_STORAGE_SYNC_OPS) this.pendingSyncCapabilities.add(op);

    const safeAppId = (appId || '_default').replace(/[^a-zA-Z0-9_-]/g, '_');
    const prefix = `softn:${safeAppId}:`;

    this.wasm.setLocalStorageBridge({
      getItem: (key: string) => {
        try {
          return localStorage.getItem(prefix + key);
        } catch {
          return null;
        }
      },
      setItem: (key: string, value: string) => {
        try {
          localStorage.setItem(prefix + key, value);
        } catch (e) {
          console.error('[zipp bridge] localStorage.setItem error:', e);
        }
      },
      removeItem: (key: string) => {
        try {
          localStorage.removeItem(prefix + key);
        } catch (e) {
          console.error('[zipp bridge] localStorage.removeItem error:', e);
        }
      },
      clear: () => {
        try {
          // Only our own prefixed keys — never another bundle's.
          const keysToRemove: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith(prefix)) keysToRemove.push(k);
          }
          for (const k of keysToRemove) localStorage.removeItem(k);
        } catch (e) {
          console.error('[zipp bridge] localStorage.clear error:', e);
        }
      },
    });
  }

  /**
   * Register the clipboard bridge backing `navigator.clipboard.*`.
   *
   * Split out because v0.0.1 did: the engine now routes `nav.*` to its own
   * `clipboard` object by the method names `writeText`/`readText`, and
   * `setLocalStorageBridge` explicitly refuses to supply it. Without this,
   * `navigator.clipboard.writeText()` — which four shipped bundles call for
   * their copy buttons — throws instead of copying.
   */
  registerClipboardBridge(): void {
    for (const op of CLIPBOARD_SYNC_OPS) this.pendingSyncCapabilities.add(op);

    this.wasm.setClipboardBridge({
      writeText: (text: string) => {
        try {
          void navigator.clipboard?.writeText(String(text));
        } catch (e) {
          console.error('[zipp bridge] clipboard.writeText error:', e);
        }
      },
      // The engine's clipboard read is synchronous but the browser's is not,
      // so this can only ever answer empty. `softn.*` async APIs are the
      // supported path for reading the clipboard. It is still granted and
      // wired: the preamble's `readText` JSON-parses whatever comes back, so a
      // script that reads the clipboard gets `''` as it always has, rather
      // than a thrown SecurityError it never had to handle before.
      readText: () => '',
    });
  }

  /**
   * Register a custom localStorage bridge (e.g. the snapshot-based one the
   * Web Worker uses).
   */
  registerLocalStorageBridgeCustom(bridge: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
    clear: () => void;
  }): void {
    for (const op of LOCAL_STORAGE_SYNC_OPS) this.pendingSyncCapabilities.add(op);
    this.wasm.setLocalStorageBridge(bridge);
  }

  /**
   * The synchronous operations registration has accumulated so far — the exact
   * list {@link initializeScript} will grant. Exposed so a test can assert that
   * wiring a bridge declares its authority; a `register*` method that forgets
   * leaves this empty and the guest is denied at its first call.
   */
  getPendingSyncCapabilities(): string[] {
    return [...this.pendingSyncCapabilities].sort();
  }

  /**
   * Compile and execute a script, returning symbol name → { index, scope }.
   * Bridges must already be registered: a script's top level commonly reads
   * `localStorage` or queries `db`, and authority freezes here — nothing can be
   * wired or granted once this has been entered.
   */
  async initializeScript(code: string): Promise<Map<string, SymbolInfo>> {
    await ensureWasm();

    // Grant exactly what registration wired, in the one call the engine allows.
    // This is the last statement before compilation on purpose: the allowlist is
    // replaced rather than unioned, and the db/localStorage/clipboard bridges
    // are installed independently and conditionally.
    // Guarded because the vendored engine is swappable and this method arrived
    // in v0.0.1. An engine without it grants authority by wiring alone, which is
    // exactly what the allowlist replaced, so skipping is correct there — while
    // calling it unconditionally turns rolling the engine back into a TypeError
    // at the last statement before every compile.
    if (typeof this.wasm.setSyncHostCapabilities === 'function') {
      this.wasm.setSyncHostCapabilities([...this.pendingSyncCapabilities]);
    }

    const symbolMapObj = ((): Record<string, { index: number; scope: string }> => {
      try {
        return this.wasm.initScript(code) as Record<string, { index: number; scope: string }>;
      } catch (e) {
        // Drain first: the top level may have logged before a later statement
        // threw. v0.0.1 then terminates the Engine on any failed or repeated
        // initScript — state, bridges and the allowlist are all cleared, and
        // every later call answers "zipp: engine is disposed". Record that so a
        // caller retrying a compile builds a fresh engine instead of chasing
        // disposal errors on a corpse.
        this.flushOutput();
        this._terminated = true;
        throw e;
      } finally {
        this.flushOutput();
      }
    })();

    this.symbolMap = new Map();
    for (const [name, info] of Object.entries(symbolMapObj)) {
      this.symbolMap.set(name, { index: info.index, scope: info.scope as SymbolScope });
    }

    this._initialized = true;
    return this.symbolMap;
  }

  /** Get a global by slot index, as a plain JS value. */
  getGlobal(index: number): unknown {
    return this.wasm.getGlobalByIndex(index);
  }

  /**
   * Set a global by slot index from a plain JS value.
   *
   * `undefined` means the host holds no value for this variable — not that the
   * script's variable should become `undefined`. Writing it through would
   * clobber the script's own initialiser on the first sync (and turn the next
   * `x = x + 1` into `NaN`), so the write is skipped and the VM keeps its value.
   */
  setGlobal(index: number, value: unknown): void {
    if (value === undefined) return;
    this.wasm.setGlobalByIndex(index, value);
  }

  /** Read many globals in one WASM boundary crossing. */
  getGlobalsBatch(indices: number[]): unknown[] {
    return this.wasm.getGlobalsBatch(indices) as unknown[];
  }

  /**
   * Write many globals in one WASM boundary crossing. Slots holding functions
   * or classes are left alone by the engine, so a read-modify-write of every
   * global cannot destroy the script's own functions. Values of `undefined`
   * are dropped for the reason given on {@link setGlobal}.
   */
  setGlobalsBatch(indices: number[], values: unknown[]): void {
    const keptIndices: number[] = [];
    const keptValues: unknown[] = [];
    for (let i = 0; i < indices.length; i++) {
      if (values[i] === undefined) continue;
      keptIndices.push(indices[i]);
      keptValues.push(values[i]);
    }
    if (keptIndices.length === 0) return;
    this.wasm.setGlobalsBatch(keptIndices, keptValues);
  }

  /**
   * Call a named top-level function. The engine drains microtasks before
   * returning, so promise callbacks the call scheduled have already run.
   */
  callFunction(name: string, args: unknown[]): unknown {
    try {
      return this.wasm.callFunction(name, sanitizeArgs(args));
    } finally {
      this.flushOutput();
    }
  }

  /** Same as {@link callFunction} — the engine is synchronous. */
  callFunctionSync(name: string, args: unknown[]): unknown {
    return this.callFunction(name, args);
  }

  /**
   * Evaluate an expression in the script's global context.
   *
   * Each call compiles fresh, so this is for one-off host queries (template
   * expressions, computed values) — never a per-frame path.
   */
  evalSync(expression: string): unknown {
    try {
      return this.wasm.evalInContext(expression);
    } finally {
      this.flushOutput();
    }
  }

  /** Whether a script has been compiled and run. */
  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Whether the engine tore itself down. True after a failed `initScript`; the
   * handle still needs {@link dispose} to release its WASM memory, but nothing
   * else on it will work again.
   */
  get terminated(): boolean {
    return this._terminated;
  }

  /** The symbol map, for external inspection. */
  getSymbolMap(): Map<string, SymbolInfo> {
    return this.symbolMap;
  }

  /** Event types the script has registered listeners for, e.g. `["keydown"]`. */
  getEventListenerTypes(): string[] {
    return (this.wasm.getEventListenerTypes() as string[]) || [];
  }

  /** Deliver an event to every VM listener for `eventType`; returns how many ran. */
  dispatchEvent(eventType: string, eventObj: Record<string, unknown>): number {
    try {
      return this.wasm.dispatchEvent(eventType, eventObj);
    } finally {
      this.flushOutput();
    }
  }

  /**
   * Digests of `indices`, or null when the engine cannot produce them.
   *
   * Equal digests across two calls mean {@link getGlobalsBatch} would return
   * equal values, so the caller can skip reading those slots. `NaN` is the
   * engine saying "unknown" and never compares equal, so it reads.
   */
  getGlobalsFingerprint(indices: number[]): number[] | null {
    const wasm = this.wasm as unknown as Record<string, unknown>;
    const fn = wasm.getGlobalsFingerprint;
    if (typeof fn !== 'function') return null;
    return (fn as (i: number[]) => number[]).call(this.wasm, indices);
  }

  /**
   * Which of `indices` changed since the last {@link clearDirty}.
   *
   * zipp keeps no per-slot dirty bits, so this answers conservatively — every
   * index is reported as possibly-dirty. Callers already diff the values they
   * read back, so the result is correct; it just skips the optimisation of not
   * reading unchanged slots at all.
   */
  getDirtyGlobals(indices: number[]): number[] {
    return indices;
  }

  /** No-op: there are no dirty bits to clear. See {@link getDirtyGlobals}. */
  clearDirty(): void {
    /* intentionally empty */
  }

  /**
   * Take the `host.call(...)` requests the script queued during the last
   * re-entry, as `{ id, kind, args }`.
   */
  drainPendingHostCalls(): Array<{ id: number; kind: string; args: string[] }> {
    return (
      (this.wasm.drainPendingHostCalls() as Array<{
        id: number;
        kind: string;
        args: string[];
      }>) || []
    );
  }

  /** Invoke the callback the script passed to `host.call` for `callId`. */
  resolveHostCallback(callId: number, result: unknown): void {
    try {
      this.wasm.resolveHostCallback(callId, result);
    } finally {
      this.flushOutput();
    }
  }

  /** Tear the VM down. The adapter is unusable afterwards. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._initialized = false;
    try {
      this.wasm.free();
    } catch {
      // Already freed — nothing to release.
    }
  }
}
