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
 *
 * A deadline answers the caller, not the slot. The parent (FormLogic's
 * HostedAppFrame) holds four calls at a time with no deadline of its own and
 * refuses a fifth, so a call it has not answered still takes one of its
 * four: freed at the deadline, the slot went to the next call, which the
 * parent refused, and so did every call after a slow one until the parent
 * caught up, storage writes among them. The slot is freed when the parent
 * answers that id, or when the port fails. A call still waiting for a slot
 * when its deadline comes, the slots all held, answers then and leaves the
 * line. Ordinary calls keep separate waiting and sent clocks: a call given
 * a slot just before its waiting deadline gets the full sent deadline.
 * Storage calls opt into one absolute admission deadline through lifecycle.
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
  /** Deadline for an answer, counted from the moment the call is sent, and for a slot while it waits. */
  timeoutMs?: number;
}

export interface BackendQueue {
  /** Resolves with the parent's result, or `{error}` when refused, timed out or unreadable. Never rejects. */
  call(action: string, input: Record<string, unknown>, lifecycle?: BackendCallLifecycle): Promise<unknown>;
  /**
   * A `{id, result}` message from the port. Frees that call's slot; returns
   * false when no caller waits on that id (none was sent, or its caller was
   * answered at the deadline).
   */
  settle(id: unknown, result: unknown): boolean;
  /** Every slot is freed and every caller still waiting on one answers `{error: reason}`; returns how many did. */
  failInFlight(reason: string): number;
  /** Terminal port/frame disposal. Waiting calls are cancelled, never dispatched. */
  dispose(reason: string): void;
  /** Calls the parent holds: sent and not answered by it, including any whose caller has had its deadline. */
  readonly inFlight: number;
  readonly waiting: number;
}

/** Optional storage lifecycle; ordinary calls retain their existing timing and replies. */
export interface BackendCallLifecycle {
  deadlineAt: number;
  signal?: AbortSignal;
  onDispatch?: () => void;
  /** Observe the matched reply before a later terminal event can dispose its caller. */
  onReply?: (result: unknown) => void;
  onLateReply?: (result: unknown) => void;
}

export const BACKEND_BUSY = 'The backend is busy: too many requests are waiting. Try again in a moment.';
export const BACKEND_TIMEOUT = 'The backend request timed out.';
export const BACKEND_UNREADABLE = 'The backend reply could not be read.';
export const BACKEND_INVALID = 'Invalid backend request.';

/** An action's name as the parent takes it (HostedAppFrame), and as the script runtime checks it before it calls. */
const ACTION = /^[a-z][a-zA-Z0-9_-]{0,63}$/;

interface Waiting { action: string; input: Record<string, unknown>; resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout>; lifecycle?: BackendCallLifecycle; detach?: () => void }
/** A call the parent holds. `resolve` is gone once its caller has been answered at the deadline. */
interface Sent { resolve?: (value: unknown) => void; timer: ReturnType<typeof setTimeout>; lifecycle?: BackendCallLifecycle; detach?: () => void }

