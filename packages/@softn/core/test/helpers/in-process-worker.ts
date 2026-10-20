/**
 * The script worker, run in this realm. A test that wants a runtime's worker
 * mode wraps itself in `withInProcessWorker`: `new Worker(…)` then makes an
 * InProcessWorker, what the runtime posts is handed to the real worker
 * script's `onmessage`, and what the script posts comes back as the worker's
 * messages. The engine in it is the real one.
 */
import { vi } from 'vitest';

const workerScope = self as unknown as {
  postMessage: (message: unknown) => void;
  onmessage: ((event: { data: unknown }) => unknown) | null;
};

export class InProcessWorker {
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onerror: ((evt: ErrorEvent) => void) | null = null;
  onmessageerror: ((evt: MessageEvent) => void) | null = null;
  terminated = false;
  constructor() {
    workerScope.postMessage = (message: unknown) => {
      if (!this.terminated) setTimeout(() => this.onmessage?.({ data: message } as MessageEvent), 0);
    };
  }
  postMessage(message: unknown): void {
    if (this.terminated) return;
    setTimeout(() => void workerScope.onmessage?.({ data: message }), 0);
  }
  terminate(): void {
    this.terminated = true;
  }
}

/**
 * Run `body` with `Worker` standing for an InProcessWorker and the worker
 * script loaded, then put the page's `Worker` and `postMessage` back.
 */
export async function withInProcessWorker<T>(body: () => Promise<T>): Promise<T> {
  const realPostMessage = workerScope.postMessage;
  vi.stubGlobal('Worker', InProcessWorker);
  await import('../../src/runtime/script-worker');
  try {
    return await body();
  } finally {
    vi.unstubAllGlobals();
    workerScope.postMessage = realPostMessage;
  }
}
