/**
 * Whose the keyboard is, when a component drawn by an app would take it.
 *
 * A dialog takes the focus as it opens, and keeps Tab and Escape while it is
 * open. An app can open one from its logic at any moment. With the person
 * typing in a field of the host's beside the app (a runtime's editor, a
 * studio's chat), that took the keyboard from under them: what they typed
 * next went into the app's dialog, Tab pressed in the host's field was pulled
 * into it, and Escape there closed it.
 *
 * The page says what is whose with three marks, which this reads and nothing
 * else: an app is drawn in an element marked `data-softn-app` (SoftN's
 * renderer writes it), and a host marks its own controls `data-softn-host`
 * (its permission bar is `data-softn-consent`). The same rule, for what the
 * renderer itself does, is `hostHoldsKeyboard` in @softn/core's
 * runtime/key-capture.ts.
 *
 * A component that is not drawn by an app (these components used in a page
 * of one's own) is not held back at all: there is no host beside it.
 */

const APP_BOX = '[data-softn-app]';
const HOST_CHROME = '[data-softn-host], [data-softn-consent]';

function takesTyping(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return (element as HTMLElement).isContentEditable === true;
}

/** Whether `element` is the host's: outside every app, and a field or a control of the host's marked chrome. */
export function isHostsOwn(element: Element | null | undefined): boolean {
  if (!element || typeof element.closest !== 'function') return false;
  const doc = element.ownerDocument;
  if (doc && (element === doc.body || element === doc.documentElement)) return false;
  if (element.closest(APP_BOX) !== null) return false;
  return takesTyping(element) || element.closest(HOST_CHROME) !== null;
}

/** Whether `within` is drawn by an app. Asked while it is on the page: an element taken off it has no app around it. */
export function drawnByApp(within: Element | null | undefined): boolean {
  return !!within && typeof within.closest === 'function' && within.closest(APP_BOX) !== null;
}

/**
 * Whether a component drawn at `within` may take the keyboard now: always,
 * unless it is an app's and the focus is on something of the host's.
 */
export function mayTakeKeyboard(within: Element | null | undefined): boolean {
  if (!drawnByApp(within)) return true;
  return !isHostsOwn(within!.ownerDocument?.activeElement);
}

/** Whether a key pressed at `target` is the host's to keep from a component drawn at `within`. */
export function keyIsHosts(within: Element | null | undefined, target: EventTarget | null): boolean {
  return drawnByApp(within) && isHostsOwn(target as Element | null);
}
