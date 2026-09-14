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
 */

export { ZippWasmAdapter as VmAdapter, ZIPP_BRIDGE_PREAMBLE as VM_BRIDGE_PREAMBLE } from './zipp-wasm-adapter';
export type { SymbolScope, SymbolInfo } from './zipp-wasm-adapter';

import { ZippWasmAdapter } from './zipp-wasm-adapter';

/** The concrete adapter type, for callers that need to name it. */
export type VmAdapterInstance = ZippWasmAdapter;
