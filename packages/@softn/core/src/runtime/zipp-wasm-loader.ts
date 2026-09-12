import initWasm, { zipp_install_panic_hook, type InitOutput } from '../../wasm-zipp/zipp_wasm.js';
import { retryableSingleFlight } from './retryable-single-flight';

let suppliedSource: BufferSource | WebAssembly.Module | undefined;
let initializationStarted = false;

/**
 * Supply trusted engine bytes or compiled code before this realm starts ZIPP.
 * A host can fetch once and clone the bytes into separate workers/frames; each
 * realm still creates its own WASM instance, memory and guest engines.
 * Byte sources are copied so later caller mutations cannot change the engine.
 */
export function configureZippWasmSource(source: BufferSource | WebAssembly.Module): void {
  if (initializationStarted) {
    throw new Error('The ZIPP engine source must be configured before initialization starts');
  }
  if (source instanceof WebAssembly.Module) {
    suppliedSource = source;
    return;
  }
  const bytes = source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : null;
  if (!bytes || bytes.byteLength < 8) {
    throw new TypeError('The ZIPP engine source must be a WASM module or engine bytes');
  }
  suppliedSource = bytes.slice();
}

/** A copy for a new worker; never expose this realm's mutable engine memory. */
export function getConfiguredZippWasmSource(): BufferSource | WebAssembly.Module | undefined {
  if (suppliedSource === undefined || suppliedSource instanceof WebAssembly.Module) {
    return suppliedSource;
  }
  return suppliedSource instanceof ArrayBuffer
    ? suppliedSource.slice(0)
    : new Uint8Array(suppliedSource.buffer, suppliedSource.byteOffset, suppliedSource.byteLength).slice();
}

const initialize = retryableSingleFlight<InitOutput>(async () => {
  const exports = suppliedSource === undefined
    ? await initWasm()
    : await initWasm({ module_or_path: suppliedSource });
  zipp_install_panic_hook();
  return exports;
});

/** One retryable initialization per JS realm, shared by its runtime consumers. */
export function ensureZippWasm(): Promise<InitOutput> {
  // Freeze synchronously, including the gap before the single-flight microtask.
  // A failed load can retry, but cannot silently switch the configured engine.
  initializationStarted = true;
  return initialize();
}
