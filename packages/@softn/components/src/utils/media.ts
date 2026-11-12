/**
 * What the screen is like, for what a stylesheet cannot do by itself: a
 * component that draws something else on a phone (a sidebar as a drawer, a
 * table as cards), not the same thing restyled.
 */

import { useEffect, useState } from 'react';

/** The width, and under, at which a layout is a phone's or a portrait tablet's: the theme's own breakpoint. */
export const PHONE_QUERY = '(max-width: 768px)';

/** The width, and under, at which a row of columns is drawn as a card each: SmartGrid's breakpoint. */
export const NARROW_QUERY = '(max-width: 640px)';

/**
 * The rule that holds for a finger and not for a mouse. Controls are sized
 * for a mouse and grow to 44 pixels under it.
 */
export const TOUCH_MEDIA = '@media (pointer: coarse)';

/** Whether a media query holds right now; false where there is no `matchMedia` (a server, an old test DOM). */
export function mediaMatches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** Whether a media query holds, following the screen while the component is mounted. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => mediaMatches(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let list: MediaQueryList;
    try {
      list = window.matchMedia(query);
    } catch {
      return;
    }
    const update = () => setMatches(list.matches);
    update();
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', update);
      return () => list.removeEventListener('change', update);
    }
    // Safari before 14 only has the deprecated listener API.
    list.addListener?.(update);
    return () => list.removeListener?.(update);
  }, [query]);
  return matches;
}
