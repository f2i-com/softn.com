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
 * To go back to the FormLogic VM, swap the two re-exports for:
 *
 *   export { WasmFormLogicAdapter as VmAdapter } from './formlogic-wasm-adapter';
 *   export { WASM_BRIDGE_PREAMBLE as VM_BRIDGE_PREAMBLE } from './formlogic-wasm-adapter';
 *
 * The preamble travels with the adapter deliberately: what has to be prepended
 * to a script is a property of the engine, not of the runtime. zipp declares
 * `window`/`navigator`/`db`/`localStorage`/`host` itself and rejects a script
 * that redeclares them, so its preamble is empty while FormLogic's is not.
 */

export { ZippWasmAdapter as VmAdapter, ZIPP_BRIDGE_PREAMBLE as VM_BRIDGE_PREAMBLE } from './zipp-wasm-adapter';
export type { SymbolScope, SymbolInfo } from './zipp-wasm-adapter';

import { ZippWasmAdapter } from './zipp-wasm-adapter';

/** The concrete adapter type, for callers that need to name it. */
export type VmAdapterInstance = ZippWasmAdapter;
