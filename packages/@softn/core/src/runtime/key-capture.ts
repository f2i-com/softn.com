/**
 * Keys a script asked the host to keep from the browser.
 *
 * A script's key handler runs after the browser has acted on the event — in
 * the VM, or in a worker a message away — so it cannot cancel the default
 * itself. A game that reads the arrow keys watches the page scroll under it;
 * one that uses Space, Tab or the function keys fights the browser for each
 * of them. `softn.input.captureKeys(...)` names the keys the script wants
 * whole, and the window listeners cancel the default for those before the
 * event is forwarded.
 *
 * The capture never reaches a text field, so typing in the app's own inputs
 * is untouched, and never applies to a key pressed with the system modifier
 * or to a Ctrl+letter chord, so the browser's own shortcuts keep working.
 *
 * Each app's keys are its own. A page can hold more than one app — Studio's
 * preview beside another, or a reload whose old runtime is still being
 * cleaned up — and with one list for the page, the second app's keys
 * replaced the first's, and the first app to close released the other's.
 * The keys kept from the browser are every app's together.
 */

/** The keys each app asked for, by the runtime that asked. */
const captured = new Map<object, Set<string>>();

const MAX_CAPTURED_KEYS = 32;

/**
 * The element each app is drawn in, by the runtime that runs it.
 *
 * A script's `window.addEventListener('keydown', …)` was a listener on the
 * host's window, and heard every key pressed in the document: the host's
 * own fields (Studio's API key, its editor), and another app's password
 * field, in a tab beside it or behind it. With no permission, and while the
 * permission bar was still asking. An app now hears what is aimed at it —
 * at its own elements, or at the page itself when nothing has focus and the
 * app is on screen — and the pointer anywhere while it is on screen, which
 * a drag that leaves the app needs and which carries no text.
 */
const appElements = new Map<object, Element>();

/** Where `owner`'s app is drawn; null when it is not drawn anywhere now. */
export function setAppElement(owner: object, element: Element | null): void {
  if (element) {
    appElements.set(owner, element);
    watchPresses(element.ownerDocument?.defaultView ?? null);
  } else {
    appElements.delete(owner);
  }
}

/**
 * What the person last pressed on the page: a click, a tap or a key.
 *
 * The browser lets a page write the clipboard, start a download or open a
 * file picker for a few seconds after any press, and SoftN Web keeps every
 * open app running, one on screen. So an app behind the one on screen could
 * write the clipboard on a timer and replace what the person copied in the
 * other (an address in a wallet app) within those seconds, or put up its own
 * file picker as they pressed Open in the other. `lastPressWasFor` asks
 * whose press it was.
 */
let lastPress: EventTarget | null = null;
const watchedWindows = new WeakSet<object>();

function watchPresses(view: Window | null): void {
  if (!view || watchedWindows.has(view)) return;
  watchedWindows.add(view);
  // A press the page's own code makes up grants the browser nothing, and an
  // app's markup cannot make one, so every press is taken as it comes.
  const note = (event: Event) => {
    lastPress = event.target;
  };
  // The events the browser counts as the person's activation, seen first.
  for (const type of ['pointerdown', 'mousedown', 'touchend', 'keydown']) {
    view.addEventListener(type, note, { capture: true, passive: true });
  }
}

/**
 * Whether the person's last press on the page was aimed at `owner`'s app: at
 * one of its elements, or at the page itself (a key with nothing focused)
 * while the app is on screen. An app drawn nowhere (a check without a page,
 * a script without a renderer) has no other app to tell it from.
 */
export function lastPressWasFor(owner: object): boolean {
  const element = appElements.get(owner);
  if (!element) return true;
  const target = lastPress as (Node & { ownerDocument: Document | null }) | null;
  if (!target || typeof target.nodeType !== 'number') return false;
  if (element.contains(target)) return true;
  const shown = typeof element.checkVisibility === 'function' ? element.checkVisibility() : element.isConnected;
  if (!shown) return false;
  const doc = target.nodeType === 9 ? (target as unknown as Document) : target.ownerDocument;
  return !!doc && (target === doc || target === doc.body || target === doc.documentElement);
}

