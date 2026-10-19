/**
 * What a script gets to see of a browser event.
 *
 * A DOM event cannot cross into the VM, let alone into a worker: it holds
 * the DOM. This is the one place that decides which of its properties do
 * cross, so a window listener, an element handler and a worker relay all
 * hand a script the same shape.
 *
 * Besides the obvious, a pointer event carries where its target sits on the
 * page. A canvas scaled to fit its box has no other way to say which of its
 * pixels was hit, and an emulator's mouse is exactly that question.
 */
export function extractEventProps(event: Event): Record<string, unknown> {
  const props: Record<string, unknown> = { type: event.type };

  // Enough about the target for a handler to leave native controls alone: a
  // game's WASD listener must not swallow typing in the app's own inputs.
  const target = event.target as
    | (Element & { isContentEditable?: boolean; getBoundingClientRect?: () => DOMRect })
    | null;
  if (target && typeof target.tagName === 'string') {
    props.targetTag = target.tagName.toLowerCase();
    props.targetEditable = target.isContentEditable === true;
  }

  if (typeof KeyboardEvent !== 'undefined' && event instanceof KeyboardEvent) {
    props.key = event.key;
    props.code = event.code;
    props.altKey = event.altKey;
    props.ctrlKey = event.ctrlKey;
    props.shiftKey = event.shiftKey;
    props.metaKey = event.metaKey;
    props.repeat = event.repeat;
    props.isComposing = event.isComposing === true;
    return props;
  }

  if (typeof MouseEvent !== 'undefined' && event instanceof MouseEvent) {
    props.clientX = event.clientX;
    props.clientY = event.clientY;
    props.offsetX = event.offsetX;
    props.offsetY = event.offsetY;
    props.button = event.button;
    props.buttons = event.buttons;
    // Relative motion, which is all a pointer-locked camera has: under
    // pointer lock clientX/Y stop changing. Summed, not sampled, when several
    // arrive in one frame — see event-coalescer.ts.
    props.movementX = event.movementX;
    props.movementY = event.movementY;
    props.altKey = event.altKey;
    props.ctrlKey = event.ctrlKey;
    props.shiftKey = event.shiftKey;
    props.metaKey = event.metaKey;
    if (target && typeof target.getBoundingClientRect === 'function') {
      const rect = target.getBoundingClientRect();
      props.targetLeft = rect.left;
      props.targetTop = rect.top;
      props.targetWidth = rect.width;
      props.targetHeight = rect.height;
    }
    if (typeof WheelEvent !== 'undefined' && event instanceof WheelEvent) {
      props.deltaX = event.deltaX;
      props.deltaY = event.deltaY;
      props.deltaMode = event.deltaMode;
    }
    return props;
  }

  if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) {
    props.touches = event.touches.length;
    props.changedTouches = event.changedTouches.length;
    const first = event.touches[0] || event.changedTouches[0];
    if (first) {
      props.clientX = first.clientX;
      props.clientY = first.clientY;
    }
  }

  return props;
}

/**
 * What a script reads of an element an event happened on: what a form's
 * handler reads (`e.target.value`, `e.target.checked`, `e.target.dataset`),
 * as plain data. Not its text or its size: reading `innerText` lays the
 * page out, and a handler that wants those has `:bind` and the markup's own
 * `event.target`.
 */
const SCRIPT_TARGET_HOLDS = [
  'tagName',
  'id',
  'name',
  'type',
  'value',
  'checked',
  'selectedIndex',
  'valueAsNumber',
] as const;

function isElement(value: unknown): value is Element {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { nodeType?: unknown }).nodeType === 1 &&
    typeof (value as { contains?: unknown }).contains === 'function'
  );
}

function elementData(element: Element): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const host = element as unknown as Record<string, unknown>;
  for (const name of SCRIPT_TARGET_HOLDS) {
    if (!(name in element)) continue;
    const value = host[name];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) data[name] = value;
  }
  data.dataset = { ...((element as HTMLElement).dataset ?? {}) };
  return data;
}

