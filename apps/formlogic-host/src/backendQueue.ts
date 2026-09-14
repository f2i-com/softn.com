/**
 * Backend calls from the hosted app to the trusted parent, over the port the
 * parent transferred in `formlogic:init`.
 *
 * A few calls run at once; the rest wait in a bounded queue and go out as
 * slots free, so a dashboard that fires five widgets' calls together sees
 * five answers, not four and a "please wait". Each call, once sent, has its
 * own deadline. The wire protocol is unchanged: `{type:'call', id, action,
 * input}` out, `{id, result}` back, and a result the port could not clone
 * (`messageerror`) fails what is in flight instead of waiting out the clock.
 */
export interface BackendCallMessage {
  type: 'call';
  id: number;
  action: string;
  input: Record<string, unknown>;
}

export interface BackendQueueOptions {
  /** Sends one call to the parent; the queue never sends more than `maxInFlight` unanswered. */
  post: (message: BackendCallMessage) => void;
  /** Calls the parent may hold at once. */
  maxInFlight?: number;
  /** Calls that may wait for a slot before the queue refuses new ones. */
  maxQueued?: number;
  /** Deadline for an answer, counted from the moment the call is sent. */
  timeoutMs?: number;
}

export interface BackendQueue {
  /** Resolves with the parent's result, or `{error}` when refused, timed out or unreadable. Never rejects. */
  call(action: string, input: Record<string, unknown>): Promise<unknown>;
  /** A `{id, result}` message from the port; returns false when nothing waits on that id. */
  settle(id: unknown, result: unknown): boolean;
  /** Every call in flight answers `{error: reason}`; what waits in the queue is sent next. */
  failInFlight(reason: string): number;
  readonly inFlight: number;
  readonly waiting: number;
}

export const BACKEND_BUSY = 'The backend is busy: too many requests are waiting. Try again in a moment.';
export const BACKEND_TIMEOUT = 'The backend request timed out.';
export const BACKEND_UNREADABLE = 'The backend reply could not be read.';

interface Waiting { action: string; input: Record<string, unknown>; resolve: (value: unknown) => void }
interface Sent { resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }

export function createBackendQueue(options: BackendQueueOptions): BackendQueue {
  const maxInFlight = options.maxInFlight ?? 4;
  const maxQueued = options.maxQueued ?? 32;
  const timeoutMs = options.timeoutMs ?? 20000;
  let sequence = 0;
  const sent = new Map<number, Sent>();
  const waiting: Waiting[] = [];

  function dispatch(): void {
    while (sent.size < maxInFlight && waiting.length > 0) {
      const next = waiting.shift() as Waiting;
      const id = ++sequence;
      const timer = setTimeout(() => {
        if (!sent.delete(id)) return;
        next.resolve({ error: BACKEND_TIMEOUT });
        dispatch();
      }, timeoutMs);
      sent.set(id, { resolve: next.resolve, timer });
      try {
        options.post({ type: 'call', id, action: next.action, input: next.input });
      } catch (error) {
        // A port that will not take the message (closed, or an input it
        // cannot clone) answers the caller now rather than at the deadline.
        clearTimeout(timer);
        sent.delete(id);
        next.resolve({ error: error instanceof Error && error.message ? error.message : BACKEND_UNREADABLE });
      }
    }
  }

  return {
    call(action, input) {
      if (waiting.length >= maxQueued) return Promise.resolve({ error: BACKEND_BUSY });
      return new Promise(resolve => {
        waiting.push({ action, input, resolve });
        dispatch();
      });
    },
    settle(id, result) {
      if (typeof id !== 'number') return false;
      const item = sent.get(id);
      if (!item) return false;
      clearTimeout(item.timer);
      sent.delete(id);
      item.resolve(result);
      dispatch();
      return true;
    },
    failInFlight(reason) {
      const failed = [...sent.entries()];
      sent.clear();
      for (const [, item] of failed) {
        clearTimeout(item.timer);
        item.resolve({ error: reason });
      }
      dispatch();
      return failed.length;
    },
    get inFlight() { return sent.size; },
    get waiting() { return waiting.length; },
  };
}
