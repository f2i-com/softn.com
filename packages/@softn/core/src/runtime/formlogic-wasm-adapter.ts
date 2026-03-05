/**
 * FormLogic WASM Adapter
 *
 * Drop-in replacement for the TypeScript FormLogicEngine, powered by the
 * formlogic-rust WASM module. Provides the same API surface used by
 * formlogic.ts (SoftNScriptRuntime).
 *
 * Key difference from the TS engine: the WASM engine returns plain JS values
 * (not BaseObject instances), so jsToFormLogic/formLogicToJS conversions are
 * skipped — the WASM bridge handles the conversion internally.
 */

import initWasm, { WasmFormLogicEngine, detectHostBridges } from '../../wasm/formlogic_wasm.js';

import type { DBNamespace } from './formlogic';
import { setWasmDetectHostBridges } from './formlogic';

// ============================================================================
// WASM initialization
// ============================================================================

let wasmReady: Promise<void> | null = null;

function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm().then(() => {
      // Register the WASM lexer-based bridge detector for use by detectWorkerIncompatibilities
      if (typeof detectHostBridges === 'function') {
        setWasmDetectHostBridges((code: string) => detectHostBridges(code) as string[]);
      }
    });
  }
  return wasmReady;
}

// ============================================================================
// Bridge preamble
// ============================================================================

/**
 * Code prepended to .logic files to declare bridge variables.
 * These shadow the real browser globals so the VM can intercept access.
 */
export const WASM_BRIDGE_PREAMBLE = 'let window = {};\nlet navigator = {};\n';

// ============================================================================
// Argument sanitization
// ============================================================================

/**
 * Sanitize arguments before passing to the WASM VM.
 * Performs a defensive deep-clone that:
 * - Replaces DOM Events, Nodes, and Window with null
 * - Breaks circular references using a WeakSet (prevents Rust panic from infinite recursion)
 * - Catches throwing getters gracefully
 * .logic code operates on plain data, not browser objects.
 */
function sanitizeArgs(args: unknown[]): unknown[] {
  if (args.length === 0) return args;
  const seen = new WeakSet();

  function cloneSafe(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    const t = typeof obj;
    if (t === 'string' || t === 'number' || t === 'boolean') return obj;
    if (t === 'function') return null;
    if (t !== 'object') return obj;
    // Reject DOM objects — warn in dev so .logic authors know why values are null
    if (typeof Event !== 'undefined' && obj instanceof Event) {
      console.warn('[FormLogic Sandbox] Dropped Event object from script arguments.');
      return null;
    }
    if (typeof Node !== 'undefined' && obj instanceof Node) {
      console.warn('[FormLogic Sandbox] Dropped DOM Node from script arguments.');
      return null;
    }
    if (typeof window !== 'undefined' && obj === window) {
      console.warn('[FormLogic Sandbox] Dropped Window object from script arguments.');
      return null;
    }
    // Break circular references
    const o = obj as object;
    if (seen.has(o)) return null;
    seen.add(o);
    if (Array.isArray(o)) {
      return o.map(cloneSafe);
    }
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(o)) {
      try {
        clone[key] = cloneSafe((o as Record<string, unknown>)[key]);
      } catch {
        // Handle getters that throw
        clone[key] = null;
      }
    }
    return clone;
  }

  return args.map(cloneSafe);
}

// ============================================================================
// Symbol types (matching TS engine)
// ============================================================================

export type SymbolScope = 'function' | 'variable';

export interface SymbolInfo {
  index: number;
  scope: SymbolScope;
}

// ============================================================================
// WasmFormLogicAdapter
// ============================================================================

/**
 * Adapter that wraps the Rust WASM FormLogic engine with the same API
 * as the TypeScript FormLogicEngine used by SoftNScriptRuntime.
 */
export class WasmFormLogicAdapter {
  private wasm: WasmFormLogicEngine;
  private symbolMap: Map<string, SymbolInfo> = new Map();
  private _initialized = false;

