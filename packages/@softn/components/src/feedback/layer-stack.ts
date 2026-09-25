/**
 * The stack of modal layers — Modal and Drawer — open on the page, and the
 * keyboard behaviour a modal layer owes the user.
 *
 * Each layer used to put its own Escape and Tab listeners on `document`, so a
 * Modal opened from inside a Drawer closed *both* on one Escape, and a
 * Tooltip's Escape inside a Modal closed the Modal too. Only the layer on top
 * answers now, and a keystroke something inside it already handled (it called
 * `preventDefault`) is left alone.
 *
 * The Tab trap also started from the dialog container, which is neither the
 * first nor the last tabbable element: Shift+Tab from there went straight to
 * the page behind the overlay. Focus that is on the container, or has escaped
 * it, now wraps like focus on the first or last element.
 */

import { useEffect, useRef, type RefObject } from 'react';

const layers: symbol[] = [];

/** Whether `layer` is the topmost open modal layer. */
function isTop(layer: symbol): boolean {
  return layers[layers.length - 1] === layer;
}

const TABBABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(', ');

/** The elements Tab can reach inside `root`, in document order. */
export function tabbableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => {
    if (el.tabIndex < 0) return false;
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    return true;
  });
}

export interface ModalLayerOptions {
  /** Called on Escape while this layer is on top; omit to ignore Escape. */
  onEscape?: () => void;
}

/**
 * While `active`, make the element in `ref` a modal layer: register it on the
 * stack, move focus into it, keep Tab inside it, answer Escape when it is on
 * top, and give focus back to what had it when the layer closes.
 */
export function useModalLayer(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  options: ModalLayerOptions = {}
): void {
  // The latest handler, read at keypress time: an inline `onClose` is a new
  // function every render, and re-running the effect for it would move focus
  // back to the container on every parent render.
  const onEscapeRef = useRef(options.onEscape);
  onEscapeRef.current = options.onEscape;

  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const layer = Symbol('modal-layer');
    layers.push(layer);

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) root.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isTop(layer) || e.defaultPrevented) return;
      const container = ref.current;
      if (!container) return;

      if (e.key === 'Escape') {
        const onEscape = onEscapeRef.current;
        if (!onEscape) return;
        e.preventDefault();
        onEscape();
        return;
      }

      if (e.key !== 'Tab') return;
      const tabbable = tabbableWithin(container);
      if (tabbable.length === 0) {
        // Nothing to move to: stay on the dialog rather than leave it.
        e.preventDefault();
        container.focus();
        return;
      }
      const first = tabbable[0];
      const last = tabbable[tabbable.length - 1];
      const current = document.activeElement;
      const outside = !current || !container.contains(current);
      if (e.shiftKey) {
        if (outside || current === first || current === container) {
          e.preventDefault();
          last.focus();
        }
      } else if (outside || current === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const index = layers.lastIndexOf(layer);
      if (index >= 0) layers.splice(index, 1);
      if (previouslyFocused && previouslyFocused.isConnected && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [active, ref]);
}
