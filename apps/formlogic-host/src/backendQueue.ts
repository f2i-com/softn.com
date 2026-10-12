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
 * line. The two clocks are separate: a call that gets its slot just before
 * that deadline is given the whole of the next one for its answer, so a
 * caller hears back within two deadlines of calling, not one.
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
  call(action: string, input: Record<string, unknown>): Promise<unknown>;
  /**
   * A `{id, result}` message from the port. Frees that call's slot; returns
   * false when no caller waits on that id (none was sent, or its caller was
   * answered at the deadline).
   */
  settle(id: unknown, result: unknown): boolean;
  /** Every slot is freed and every caller still waiting on one answers `{error: reason}`; returns how many did. */
  failInFlight(reason: string): number;
  /** Calls the parent holds: sent and not answered by it, including any whose caller has had its deadline. */
  readonly inFlight: number;
  readonly waiting: number;
}

export const BACKEND_BUSY = 'The backend is busy: too many requests are waiting. Try again in a moment.';
export const BACKEND_TIMEOUT = 'The backend request timed out.';
export const BACKEND_UNREADABLE = 'The backend reply could not be read.';
export const BACKEND_INVALID = 'Invalid backend request.';

/** An action's name as the parent takes it (HostedAppFrame), and as the script runtime checks it before it calls. */
const ACTION = /^[a-z][a-zA-Z0-9_-]{0,63}$/;

interface Waiting { action: string; input: Record<string, unknown>; resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }
/** A call the parent holds. `resolve` is gone once its caller has been answered at the deadline. */
interface Sent { resolve?: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }

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
      clearTimeout(next.timer);
      const id = ++sequence;
      const timer = setTimeout(() => {
        const item = sent.get(id);
        if (!item?.resolve) return;
        // The caller is answered; the slot stays the parent's until it answers.
        item.resolve({ error: BACKEND_TIMEOUT });
        item.resolve = undefined;
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
      // The one message the parent leaves unanswered is a call it cannot read
      // as one: an action that is not text of the shape it takes. Unanswered,
      // it would hold its slot for good, and four of them every slot.
      if (typeof action !== 'string' || !ACTION.test(action)) return Promise.resolve({ error: BACKEND_INVALID });
      if (waiting.length >= maxQueued) return Promise.resolve({ error: BACKEND_BUSY });
      return new Promise(resolve => {
        const entry: Waiting = {
          action,
          input,
          resolve,
          timer: setTimeout(() => {
            const index = waiting.indexOf(entry);
            if (index < 0) return;
            waiting.splice(index, 1);
            resolve({ error: BACKEND_TIMEOUT });
          }, timeoutMs),
        };
        waiting.push(entry);
        dispatch();
      });
    },
    settle(id, result) {
      if (typeof id !== 'number') return false;
      const item = sent.get(id);
      if (!item) return false;
      clearTimeout(item.timer);
      sent.delete(id);
      item.resolve?.(result);
      dispatch();
      return item.resolve !== undefined;
    },
    failInFlight(reason) {
      const failed = [...sent.values()];
      sent.clear();
      let answered = 0;
      for (const item of failed) {
        clearTimeout(item.timer);
        if (!item.resolve) continue;
        item.resolve({ error: reason });
        answered++;
      }
      dispatch();
      return answered;
    },
    get inFlight() { return sent.size; },
    get waiting() { return waiting.length; },
  };
}
