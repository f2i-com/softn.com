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

import { Engine, accelGuestCall } from '../../wasm-zipp/zipp_wasm.js';
import { ensureZippWasm } from './zipp-wasm-loader';
import { flushEngineOutput } from './engine-output';
import { LOCAL_STORAGE_BUDGET, StorageBudget } from './storage-budget';

import type { DBNamespace } from './script-runtime';
import type { LogicEngine } from './vm-adapter';
import type { ScriptOrigin } from './logic-origin';
import type { ClipboardBridgeOptions } from './clipboard-gate';
import { sanitizeArgs } from './vm-args';
import { EVENT_METHODS_FUNCTION, EVENT_METHODS_SOURCE, holdsEvent } from './event-props';

// ============================================================================
// WASM initialization
// ============================================================================

/** The instantiated module's exports; `memory` backs the accel bridge's views. */
let wasmExports: { memory: WebAssembly.Memory } | null = null;

async function ensureWasm(): Promise<void> {
  wasmExports = await ensureZippWasm();
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

/**
 * A host storage failure as the script sees it: an exception carrying the
 * browser's own name for what went wrong — `QuotaExceededError`,
 * `SecurityError` — so a script that catches around a save can tell the
 * player what happened, and one that does not fails loudly instead of
 * silently.
 */
function storageFailure(operation: string, key: string, cause: unknown): Error {
  // A DOMException is not an Error in every realm (jsdom's is not), so the
  // name and message are read off whatever was thrown rather than typed.
  const thrown = (cause ?? {}) as { name?: unknown; message?: unknown };
  const name = typeof thrown.name === 'string' && thrown.name ? thrown.name : 'Error';
  const detail =
    typeof thrown.message === 'string' && thrown.message ? thrown.message : String(cause);
  const error = new Error(`localStorage.${operation}("${key}") was not kept: ${name}: ${detail}`);
  error.name = name;
  return error;
}

/** Everything `accel.*` can reach. Served by `setAccelBridge`. */
const ACCEL_SYNC_OPS = ['accel.compile', 'accel.make', 'accel.state', 'accel.run', 'accel.install'] as const;

// ============================================================================
// Async functions the host calls
// ============================================================================

/**
 * The function an async function of the script is entered through when the
 * host calls it, put after the script by {@link asyncEntrySource} and kept
 * out of the symbol map the host is given.
 *
 * ZIPP hands the host no promise: a call to an async function answers null,
 * and a rejection after that goes nowhere, so a handler that threw was
 * silent. This calls the function as the engine would, and if it answers a
 * promise, has the guest write the runtime's line for a failed call when it
 * rejects, naming the function (`engine-output.ts` prints it as an error).
 * The rejection is otherwise left alone.
 */
const ASYNC_ENTRY = '__zippSoftnEnter';

/**
 * {@link ASYNC_ENTRY} for `names`. Each is reached by its own name, in the
 * script's scope, so the function called is the one the host would have
 * called; a name the script does not declare at its top level is undefined
 * there, and the call fails as the host's direct call would.
 */
function asyncEntrySource(names: ReadonlySet<string>): string {
  const cases = [...names]
    .map((name) => `case ${JSON.stringify(name)}: fn = typeof ${name} === "function" ? ${name} : undefined; break;`)
    .join('\n    ');
  return `
;function ${ASYNC_ENTRY}(name, args) {
  var fn;
  switch (name) {
    ${cases}
  }
  if (typeof fn !== "function") throw new TypeError(name + " is not a function");
  var result = fn(...args);
  if (result !== null && typeof result === "object" && typeof result.then === "function") {
    result.then(undefined, function (error) {
      var said;
      try { said = String(error); } catch (_) { said = "an error that cannot be shown"; }
      console.error("[SoftN] Error executing function " + name + ": " + said);
    });
  }
  return result;
}
`;
}

/**
 * The function a function of the script is entered through when the host
 * hands it an event: it gives the event's record its methods (see
 * `EVENT_METHODS_SOURCE`), then calls the function as the host would have,
 * through {@link ASYNC_ENTRY} when it is async.
 */
const EVENT_ENTRY = '__zippSoftnEvent';

/**
 * The names a script declares functions under at its top level, or may:
 * `function save()`, and `const save = () => …` or `= function`. A name
 * that is nested somewhere instead is undefined at the top and fails as the
 * host's direct call of it would.
 */
export function declaredFunctionNames(code: string): Set<string> {
  const names = new Set<string>();
  for (const match of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) names.add(match[1]);
  const assigned =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
  for (const match of code.matchAll(assigned)) names.add(match[1]);
  // The text is read whole, comments and strings included, so "the function
  // for each row" in a comment names `for`. A name that is not declared is
  // harmless here (its case answers undefined), but a reserved word is not a
  // name at all: `typeof for` would be a syntax error in the entry, and the
  // app's whole script would fail to compile with it.
  for (const name of names) if (RESERVED_WORDS.has(name)) names.delete(name);
  return names;
}

/** JavaScript's reserved words, which `typeof <word>` cannot be written with. */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import',
  'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public',
  'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'yield',
]);

