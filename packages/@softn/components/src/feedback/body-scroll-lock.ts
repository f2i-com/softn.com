/**
 * The body scroll lock every overlay shares.
 *
 * A page may hold more than one overlay at once — a Modal opened from inside
 * a Drawer, two modals briefly overlapping during a transition. Each used to
 * save `body.style.overflow` on open and put it back on close, so whichever
 * opened second saved `hidden` as the value to restore: close the first, the
 * page scrolls again under the second; close the second, it never scrolls
 * again. Locks are counted per body here instead, and the value from before
 * the first lock comes back when the last one releases, in whichever order.
 */

interface BodyScrollLock {
  count: number;
  originalOverflow: string;
}

const bodyScrollLocks = new WeakMap<HTMLElement, BodyScrollLock>();

/**
 * Hide the body's scrollbars until the returned release is called. The
 * release is idempotent, so StrictMode's double effect and an unmount
 * cleanup cannot release somebody else's lock.
 */
export function lockBodyScroll(body: HTMLElement): () => void {
  let lock = bodyScrollLocks.get(body);
  if (!lock) {
    lock = { count: 0, originalOverflow: body.style.overflow };
    bodyScrollLocks.set(body, lock);
  }

  lock.count += 1;
  body.style.overflow = 'hidden';
  let released = false;

  return () => {
    if (released) return;
    released = true;
    lock!.count -= 1;

    if (lock!.count === 0) {
      body.style.overflow = lock!.originalOverflow;
      bodyScrollLocks.delete(body);
    }
  };
}
