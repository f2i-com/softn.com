/**
 * The WebAssembly worker as a browser starts it, on a Node thread: the same
 * source text (`wasmWorkerSource()`), its `self` a few lines over
 * worker_threads. A real thread, so a module that never stops can be
 * stopped, as the host does it, by terminating the worker.
 */

import { Worker } from 'node:worker_threads';
import { wasmWorkerSource, type WasmWorkerLike } from '../../src/runtime/wasm/wasm-host';

/** `heapMB` limits the thread's JavaScript heap, as a browser's worker is limited: past it the thread is stopped. */
export function nodeWasmWorker(heapMB?: number): WasmWorkerLike {
  const code = `
    const { parentPort } = require('node:worker_threads');
    let listener = null;
    const self = {
      postMessage: (message, transfer) => parentPort.postMessage(message, transfer),
      set onmessage(fn) {
        if (listener) parentPort.off('message', listener);
        listener = fn ? (data) => fn({ data }) : null;
        if (listener) parentPort.on('message', listener);
      },
    };
    ${wasmWorkerSource()}
  `;
  const worker = new Worker(code, { eval: true, ...(heapMB ? { resourceLimits: { maxOldGenerationSizeMb: heapMB } } : {}) });
  const like: WasmWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (message, transfer) => worker.postMessage(message, (transfer ?? []) as never),
    terminate: () => {
      void worker.terminate();
    },
  };
  worker.on('message', (data) => like.onmessage?.({ data }));
  worker.on('error', (error: Error) => like.onerror?.({ message: error.message }));
  return like;
}

/** Every worker a test made, so it can terminate those still running. */
export function trackedWorkers(heapMB?: number): { factory: () => WasmWorkerLike; made: WasmWorkerLike[] } {
  const made: WasmWorkerLike[] = [];
  return {
    made,
    factory: () => {
      const worker = nodeWasmWorker(heapMB);
      made.push(worker);
      return worker;
    },
  };
}
