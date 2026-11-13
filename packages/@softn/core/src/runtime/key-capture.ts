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

/**
 * The press now held down: where it began, and whether it has been let go.
 * null between presses. A drag that began in an app is that app's until it is
 * let go, wherever the pointer goes (see `appHears`).
 *
 * A press, not a slot: one that has ended stays here until everyone has heard
 * its release (an app's own listener for it is on the window, later in the
 * same dispatch), and is cleared by a timer that clears that press and no
 * other, so a press begun straight after is not cut off by the one before.
 */
interface Press {
  target: EventTarget | null;
  ended: boolean;
}
let heldPress: Press | null = null;

/** Whether a button or a finger is still down after this release: one button of a chord, one finger of two. */
function stillHeld(event: Event): boolean {
  const touches = (event as TouchEvent).touches;
  if (touches && typeof touches.length === 'number') return touches.length > 0;
  if (event.type !== 'pointerup' && event.type !== 'mouseup') return false;
  const buttons = (event as MouseEvent).buttons;
  return typeof buttons === 'number' && buttons !== 0;
}

/** Whether this is the start of a press, and not a second button or finger joining one. */
function beginsPress(event: Event): boolean {
  // A mouse sends pointerdown for its first button alone, and is the primary
  // pointer. Each finger is a pointer of its own, with a pointerdown of its
  // own: the first is primary, and one put down beside it joins its press.
  if (event.type === 'pointerdown') return (event as PointerEvent).isPrimary === true;
  const touches = (event as TouchEvent).touches;
  if (touches && typeof touches.length === 'number') return touches.length <= 1;
  const buttons = (event as MouseEvent).buttons;
  // One bit set, or none said (an event some code made): one button.
  return typeof buttons !== 'number' || (buttons & (buttons - 1)) === 0;
}

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
  const held = (event: Event) => {
    if (!heldPress || heldPress.ended || beginsPress(event)) heldPress = { target: event.target, ended: false };
  };
  const released = (event: Event) => {
    const press = heldPress;
    if (!press || stillHeld(event)) return;
    press.ended = true;
    setTimeout(() => {
      if (heldPress === press) heldPress = null;
    }, 0);
  };
  for (const type of ['pointerdown', 'mousedown', 'touchstart']) view.addEventListener(type, held, { capture: true, passive: true });
  for (const type of ['pointerup', 'mouseup', 'touchend', 'pointercancel', 'touchcancel', 'dragend']) {
    view.addEventListener(type, released, { capture: true, passive: true });
  }
}

/**
 * Whether the keyboard is the host's now: the focus is in a field of the
 * host's, or on a control of its marked chrome, outside every app.
 *
 * An app can ask for the focus whenever it likes: an `<input autofocus>`
 * drawn on a timer, a page script calling `focus()`, a dialog opened from its
 * logic. With the person typing in a field of the host's beside the app (an
 * editor's source, a chat box) that took the keyboard from under them, and
 * what they typed next went to the app, where the app's code reads it.
 *
 * So an app's own asks are not carried out while this answers true: the
 * renderer draws no `autofocus` then (renderer/render.tsx), a page's
 * `focus()` is not made (document-shell/host.ts), and a dialog does not take
 * the focus as it opens (@softn/components' layer-stack, which reads the same
 * marks). Nothing is done about a focus move once made, so nothing of the
 * host's is blurred, and a move made for the person (Tab, a press in the app,
 * a screen reader or voice control putting the focus on a field) is theirs.
 * Once the person has moved into the app, by any of those, this answers false
 * and the app has its `autofocus` and its `focus()` as ever.
 *
 * An app's box is told by the mark the renderer writes on it
 * (`data-softn-app`), which is there from the first draw: an app that is
 * only starting, and one with no logic, are known too.
 */
export function hostHoldsKeyboard(doc: Document | null = typeof document !== 'undefined' ? document : null): boolean {
  const active = doc?.activeElement as HTMLElement | null | undefined;
  if (!doc || !active || active === doc.body || active === doc.documentElement || typeof active.closest !== 'function') return false;
  if (active.closest(APP_BOX) !== null) return false;
  return targetIsEditable(active) || active.closest(HOST_CHROME) !== null;
}

/** The element the renderer draws an app in (loader/SoftNRenderer.tsx). */
const APP_BOX = '[data-softn-app]';

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
  // Not a box of the host's that holds the app, which appHears takes a key on: this is asked
  // before an app may write to the clipboard, and stays as narrow as it was.
  return !!doc && (target === doc || target === doc.body || target === doc.documentElement);
}

/**
 * Whether `target` is an element that holds the app drawn in `element` and is
 * neither a field of the host's nor one of its marked controls: the box a host
 * keeps an app in, where it rests the focus when nothing in the app has it.
 */
function holdsApp(target: Node, element: Element): boolean {
  if (target.nodeType !== 1 || target === element || !target.contains(element)) return false;
  if (targetIsEditable(target as Node & { ownerDocument: Document | null })) return false;
  return typeof (target as Element).matches !== 'function' || !(target as Element).matches(HOST_CHROME);
}

const POINTER_EVENT = /^(?:mouse|pointer|touch|drag|drop|wheel|click|dblclick|contextmenu|lostpointercapture|gotpointercapture)/;

/**
 * What a host marks as its own: the bar over an app, a permission bar, an
 * editor beside the app, a sheet laid over it.
 *
 * "The pointer anywhere" told an app every press on the host's own controls,
 * with where it was: which of the bar's buttons, where in an editor's text.
 * And a sheet a host laid over the app to take a press for itself (picking an
 * element to edit) handed the press on to a game, which fired. A pointer
 * event aimed at marked chrome is the host's. The one exception is a drag
 * that began in the app: it hears the pointer move over the chrome and hears
 * it let go there, or it would be left holding a button that was released.
 */
const HOST_CHROME = '[data-softn-host], [data-softn-consent]';

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
  // A key, or anything else that is not the pointer, aimed at a box that holds
  // the app: where a host rests the focus while nothing in the app has it
  // (SoftN Web keeps it on the app's own tab, so there is somewhere for it to
  // land other than the page). The page was the only such box known here, so a
  // game heard no key until the person had clicked one of its controls, and in
  // a browser where a click gives a button no focus (Safari), never. Not a
  // field the host has there, and not the host's marked controls.
  if (!POINTER_EVENT.test(event.type)) return holdsApp(target, element);
  const chrome = typeof (target as unknown as Element).closest === 'function' && (target as unknown as Element).closest(HOST_CHROME) !== null;
  if (!chrome) return true;
  const press = heldPress;
  const began = press ? (press.target as Node | null) : null;
  if (!press || !began || typeof began.nodeType !== 'number' || !element.contains(began)) return false;
  // The drag's end, wherever it comes.
  if (RELEASE_EVENT.test(event.type)) return true;
  // The pointer on its way, while something is still down.
  const buttons = (event as MouseEvent).buttons;
  if (typeof buttons === 'number' && buttons !== 0) return true;
  const touches = (event as TouchEvent).touches;
  if (touches && touches.length > 0) return true;
  // Nothing is down, so the press ended without a release the page saw (a
  // context menu, a select's list, a native drag take theirs): it is over,
  // and the chrome is the host's again.
  if (!press.ended && heldPress === press) heldPress = null;
  return false;
}

const RELEASE_EVENT = /^(?:pointerup|mouseup|touchend|pointercancel|touchcancel|dragend)$/;

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