/**
 * What a script is given for an event a page's handler passes it,
 * `onsubmit="send(event)"` or `@input={search}`: the record above, the
 * element the handler is on and the one the event happened on as data
 * (`target`, `currentTarget`), and `defaultPrevented`.
 *
 * An element is described only when it is inside the one the handler is on:
 * a listener on the window has a target anywhere on the page, the host's
 * own fields included, and what is typed there is not the app's to read.
 *
 * `type` and `defaultPrevented` together are how an engine knows the record
 * for an event, and gives it `preventDefault()` and `stopPropagation()`
 * (see `EVENT_METHODS_SOURCE`). They do nothing there: a script runs apart
 * from the page, so cancelling is the handler's (`.prevent`, `return false`)
 * or a form's, which keeps its page (render.tsx). Without them, the first
 * line of the handler a person or a model writes, `e.preventDefault()`,
 * threw, and nothing after it ran.
 */
export function handlerEventForScript(
  event: Event,
  target: unknown,
  currentTarget: unknown
): Record<string, unknown> {
  const props = extractEventProps(event);
  props.defaultPrevented = event.defaultPrevented === true;
  const on = isElement(currentTarget) ? currentTarget : null;
  props.currentTarget = on ? elementData(on) : null;
  props.target = on && isElement(target) && on.contains(target) ? elementData(target) : null;
  return props;
}

/**
 * The record a script is given for a value standing in for an event, as the
 * markup's event records do (renderer/host-values.ts): they hold what a
 * handler may do with the page, out of a script's sight.
 */
const scriptViews = new WeakMap<object, () => Record<string, unknown>>();

/** Say what a script is given for `record`, an event's stand-in. */
export function giveScriptView(record: object, view: () => Record<string, unknown>): void {
  scriptViews.set(record, view);
}

/**
 * What a script is given for a value that is an event, or for a stand-in for
 * one; undefined for any other value.
 */
export function eventForScript(value: object): Record<string, unknown> | undefined {
  const view = scriptViews.get(value);
  if (view) return view();
  if (typeof Event === 'undefined') return undefined;
  const wrapped = value as { nativeEvent?: unknown; target?: unknown; currentTarget?: unknown };
  if (value instanceof Event) return handlerEventForScript(value, value.target, value.currentTarget);
  if (wrapped.nativeEvent instanceof Event) {
    return handlerEventForScript(wrapped.nativeEvent, wrapped.target, wrapped.currentTarget);
  }
  return undefined;
}

/**
 * Engine code that gives the record for an event its methods, for a script
 * written as browser code is: `preventDefault`, `stopPropagation` and
 * `stopImmediatePropagation`, which do nothing (see `handlerEventForScript`).
 * Not enumerable, so the record's data is what it was. Defined as
 * `__softnEventMethods(args)`, run on a call's arguments.
 */
export const EVENT_METHODS_FUNCTION = '__softnEventMethods';
export const EVENT_METHODS_SOURCE = `
;function ${EVENT_METHODS_FUNCTION}(args) {
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    if (a === null || typeof a !== "object" || typeof a.type !== "string" || typeof a.defaultPrevented !== "boolean") continue;
    var none = function () {};
    Object.defineProperty(a, "preventDefault", { value: none, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(a, "stopPropagation", { value: none, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(a, "stopImmediatePropagation", { value: none, enumerable: false, configurable: true, writable: true });
  }
  return args;
}
`;

/**
 * `EVENT_METHODS_SOURCE`, for an engine that runs the script in the page's
 * own JavaScript (host-js): the same methods, which do nothing, on the record
 * for an event among `args`, which have crossed already.
 */
export function giveEventMethods(args: unknown[]): unknown[] {
  const none = (): void => {};
  for (const a of args) {
    if (!holdsEvent([a])) continue;
    for (const name of ['preventDefault', 'stopPropagation', 'stopImmediatePropagation']) {
      Object.defineProperty(a, name, { value: none, enumerable: false, configurable: true, writable: true });
    }
  }
  return args;
}

/** Whether a call's arguments, as they cross, hold the record for an event. */
export function holdsEvent(args: readonly unknown[]): boolean {
  return args.some(
    (a) =>
      a !== null &&
      typeof a === 'object' &&
      typeof (a as { type?: unknown }).type === 'string' &&
      typeof (a as { defaultPrevented?: unknown }).defaultPrevented === 'boolean'
  );
}
