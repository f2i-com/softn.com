/**
 * What markup may hold of the browser.
 *
 * An expression in a `.ui` file runs in the host page, not in the script VM,
 * and the evaluator reads any member of any value it is handed. Handed a DOM
 * event that is the whole page: `e.target.ownerDocument.defaultView` is the
 * window, and from the window a bundle a stranger wrote calls whatever the
 * page can call. Blocking names does not hold, because the DOM has too many
 * (`insertAdjacentHTML`, `setAttribute('onclick', …)`, `getRootNode()`), so
 * the rule is about values instead: markup never holds a piece of the DOM.
 *
 *  - An event becomes the plain record a script is given (event-props.ts),
 *    with what only a handler can use added out of a script's sight:
 *    `preventDefault()`, `stopPropagation()`, `target`, `currentTarget`.
 *  - An element becomes a record of what it holds (`value`, `checked`,
 *    `dataset`, its size) and a few things to ask of it (`focus()`,
 *    `contains()`), reading the element when asked, so it is never stale.
 *  - A window, a document and every other node are nothing.
 *
 * Everything else passes: plain data, arrays, functions, a File, a Date.
 * The evaluator runs every value it reads or is given through `markupValue`,
 * so it does not matter how a piece of the DOM arrived: as an event, from a
 * component's callback, or inside something a component handed over.
 */

import { extractEventProps, giveScriptView, handlerEventForScript } from '../runtime/event-props';

/** The record standing in for an event or an element, so the same one gives the same record. */
const standIns = new WeakMap<object, object>();
/** The element a record stands in for, for `a.contains(b)`. */
const elements = new WeakMap<object, Element>();

/**
 * A value as markup may hold it. Constant time for everything a page
 * normally reads: this runs for each name and member of each expression.
 */
export function markupValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value;
  const proto = Object.getPrototypeOf(value);
  // Plain data, and the records made here, are the usual case.
  if (proto === Object.prototype || proto === null) return value;
  return standIn(value);
}

function standIn(value: object): unknown {
  const made = standIns.get(value);
  if (made !== undefined) return made;
  try {
    const event = nativeEventOf(value);
    if (event) return remember(value, eventRecord(value as EventLike, event));
    if (isWindow(value)) return undefined;
    if (isNode(value)) return isElement(value) ? elementRecord(value) : undefined;
  } catch {
    // Something that throws when asked what it is (another origin's window,
    // a prototype object read as an instance) is not for markup to hold.
    return undefined;
  }
  return value;
}

function remember<T extends object>(host: object, record: T): T {
  standIns.set(host, record);
  return record;
}

type EventLike = {
  target?: unknown;
  currentTarget?: unknown;
  relatedTarget?: unknown;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  defaultPrevented?: boolean;
  nativeEvent?: unknown;
};

/** The browser event behind a value: itself, or the one React wrapped. */
function nativeEventOf(value: object): Event | null {
  if (typeof Event === 'undefined') return null;
  if (value instanceof Event) return value;
  const native = (value as EventLike).nativeEvent;
  return native instanceof Event ? native : null;
}

function isWindow(value: object): boolean {
  if (value === globalThis) return true;
  if (typeof Window !== 'undefined' && value instanceof Window) return true;
  // A frame's window is not an instance of this page's Window.
  return (value as { window?: unknown }).window === value;
}

function isNode(value: object): value is Node {
  if (typeof Node !== 'undefined' && value instanceof Node) return true;
  const node = value as { nodeType?: unknown; nodeName?: unknown };
  return typeof node.nodeType === 'number' && typeof node.nodeName === 'string';
}

function isElement(value: Node): value is Element {
  return value.nodeType === 1;
}

/** Only what cannot lead anywhere: text, a number, a yes or no. */
function plain(value: unknown): unknown {
  const type = typeof value;
  return value === null || type === 'string' || type === 'number' || type === 'boolean' ? value : undefined;
}

function hidden(record: object, name: string, value: unknown): void {
  Object.defineProperty(record, name, { value, enumerable: false, configurable: false, writable: false });
}

function hiddenGetter(record: object, name: string, get: () => unknown): void {
  Object.defineProperty(record, name, { get, enumerable: false, configurable: false });
}

/**
 * The record for an event: what a script gets, plus the handler's own
 * things, not enumerable. Handed on, `handle(e)`, it crosses into a script
 * as the event itself would (`handlerEventForScript`): the elements as data,
 * none of the handler's own things.
 */
