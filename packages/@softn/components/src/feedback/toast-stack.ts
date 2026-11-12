/**
 * The toasts showing at each corner of the screen, so that they stack.
 *
 * Every Toast is a fixed box of its own at the corner its `position` names,
 * and two shown at once were drawn exactly on top of each other: the second
 * hid the first, and closing it showed a message the person had never seen
 * arrive. Each toast now tells this list it is showing and how tall it is,
 * and stands clear of those shown after it: the newest is nearest the edge,
 * and the older ones move away from it, back again as the newer ones go.
 *
 * Each toast stays where the page drew it, in its own app, with its own
 * colours and its own live region; only where it stands is shared.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

interface StackedToast {
  /** The corner it shows at. */
  corner: string;
  /** Its box, to measure. */
  element: RefObject<HTMLElement | null>;
  /** When it began showing, among all toasts: later is newer. */
  order: number;
}

const showing: StackedToast[] = [];
const watchers = new Set<() => void>();
let shown = 0;

/** The space between two toasts at one corner, in pixels. */
const GAP = 12;

function tellAll(): void {
  for (const watcher of Array.from(watchers)) watcher();
}

/**
 * How tall a toast is drawn; nothing for one that is not on screen. A
 * runtime keeps an app it is not showing mounted under `display: none`, and
 * a toast left showing there takes no room at the corner.
 */
function heightOf(toast: StackedToast): number {
  const element = toast.element.current;
  if (!element || !element.isConnected) return 0;
  return element.getBoundingClientRect().height;
}

// Before paint in a browser, so a second toast is never seen over the first.
const useBeforePaint = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * While `visible`, a place in the stack at `corner` for the toast drawn in
 * `element`: how far from the corner's edge it stands, in pixels, which is
 * the height of every toast shown there after it and the gaps between.
 */
export function useToastStack(visible: boolean, corner: string, element: RefObject<HTMLElement | null>): number {
  const [, redraw] = useState(0);
  const self = useRef<StackedToast | null>(null);

  useBeforePaint(() => {
    if (!visible) return;
    const toast: StackedToast = { corner, element, order: ++shown };
    self.current = toast;
    showing.push(toast);
    const watcher = () => redraw((count) => count + 1);
    watchers.add(watcher);
    tellAll();
    // A toast whose text wraps differently (the window narrowed, the message
    // changed) is a different height, and those beyond it move.
    const observer = typeof ResizeObserver === 'undefined' || !element.current ? null : new ResizeObserver(tellAll);
    if (observer && element.current) observer.observe(element.current);
    return () => {
      observer?.disconnect();
      watchers.delete(watcher);
      const at = showing.indexOf(toast);
      if (at >= 0) showing.splice(at, 1);
      self.current = null;
      tellAll();
    };
  }, [visible, corner, element]);

  const toast = self.current;
  if (!visible || !toast) return 0;
  let offset = 0;
  for (const other of showing) {
    if (other === toast || other.corner !== toast.corner || other.order < toast.order) continue;
    const height = heightOf(other);
    if (height > 0) offset += height + GAP;
  }
  return offset;
}
