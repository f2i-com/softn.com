/**
 * Where a popup is drawn while it is open: a Select's list, a DatePicker's
 * calendar, a ColorPicker's palette, a Menu.
 *
 * Each was `position: absolute` under its control, inside the control's own
 * box. In the body of a Modal or a Drawer, which scrolls, that is inside the
 * scroller: a list opened near the bottom of a dialog was cut off there and
 * had to be scrolled to within it. And none of them looked at the screen: a
 * calendar opened from a field in a right-hand column ran off a phone's
 * edge, a list opened at the foot of the page ran under it.
 *
 * The popup stays where it is in the page (the control's own box, so a press
 * outside it, focus leaving it and the keyboard all still mean what they
 * did) and is placed on the screen instead: fixed, under the control when
 * there is room and above it when there is more there, moved in from the
 * screen's edge, and no taller than the room it has. Fixed, a scroller it is
 * inside does not cut it; it follows its control when anything scrolls.
 *
 * Nothing is placed where nothing is laid out (a server, a test DOM): the
 * popup then keeps the absolute place its component gives it.
 *
 * A popup's own style keeps it no wider than the screen less 16 pixels
 * (`maxWidth`), and lets it scroll in itself (`overflowY`) when the room it
 * is given is shorter than it is.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/** The least room left between a popup and the screen's edge, in pixels. */
const EDGE = 8;

export interface PopupOptions {
  /** The side of the control the popup opens on when it has room there */
  side?: 'bottom' | 'top';
  /** The edge of the control the popup lines up with */
  align?: 'start' | 'end';
  /** The space between the control and the popup, in pixels */
  gap?: number;
  /** As wide as the control, as a list of options is, not as wide as its content */
  matchWidth?: boolean;
  /** The popup's own tallest, in pixels, when its component gives it one */
  maxHeight?: number;
}

/** The styles a placed popup is given, each written as text so that they can be set at once. */
type Placement = Required<Pick<CSSProperties, 'position' | 'top' | 'left' | 'right' | 'bottom' | 'marginTop' | 'marginBottom' | 'maxHeight'>> & {
  width?: string;
  transformOrigin?: string;
};

// Before paint in a browser, so a popup is never seen where it would have been.
const useBeforePaint = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Where `position: fixed` counts from for an element: the screen, unless
 * something it is inside is transformed or filtered (an open Modal's panel
 * is), which then is what it counts from, and scrolls it with its content.
 */
function fixedOrigin(element: HTMLElement): { left: number; top: number } {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const contains =
      (style.transform && style.transform !== 'none') ||
      (style.perspective && style.perspective !== 'none') ||
      (style.filter && style.filter !== 'none') ||
      (style.backdropFilter && style.backdropFilter !== 'none') ||
      /transform|perspective|filter/.test(style.willChange ?? '') ||
      /paint|layout|strict|content/.test(style.contain ?? '');
    if (!contains) continue;
    const box = node.getBoundingClientRect();
    return { left: box.left + node.clientLeft - node.scrollLeft, top: box.top + node.clientTop - node.scrollTop };
  }
  return { left: 0, top: 0 };
}

function place(anchor: HTMLElement, popup: HTMLElement, options: PopupOptions, natural: number): Placement | null {
  const control = anchor.getBoundingClientRect();
  // Nothing is laid out here: leave the popup where its component puts it.
  if (control.width === 0 && control.height === 0) return null;
  const screenWidth = document.documentElement.clientWidth || window.innerWidth;
  const screenHeight = window.innerHeight;
  const gap = options.gap ?? 4;
  const room = { bottom: screenHeight - control.bottom - gap - EDGE, top: control.top - gap - EDGE };

  // Under the control, or over it, whichever was asked for; the other side
  // when the popup does not fit there and fits, or fits better, on the other.
  let side: 'bottom' | 'top' = options.side === 'top' ? 'top' : 'bottom';
  if (natural > room[side]) {
    const other = side === 'bottom' ? 'top' : 'bottom';
    if (natural <= room[other] || room[other] > room[side]) side = other;
  }
  const tallest = Math.max(0, Math.floor(Math.min(room[side], options.maxHeight ?? Infinity)));
  const height = Math.min(natural, tallest);

  const width = Math.min(options.matchWidth ? control.width : popup.offsetWidth, screenWidth - 2 * EDGE);
  let left = options.align === 'end' ? control.right - width : control.left;
  left = Math.max(EDGE, Math.min(left, screenWidth - EDGE - width));
  const top = side === 'bottom' ? control.bottom + gap : control.top - gap - height;

  const origin = fixedOrigin(popup);
  return {
    position: 'fixed',
    top: `${Math.round(top - origin.top)}px`,
    left: `${Math.round(left - origin.left)}px`,
    right: 'auto',
    bottom: 'auto',
    // The longhands a component's own style may carry, not the shorthand:
    // taking a shorthand away again takes the longhand written before it.
    marginTop: '0px',
    marginBottom: '0px',
    maxHeight: `${tallest}px`,
    ...(options.matchWidth ? { width: `${Math.round(width)}px` } : {}),
    ...(side === 'top' ? { transformOrigin: 'bottom center' } : {}),
  };
}

const same = (a: Placement | null, b: Placement | null): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * While `open`, the place on the screen of the popup in `popup` against the
 * control in `anchor`, as styles to lay over the popup's own; null while it
 * is shut and where there is no layout to place it in.
 */
export function usePopupPlacement(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  popup: RefObject<HTMLElement | null>,
  options: PopupOptions = {}
): CSSProperties | null {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const placed = useRef<Placement | null>(null);
  /** How tall the popup is when nothing here holds it shorter. */
  const natural = useRef(0);
  const { side, align, gap, matchWidth, maxHeight } = options;

  useBeforePaint(() => {
    if (!open) {
      placed.current = null;
      natural.current = 0;
      setPlacement(null);
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const control = anchor.current;
      const box = popup.current;
      if (!control || !box) return;
      const height = box.offsetHeight;
      const held = placed.current ? parseFloat(String(placed.current.maxHeight)) : Infinity;
      natural.current = height < held - 1 ? height : Math.max(natural.current, height);
      const next = place(control, box, { side, align, gap, matchWidth, maxHeight }, natural.current);
      if (same(next, placed.current)) return;
      placed.current = next;
      // On the element at once, as well as through the next draw: an effect
      // that scrolls an option into view runs before that draw, and would
      // scroll the dialog to a list still laid out inside it.
      if (next) Object.assign(box.style, next);
      setPlacement(next);
    };
    const later = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    // It follows its control: when anything scrolls (a scroll does not
    // bubble, and is heard on its way down), when the window changes size,
    // and when what is in it changes its own size.
    window.addEventListener('scroll', later, true);
    window.addEventListener('resize', later);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    if (observer && popup.current) observer.observe(popup.current);
    if (observer && anchor.current) observer.observe(anchor.current);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', later, true);
      window.removeEventListener('resize', later);
      observer?.disconnect();
    };
  }, [open, anchor, popup, side, align, gap, matchWidth, maxHeight]);

  return open ? placement : null;
}
