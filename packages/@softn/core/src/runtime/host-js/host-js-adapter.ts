/**
 * The host-JavaScript logic engine: `.logic` run as the host document's own
 * JavaScript, with no VM around it.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * Every other engine SoftN runs puts the app author's code inside a sandbox:
 * ZIPP compiles it in WebAssembly, with a step budget, a bounded heap, no
 * `document`, no `fetch`, no reachable host object the preamble did not hand
 * over. This engine does not. The author's code is compiled by the same engine
 * that is running the page, in the page's own realm, and everything that realm
 * can reach it can reach.
 *
 * It exists for one case: a host that has already decided to trust a specific
 * author, and frames their code somewhere that trust is survivable — FormLogic
 * runs it only for accounts an administrator verified, only inside an
 * opaque-origin `sandbox="allow-scripts"` frame whose policy pins every kind of
 * loading to the runtime directory. THE FRAME IS THE BOUNDARY. This file is
 * not; nothing in it should be read as one. What the frame does not stop, this
 * does not stop either: unbounded CPU and memory, arbitrary DOM inside the
 * frame, prototype pollution of the shell's realm.
 *
 * It ships in its own entry (`@softn/core/host-js`) and the default entry never
 * imports it, so an app that does not ask for it does not contain it. The
 * builders, the editors and the ordinary runtime stay on ZIPP.
 *
 * HOW IT KEEPS THE RUNTIME'S CONTRACT
 *
 * `SoftNScriptRuntime` talks to an engine through slots: it reads and writes
 * top-level variables by index, calls top-level functions by name, and diffs
 * what it read against what it wrote. Plain JavaScript has no such table, so
 * this builds one:
 *
 * - The script is compiled with `new Function` inside a closure whose
 *   parameters are ZIPP's preamble names (`window`, `navigator`,
 *   `localStorage`, `db`, `host`, `accel`), re-implemented here to behave the
 *   way `zipp-wasm/src/preamble.js` behaves, so a bundle sees the same facades
 *   on both engines.
 * - acorn finds the script's top-level declarations, and a generated prologue
 *   hands the host an accessor pair per name. Closures over `let`/`const` are
 *   legal before the declaration has run, so the prologue can come first and a
 *   top-level `return` in the script cannot skip it.
 * - Top-level `const` is rewritten to `let` before compiling, in place, so
 *   offsets do not move. ZIPP lets the host write any data slot, and the
 *   runtime depends on that — `window.__` state sync merges into a binding the
 *   script may well have declared `const`.
 * - Values cross by copy in both directions, projected the way ZIPP projects
 *   them (functions, classes, `Date`, `Map`, typed arrays, `BigInt`, `Symbol`
 *   read as `null`), and a host write is merged OVER the live value the way
 *   `host_in_over` merges, so a read-modify-write cannot destroy what the host
 *   could only ever see as `null`.
 *
 * KNOWN DIFFERENCES FROM ZIPP, which a bundle can observe:
 * - No budget of any kind. A loop that does not end does not end.
 * - A write made from a microtask or a timer is not visible to the host until
 *   the next re-entry, because nothing tells the host to re-read.
 * - `accel.*` is unavailable: every method throws.
 * - `evalSync` is a direct `eval` in the script's scope, so it sees bindings
 *   ZIPP's expression evaluator would also see, and needs `'unsafe-eval'`.
 */

import * as acorn from 'acorn';
import { sanitizeArgs } from '../vm-args';
// Type-only, all of it: a value import from here would pull the ZIPP adapter
// into this entry, which is the one thing this entry must not contain.
import type { LogicEngine, LogicEngineFactory, SymbolInfo, SymbolScope } from '../vm-adapter';
import type { DBNamespace } from '../script-runtime';

/**
 * A string that is in a built bundle if and only if this adapter is.
 *
 * `scripts/host-js-isolation.test.mjs` greps for it: the editors, the web app
 * and the ZIPP entry document must not contain it, and the host document's
 * chunk must.
 */
