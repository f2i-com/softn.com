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
    if (this._disposed) return;
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
   */
  registerDBBridge(db: DBNamespace): void {
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
   * `navigator.clipboard` is served from this same object: the engine routes
   * its `nav.*` host calls to the localStorage bridge.
   */
  registerLocalStorageBridge(appId?: string): void {
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
      clipboardWrite: (text: string) => {
        try {
          void navigator.clipboard?.writeText(String(text));
        } catch (e) {
          console.error('[zipp bridge] clipboard.writeText error:', e);
        }
      },
      // The engine's clipboard read is synchronous but the browser's is not,
      // so this can only ever answer empty. `softn.*` async APIs are the
      // supported path for reading the clipboard.
      clipboardRead: () => '',
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
    this.wasm.setLocalStorageBridge(bridge);
  }

  /**
   * Compile and execute a script, returning symbol name → { index, scope }.
   * Bridges must already be registered: a script's top level commonly reads
   * `localStorage` or queries `db`.
   */
  async initializeScript(code: string): Promise<Map<string, SymbolInfo>> {
    await ensureWasm();

    const symbolMapObj = ((): Record<string, { index: number; scope: string }> => {
      try {
        return this.wasm.initScript(code) as Record<string, { index: number; scope: string }>;
      } finally {
        // The top level may have logged before a later statement threw.
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
