/**
 * What `<WasmApp>` (@softn/components) runs a program with, from core's
 * start-up code: a function that fetches the WebAssembly host when the first
 * program starts. Only types are imported here, so the host and its worker
 * are a chunk of their own that a page without a program never fetches.
 */

import type { WasmProgram, WasmProgramOptions } from './wasm-host';

export type { WasmProgram, WasmProgramOptions, WasmExportInfo, WasmFile, WasmCallOptions, WasmArg } from './wasm-host';
export type { WasmInputEvent } from './wasm-worker';

/** Starts a program that draws, as wasm-host.ts's `startWasmProgram` does. */
export async function startWasmProgram(options: WasmProgramOptions): Promise<WasmProgram> {
  const host = await import('./wasm-host');
  return host.startWasmProgram(options);
}

/** Fetches the WebAssembly host ahead of its first use: an app installed for offline use that runs modules. */
export async function preloadWasmRuntime(): Promise<void> {
  await import('./wasm-host');
}
