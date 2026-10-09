/**
 * The canvas scrolls under a drag held near its upper or lower edge.
 *
 * A drag here is the pointer with the button held, not the browser's own
 * drag and drop, so nothing scrolled: an element could be dragged only as
 * far as the part of the page that was on the screen, unless the person
 * knew to turn the wheel with the button held. Held within {@link EDGE}
 * pixels of an edge, the canvas now moves towards it, faster the nearer
 * the pointer is, and what is under the pointer is asked again where a
 * drop would go, since it is not what it was.
 */

import { useEffect, type RefObject } from 'react';
import { useCanvasStore } from '../stores/canvasStore';

/** How near an edge of the canvas the pointer is held for it to scroll, in pixels. */
export const EDGE = 56;
/** The most it scrolls in one frame, in pixels. */
export const MAX_STEP = 18;
/**
 * How many frames the pointer is at an edge before the canvas moves, about
 * a fifth of a second. Something let go near the edge is let go where it
 * was aimed: the canvas moving at once took the place out from under it.
 */
export const HOLD_FRAMES = 12;

/**
 * How far to scroll this frame with the pointer at `pointerY`, for a canvas
 * that is on the screen from `top` to `bottom`: negative is up. Nothing in
 * the middle, nothing once the pointer is well outside the canvas, and a
 * canvas too short for two edges gives each a third of itself.
 */
export function edgeScrollStep(pointerY: number, top: number, bottom: number): number {
  const height = bottom - top;
  if (height <= 0) return 0;
  const edge = Math.min(EDGE, height / 3);
  if (pointerY < top - EDGE || pointerY > bottom + EDGE) return 0;
  if (pointerY < top + edge) return -Math.ceil(MAX_STEP * Math.min(1, (top + edge - pointerY) / edge));
  if (pointerY > bottom - edge) return Math.ceil(MAX_STEP * Math.min(1, (pointerY - (bottom - edge)) / edge));
  return 0;
}

/** Scroll `scroller` while something is being dragged and the pointer is held near its upper or lower edge. */
export function useDragAutoScroll(scroller: RefObject<HTMLElement | null>): void {
  const dragging = useCanvasStore((state) => state.draggedType !== null || state.draggedElementId !== null);

  useEffect(() => {
    if (!dragging) return;
    let pointer: { x: number; y: number } | null = null;
    let frame = 0;
    /** Frames the pointer has been at an edge, and which way that edge is. */
    let held = 0;
    let towards = 0;

    // The synthetic move below comes back here too, with the same place.
    const track = (event: MouseEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
    };

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const el = scroller.current;
      if (!el || !pointer) return;
      const rect = el.getBoundingClientRect();
      const step = pointer.x < rect.left || pointer.x > rect.right ? 0 : edgeScrollStep(pointer.y, rect.top, rect.bottom);
      if (step === 0 || Math.sign(step) !== towards) {
        held = 0;
        towards = Math.sign(step);
        return;
      }
      held += 1;
      if (held < HOLD_FRAMES) return;
      const before = el.scrollTop;
      el.scrollTop = before + step;
      if (el.scrollTop === before) return;
      // A still pointer sends no move, and what is under it has changed:
      // ask it where a drop would go now.
      document.elementFromPoint?.(pointer.x, pointer.y)?.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: pointer.x, clientY: pointer.y })
      );
    };

    window.addEventListener('mousemove', track);
    frame = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('mousemove', track);
      cancelAnimationFrame(frame);
    };
  }, [dragging, scroller]);
}
