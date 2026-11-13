/**
 * Which calls into a script may be dropped when the engine cannot keep up.
 *
 * Calls into the engine wait in a queue. When 32 are waiting as an event
 * arrives that reports where something is right now (the pointer, the
 * scroll, the next tick of a game), what its handler calls is not added: the
 * event after it says the same thing later, and a queue of stale ones only
 * puts off the click behind them. Every other call waits its turn, however
 * long the queue.
 *
 * It is the event that is left out, whole, and for what was waiting before
 * it came, never part of one for what it asks itself: a tick that moves forty
 * enemies with forty calls (`@tick={() => enemies.forEach(e => move(e.id))}`)
 * makes all forty, where the thirty-third and after were dropped on every
 * tick, however idle the engine.
 *
 * Which is which used to be read off the function's name: one beginning
 * `tick`, `update`, `animate` or `render` could be dropped whatever it was
 * bound to, so `<Button @click={updateCart}>` could lose a press, and two
 * shipped games name their loops `gameStep` and warn their readers off the
 * other names. It is the event that is continuous, not the function, and the
 * renderer knows which event it is binding. So the renderer says: it runs a
 * handler for one of the events below inside `asDroppable`, and a script
 * function called while that handler runs is one that may be dropped.
 *
 * The mark is for the handler's own synchronous run, which is where a
 * handler calls the script (`@tick={step}`, `@tick={(dt) => step(dt)}`). A
 * call a handler makes later, after waiting for something, is not marked,
 * and so is never dropped.
 */

/**
 * The React props of the events that may be dropped: each reports a sample
 * of something that goes on changing, and the next one supersedes it.
 *
 * - `onTick`: a `<Loop>`'s clock.
 * - `onHover`: the object under the pointer in a `<Scene3D>`, sent as the
 *   pointer moves.
 * - `onPointerMove`, `onMouseMove`, `onTouchMove`: where the pointer is.
 * - `onScroll`, `onWheel`: how far something has scrolled, a turn of the wheel.
 * - `onDrag`, `onDragOver`: where a drag is, sent for as long as it lasts.
 * - `onTimeUpdate`: where a playing sound or video has got to.
 * - `onLevel`: a `<Microphone>`'s level meter.
 * - `onFps`: a `<PixelCanvas>`'s frame rate.
 * - `onFrame`: a `<Camera>`'s live frames.
 *
 * Nothing else is: a click, a key, a change, a submit, a press or release of
 * a `<DPad>`, the samples of a `<Microphone>` (each is a stretch of sound
 * that no later one repeats), and every event this list does not name.
 */
export const DROPPABLE_EVENT_PROPS: ReadonlySet<string> = new Set([
  'onTick',
  'onHover',
  'onPointerMove',
  'onMouseMove',
  'onTouchMove',
  'onScroll',
  'onWheel',
  'onDrag',
  'onDragOver',
  'onTimeUpdate',
  'onLevel',
  'onFps',
  'onFrame',
]);

/** How many handlers of droppable events are running now, one inside another. */
let depth = 0;
/** Which run of such a handler this is: a new number each time one starts with none running. */
let run = 0;

/** Run `handler`, the handler of an event that may be dropped, and answer what it answers. */
export function asDroppable<T>(handler: () => T): T {
  if (depth === 0) run = run >= Number.MAX_SAFE_INTEGER ? 1 : run + 1;
  depth++;
  try {
    return handler();
  } finally {
    depth--;
  }
}


/** Whether the call being made now comes from the handler of an event that may be dropped. */
export function callIsDroppable(): boolean {
  return depth > 0;
}

/**
 * The run of a droppable event's handler the call being made now comes from,
 * or 0 when it comes from none: every call one event's handler makes has the
 * same number, and the next event's another.
 */
export function droppableRun(): number {
  return depth > 0 ? run : 0;
}

/**
 * `handler` as the handler of the event whose React prop is `prop`: wrapped
 * to run inside {@link asDroppable} when that event may be dropped, and
 * itself otherwise.
 */
export function forEventProp<F extends (...args: never[]) => unknown>(prop: string, handler: F): F {
  if (!DROPPABLE_EVENT_PROPS.has(prop)) return handler;
  return ((...args: Parameters<F>) => asDroppable(() => handler(...args))) as F;
}
