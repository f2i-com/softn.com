/**
 * Dedicated Web Worker Entry (`/runtime/container-worker.js`).
 */

import { ContainerWorkerSession } from './worker-runtime';
import type { HostToWorkerMsg, WorkerToHostMsg } from './types';

const session = new ContainerWorkerSession((msg: WorkerToHostMsg, transfer?: Transferable[]) => {
  const post = self.postMessage as unknown as (message: unknown, transfer?: Transferable[]) => void;
  if (transfer && transfer.length > 0) post(msg, transfer);
  else post(msg);
});

self.addEventListener('message', (event: MessageEvent<HostToWorkerMsg>) => {
  void session.handleMessage(event.data);
});
