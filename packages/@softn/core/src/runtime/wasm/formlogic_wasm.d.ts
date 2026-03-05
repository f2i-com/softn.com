/* tslint:disable */
/* eslint-disable */

export class WasmFormLogicEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Call a named function with JS array arguments. Returns the result as a JS value.
     */
    callFunction(name: string, args: any): any;
    /**
     * Clear all dirty bits. Call after syncing VM state to React.
     */
    clearDirty(): void;
    /**
     * Dispatch an event to all registered handlers for the given event type.
     * `event_type` is e.g. "keydown". `event_obj` is a JS object that will be
     * passed as the first argument to each handler (converted to a VM Hash).
     * Returns the number of handlers invoked.
     */
    dispatchEvent(event_type: string, event_obj: any): number;
    /**
     * Drain all pending host calls queued by `host.call()` during VM execution.
     * Returns a JS array of `{ id: number, kind: string, args: string[] }`.
     */
    drainPendingHostCalls(): any;
    eval(source: string): any;
    /**
     * Evaluate an expression in the script's global context.
     * The expression has access to all script variables and functions.
     */
    evalInContext(expr: string): any;
    evalInspect(source: string): string;
    /**
     * Given an array of global slot indices, return an array of only those
     * that have been written since the last `clearDirty()` call.
     * Used by the JS runtime to skip deepEqual on unchanged state variables.
     */
    getDirtyGlobals(indices: any): any;
    /**
     * Return an array of event type strings that have registered listeners.
     * E.g. ["keydown", "keyup", "blur"]
     */
    getEventListenerTypes(): any;
    /**
     * Get a global variable by its slot index. Returns a JS value.
     */
    getGlobalByIndex(index: number): any;
    /**
     * Get multiple globals at once, returning a JS array of values.
     * `indices` is a JS array of u32 slot indices.
     * Returns a JS array of the same length with the corresponding values.
     */
    getGlobalsBatch(indices: any): any;
    /**
     * Get the symbol map as a JS object.
     */
    getSymbolMap(): any;
    /**
     * Compile, set up bridges, and run the script.
     * Returns the symbol map as a JS object: { name: { index, scope } }.
     */
    initScript(source: string): any;
    constructor();
    /**
     * Resolve a pending host callback by its call ID. The `result` JsValue is
     * converted to a VM Object and passed to the stored callback function.
     */
    resolveHostCallback(call_id: number, result: any): void;
    /**
     * Store a JS database bridge object for later use during init_script.
     */
    setDbBridge(bridge: any): void;
    /**
     * Set a global variable by its slot index.
     * Non-serializable types cannot survive a JS round-trip (object_to_jsvalue
     * converts them to JsValue::NULL), so we skip the write to preserve the VM value.
     */
    setGlobalByIndex(index: number, value: any): void;
    /**
     * Set multiple globals at once.
     * `indices` is a JS array of u32 slot indices.
     * `values` is a JS array of the same length with corresponding values.
     * Non-serializable types (Class, CompiledFunction, BoundMethod, BuiltinFunction)
     * are protected from overwrite, same as setGlobalByIndex.
     */
    setGlobalsBatch(indices: any, values: any): void;
    /**
     * Store a JS localStorage bridge object for later use during init_script.
     */
    setLocalStorageBridge(bridge: any): void;
}

/**
 * Detect host bridge usage in .logic source code using the Rust lexer.
 * Returns a JS array of reason strings (e.g. ["uses db bridge", "uses window bridge"]).
 * Uses proper lexical analysis instead of brittle regex, correctly handling
 * comments, string literals, template literals, and regex literals.
 */
export function detectHostBridges(source: string): any;

/**
 * Install panic hook so panics are logged to the browser console with stack traces.
 */
export function init_panic_hook(): void;

export function wasm_engine_info(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmformlogicengine_free: (a: number, b: number) => void;
    readonly detectHostBridges: (a: number, b: number) => number;
    readonly wasm_engine_info: (a: number) => void;
    readonly wasmformlogicengine_callFunction: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasmformlogicengine_clearDirty: (a: number) => void;
    readonly wasmformlogicengine_dispatchEvent: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasmformlogicengine_drainPendingHostCalls: (a: number) => number;
    readonly wasmformlogicengine_eval: (a: number, b: number, c: number, d: number) => void;
    readonly wasmformlogicengine_evalInContext: (a: number, b: number, c: number, d: number) => void;
    readonly wasmformlogicengine_evalInspect: (a: number, b: number, c: number, d: number) => void;
    readonly wasmformlogicengine_getDirtyGlobals: (a: number, b: number) => number;
    readonly wasmformlogicengine_getEventListenerTypes: (a: number) => number;
    readonly wasmformlogicengine_getGlobalByIndex: (a: number, b: number) => number;
    readonly wasmformlogicengine_getGlobalsBatch: (a: number, b: number) => number;
    readonly wasmformlogicengine_getSymbolMap: (a: number) => number;
    readonly wasmformlogicengine_initScript: (a: number, b: number, c: number, d: number) => void;
    readonly wasmformlogicengine_new: () => number;
    readonly wasmformlogicengine_resolveHostCallback: (a: number, b: number, c: number, d: number) => void;
    readonly wasmformlogicengine_setDbBridge: (a: number, b: number) => void;
    readonly wasmformlogicengine_setGlobalByIndex: (a: number, b: number, c: number) => void;
    readonly wasmformlogicengine_setGlobalsBatch: (a: number, b: number, c: number) => void;
    readonly wasmformlogicengine_setLocalStorageBridge: (a: number, b: number) => void;
    readonly init_panic_hook: () => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
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
