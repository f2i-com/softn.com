/**
 * Dedicated Backend Web Worker Entry (`/runtime/backend-worker.js`).
 */

import { BackendWorkerSession, type BackendToHostMsg, type HostToBackendMsg } from './backend-runtime';

const session = new BackendWorkerSession((msg: BackendToHostMsg) => {
  self.postMessage(msg);
});

self.addEventListener('message', (event: MessageEvent<HostToBackendMsg>) => {
  void session.handleMessage(event.data);
});