function eventRecord(event: EventLike, native: Event): Record<string, unknown> {
  const record = extractEventProps(native);
  // React clears `currentTarget` once the handlers have run; a handler that
  // reads it after an `await` still gets the element it was on.
  const on = event.currentTarget;
  const from = event.target;
  const other = event.relatedTarget;
  // An element is described only when it is inside the one the handler is
  // on. A listener on the window or the document, which some components
  // pass on, has a target anywhere on the page, the runtime's own controls
  // included, and where focus came from can be anywhere too.
  const within = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate !== 'object' || !isNode(candidate) || !isElement(candidate)) return null;
    if (on === null || typeof on !== 'object' || !isNode(on) || !isElement(on)) return null;
    return on.contains(candidate) ? elementRecord(candidate) : null;
  };
  hiddenGetter(record, 'target', () => within(from));
  hiddenGetter(record, 'currentTarget', () => within(on));
  hiddenGetter(record, 'relatedTarget', () => within(other));
  hiddenGetter(record, 'defaultPrevented', () => event.defaultPrevented === true || native.defaultPrevented);
  hidden(record, 'preventDefault', () => {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    else native.preventDefault();
  });
  hidden(record, 'stopPropagation', () => {
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    else native.stopPropagation();
  });
  const carried = (native as { dataTransfer?: unknown; clipboardData?: unknown }).dataTransfer ?? null;
  const pasted = (native as { clipboardData?: unknown }).clipboardData ?? null;
  if (carried !== null) hidden(record, 'dataTransfer', transferRecord(carried as DataTransfer));
  if (pasted !== null) hidden(record, 'clipboardData', transferRecord(pasted as DataTransfer));
  // Handed on to a logic function, it is what that function would have been
  // given for the event itself.
  giveScriptView(record, () => handlerEventForScript(native, from, on));
  return record;
}

/** What is dragged or pasted: its text by type, never an element. */
function transferRecord(transfer: DataTransfer): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  Object.defineProperty(record, 'types', { get: () => Array.from(transfer.types ?? []).map(String), enumerable: true });
  Object.defineProperty(record, 'files', { get: () => fileList(transfer.files), enumerable: true });
  hidden(record, 'getData', (type: unknown) => String(transfer.getData(String(type))));
  hidden(record, 'setData', (type: unknown, text: unknown) => {
    transfer.setData(String(type), String(text));
  });
  return record;
}

function fileList(files: FileList | null | undefined): Array<Record<string, unknown>> {
  return Array.from(files ?? []).map((file) => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified }));
}

/**
 * What an element holds that a handler reads. Each is a text, a number or a
 * yes/no on the element; a name the element does not have is left out, so
 * `"value" in e.target` still tells a field from a button.
 */
const ELEMENT_HOLDS = [
  'tagName',
  'id',
  'name',
  'type',
  'value',
  'checked',
  'disabled',
  'readOnly',
  'required',
  'multiple',
  'selectedIndex',
  'valueAsNumber',
  'className',
  'title',
  'textContent',
  'innerText',
  'isContentEditable',
  'selectionStart',
  'selectionEnd',
  'scrollTop',
  'scrollLeft',
  'scrollWidth',
  'scrollHeight',
  'clientWidth',
  'clientHeight',
  'offsetWidth',
  'offsetHeight',
  'offsetLeft',
  'offsetTop',
  'currentTime',
  'duration',
  'paused',
  'ended',
  'volume',
  'muted',
  'playbackRate',
  'videoWidth',
  'videoHeight',
  'naturalWidth',
  'naturalHeight',
] as const;

/** What a handler may ask an element to do: none of them takes or returns a piece of the page. */
const ELEMENT_DOES = ['focus', 'blur', 'select', 'scrollIntoView', 'play', 'pause'] as const;

function elementRecord(element: Element): Record<string, unknown> {
  const made = standIns.get(element);
  if (made !== undefined) return made as Record<string, unknown>;
  const record: Record<string, unknown> = {};
  const host = element as unknown as Record<string, unknown>;
  for (const name of ELEMENT_HOLDS) {
    if (!(name in element)) continue;
    Object.defineProperty(record, name, { get: () => plain(host[name]), enumerable: true });
  }
  Object.defineProperty(record, 'dataset', {
    get: () => ({ ...((element as HTMLElement).dataset ?? {}) }),
    enumerable: true,
  });
  if ('files' in element) {
    Object.defineProperty(record, 'files', { get: () => fileList((element as HTMLInputElement).files), enumerable: true });
  }
  for (const name of ELEMENT_DOES) {
    if (typeof host[name] !== 'function') continue;
    hidden(record, name, () => {
      // `play()` answers a promise that rejects when the browser refuses;
      // nothing here could hear it.
      const result = (host[name] as () => unknown).call(element);
      if (result instanceof Promise) result.catch(() => {});
    });
  }
  hidden(record, 'getAttribute', (name: unknown) => plain(element.getAttribute(String(name))));
  hidden(record, 'hasAttribute', (name: unknown) => element.hasAttribute(String(name)));
  hidden(record, 'matches', (selector: unknown) => {
    try {
      return element.matches(String(selector));
    } catch {
      return false;
    }
  });
  hidden(record, 'contains', (other: unknown) => {
    const inner = other !== null && typeof other === 'object' ? elements.get(other) : undefined;
    return inner !== undefined && element.contains(inner);
  });
  hidden(record, 'getBoundingClientRect', () => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  });
  elements.set(record, element);
  return remember(element, record);
}