  private constructor(wasm: WasmFormLogicEngine) {
    this.wasm = wasm;
  }

  /**
   * Create a new adapter instance. Must be called with `await`.
   */
  static async create(): Promise<WasmFormLogicAdapter> {
    await ensureWasm();
    const engine = new WasmFormLogicEngine();
    return new WasmFormLogicAdapter(engine);
  }

  /**
   * Register the DB bridge. Creates a JS bridge object that delegates
   * to the DBNamespace, then passes it to the WASM engine.
   *
   * The Rust VM calls db.query(), db.create(), etc. as built-in opcodes,
   * which invoke the DbBridge trait methods. The WASM bridge delegates
   * those calls to this JS object via js_sys::Reflect.
   */
  registerDBBridge(db: DBNamespace): void {
    this.wasm.setDbBridge({
      query: (collection: string) => {
        try {
          return db.query(collection);
        } catch (e) {
          console.error('[WASM Bridge] db.query error:', e);
          return [];
        }
      },
      create: (collection: string, data: Record<string, unknown>) => {
        // Let write errors propagate to the WASM boundary so the VM can surface them.
        return db.create(collection, data || {});
      },
      update: (id: string, data: Record<string, unknown>) => {
        return db.update(id, data || {});
      },
      // Note: The Rust VM calls db.hard_delete() which maps to "hardDelete" on the JS side
      hardDelete: (collection: string, id: string) => {
        db.hardDelete(collection, id);
      },
      get: (collection: string, id: string) => {
        try {
          return db.get(collection, id);
        } catch (e) {
          console.error('[WASM Bridge] db.get error:', e);
          return null;
        }
      },
      startSync: (room: string) => {
        try {
          db.startSync(room);
        } catch (e) {
          console.error('[WASM Bridge] db.startSync error:', e);
        }
      },
      stopSync: (room?: string) => {
        try {
          db.stopSync(room);
        } catch (e) {
          console.error('[WASM Bridge] db.stopSync error:', e);
        }
      },
      getSyncStatus: (room?: string) => {
        try {
          return db.getSyncStatus(room);
        } catch (e) {
          console.error('[WASM Bridge] db.getSyncStatus error:', e);
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
      // The Rust VM also calls db.delete() via the Delete opcode
      delete: (id: string) => {
        db.delete(id);
      },
    });
  }

  /**
   * Register the localStorage bridge. Creates a JS bridge object that
   * delegates to the real browser localStorage with app-scoped key prefixing.
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
          console.error('[WASM Bridge] localStorage.setItem error:', e);
        }
      },
      removeItem: (key: string) => {
        try {
          localStorage.removeItem(prefix + key);
        } catch (e) {
          console.error('[WASM Bridge] localStorage.removeItem error:', e);
        }
      },
      clear: () => {
        try {
          // Only clear keys with our prefix
          const keysToRemove: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith(prefix)) {
              keysToRemove.push(k);
            }
          }
          for (const k of keysToRemove) {
            localStorage.removeItem(k);
          }
        } catch (e) {
          console.error('[WASM Bridge] localStorage.clear error:', e);
        }
      },
    });
  }

  /**
   * Register a custom localStorage bridge (e.g., snapshot-based for Web Worker).
   * Accepts an object with getItem/setItem/removeItem/clear methods.
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
   * Compile and execute a script in the WASM VM.
   * Returns a Map of symbol name → { index, scope } matching the TS engine API.
   */
  async initializeScript(code: string): Promise<Map<string, SymbolInfo>> {
    await ensureWasm();

    // The WASM engine's initScript does: compile → set bridges → run
    const symbolMapObj = this.wasm.initScript(code) as Record<
      string,
      { index: number; scope: string }
    >;

    // Convert the plain JS object to a Map
    this.symbolMap = new Map();
    for (const [name, info] of Object.entries(symbolMapObj)) {
      this.symbolMap.set(name, {
        index: info.index,
        scope: info.scope as SymbolScope,
      });
    }

    this._initialized = true;
    return this.symbolMap;
  }

  /**
   * Get a global variable by slot index.
   * Returns a plain JS value (not a BaseObject).
   */
  getGlobal(index: number): unknown {
    return this.wasm.getGlobalByIndex(index);
  }

  /**
   * Set a global variable by slot index.
   * Accepts a plain JS value (not a BaseObject).
   */
  setGlobal(index: number, value: unknown): void {
    this.wasm.setGlobalByIndex(index, value);
  }

  /**
   * Get multiple globals at once in a single WASM boundary crossing.
   * Returns an array of values corresponding to the given indices.
   */
  getGlobalsBatch(indices: number[]): unknown[] {
    return this.wasm.getGlobalsBatch(indices) as unknown[];
  }

  /**
   * Set multiple globals at once in a single WASM boundary crossing.
   * Non-serializable types (Class, CompiledFunction, etc.) are protected.
   */
  setGlobalsBatch(indices: number[], values: unknown[]): void {
    this.wasm.setGlobalsBatch(indices, values);
  }

  /**
   * Call a named function in the VM (sync).
   * The WASM engine does not support async operations, so this is always sync.
   * Returns a plain JS value.
   */
  callFunction(name: string, args: unknown[]): unknown {
    return this.wasm.callFunction(name, sanitizeArgs(args));
  }

  /**
   * Call a named function synchronously.
   * Same as callFunction since the WASM engine is always sync.
   */
  callFunctionSync(name: string, args: unknown[]): unknown {
    return this.wasm.callFunction(name, sanitizeArgs(args));
  }

  /**
   * Evaluate an expression synchronously.
   * Returns a plain JS value.
   */
  evalSync(expression: string): unknown {
    return this.wasm.evalInContext(expression);
  }

  /**
   * Check if the engine has been initialized with a script.
   */
  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Get the symbol map (for external inspection).
   */
  getSymbolMap(): Map<string, SymbolInfo> {
    return this.symbolMap;
  }

  /**
   * Get the list of event types that have registered listeners in the VM.
   * E.g. ["keydown", "keyup", "blur"]
   */
  getEventListenerTypes(): string[] {
    return (this.wasm.getEventListenerTypes() as string[]) || [];
  }

  /**
   * Dispatch a browser event to all VM handlers registered for the given type.
   * Returns the number of handlers invoked.
   */
  dispatchEvent(eventType: string, eventObj: Record<string, unknown>): number {
    return this.wasm.dispatchEvent(eventType, eventObj);
  }

  /**
   * Return the subset of `indices` that have been written since the last `clearDirty()`.
   * Used to skip deepEqual on unchanged state variables during VM→React sync.
   */
  getDirtyGlobals(indices: number[]): number[] {
    return (this.wasm.getDirtyGlobals(indices) as number[]) || [];
  }

  /**
   * Clear all dirty bits. Call after syncing VM state to React.
   */
  clearDirty(): void {
    this.wasm.clearDirty();
  }

  /**
   * Drain all pending host calls queued by `host.call()` during VM execution.
   * Returns an array of { id, kind, args[] } objects.
   */
  drainPendingHostCalls(): Array<{ id: number; kind: string; args: string[] }> {
    return (this.wasm.drainPendingHostCalls() as Array<{ id: number; kind: string; args: string[] }>) || [];
  }

  /**
   * Resolve a pending host callback by its call ID.
   * Converts the result to a VM Object and invokes the stored callback.
   */
  resolveHostCallback(callId: number, result: unknown): void {
    this.wasm.resolveHostCallback(callId, result);
  }

  /**
   * Clean up WASM resources.
   */
  dispose(): void {
    if (this.wasm) {
      this.wasm.free();
    }
  }
}
