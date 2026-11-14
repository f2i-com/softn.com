/**
 * A WebAssembly program run on top of the app (<WasmApp>). The component is
 * small; the host that runs a program, and its worker, are core's own chunk,
 * fetched when the first program starts (`preloadWasmApp` fetches it ahead,
 * for an app installed for offline use).
 */
export * from '../utility/WasmApp';

import { preloadWasmRuntime } from '@softn/core';
import { WasmApp } from '../utility/WasmApp';

export const wasmComponents = { WasmApp };

/** Fetches what a <WasmApp> starts its program with, ahead of its first use. */
export function preloadWasmApp(): Promise<void> {
  return preloadWasmRuntime();
}
