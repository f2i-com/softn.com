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
  }
  self.postMessage(msg, transfer);
});

self.addEventListener('message', (event: MessageEvent<HostToBackendMsg>) => {
  void session.handleMessage(event.data);
});
