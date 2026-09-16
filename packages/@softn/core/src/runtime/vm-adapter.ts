/**
 * The scripting VM SoftN runs `.logic` on.
 *
 * This module is the single seam between the runtime and the engine behind it.
 * `SoftNScriptRuntime` and the Web Worker runtime import only from here, so
 * changing engines means changing the re-exports below and nothing else.
 *
 * Current engine: **zipp** — a clean-sheet JavaScript engine (Rust → WASM).
 * `.logic` is JavaScript, so a real JS engine runs the same sources the
 * previous bytecode VM did, with the same sandbox guarantee: no `eval`, no
 * `new Function`, and no reachable host object the preamble does not hand over.
 *
 * The previous engine, the FormLogic bytecode VM and its adapter
 * (`formlogic-wasm-adapter.ts`, `wasm/formlogic_wasm*`), was removed on
 * 15 September 2026: nothing had selected it since zipp became the engine,
 * and its 2 MB binary shipped with every checkout. It is in the history if a
 * second engine is ever wanted; an adapter plugs in by re-exporting here.
 *
 * The preamble travels with the adapter deliberately: what has to be prepended
 * to a script is a property of the engine, not of the runtime. zipp declares
 * `window`/`navigator`/`db`/`localStorage`/`host` itself and rejects a script
 * that redeclares them, so its preamble is empty.
 *
 * A host that must run one page's apps on one engine and another page's on a
 * second one cannot do that by changing a re-export, so the same seam is also
 * available at runtime: {@link LogicEngine} is the surface the main-thread
 * runtime calls, {@link configureLogicEngine} chooses the factory behind it,
 * and {@link createLogicEngine} is what `SoftNScriptRuntime` builds from.
 * Nothing configures it today, and the default factory is the ZIPP adapter,
 * so the runtime behaves exactly as it did before the seam existed.
 */

export { ZippWasmAdapter as VmAdapter, ZIPP_BRIDGE_PREAMBLE as VM_BRIDGE_PREAMBLE } from './zipp-wasm-adapter';
export type { SymbolScope, SymbolInfo } from './zipp-wasm-adapter';

import { ZippWasmAdapter, type SymbolInfo } from './zipp-wasm-adapter';
import type { DBNamespace } from './script-runtime';

/** The concrete adapter type, for callers that need to name it. */
export type VmAdapterInstance = ZippWasmAdapter;

// ============================================================================
// The engine seam
// ============================================================================

/**
 * What `SoftNScriptRuntime` needs from the engine running `.logic`.
 *
 * This is the adapter surface as the main-thread runtime actually uses it —
 * every method below is called from `script-runtime.ts` — so an engine that
 * implements it is drop-in. It is deliberately NOT the whole of
 * {@link ZippWasmAdapter}: `setInstructionBudget`, `registerAccelBridge`,
 * `registerLocalStorageBridgeCustom`, `getDirtyGlobals` and `clearDirty` belong
 * to the worker runtime, which imports the ZIPP adapter directly and is not
 * part of this seam (see {@link createLogicEngine}).
 *
 * Values cross this boundary as plain data in both directions; nothing here may
 * hand a host object to the guest.
 */
export interface LogicEngine {
  /** Wire `db.*` so the guest can call it synchronously from inside the VM. */
  registerDBBridge(db: DBNamespace): void;
  /** Wire `localStorage.*`, scoped to `appId` so two bundles cannot collide. */
  registerLocalStorageBridge(appId?: string): void;
  /** Wire `navigator.clipboard.*`. */
  registerClipboardBridge(): void;
  /** Where a refused storage write is reported before it is thrown to the guest. */
  onStorageFailure: ((failure: { operation: string; key: string; error: Error }) => void) | null;
  /** Compile and run a script, answering symbol name → `{ index, scope }`. */
  initializeScript(code: string): Promise<Map<string, SymbolInfo>>;
  /** Read one global by slot index, as a plain JS value. */
  getGlobal(index: number): unknown;
  /** Write one global by slot index; `undefined` means "the host holds none". */
  setGlobal(index: number, value: unknown): void;
  /** Read many globals in one boundary crossing. */
  getGlobalsBatch(indices: number[]): unknown[];
  /** Write many globals in one boundary crossing. */
  setGlobalsBatch(indices: number[], values: unknown[]): void;
  /** Call a named top-level function. */
  callFunction(name: string, args: unknown[]): unknown;
  /** Call a named top-level function where the caller needs the value now. */
  callFunctionSync(name: string, args: unknown[]): unknown;
  /** Evaluate an expression in the script's global scope. */
  evalSync(expression: string): unknown;
  /** Event types the script registered listeners for, e.g. `["keydown"]`. */
  getEventListenerTypes(): string[];
  /** Deliver an event to every guest listener; answers how many ran. */
  dispatchEvent(eventType: string, eventObj: Record<string, unknown>): number;
  /** Take the `host.call(...)` requests the last re-entry queued. */
  drainPendingHostCalls(): Array<{ id: number; kind: string; args: string[] }>;
  /** Invoke the callback the guest passed to `host.call` for `callId`. */
  resolveHostCallback(callId: number, result: unknown): void;
  /** Tear the engine down. It is unusable afterwards. */
  dispose(): void;
  /** Whether the engine tore itself down and will not work again. */
  readonly terminated: boolean;
  /**
   * Digests of `indices`, or null when this engine cannot produce them.
   * Optional: it is an optimisation, and a host that loses it only reads more.
   */
  getGlobalsFingerprint?(indices: number[]): number[] | null;
  /**
   * Compile and run a Python project, answering the same symbol map
   * {@link initializeScript} answers.
   *
   * Optional, and its absence is the point: an engine without it cannot run
   * Python, and {@link createPythonLogicEngine} refuses by name rather than
   * handing `.py` source to something that would read it as JavaScript.
   */
  initializePythonProject?(project: PythonProject): Promise<Map<string, SymbolInfo>>;
}

