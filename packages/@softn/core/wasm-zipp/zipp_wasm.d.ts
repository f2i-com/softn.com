/* tslint:disable */
/* eslint-disable */

/**
 * A compiled script plus the live VM running it.
 */
export class Engine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Call the top-level function `name`. Microtasks are drained before this
     * returns, so promise callbacks the call scheduled have already run.
     */
    callFunction(name: string, args: any): any;
    /**
     * Deliver `event` to every listener registered for `type`, returning how
     * many ran. The event object is given a no-op `preventDefault` if the host
     * did not supply one, since scripts call it unconditionally.
     */
    dispatchEvent(event_type: string, event: any): number;
    /**
     * Tear the VM down. The engine is unusable afterwards.
     */
    dispose(): void;
    /**
     * Take the `host.call(...)` requests the script queued during the last
     * re-entry, as `[{ id, kind, args }]`.
     */
    drainPendingHostCalls(): any;
    /**
     * Evaluate `expr` in the script's global context and return its value.
     *
     * Each call compiles fresh and installs stable-address definitions, so this
     * is for one-off host queries — never a per-frame path. Use
     * [`Engine::callFunction`] there.
     */
    evalInContext(expr: string): any;
    /**
     * Event types the script has registered listeners for, e.g. `["keydown"]`.
     */
    getEventListenerTypes(): any;
    /**
     * Read the global in `index`. Values that cannot cross as data (functions,
     * classes, `Map`, `Date`, …) read as `null`.
     */
    getGlobalByIndex(index: number): any;
    /**
     * Read many globals in one boundary crossing.
     */
    getGlobalsBatch(indices: any): any;
    /**
     * Fingerprint many globals in one boundary crossing.
     *
     * One number per index: equal numbers mean `getGlobalsBatch` would
     * return an equal value, so a host can skip reading the ones that have not
     * moved. `NaN` means "unknown, read it", which is what a value too large
     * to walk reports — the fallback is always the old always-read behaviour.
     *
     * Digests are 53-bit so they land exactly in a JS number. At that width a
     * collision across a UI's worth of state is not a practical concern, and the
     * cost of one would be a skipped update, not corruption.
     *
     * Built with the same Array and from_f64 that getGlobalsBatch uses, rather
     * than the Float64Array this obviously wants to be. A typed array pulls in
     * `__wbg_new_with_length` and `__wbg_set_index`, and the host import surface
     * is audited: check-wasm-memory.cjs pins the exact set of functions this
     * module may call out to. Widening that list to save an allocation on a
     * path that runs once per frame is a bad trade — the point of pinning it is
     * that it only moves deliberately.
     */
    getGlobalsFingerprint(indices: any): any;
    /**
     * Compile `source` behind the preamble, run its top level, and return the
     * symbol map as `{ name: { index, scope } }`.
     *
     * Bridges should be installed first — a script's top level (and its
     * `_init`) commonly reads `localStorage` or queries `db`.
     */
    initScript(source: string): any;
    constructor();
    /**
     * Run pending microtasks without calling into the script.
     */
    pump(): void;
    /**
     * Restore this engine's instruction budget.
     *
     * The budget is a lifetime total, which bounds a runaway script but also
     * puts a fuse on every long-running embedder: an interactive application
     * is tens of thousands of small calls, and 50M instructions is minutes of
     * ordinary use. Call this BEFORE a re-entry and the bound becomes
     * per-re-entry instead — no single call can run unbounded, which is the
     * property a browser host actually needs, while the application lives as
     * long as its host keeps calling it.
     *
     * Host-only, and that is the whole design: this is a method on the Engine
     * binding, unreachable from guest code, so a guest still cannot raise its
     * own ceiling. Returns false once a budget has actually been spent —
     * exhaustion stays sticky and a torn-down engine stays torn down.
     */
    renewInstructionBudget(): boolean;
    /**
     * Invoke the callback the script passed to `host.call` for `call_id`.
     */
    resolveHostCallback(call_id: number, result: any): void;
    /**
     * Install the object backing `navigator.clipboard.*`. Clipboard authority
     * is intentionally separate from local storage authority.
     */
    setClipboardBridge(bridge: any): void;
    /**
     * Install the object backing `db.*`. Its methods are called synchronously
     * from inside VM execution, so they must not await. Installing a bridge
     * does not grant any operation; call `setSyncHostCapabilities` separately.
     */
    setDbBridge(bridge: any): void;
    /**
     * Key this engine's global fingerprints with host randomness.
     *
     * Supply two halves of a 64-bit value from a real random source. The
     * digest mixer is invertible, so an unkeyed digest can be SOLVED for a
     * collision — a host skipping reads on matching digests would mirror
     * stale state while the guest moved on. The key is never exposed to guest
     * code and never needs to be stable, since digests are only compared with
     * earlier digests from the same engine.
     */
    setFingerprintSeed(lo: number, hi: number): void;
    /**
     * Write the global in `index`. A slot currently holding a function or
     * class is left alone, so a host that reads all globals and writes them
     * back cannot destroy the script's own functions.
     */
    setGlobalByIndex(index: number, value: any): void;
    /**
     * Write many globals in one boundary crossing.
     */
    setGlobalsBatch(indices: any, values: any): void;
    /**
     * Install the object backing `localStorage.*`. This never provides the
     * clipboard bridge, even when the object happens to have clipboard-like
     * methods.
     */
    setLocalStorageBridge(bridge: any): void;
    /**
     * Replace the exact allowlist for synchronous guest-to-host operations.
     * The list is fixed before initialization so guest execution cannot race
     * or influence a later authority upgrade. Unknown operation names reject
     * the complete update rather than being silently ignored.
     */
    setSyncHostCapabilities(operations: any): void;
    /**
     * Drain `console.log`/`info`/`debug` output produced so far.
     */
    takeOutput(): any;
    /**
     * Lines the preamble prepends to the host's source.
     */
    readonly preambleLines: number;
}

