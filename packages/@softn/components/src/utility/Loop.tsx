/**
 * Loop Component
 *
 * A generic interval timer that fires a callback at a regular interval.
 * Renders nothing visible — returns null.
 */

import { useEffect, useRef } from 'react';

export interface LoopProps {
  /** Interval in milliseconds (default 1000) */
  interval?: number;
  /** Whether the timer is running (default false) */
  running?: boolean;
  /** Callback fired each interval */
  onTick?: () => void | Promise<void>;
}

export function Loop({ interval = 1000, running = false, onTick }: LoopProps) {
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  useEffect(() => {
    if (!running) return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const scheduleNext = (delayMs: number) => {
      if (cancelled) return;
      timeoutId = setTimeout(tick, Math.max(0, delayMs));
    };

    const tick = () => {
      if (cancelled) return;
      if (inFlight) {
        // Guard against overlap under heavy load: never queue multiple concurrent ticks.
        scheduleNext(interval);
        return;
      }
      inFlight = true;
      const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      Promise.resolve()
        .then(() => onTickRef.current?.())
        .catch(() => {
          // Swallow tick errors so one failure does not permanently stop the loop.
        })
        .finally(() => {
          if (cancelled) return;
          inFlight = false;
          const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
          const elapsed = finishedAt - startedAt;
          scheduleNext(interval - elapsed);
        });
    };

    scheduleNext(interval);

    return () => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [running, interval]);

  return null;
}
