/**
 * The user's reduced-motion preference, for motion a stylesheet cannot stop.
 *
 * A CSS animation or transition is covered by the `prefers-reduced-motion`
 * rule the ThemeProvider and App stylesheets carry. Motion driven from
 * JavaScript — a requestAnimationFrame loop, a typing timer, a counter that
 * tweens — has to ask, and should jump to its end state when the answer is
 * yes.
 */

import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/** The preference right now; false where there is no `matchMedia` (a server, an old test DOM). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/** The preference, following changes while the component is mounted. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia(QUERY);
    } catch {
      return;
    }
    const update = () => setReduced(query.matches);
    update();
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
    }
    // Safari before 14 only has the deprecated listener API.
    query.addListener?.(update);
    return () => query.removeListener?.(update);
  }, []);
  return reduced;
}
