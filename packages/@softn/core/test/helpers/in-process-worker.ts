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

/** Every worker made while a test runs, so the test's end can stop them all. */
const made = new Set<InProcessWorker>();

export class InProcessWorker {
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onerror: ((evt: ErrorEvent) => void) | null = null;
  onmessageerror: ((evt: MessageEvent) => void) | null = null;
  terminated = false;
  constructor() {
    made.add(this);
    workerScope.postMessage = (message: unknown) => {
      // Asked again when the timer fires: a real worker that was terminated delivers nothing more.
      if (!this.terminated) setTimeout(() => { if (!this.terminated) this.onmessage?.({ data: message } as MessageEvent); }, 0);
    };
  }
  postMessage(message: unknown): void {
    if (this.terminated) return;
    // Asked again when the timer fires. A message posted just before terminate() reached the
    // script afterwards; when the test had ended by then, the script's answer went to the page's
    // own postMessage, which threw, and the run failed with every test passing (about one run in
    // three of the live-update tests, which end a worker and start another).
    setTimeout(() => { if (!this.terminated) void workerScope.onmessage?.({ data: message }); }, 0);
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
    for (const worker of made) worker.terminate();
    made.clear();
    vi.unstubAllGlobals();
    // The page's own postMessage is put back for what calls it as a page does (a message and a
    // target origin). A script still finishing a call it was handed before the test ended answers
    // as a worker does, with one argument: that answer has nobody to go to and is dropped.
    workerScope.postMessage = ((...args: unknown[]) => {
      if (args.length >= 2) (realPostMessage as (...rest: unknown[]) => void).apply(self, args);
    }) as typeof workerScope.postMessage;
  }
}
