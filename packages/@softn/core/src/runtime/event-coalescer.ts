/**
 * Delivery of the events a browser fires faster than a script can use.
 *
 * Pointer movement, scrolling, resizing and the wheel all arrive several times
 * a frame, and each delivery is a serialisation and a trip across the WASM
 * bridge, so the runtimes hand them to a script at most once a frame. The
 * throttle they used to do it with could run time backwards: when an event
 * arrived inside the 16 ms window it was parked in a requestAnimationFrame,
 * and when the next one arrived after the window it was delivered at once —
 * so the parked, older event landed on the script *after* the newer one, and
 * a cursor that had stopped moving was reported a few pixels back from where
 * it had stopped. The same throttle also treated a wheel notch as a position
 * sample: two notches in one frame delivered one of them and dropped the
 * other, so a zoom or a scroll went half as far as the hand had moved.
 *
 * Two policies, chosen by event type, and one ordering rule:
 *
 * - `latest`: the newest sample stands in for all the ones before it. Right
 *   for anything that reports an absolute state — where the pointer is, how
 *   big the window is, how far the page has scrolled.
 * - `accumulate`: the relative parts of the samples are summed — wheel
 *   deltas, and the pointer-lock movement a first-person camera turns by —
 *   and everything else is taken from the newest. Nothing a hand did is lost.
 *
 * Once a sample is waiting for the frame, every later sample joins it there;
 * none is delivered ahead of it. That is what keeps delivery in the order the
 * events happened. The frame is cancelled on disposal, so a runtime that has
 * been torn down is never called into.
 */

export type CoalescePolicy = 'latest' | 'accumulate';

/** The events delivered at most once a frame, and how their samples combine. */
const POLICIES: Record<string, CoalescePolicy> = {
  mousemove: 'accumulate',
  pointermove: 'accumulate',
  touchmove: 'latest',
  scroll: 'latest',
  resize: 'latest',
  wheel: 'accumulate',
};

/** Fields summed under the `accumulate` policy; all others take the newest value. */
const RELATIVE_FIELDS = ['deltaX', 'deltaY', 'deltaZ', 'movementX', 'movementY'] as const;

/** Frames closer together than this are one frame's worth of input. */
export const COALESCE_WINDOW_MS = 16;

export function coalescePolicyFor(eventType: string): CoalescePolicy | null {
  return POLICIES[eventType] ?? null;
}

export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

/** requestAnimationFrame where it exists, a timer where it does not. */
export function defaultFrameScheduler(): FrameScheduler {
  if (typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function') {
    return {
      request: (cb) => requestAnimationFrame(cb),
      cancel: (h) => cancelAnimationFrame(h),
    };
  }
  return {
    request: (cb) => setTimeout(cb, COALESCE_WINDOW_MS) as unknown as number,
    cancel: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
  };
}

function merge(
  policy: CoalescePolicy,
  pending: Record<string, unknown>,
  next: Record<string, unknown>
): Record<string, unknown> {
  if (policy === 'latest') return next;
  const merged: Record<string, unknown> = { ...next };
  for (const field of RELATIVE_FIELDS) {
    const a = pending[field];
    const b = next[field];
    if (typeof a === 'number' && typeof b === 'number') merged[field] = a + b;
    else if (typeof a === 'number' && b === undefined) merged[field] = a;
  }
  return merged;
}

export class EventCoalescer {
  private pending: Record<string, unknown> | null = null;
  private frame: number | null = null;
  private lastDelivery = -Infinity;
  private disposed = false;

  constructor(
    private readonly policy: CoalescePolicy,
    private readonly deliver: (props: Record<string, unknown>) => void,
    private readonly scheduler: FrameScheduler = defaultFrameScheduler(),
    private readonly now: () => number = () =>
      typeof performance !== 'undefined' ? performance.now() : Date.now()
  ) {}

  push(props: Record<string, unknown>): void {
    if (this.disposed) return;
    if (this.pending !== null) {
      // Something older is already waiting. Joining it is what keeps the
      // order right; delivering now would put this ahead of it.
      this.pending = merge(this.policy, this.pending, props);
      return;
    }
    const at = this.now();
    if (at - this.lastDelivery >= COALESCE_WINDOW_MS) {
      this.lastDelivery = at;
      this.deliver(props);
      return;
    }
    this.pending = props;
    this.frame = this.scheduler.request(() => {
      this.frame = null;
      const sample = this.pending;
      this.pending = null;
      if (this.disposed || sample === null) return;
      this.lastDelivery = this.now();
      this.deliver(sample);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
    if (this.frame !== null) {
      this.scheduler.cancel(this.frame);
      this.frame = null;
    }
  }
}