export const HOST_JS_ENGINE_MARK = 'softn.host-js.engine/1';

/**
 * This engine's bridge preamble, for symmetry with ZIPP's: empty, because the
 * facades are function parameters rather than declarations prepended to the
 * script.
 */
export const HOST_JS_BRIDGE_PREAMBLE = '';

/** Everything `db.*` can reach, granted by {@link HostJsAdapter.registerDBBridge}. */
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

/** Everything `localStorage.*` can reach. */
const LOCAL_STORAGE_SYNC_OPS = ['ls.getItem', 'ls.setItem', 'ls.removeItem', 'ls.clear'] as const;

/** Everything `navigator.clipboard.*` can reach. */
const CLIPBOARD_SYNC_OPS = ['nav.clipboardWrite', 'nav.clipboardRead'] as const;

/**
 * The preamble names, in the order the compiled closure takes them. A script
 * that declares one of these at the top level gets the facade, not its own
 * binding — which is what happens on ZIPP too, where the engine refuses the
 * redeclaration outright.
 */
const PREAMBLE_PARAMS = ['window', 'navigator', 'localStorage', 'db', 'host', 'accel'] as const;

/**
 * The preamble names the host is given slots for. The runtime reads and writes
 * `window` (its `window.__` key sync), and reads `navigator` and `host` while
 * classifying symbols; the rest are the script's to call, not the host's.
 */
const EXPOSED_PREAMBLE = ['window', 'navigator', 'host'] as const;

/** How deep a host write is merged before it is taken as a replacement. */
const MERGE_MAX_DEPTH = 64;

/** The storage bridge shape, shared by the browser one and the worker's snapshot one. */
export interface HostJsLocalStorageBridge {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

/**
 * ZIPP's host projection: plain data crosses, and everything else reads as
 * `null`. Cycles read as `null` rather than recursing, as they do there.
 */
function project(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type !== 'object') return null;
  const object = value as object;
  const proto = Object.getPrototypeOf(object);
  if (!Array.isArray(object) && proto !== Object.prototype && proto !== null) return null;
  if (seen.has(object)) return null;
  seen.add(object);
  let out: unknown;
  if (Array.isArray(object)) {
    out = object.map((item) => project(item, seen));
  } else {
    const plain: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      const projected = project((object as Record<string, unknown>)[key], seen);
      if (projected !== undefined) plain[key] = projected;
    }
    out = plain;
  }
  seen.delete(object);
  return out;
}

/** True for anything the host can only ever read back as `null`. */
function isOpaque(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const type = typeof value;
  if (type === 'function' || type === 'bigint' || type === 'symbol') return true;
  if (type !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return !Array.isArray(value) && proto !== Object.prototype && proto !== null;
}

/**
 * ZIPP's `host_in_over`: a host write is merged over the live value rather than
 * replacing it, element-wise through arrays and property-wise through objects,
 * so a host that read a record as `{when: null}` and wrote it back does not
 * destroy the `Date` that was there. The result is a new object, as it is in
 * the engine.
 */
function mergeOver(existing: unknown, incoming: unknown, depth = 0): unknown {
  if (depth > MERGE_MAX_DEPTH) return project(incoming);
  if (Array.isArray(incoming) && Array.isArray(existing)) {
    return incoming.map((item, index) => {
      if (index >= existing.length) return project(item);
      if ((item === null || item === undefined) && isOpaque(existing[index])) return existing[index];
      return mergeOver(existing[index], item, depth + 1);
    });
  }
  const bothPlain =
    incoming !== null &&
    typeof incoming === 'object' &&
    !Array.isArray(incoming) &&
    existing !== null &&
    typeof existing === 'object' &&
    !Array.isArray(existing);
  if (bothPlain) {
    const previous = existing as Record<string, unknown>;
    const next = incoming as Record<string, unknown>;
    const out: Record<string, unknown> = Object.create(Object.getPrototypeOf(previous));
    for (const key of Object.keys(next)) {
      const value = next[key];
      if (!Object.hasOwn(previous, key)) out[key] = project(value);
      else if ((value === null || value === undefined) && isOpaque(previous[key])) out[key] = previous[key];
      else out[key] = mergeOver(previous[key], value, depth + 1);
    }
    // A key the host never saw because it could not be projected stays.
    for (const key of Object.keys(previous)) {
      if (!Object.hasOwn(next, key) && isOpaque(previous[key])) out[key] = previous[key];
    }
    return out;
  }
  return project(incoming);
}

/** Every name a binding pattern introduces. */
function patternNames(node: acorn.Pattern | null | undefined, out: string[]): void {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      out.push(node.name);
      break;
    case 'ObjectPattern':
      for (const property of node.properties) {
        patternNames(property.type === 'RestElement' ? property.argument : (property.value as acorn.Pattern), out);
      }
      break;
    case 'ArrayPattern':
      for (const element of node.elements) patternNames(element as acorn.Pattern, out);
      break;
    case 'RestElement':
      patternNames(node.argument, out);
      break;
    case 'AssignmentPattern':
      patternNames(node.left, out);
      break;
  }
}

