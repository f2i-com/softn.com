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