/** {@link EVENT_ENTRY} for `names`; `asyncNames` are entered through {@link ASYNC_ENTRY}. */
function eventEntrySource(names: ReadonlySet<string>, asyncNames: ReadonlySet<string>): string {
  const cases = [...names]
    .map((name) => `case ${JSON.stringify(name)}: fn = typeof ${name} === "function" ? ${name} : undefined; break;`)
    .join('\n    ');
  const entered = [...names].filter((name) => asyncNames.has(name)).map((name) => JSON.stringify(name));
  return `${EVENT_METHODS_SOURCE}
;function ${EVENT_ENTRY}(name, args) {
  ${EVENT_METHODS_FUNCTION}(args);
  ${entered.length > 0 ? `if ([${entered.join(', ')}].indexOf(name) !== -1) return ${ASYNC_ENTRY}(name, args);` : ''}
  var fn;
  switch (name) {
    ${cases}
  }
  if (typeof fn !== "function") throw new TypeError(name + " is not a function");
  return fn(...args);
}
`;
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
  private _terminated = false;
  /** Per-re-entry step budget; see {@link setInstructionBudget}. */
  private instructionBudget: number | undefined = undefined;
  /** Names accumulated by `register*` calls, flushed once before `initScript`. */
  private pendingSyncCapabilities = new Set<string>();
  /** The script's async functions, entered through {@link ASYNC_ENTRY}. */
  private asyncFunctions: ReadonlySet<string> = new Set();
  /** The script's functions, entered through {@link EVENT_ENTRY} when handed an event. */
  private eventFunctions: ReadonlySet<string> = new Set();

  private constructor(wasm: Engine) {
    this.wasm = wasm;
  }

  /** Create a new adapter instance. Must be awaited. */
  static async create(): Promise<ZippWasmAdapter> {
    await ensureWasm();
    const engine = new Engine();

    // Key the global fingerprints before anything can be digested.
    //
    // The engine's digest mixer is a chain of bijections, so an unkeyed digest
    // can be inverted and SOLVED for a collision — two different values with the
    // same digest, constructed rather than stumbled upon. syncVMStateToReact
    // skips reading globals whose digest has not moved, so a bundle that did
    // that would leave the host mirroring state the VM had already changed, and
    // could show one number while acting on another.
    //
    // The key never leaves this side and never needs to be stable: digests are
    // only ever compared against earlier digests from the same engine.
    const seedEngine = engine as unknown as {
      setFingerprintSeed?: (lo: number, hi: number) => void;
    };
    if (typeof seedEngine.setFingerprintSeed === 'function') {
      const seed = new Uint32Array(2);
      const c = (globalThis as { crypto?: Crypto }).crypto;
      if (c && typeof c.getRandomValues === 'function') {
        c.getRandomValues(seed);
      } else {
        // No CSPRNG here. Still better than a constant every bundle knows,
        // and the engine keeps working either way.
        seed[0] = (Math.random() * 0x1_0000_0000) >>> 0;
        seed[1] = (Math.random() * 0x1_0000_0000) >>> 0;
      }
      seedEngine.setFingerprintSeed(seed[0], seed[1]);
    }

    return new ZippWasmAdapter(engine);
  }

  /**
   * Make an engine for a Python app on this same ZIPP build.
   *
   * A Python state answers a different API from a JavaScript one — no
   * preamble, no global slots, no host-call queue — so it gets its own adapter
   * rather than a mode of this one. Its presence here is what says ZIPP can
   * run Python at all; the factories that cannot (the host-JavaScript engine)
   * simply do not have this method, and `createPythonLogicEngine` refuses.
   *
   * Imported on demand so a realm that only ever runs JavaScript never loads
   * the Python runtime source.
   */
  static async createPython(): Promise<LogicEngine> {
    const { PythonLogicAdapter } = await import('./python/python-logic-adapter');
    return PythonLogicAdapter.create();
  }

  /** Forward anything the script printed; see `engine-output.ts`. */
  private flushOutput(): void {
    if (this._disposed || this._terminated) return;
    flushEngineOutput(this.wasm);
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
   * Writes that the browser refuses reach the script as exceptions; see the
   * bridge below.
   *
   * `navigator.clipboard` used to be served from this same object — the old
   * engine routed `nav.*` to the localStorage bridge. v0.0.1 refuses to, so it
   * moved to {@link registerClipboardBridge}.
   */
  registerLocalStorageBridge(appId?: string): void {
    for (const op of LOCAL_STORAGE_SYNC_OPS) this.pendingSyncCapabilities.add(op);

    const safeAppId = (appId || '_default').replace(/[^a-zA-Z0-9_-]/g, '_');
    const prefix = `softn:${safeAppId}:`;
    // The app's share of the store, which the host and every other app use too.
    // In a sandboxed frame with no origin, as FormLogic runs an app that is not
    // native, reading `localStorage` throws, and `typeof` reads it: that threw
    // here and the app never opened. There is no store to share then, and each
    // call below says so to the script as it would anywhere else.
    let budget: StorageBudget | null = null;
    try {
      budget = typeof localStorage === 'undefined' ? null : new StorageBudget(localStorage, prefix, LOCAL_STORAGE_BUDGET);
    } catch {
      budget = null;
    }

    // A write that fails is thrown to the guest, not logged and swallowed.
    // The bridge used to catch the browser's exception — quota, most often —
    // and return, so a script's `try { localStorage.setItem(...) } catch` saw
    // the save succeed after it had failed, and told the player so. A throw
    // here crosses the VM boundary the same way a `db.create` error does,
    // and lands in the script's catch with the browser's own name for what
    // went wrong. Reads stay lenient: an unreadable store reads as empty,
    // which is what it is.
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
          const text = String(value);
          budget?.admit(prefix + key, text);
          localStorage.setItem(prefix + key, text);
          budget?.wrote(prefix + key, text);
        } catch (e) {
          throw this.refuseStorage('setItem', key, e);
        }
      },
      removeItem: (key: string) => {
        try {
          localStorage.removeItem(prefix + key);
          budget?.removed(prefix + key);
        } catch (e) {
          throw this.refuseStorage('removeItem', key, e);
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
          for (const k of keysToRemove) {
            localStorage.removeItem(k);
            budget?.removed(k);
          }
        } catch (e) {
          throw this.refuseStorage('clear', '', e);
        }
      },
    });
  }

  /**
   * Where a refused storage write is reported before it is thrown to the
   * script. The engine hands the script a generic failure; the host gets the
   * browser's own exception and can say why.
   */
  onStorageFailure: ((failure: { operation: string; key: string; error: Error }) => void) | null =
    null;

  private refuseStorage(operation: string, key: string, cause: unknown): Error {
    const failure = storageFailure(operation, key, cause);
    try {
      this.onStorageFailure?.({ operation, key, error: failure });
    } catch (e) {
      console.error('[zipp bridge] the storage failure handler threw:', e);
    }
    return failure;
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
  registerClipboardBridge(options: ClipboardBridgeOptions = {}): void {
    for (const op of CLIPBOARD_SYNC_OPS) this.pendingSyncCapabilities.add(op);

    this.wasm.setClipboardBridge({
      // Held to the person's own action (clipboard-gate.ts); a refusal is
      // thrown to the script, as a refused storage write is. In a worker the
      // write is handed to the page, which holds it to the same rule.
      writeText: (text: string) => {
        if (options.write) {
          options.write(String(text));
          return;
        }
        const refused = options.refusal?.() ?? null;
        if (refused) throw new DOMException(refused, 'NotAllowedError');
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
   * Install the accelerator: the script's generated numeric functions compile
   * with this engine and run over views of its typed arrays. See
   * `accel-host.ts` for what keeps that safe. Granted by the `accel`
   * capability; an engine without the bridge (a rolled-back artifact) makes
   * this a no-op, and the guest's `accel.*` then throws as if denied.
   *
   * Asynchronous because the host and its validator (some 15 KB) load here:
   * only the script worker installs the bridge, for a script that asked for
   * `accel`, so the main-thread runtime of every host no longer carries them.
   * Awaited before the script is compiled, as the worker does.
   */
  async registerAccelBridge(): Promise<void> {
    for (const op of ACCEL_SYNC_OPS) this.pendingSyncCapabilities.add(op);
    if (typeof this.wasm.setAccelBridge !== 'function') return;
    const { createAccelHost } = await import('./accel-host');
    if (this._disposed) return;
    const host = createAccelHost({
      memory: () => {
        if (!wasmExports) throw new Error('accel: the engine is not instantiated');
        return wasmExports.memory;
      },
      guestCall: (name, args) => accelGuestCall(name, args),
    });
    // The engine reports a failed bridge call to the guest as a bare "host
    // bridge call failed", so the reason is said here, once per method: a
    // script that falls back to its own interpreter is ten times slower and
    // nobody would otherwise know why.
    const reported = new Set<string>();
    const guarded = <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
      (...args: A): R => {
        try {
          return fn(...args);
        } catch (err) {
          if (!reported.has(name)) {
            reported.add(name);
            console.warn(`[SoftN accel] ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          throw err;
        }
      };
    this.wasm.setAccelBridge({
      compile: guarded('compile', host.compile),
      make: guarded('make', host.make),
      state: guarded('state', host.state),
      run: guarded('run', host.run),
      install: guarded('install', host.install),
    });
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
   * wired or granted once this has been entered. `origin` names the script and
   * moves the positions its errors report, so they count from the app's logic
   * rather than from the runtime's code ahead of it (logic-origin.ts).
   */
  async initializeScript(code: string, origin?: ScriptOrigin): Promise<Map<string, SymbolInfo>> {
    await ensureWasm();

    // The async functions the host may call, entered through a function of
    // this adapter's that says when one rejects (see ASYNC_ENTRY).
    this.asyncFunctions = new Set(
      [...code.matchAll(/\basync\s+function\s+([A-Za-z_$][\w$]*)/g)]
        .map((match) => match[1])
        .filter((name) => !RESERVED_WORDS.has(name))
    );
    if (this.asyncFunctions.size > 0) code += asyncEntrySource(this.asyncFunctions);
    this.eventFunctions = declaredFunctionNames(code);
    if (this.eventFunctions.size > 0) code += eventEntrySource(this.eventFunctions, this.asyncFunctions);

    // 0.0.29 and later; an engine before it counts from the top of `code`.
    if (origin && typeof this.wasm.setScriptOrigin === 'function') {
      this.wasm.setScriptOrigin(origin.name, origin.lineOffset, origin.columnOffset);
    }

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
      if (name === ASYNC_ENTRY || name === EVENT_ENTRY || name === EVENT_METHODS_FUNCTION) continue;
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
   * Restore the engine's instruction budget before re-entering it.
   *
   * The budget is a LIFETIME total — about 50 million instructions for the
   * life of an Engine, regardless of how the work is divided. That bounds a
   * runaway script, and it also puts a fuse on every long-running application:
   * Pocket's emulator spent it within seconds of a cartridge starting and the
   * engine was disposed mid-frame, after which every call answered "engine is
   * disposed" without saying why.
   *
   * Renewing HERE, before the call and never after, makes the bound
   * per-re-entry: a single call still cannot run unbounded — which is the
   * property that matters in a browser, since that is what would wedge the tab
   * — while an application runs as long as the host keeps driving it. The host
   * decides the cadence, the guest cannot reach this, and an engine that has
   * already spent a budget stays spent.
   */
  private renewBudget(): void {
    const engine = this.wasm as unknown as {
      renewInstructionBudget?: () => boolean;
      setInstructionBudget?: (steps: number) => boolean;
    };
    try {
      // v0.0.13's setInstructionBudget goes through the same renewal as
      // renewInstructionBudget, with the host's size instead of the default;
      // an older engine has only the default.
      if (this.instructionBudget !== undefined && typeof engine.setInstructionBudget === 'function') {
        engine.setInstructionBudget(this.instructionBudget);
      } else if (typeof engine.renewInstructionBudget === 'function') {
        engine.renewInstructionBudget();
      }
    } catch {
      // An engine too far gone to renew is about to report that itself.
    }
  }

  /**
   * How many engine steps one re-entry may spend before it is judged a
   * runaway. `undefined` is the engine's default, 50M — right for a script on
   * the page's main thread, where every step of a call is a step the page is
   * frozen for. A host that runs the script where a long call blocks nothing
   * (the worker runtime) grants more, so a legitimately long computation is
   * not cut off by the fuse meant for an infinite loop. Guest code cannot
   * reach this; exhaustion stays sticky either way.
   */
  setInstructionBudget(steps: number | undefined): void {
    // The engine clamps to [1, 2e9]; anything else here means the default.
    this.instructionBudget =
      typeof steps === 'number' && Number.isFinite(steps) && steps >= 1
        ? Math.min(Math.floor(steps), 2_000_000_000)
        : undefined;
  }

  /**
   * Call a named top-level function. The engine drains microtasks before
   * returning, so promise callbacks the call scheduled have already run.
   */
  callFunction(name: string, args: unknown[]): unknown {
    const crossing = sanitizeArgs(args);
    // Handed an event, a function is entered through EVENT_ENTRY, which gives
    // the event's record the methods browser code calls on it.
    if (this.eventFunctions.has(name) && holdsEvent(crossing)) {
      return this.callDirect(EVENT_ENTRY, [name, crossing], true);
    }
    if (!this.asyncFunctions.has(name)) return this.callDirect(name, crossing, true);
    // An async function answers a promise, which reaches the host as null:
    // whether it went on to reject only the guest can see. So it is entered
    // through ASYNC_ENTRY, which says so as the runtime's other failures are
    // said, naming the function. The function itself runs as before.
    return this.callDirect(ASYNC_ENTRY, [name, crossing], true);
  }

  /** Same as {@link callFunction}, for a value the caller needs now; no promise is awaited. */
  callFunctionSync(name: string, args: unknown[]): unknown {
    return this.callDirect(name, args);
  }

  /** Call `name`; `sanitized` says `args` have been through sanitizeArgs already. */
  private callDirect(name: string, args: unknown[], sanitized = false): unknown {
    this.renewBudget();
    try {
      return this.wasm.callFunction(name, sanitized ? args : sanitizeArgs(args));
    } catch (e) {
      // A call that blew its budget takes the engine with it, and every call
      // after that answers "engine is disposed". Remember it so the runtime
      // stops driving a corpse instead of logging the same line thirty times
      // a second.
      if (e instanceof Error && /engine is disposed/i.test(e.message)) this._terminated = true;
      throw e;
    } finally {
      this.flushOutput();
    }
  }

  /**
   * Evaluate an expression in the script's global context.
   *
   * Each call compiles fresh, so this is for one-off host queries (template
   * expressions, computed values) — never a per-frame path.
   */
  evalSync(expression: string): unknown {
    try {
      this.renewBudget();
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
    this.renewBudget();
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
      this.renewBudget();
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
      try {
        // Explicit teardown records the dynamic definitions retained by the
        // shared WASM instance. free() alone drops the VM but skips that account.
        this.wasm.dispose();
      } finally {
        this.wasm.free();
      }
    } catch {
      // Cleanup must remain safe after a prior teardown or a WASM trap.
    }
  }
}