/** A top-level binding the host gets a slot for. */
interface Declared {
  name: string;
  scope: SymbolScope;
  /** No setter: a class binding, which a host write could only ever destroy. */
  constant: boolean;
}

/** What one parse answered: the script to compile, and its top-level bindings. */
interface Scanned {
  code: string;
  declared: Declared[];
}

/**
 * Find the script's top-level bindings and rewrite its top-level `const` to
 * `let`.
 *
 * The rewrite is five characters over five characters, so every offset in the
 * source stays where it was and a syntax error still points at the right place.
 * Only statements directly in the program body are touched: a `for (const x of
 * …)` head is inside a `ForOfStatement`, declares nothing at the top level and
 * is left alone.
 */
function scanScript(code: string): Scanned {
  const ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    // The script is compiled as a function body, where a top-level `return` is
    // legal — and shipped bundles use it.
    allowReturnOutsideFunction: true,
  });
  const declared: Declared[] = [];
  const seen = new Set<string>();
  const add = (name: string, scope: SymbolScope, constant: boolean) => {
    if (seen.has(name)) return;
    seen.add(name);
    declared.push({ name, scope, constant });
  };
  // `var` hoists out of blocks, loops and `try`; `let`/`const`/`class`/
  // `function` do not leave the statement they are in, and a function or class
  // body is a scope of its own, so the walk stops at one.
  const walkVar = (node: acorn.AnyNode | null | undefined): void => {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'ClassDeclaration' ||
      node.type === 'ClassExpression'
    ) {
      return;
    }
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
      for (const declarator of node.declarations) {
        const names: string[] = [];
        patternNames(declarator.id, names);
        for (const name of names) add(name, 'variable', false);
      }
    }
    for (const key of Object.keys(node)) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof (item as acorn.AnyNode).type === 'string') walkVar(item as acorn.AnyNode);
        }
      } else if (child && typeof (child as acorn.AnyNode).type === 'string') {
        walkVar(child as acorn.AnyNode);
      }
    }
  };
  const constStarts: number[] = [];
  for (const statement of ast.body) {
    if (statement.type === 'FunctionDeclaration' && statement.id) {
      add(statement.id.name, 'function', false);
    } else if (statement.type === 'ClassDeclaration' && statement.id) {
      add(statement.id.name, 'function', true);
    } else if (statement.type === 'VariableDeclaration') {
      if (statement.kind === 'const') constStarts.push(statement.start);
      for (const declarator of statement.declarations) {
        const names: string[] = [];
        patternNames(declarator.id, names);
        for (const name of names) add(name, 'variable', false);
      }
    } else {
      walkVar(statement);
    }
  }
  let rewritten = code;
  for (const start of constStarts) {
    // `const` is five characters and so is `let` plus the two spaces that keep
    // every later offset exactly where the parser found it.
    rewritten = rewritten.slice(0, start) + 'let  ' + rewritten.slice(start + 5);
  }
  return { code: rewritten, declared };
}

