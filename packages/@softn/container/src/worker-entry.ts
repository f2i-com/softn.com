/**
 * Dedicated Web Worker Entry (`/runtime/container-worker.js`).
 */

import { ContainerWorkerSession } from './worker-runtime';
import type { HostToWorkerMsg, WorkerToHostMsg } from './types';

const session = new ContainerWorkerSession((msg: WorkerToHostMsg, transfer?: Transferable[]) => {
  if (transfer && transfer.length > 0) self.postMessage(msg, transfer);
  else self.postMessage(msg);
});

self.addEventListener('message', (event: MessageEvent<HostToWorkerMsg>) => {
  void session.handleMessage(event.data);
});