const POINTER_EVENT = /^(?:mouse|pointer|touch|drag|drop|wheel|click|dblclick|contextmenu|lostpointercapture|gotpointercapture)/;

/** Whether a listener `owner`'s app put on the window hears `event`. */
export function appHears(owner: object, event: Event): boolean {
  const target = event.target as (Node & { ownerDocument: Document | null }) | null;
  // The window and the document themselves: a resize, a page leaving, a key
  // sent to the window. Nothing typed into anything.
  if (!target || typeof target.nodeType !== 'number' || target.nodeType !== 1) return true;
  const element = appElements.get(owner);
  if (!element) return !targetIsEditable(target);
  if (element.contains(target)) return true;
  const shown = typeof element.checkVisibility === 'function' ? element.checkVisibility() : element.isConnected;
  if (!shown) return false;
  const doc = target.ownerDocument;
  if (doc && (target === doc.body || target === doc.documentElement)) return true;
  return POINTER_EVENT.test(event.type);
}

/**
 * Replace the keys `owner` captures; an empty list releases them. Entries
 * are `KeyboardEvent.key` or `.code` values.
 */
export function setCapturedKeys(owner: object, keys: Iterable<string>): void {
  const names = new Set<string>();
  for (const key of keys) {
    const name = String(key);
    if (name !== '') names.add(name);
    // A game's controls, not the keyboard: the rest are the browser's.
    if (names.size >= MAX_CAPTURED_KEYS) break;
  }
  if (names.size > 0) captured.set(owner, names);
  else captured.delete(owner);
}

/** Release the keys `owner` captured, and only those. */
export function clearCapturedKeys(owner: object): void {
  captured.delete(owner);
}

/** How many different keys are captured, by every owner together. */
export function capturedKeyCount(): number {
  const all = new Set<string>();
  for (const names of captured.values()) for (const name of names) all.add(name);
  return all.size;
}

function isCaptured(key: string, code: string, owner?: object): boolean {
  if (owner) {
    const names = captured.get(owner);
    return !!names && (names.has(key) || names.has(code));
  }
  for (const names of captured.values()) {
    if (names.has(key) || names.has(code)) return true;
  }
  return false;
}

/** Whether the event's target takes typed text, which capture must leave alone. */
function targetIsEditable(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).tagName !== 'string') return false;
  const element = target as Element & { isContentEditable?: boolean };
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return element.isContentEditable === true;
}

/**
 * Whether this event's default action should be cancelled before the script
 * sees it: a captured key, on its way somewhere other than a text field, with
 * no modifier that makes it the browser's.
 */
export function shouldCaptureKey(event: Event, owner?: object): boolean {
  if (captured.size === 0) return false;
  if (typeof KeyboardEvent === 'undefined' || !(event instanceof KeyboardEvent)) return false;
  if (event.type !== 'keydown' && event.type !== 'keyup') return false;
  if (event.metaKey) return false;
  if (event.ctrlKey && event.key.length === 1) return false;
  if (!isCaptured(event.key, event.code, owner)) return false;
  // Only a key the app hears: Enter on the host's own button, or Tab out of
  // the permission bar, is the host's.
  if (owner && !appHears(owner, event)) return false;
  return !targetIsEditable(event.target);
}

/**
 * The list a `input.captureKeys` host call carries: a JSON array of names,
 * or a comma-separated string. Anything else is an empty list.
 */
export function parseCapturedKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((k) => String(k)).filter((k) => k !== '');
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const text = raw.trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return Array.isArray(parsed) ? parsed.map((k) => String(k)).filter((k) => k !== '') : [];
    } catch {
      return [];
    }
  }
  return text
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '');
}