/**
 * Route Rust panics to `console.error` with a message instead of a bare
 * `unreachable` trap — without this a panic in wasm is undiagnosable.
 */
export function zipp_install_panic_hook(): void;

/**
 * Runs when the module is instantiated, before the host can call anything
 * else. The clock install is not optional: wasm32 has no clock, and `Vm::new`
 * reads one, so a VM constructed before this ran would trap.
 */
export function zipp_start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_engine_free: (a: number, b: number) => void;
    readonly engine_callFunction: (a: number, b: number, c: number, d: any) => [number, number, number];
    readonly engine_dispatchEvent: (a: number, b: number, c: number, d: any) => [number, number, number];
    readonly engine_dispose: (a: number) => void;
    readonly engine_drainPendingHostCalls: (a: number) => [number, number, number];
    readonly engine_evalInContext: (a: number, b: number, c: number) => [number, number, number];
    readonly engine_getEventListenerTypes: (a: number) => [number, number, number];
    readonly engine_getGlobalByIndex: (a: number, b: number) => [number, number, number];
    readonly engine_getGlobalsBatch: (a: number, b: any) => [number, number, number];
    readonly engine_getGlobalsFingerprint: (a: number, b: any) => [number, number, number];
    readonly engine_initScript: (a: number, b: number, c: number) => [number, number, number];
    readonly engine_new: () => number;
    readonly engine_preambleLines: (a: number) => number;
    readonly engine_pump: (a: number) => [number, number];
    readonly engine_renewInstructionBudget: (a: number) => number;
    readonly engine_resolveHostCallback: (a: number, b: number, c: any) => [number, number];
    readonly engine_setClipboardBridge: (a: number, b: any) => [number, number];
    readonly engine_setDbBridge: (a: number, b: any) => [number, number];
    readonly engine_setFingerprintSeed: (a: number, b: number, c: number) => void;
    readonly engine_setGlobalByIndex: (a: number, b: number, c: any) => [number, number];
    readonly engine_setGlobalsBatch: (a: number, b: any, c: any) => [number, number];
    readonly engine_setLocalStorageBridge: (a: number, b: any) => [number, number];
    readonly engine_setSyncHostCapabilities: (a: number, b: any) => [number, number];
    readonly engine_takeOutput: (a: number) => [number, number, number];
    readonly zipp_install_panic_hook: () => void;
    readonly zipp_start: () => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