export function createBackendQueue(options: BackendQueueOptions): BackendQueue {
  const maxInFlight = options.maxInFlight ?? 4;
  const maxQueued = options.maxQueued ?? 32;
  const timeoutMs = options.timeoutMs ?? 20000;
  let sequence = 0;
  const sent = new Map<number, Sent>();
  const waiting: Waiting[] = [];
  let disposed = false;
  const refused = (reason: string, lifecycle?: BackendCallLifecycle, sent = false) => lifecycle
    ? { error: reason, outcome: sent ? 'unknown' : 'unsent' } : { error: reason };
  const observe = (callback: ((result: unknown) => void) | undefined, result: unknown) => {
    try { callback?.(result); } catch { /* Observers cannot strand callers or slots. */ }
  };

  function dispatch(): void {
    while (!disposed && sent.size < maxInFlight && waiting.length > 0) {
      const next = waiting.shift() as Waiting;
      clearTimeout(next.timer);
      if (next.lifecycle && (next.lifecycle.signal?.aborted || next.lifecycle.deadlineAt <= Date.now())) {
        next.detach?.();
        next.resolve(refused(BACKEND_TIMEOUT, next.lifecycle));
        continue;
      }
      const id = ++sequence;
      const timer = setTimeout(() => {
        const item = sent.get(id);
        if (!item?.resolve) return;
        // The caller is answered; the slot stays the parent's until it answers.
        item.resolve(refused(BACKEND_TIMEOUT, item.lifecycle, true));
        item.resolve = undefined;
      }, next.lifecycle ? Math.max(0, next.lifecycle.deadlineAt - Date.now()) : timeoutMs);
      // Move cancellation from the waiting entry to this sent slot. A sent
      // cancellation answers unknown, but cannot release the parent's slot.
      next.detach?.();
      const item: Sent = { resolve: next.resolve, timer, lifecycle: next.lifecycle };
      const abort = () => {
        if (!item.resolve) return;
        clearTimeout(item.timer);
        item.resolve(refused(BACKEND_TIMEOUT, item.lifecycle, true));
        item.resolve = undefined;
      };
      next.lifecycle?.signal?.addEventListener('abort', abort, { once: true });
      item.detach = () => next.lifecycle?.signal?.removeEventListener('abort', abort);
      sent.set(id, item);
      try {
        next.lifecycle?.onDispatch?.();
        options.post({ type: 'call', id, action: next.action, input: next.input });
      } catch (error) {
        // A port that will not take the message (closed, or an input it
        // cannot clone) answers the caller now rather than at the deadline.
        clearTimeout(timer);
        sent.delete(id);
        item.detach?.();
        next.resolve(refused(error instanceof Error && error.message ? error.message : BACKEND_UNREADABLE, next.lifecycle));
      }
    }
  }

  return {
    call(action, input, lifecycle) {
      // Refuse malformed actions before they can occupy a parent-owned slot.
      if (typeof action !== 'string' || !ACTION.test(action)) return Promise.resolve(refused(BACKEND_INVALID, lifecycle));
      if (disposed) return Promise.resolve(refused(BACKEND_UNREADABLE, lifecycle));
      if (lifecycle && (lifecycle.signal?.aborted || lifecycle.deadlineAt <= Date.now())) return Promise.resolve(refused(BACKEND_TIMEOUT, lifecycle));
      if (waiting.length >= maxQueued) return Promise.resolve(refused(BACKEND_BUSY, lifecycle));
      return new Promise(resolve => {
        const entry: Waiting = {
          action,
          input,
          resolve,
          lifecycle,
          timer: setTimeout(() => {
            const index = waiting.indexOf(entry);
            if (index < 0) return;
            waiting.splice(index, 1);
            entry.detach?.();
            resolve(refused(BACKEND_TIMEOUT, lifecycle));
          }, lifecycle ? Math.max(0, lifecycle.deadlineAt - Date.now()) : timeoutMs),
        };
        const abort = () => {
          const index = waiting.indexOf(entry);
          if (index < 0) return;
          waiting.splice(index, 1);
          clearTimeout(entry.timer);
          entry.detach?.();
          resolve(refused(BACKEND_TIMEOUT, lifecycle));
        };
        lifecycle?.signal?.addEventListener('abort', abort, { once: true });
        entry.detach = () => lifecycle?.signal?.removeEventListener('abort', abort);
        waiting.push(entry);
        dispatch();
      });
    },
    settle(id, result) {
      if (typeof id !== 'number') return false;
      const item = sent.get(id);
      if (!item) return false;
      clearTimeout(item.timer);
      item.detach?.();
      sent.delete(id);
      if (item.resolve) observe(item.lifecycle?.onReply, result);
      item.resolve?.(result);
      if (!item.resolve) observe(item.lifecycle?.onLateReply, result);
      dispatch();
      return item.resolve !== undefined;
    },
    failInFlight(reason) {
      const failed = [...sent.values()];
      sent.clear();
      let answered = 0;
      for (const item of failed) {
        clearTimeout(item.timer);
        item.detach?.();
        if (!item.resolve) continue;
        item.resolve(refused(reason, item.lifecycle, true));
        answered++;
      }
      dispatch();
      return answered;
    },
    dispose(reason) {
      disposed = true;
      for (const item of waiting.splice(0)) {
        clearTimeout(item.timer); item.detach?.();
        item.resolve(refused(reason, item.lifecycle));
      }
      for (const item of sent.values()) {
        clearTimeout(item.timer); item.detach?.();
        item.resolve?.(refused(reason, item.lifecycle, true));
      }
      sent.clear();
    },
    get inFlight() { return sent.size; },
    get waiting() { return waiting.length; },
  };
}
