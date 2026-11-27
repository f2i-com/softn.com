/**
 * Dedicated Backend Web Worker Entry (`/runtime/backend-worker.js`).
 */

import { BackendWorkerSession, type BackendToHostMsg, type HostToBackendMsg } from './backend-runtime';

const session = new BackendWorkerSession((msg: BackendToHostMsg) => {
  const transfer: Transferable[] = [];
  if (
    msg.type === 'response' &&
    msg.bodyBytes instanceof Uint8Array &&
    msg.bodyBytes.buffer instanceof ArrayBuffer &&
    msg.bodyBytes.byteOffset === 0 &&
    msg.bodyBytes.byteLength === msg.bodyBytes.buffer.byteLength
  ) {
    transfer.push(msg.bodyBytes.buffer);
  } else if (
    msg.type === 'sqlite-persist' &&
    msg.bytes instanceof Uint8Array &&
    msg.bytes.buffer instanceof ArrayBuffer &&
    msg.bytes.byteOffset === 0 &&
    msg.bytes.byteLength === msg.bytes.buffer.byteLength
  ) {
    transfer.push(msg.bytes.buffer);
  } else if (msg.type === 'rpc-reply' && msg.ok && msg.result) {
    const res = msg.result as unknown;
    if (
      res instanceof Uint8Array &&
      res.buffer instanceof ArrayBuffer &&
      res.byteOffset === 0 &&
      res.byteLength === res.buffer.byteLength
    ) {
      transfer.push(res.buffer);
    } else if (
      typeof res === 'object' &&
      res !== null &&
      (res as { bytes?: unknown }).bytes instanceof Uint8Array
    ) {
      const b = (res as { bytes: Uint8Array }).bytes;
      if (b.buffer instanceof ArrayBuffer && b.byteOffset === 0 && b.byteLength === b.buffer.byteLength) {
        transfer.push(b.buffer);
      }
    }
  }
  (self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void }).postMessage(msg, transfer);
});

self.addEventListener('message', (event: MessageEvent<HostToBackendMsg>) => {
  void session.handleMessage(event.data);
});
