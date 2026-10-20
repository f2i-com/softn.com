/**
 * Resolves once the browser is idle — after an app's first screen, say — or
 * after `timeout` ms at the most, and at once when `signal` fires. For
 * background work whose fetches should not compete with what a page is
 * drawing.
 */
export function whenIdle(signal?: AbortSignal, timeout = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', done);
      resolve();
    };
    signal?.addEventListener('abort', done, { once: true });
    if (typeof requestIdleCallback === 'function') requestIdleCallback(done, { timeout });
    else setTimeout(done, Math.min(timeout, 500));
  });
}