/**
 * A Python app's logic, as the composer found it in the bundle.
 *
 * `files` is module name → the author's source, exactly as written; `modules`
 * is the order they are imported in, helpers first and the entry last, which
 * is the order the JavaScript composition concatenates fragments in. The
 * runtime adds its own files around these and never edits one.
 */
export interface PythonProject {
  readonly files: Readonly<Record<string, string>>;
  readonly modules: readonly string[];
}

/**
 * Which threads an engine can run on.
 *
 * `'any'` is today's ZIPP: the same adapter serves the main thread and the
 * script Worker. `'main-only'` is an engine that exists only where the host
 * document does — one built on the document's own JavaScript, say — and forces
 * main-thread execution however a bundle or a harness asked to be run.
 */
export type LogicEngineThreads = 'any' | 'main-only';

/**
 * How a logic engine is made. {@link ZippWasmAdapter} satisfies it as it
 * stands, which is why it is the default and why the default costs nothing.
 */
export interface LogicEngineFactory {
  create(): Promise<LogicEngine>;
  /**
   * Make an engine for a Python app, or be absent because this engine cannot
   * run one.
   *
   * A factory without it is a factory that runs JavaScript and only
   * JavaScript. That is the whole refusal: ZIPP's JavaScript-only build and an
   * engine built on the host document's own JavaScript could do nothing with a
   * `.py` file except read it as JavaScript and fail somewhere confusing, and
   * neither declares this method.
   */
  createPython?(): Promise<LogicEngine>;
  /** Defaults to `'any'` when a factory does not say. */
  readonly threads?: LogicEngineThreads;
}

let engineFactory: LogicEngineFactory = ZippWasmAdapter;
let engineCreated = false;

/**
 * Choose the engine this realm runs `.logic` on, before it runs any.
 *
 * Mirrors `configureZippWasmSource`: module-level, one realm, and frozen the
 * moment the first engine is created, so a bundle already running cannot be
 * moved to a different engine underneath itself. A host configures once, before
 * it renders; not calling it at all leaves ZIPP, which is what every host does
 * today.
 */
export function configureLogicEngine(factory: LogicEngineFactory): void {
  if (engineCreated) {
    throw new Error('The logic engine must be configured before the first engine is created');
  }
  if (!factory || typeof factory.create !== 'function') {
    throw new TypeError('A logic engine factory must have a create() method');
  }
  engineFactory = factory;
}

/** Make an engine with the configured factory, freezing the choice. */
export function createLogicEngine(): Promise<LogicEngine> {
  // Freeze synchronously, including the gap before the factory's first await,
  // for the same reason `ensureZippWasm` does.
  engineCreated = true;
  return engineFactory.create();
}

/**
 * Make an engine for a Python app, or refuse because the configured engine
 * cannot run one.
 *
 * The refusal is by name and it happens before any of the author's source is
 * compiled. An engine that cannot run Python would otherwise be handed `.py`
 * text and read it as JavaScript, and the person would see a syntax error
 * about their own correct code.
 */
export function createPythonLogicEngine(): Promise<LogicEngine> {
  const make = engineFactory.createPython;
  if (typeof make !== 'function') {
    throw new Error('This app’s logic is written in Python, and this app runtime runs only JavaScript');
  }
  engineCreated = true;
  return make.call(engineFactory);
}

/** Whether the configured engine can run a Python app at all. */
export function logicEngineRunsPython(): boolean {
  return typeof engineFactory.createPython === 'function';
}

/** Where the configured engine can run. See {@link LogicEngineThreads}. */
export function logicEngineThreads(): LogicEngineThreads {
  return engineFactory.threads === 'main-only' ? 'main-only' : 'any';
}
