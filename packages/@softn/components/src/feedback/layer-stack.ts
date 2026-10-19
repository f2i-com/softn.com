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

const layers: Array<{ id: symbol; ref: RefObject<HTMLElement | null> }> = [];

/**
 * Whether a layer's element is on screen. A runtime keeps an app it is not
 * showing mounted under `display: none`, and a dialog left open there is
 * still on the stack: it took Tab and Escape for the whole page, moving focus
 * into a box no one could see.
 */
function isShown(element: HTMLElement | null): boolean {
  if (!element?.isConnected || element.closest('[hidden], [inert]')) return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

/** Whether `layer` is the topmost open modal layer on screen. */
function isTop(layer: symbol): boolean {
  for (let index = layers.length - 1; index >= 0; index--) {
    if (isShown(layers[index].ref.current)) return layers[index].id === layer;
  }
  return false;
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

/** A radio that belongs to a named group, which Tab reaches as one stop. */
function groupedRadio(el: Element | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === 'radio' && el.name !== '';
}

/** Whether two radios are in one group: the same name in the same form. */
function sameGroup(a: HTMLInputElement, b: HTMLInputElement): boolean {
  return a.name === b.name && a.form === b.form;
}

/**
 * The elements Tab can reach inside `root`, in document order.
 *
 * A group of radios is one stop, as the browser makes it: the checked one,
 * or the first when none is. Each radio counted as a stop of its own, so Tab
 * from the checked radio of a group that ended a Drawer was not Tab from the
 * last stop: it was left to the browser, which went past the group and out
 * of the dialog.
 */
export function tabbableWithin(root: HTMLElement): HTMLElement[] {
  const reachable = Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => {
    if (el.tabIndex < 0) return false;
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    return true;
  });
  const stops: HTMLInputElement[] = [];
  for (const el of reachable) {
    if (!groupedRadio(el)) continue;
    const at = stops.findIndex((stop) => sameGroup(stop, el));
    if (at < 0) stops.push(el);
    else if (el.checked && !stops[at].checked) stops[at] = el;
  }
  return reachable.filter((el) => !groupedRadio(el) || stops.includes(el));
}

/**
 * The stop Tab is moving from: for a radio, its group's stop. Focus can be on
 * a radio that is not the stop (one unchecked, in a group none is checked
 * in), and Tab from there leaves the group as Tab from the stop does.
 */
function stopOf(el: Element | null, tabbable: HTMLElement[]): Element | null {
  if (!groupedRadio(el)) return el;
  return tabbable.find((stop) => groupedRadio(stop) && sameGroup(stop, el)) ?? el;
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

  // What had focus when the layer opened, read in the render that opens it.
  // The effect below runs after the layer's content has taken focus (Confirm's
  // first answer, a field with autoFocus), and read there it was that content:
  // focus went back to a control that was gone, and so to the page's body.
  const openedFrom = useRef<HTMLElement | null>(null);
  const wasActive = useRef(false);
  if (active && !wasActive.current && typeof document !== 'undefined') {
    openedFrom.current = document.activeElement as HTMLElement | null;
  }
  wasActive.current = active;

  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const layer = Symbol('modal-layer');
    layers.push({ id: layer, ref });

    const previouslyFocused = openedFrom.current ?? (document.activeElement as HTMLElement | null);
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
      const active = document.activeElement;
      const outside = !active || !container.contains(active);
      const current = outside ? active : stopOf(active, tabbable);
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
      const index = layers.findIndex((entry) => entry.id === layer);
      if (index >= 0) layers.splice(index, 1);
      if (previouslyFocused && previouslyFocused.isConnected && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [active, ref]);
}