/** The pair the generated prologue hands back for one binding. */
type Accessor = [() => unknown, ((value: unknown) => void) | null];

/** What the compiled script exports to the host before its first statement. */
interface ScriptExports {
  slots: Record<string, Accessor>;
  evaluate: (expression: string) => unknown;
}

/** One slot as the host holds it. */
interface Slot {
  name: string;
  get: () => unknown;
  set: ((value: unknown) => void) | null;
  scope: SymbolScope;
}

let compileCounter = 0;

/**
 * The engine itself. Created through {@link HostJsEngine}, never directly by
 * the runtime, and only ever on the thread the host document runs on.
 */
export class HostJsAdapter implements LogicEngine {
  /** Kept as a field so a built bundle carries the mark the isolation scan looks for. */
  static readonly mark: string = HOST_JS_ENGINE_MARK;

  private symbolMap = new Map<string, SymbolInfo>();
  private slots: Slot[] = [];
  private evaluate: ((expression: string) => unknown) | null = null;
  /** Capabilities a registered bridge could serve. */
  private capabilities = new Set<string>();
  /** Capabilities the script may actually use, frozen when it is compiled. */
  private granted = new Set<string>();
  private dbBridge: DBNamespace | null = null;
  private localStorageBridge: HostJsLocalStorageBridge | null = null;
  private clipboard: { writeText(text: string): void; readText(): string } | null = null;
  private listeners: Record<string, Array<(event: unknown) => void>> = Object.create(null);
  private hostQueue: Array<{ id: number; kind: string; args: string[] }> = [];
  private hostCallbacks = new Map<number, (result: unknown) => void>();
  private hostCallId = 0;
  private initialized = false;
  private stopped = false;

  /** Where a refused storage write is reported before it is thrown to the script. */
  onStorageFailure: ((failure: { operation: string; key: string; error: Error }) => void) | null = null;

  /** There is nothing to load: the engine is the page's. */
  static async create(): Promise<HostJsAdapter> {
    return new HostJsAdapter();
  }

  // --------------------------------------------------------------------------
  // Bridges
  // --------------------------------------------------------------------------

  registerDBBridge(db: DBNamespace): void {
    for (const op of DB_SYNC_OPS) this.capabilities.add(op);
    this.dbBridge = db;
  }

  registerLocalStorageBridge(appId?: string): void {
    for (const op of LOCAL_STORAGE_SYNC_OPS) this.capabilities.add(op);
    const safeAppId = (appId || '_default').replace(/[^a-zA-Z0-9_-]/g, '_');
    const prefix = `softn:${safeAppId}:`;
    // `localStorage` is read at call time, never captured: the FormLogic shell
    // replaces the frame's `window.localStorage` with one that talks to the
    // parent, because the real one throws in an opaque origin.
    this.localStorageBridge = {
      getItem: (key) => {
        try {
          return localStorage.getItem(prefix + key);
        } catch {
          // An unreadable store reads as empty, which is what it is.
          return null;
        }
      },
      setItem: (key, value) => {
        try {
          localStorage.setItem(prefix + key, value);
        } catch (error) {
          throw this.refuseStorage('setItem', key, error);
        }
      },
      removeItem: (key) => {
        try {
          localStorage.removeItem(prefix + key);
        } catch (error) {
          throw this.refuseStorage('removeItem', key, error);
        }
      },
      clear: () => {
        try {
          // Only this app's own prefixed keys — never another bundle's.
          const doomed: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(prefix)) doomed.push(key);
          }
          for (const key of doomed) localStorage.removeItem(key);
        } catch (error) {
          throw this.refuseStorage('clear', '', error);
        }
      },
    };
  }

  /** The snapshot-backed bridge a non-browser host supplies instead. */
  registerLocalStorageBridgeCustom(bridge: HostJsLocalStorageBridge): void {
    for (const op of LOCAL_STORAGE_SYNC_OPS) this.capabilities.add(op);
    this.localStorageBridge = bridge;
  }

  registerClipboardBridge(): void {
    for (const op of CLIPBOARD_SYNC_OPS) this.capabilities.add(op);
    this.clipboard = {
      writeText: (text) => {
        try {
          void navigator.clipboard?.writeText(String(text));
        } catch {
          // A clipboard the browser refuses is not a script error; the async
          // `softn.*` APIs are the supported path for a copy that must report.
        }
      },
      // The script's read is synchronous and the browser's is not, so this can
      // only ever answer empty — as it does on ZIPP.
      readText: () => '',
    };
  }

  /**
   * A no-op: the accelerator compiles the script's generated numeric functions
   * with the host engine over views of the VM's memory, and this engine has no
   * VM memory to take a view of. `accel.*` stays unavailable to the script, as
   * it is on an engine whose host never granted it.
   */
  registerAccelBridge(): void {
    /* nothing to install */
  }

  /** The capabilities a bridge was registered for. */
  getPendingSyncCapabilities(): string[] {
    return [...this.capabilities].sort();
  }

  /** Host JavaScript cannot be metered, so a budget is accepted and ignored. */
  setInstructionBudget(_steps: number | undefined): void {
    /* no budget exists on this engine; see the file header */
  }

  private refuseStorage(operation: string, key: string, cause: unknown): Error {
    // A DOMException is not an Error in every realm, so the name and message
    // are read off whatever was thrown rather than typed.
    const thrown = (cause ?? {}) as { name?: unknown; message?: unknown };
    const name = typeof thrown.name === 'string' && thrown.name ? thrown.name : 'Error';
    const detail = typeof thrown.message === 'string' && thrown.message ? thrown.message : String(cause);
    const error = new Error(`localStorage.${operation}("${key}") was not kept: ${name}: ${detail}`);
    error.name = name;
    try {
      this.onStorageFailure?.({ operation, key, error });
    } catch {
      // The handler's failure is not the script's; the refusal still throws.
    }
    return error;
  }

  /** A capability the host never wired is denied, the way the engine denies one. */
  private requireCapability(op: string): void {
    if (this.granted.has(op)) return;
    const error = new Error(`synchronous host capability denied: ${op}`);
    error.name = 'SecurityError';
    throw error;
  }

  // --------------------------------------------------------------------------
  // The preamble the script sees
  // --------------------------------------------------------------------------

  /** The facades, in {@link PREAMBLE_PARAMS} order. */
  private preamble(): unknown[] {
    // `json` is how every structured value crosses on ZIPP: the bridge is
    // strings in, string out, and both sides JSON it. Doing the same here keeps
    // a bundle's `db` results the same shape on both engines.
    const json = (value: unknown) => JSON.parse(JSON.stringify(value === undefined ? null : value));
    const room = (value: unknown) => (value === undefined || value === null ? undefined : String(value));

    const windowFacade = {
      addEventListener: (type: unknown, handler: (event: unknown) => void) => {
        if (typeof handler !== 'function') return;
        const key = String(type);
        (this.listeners[key] || (this.listeners[key] = [])).push(handler);
      },
      removeEventListener: (type: unknown, handler: (event: unknown) => void) => {
        const registered = this.listeners[String(type)];
        if (!registered) return;
        const at = registered.indexOf(handler);
        if (at >= 0) registered.splice(at, 1);
      },
      // Deliberately limited, and the limit is the contract: delivered to the
      // listeners registered on THIS object, synchronously, never cancelled.
      dispatchEvent: (event: { type?: unknown }) => {
        if (event === null || typeof event !== 'object' || typeof event.type !== 'string') {
          throw new TypeError('dispatchEvent: expected an event object with a string type');
        }
        this.dispatchEvent(event.type, event as Record<string, unknown>);
        return true;
      },
    };

    const navigatorFacade = {
      clipboard: {
        writeText: (text: unknown) => {
          this.requireCapability('nav.clipboardWrite');
          this.clipboard?.writeText(String(text));
        },
        readText: () => {
          this.requireCapability('nav.clipboardRead');
          return this.clipboard?.readText() ?? '';
        },
      },
    };

    const localStorageFacade = {
      getItem: (key: unknown) => {
        this.requireCapability('ls.getItem');
        return this.localStorageBridge?.getItem(String(key)) ?? null;
      },
      setItem: (key: unknown, value: unknown) => {
        this.requireCapability('ls.setItem');
        this.localStorageBridge?.setItem(String(key), String(value));
      },
      removeItem: (key: unknown) => {
        this.requireCapability('ls.removeItem');
        this.localStorageBridge?.removeItem(String(key));
      },
      clear: () => {
        this.requireCapability('ls.clear');
        this.localStorageBridge?.clear();
      },
    };

    const dbFacade = {
      query: (collection: unknown, filter?: unknown) => {
        this.requireCapability('db.query');
        try {
          return json(this.dbBridge?.query(String(collection), (filter ?? undefined) as never));
        } catch {
          return [];
        }
      },
      get: (collection: unknown, id: unknown) => {
        this.requireCapability('db.get');
        try {
          return json(this.dbBridge?.get(String(collection), String(id)));
        } catch {
          return null;
        }
      },
      create: (collection: unknown, data: unknown) => {
        this.requireCapability('db.create');
        return json(this.dbBridge?.create(String(collection), json(data ?? {})));
      },
      update: (id: unknown, data: unknown) => {
        this.requireCapability('db.update');
        return json(this.dbBridge?.update(String(id), json(data ?? {})));
      },
      delete: (id: unknown) => {
        this.requireCapability('db.delete');
        this.dbBridge?.delete(String(id));
      },
      hardDelete: (collection: unknown, id: unknown) => {
        this.requireCapability('db.hardDelete');
        this.dbBridge?.hardDelete(String(collection), String(id));
      },
      startSync: (name: unknown) => {
        this.requireCapability('db.startSync');
        try {
          this.dbBridge?.startSync(String(name));
        } catch {
          // Sync that cannot start is not a script error on ZIPP either.
        }
      },
      stopSync: (name?: unknown) => {
        this.requireCapability('db.stopSync');
        try {
          this.dbBridge?.stopSync(room(name));
        } catch {
          // As above.
        }
      },
      getSyncStatus: (name?: unknown) => {
        this.requireCapability('db.getSyncStatus');
        try {
          return json(this.dbBridge?.getSyncStatus(room(name)));
        } catch {
          return { connected: false, peers: 0, room: '', peerId: '' };
        }
      },
      getSavedSyncRoom: () => {
        this.requireCapability('db.getSavedSyncRoom');
        try {
          return this.dbBridge?.getSavedSyncRoom() ?? null;
        } catch {
          return null;
        }
      },
    };

    // Asynchronous by contract: the request is queued, the host drains it after
    // this re-entry returns, and the callback runs when the host answers.
    const hostFacade = {
      call: (kind: unknown, args: unknown[] | undefined, callback?: (result: unknown) => void) => {
        // Normalise first, register second: a `toString` that throws must not
        // leave a callback waiting for a request that was never queued.
        const name = String(kind);
        const flat: string[] = [];
        if (args) for (const arg of args) flat.push(String(arg));
        const id = ++this.hostCallId;
        if (typeof callback === 'function') this.hostCallbacks.set(id, callback);
        this.hostQueue.push({ id, kind: name, args: flat });
      },
    };

    // Every method throws, which is what a script sees on an engine whose host
    // did not grant `accel`.
    const accelFacade = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('accel is not available on the host JavaScript engine');
        },
      }
    );

    return [windowFacade, navigatorFacade, localStorageFacade, dbFacade, hostFacade, accelFacade];
  }

  // --------------------------------------------------------------------------
  // Compile and run
  // --------------------------------------------------------------------------

  async initializeScript(code: string): Promise<Map<string, SymbolInfo>> {
    if (this.initialized || this.stopped) {
      this.stopped = true;
      throw new Error('host-js: this engine has already compiled a script');
    }
    // What the host wired before compiling is what the script may use; a bridge
    // registered afterwards does not widen it.
    this.granted = new Set(this.capabilities);
    let scanned: Scanned;
    try {
      scanned = scanScript(code);
    } catch (error) {
      this.stopped = true;
      throw error;
    }
    const slots: Declared[] = [
      ...EXPOSED_PREAMBLE.map((name) => ({ name, scope: 'variable' as SymbolScope, constant: false })),
      ...scanned.declared.filter((d) => !(PREAMBLE_PARAMS as readonly string[]).includes(d.name)),
    ];
    const exportName = `__hostJsExport_${++compileCounter}_${Math.random().toString(36).slice(2)}`;
    const table = slots
      .map((d) => `${JSON.stringify(d.name)}: [() => ${d.name}, ${d.constant ? 'null' : `(v) => { ${d.name} = v; }`}]`)
      .join(',\n');
    // The prologue runs before the script's first statement. Closures over
    // `let`/`const` are legal before the declaration is reached — the temporal
    // dead zone applies when one is CALLED, not when it is made — so the host
    // has its whole table however early the script returns.
    const body = `${exportName}({ slots: {\n${table}\n}, evaluate: function (__expression) { return eval(__expression); } });\n${scanned.code}`;
    let compiled: (...args: unknown[]) => unknown;
    try {
      compiled = new Function(...PREAMBLE_PARAMS, exportName, body) as typeof compiled;
    } catch (error) {
      this.stopped = true;
      throw error;
    }
    let exported: ScriptExports | null = null;
    try {
      compiled(...this.preamble(), (value: ScriptExports) => {
        exported = value;
      });
    } catch (error) {
      this.stopped = true;
      throw error;
    }
    if (!exported) {
      this.stopped = true;
      throw new Error('host-js: the script did not reach its first statement');
    }
    const table2 = (exported as ScriptExports).slots;
    this.evaluate = (exported as ScriptExports).evaluate;
    this.symbolMap = new Map();
    this.slots = [];
    slots.forEach((declared, index) => {
      const [get, set] = table2[declared.name];
      this.slots.push({ name: declared.name, get, set, scope: declared.scope });
      this.symbolMap.set(declared.name, { index, scope: declared.scope });
    });
    this.initialized = true;
    return this.symbolMap;
  }

  private readSlot(index: number): unknown {
    const slot = this.slots[index];
    if (!slot) return undefined;
    try {
      return project(slot.get());
    } catch {
      // A binding still in its temporal dead zone reads as nothing, which is
      // what the host would see for an uninitialised slot on ZIPP.
      return undefined;
    }
  }

  getGlobal(index: number): unknown {
    return this.readSlot(index);
  }

  setGlobal(index: number, value: unknown): void {
    // `undefined` means the host holds no value for this slot.
    if (value === undefined) return;
    const slot = this.slots[index];
    if (!slot || !slot.set) return;
    let current: unknown;
    try {
      current = slot.get();
    } catch {
      return; // temporal dead zone
    }
    // A function, a class or a Date is something the host only ever read as
    // `null`; writing the `null` back would destroy it.
    if (isOpaque(current)) return;
    slot.set(mergeOver(current, value));
  }

  getGlobalsBatch(indices: number[]): unknown[] {
    return indices.map((index) => this.readSlot(index));
  }

  setGlobalsBatch(indices: number[], values: unknown[]): void {
    indices.forEach((index, at) => this.setGlobal(index, values[at]));
  }

  callFunction(name: string, args: unknown[]): unknown {
    const symbol = this.symbolMap.get(name);
    const fn = symbol ? this.slots[symbol.index].get() : undefined;
    if (typeof fn !== 'function') throw new Error(`host-js: no such function '${name}'`);
    return project((fn as (...args: unknown[]) => unknown)(...sanitizeArgs(args)));
  }

  callFunctionSync(name: string, args: unknown[]): unknown {
    return this.callFunction(name, args);
  }

  evalSync(expression: string): unknown {
    if (!this.evaluate) throw new Error('host-js: no script has been compiled');
    const value = this.evaluate(`(${expression})`);
    // The same round trip the engine's expression evaluator makes: whatever
    // will not JSON is nothing, rather than a host object crossing by
    // reference.
    const text = JSON.stringify(value);
    return text === undefined ? undefined : JSON.parse(text);
  }

  getSymbolMap(): Map<string, SymbolInfo> {
    return this.symbolMap;
  }

  getEventListenerTypes(): string[] {
    return Object.keys(this.listeners).filter((type) => this.listeners[type].length > 0);
  }

  dispatchEvent(eventType: string, eventObj: Record<string, unknown>): number {
    const registered = this.listeners[String(eventType)];
    if (!registered || !registered.length) return 0;
    if (eventObj && typeof eventObj.preventDefault !== 'function') {
      eventObj.preventDefault = () => {};
      eventObj.stopPropagation = () => {};
    }
    let delivered = 0;
    // Copy first: a handler may remove itself while this is iterating, and it
    // must not skip the unrelated listener after it.
    for (const handler of registered.slice()) {
      if (typeof handler !== 'function') continue;
      handler(eventObj);
      delivered++;
    }
    return delivered;
  }

  /** This engine cannot digest a slot more cheaply than the host can read it. */
  getGlobalsFingerprint(_indices: number[]): number[] | null {
    return null;
  }

  /** Nothing tracks writes here, so every slot the host asks about may have changed. */
  getDirtyGlobals(indices: number[]): number[] {
    return indices;
  }

  clearDirty(): void {
    /* nothing is tracked */
  }

  drainPendingHostCalls(): Array<{ id: number; kind: string; args: string[] }> {
    const queued = this.hostQueue;
    this.hostQueue = [];
    return queued;
  }

  resolveHostCallback(callId: number, result: unknown): void {
    const callback = this.hostCallbacks.get(callId);
    if (!callback) return;
    this.hostCallbacks.delete(callId);
    callback(result);
  }

  /**
   * Whether the engine stopped and will not work again.
   *
   * Only a script that failed to compile stops one — the same case that
   * terminates a ZIPP engine, and the runtime answers it by building a fresh
   * engine. Nothing a compiled script does afterwards stops this one: there is
   * no budget to exceed and no heap to exhaust before the tab's.
   */
  get terminated(): boolean {
    return this.stopped;
  }

  dispose(): void {
    this.initialized = false;
    this.slots = [];
    this.symbolMap = new Map();
    this.evaluate = null;
    this.listeners = Object.create(null);
    this.hostCallbacks.clear();
    this.hostQueue = [];
    this.dbBridge = null;
    this.localStorageBridge = null;
    this.clipboard = null;
  }
}

/** A factory that says where its engine can run as well as how to make one. */
export interface HostJsEngineFactory extends LogicEngineFactory {
  /** {@link HOST_JS_ENGINE_MARK}, so a built bundle carries it. */
  readonly mark: string;
  readonly threads: 'main-only';
}

/**
 * The factory a host passes to `configureLogicEngine`.
 *
 * `threads: 'main-only'` is not a preference. The script Worker names the ZIPP
 * adapter itself and could not reach this engine, and this engine is the host
 * DOCUMENT's — it does not exist in a worker realm. Declaring it here is what
 * makes `SoftNRenderer` run a bundle on the main thread however the bundle or
 * the harness asked to be run, rather than silently giving it ZIPP.
 */
export const HostJsEngine: HostJsEngineFactory = {
  mark: HOST_JS_ENGINE_MARK,
  threads: 'main-only',
  create: () => HostJsAdapter.create(),
};
