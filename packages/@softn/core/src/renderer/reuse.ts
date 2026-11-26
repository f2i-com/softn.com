/**
 * Handing React the element it was handed last time.
 *
 * The renderer is a plain function from a document and the app's state to
 * React elements, and it makes every one of them again whenever anything in
 * state changes. React compares what it is given with what it had by
 * identity, so a fresh element with the same props is a component to run
 * again: one keystroke in a filter field ran every component on the page.
 * Measured through SoftNRenderer on a page of 300 rows, that was 11 ms of
 * every keystroke on a desktop, most of it React re-running components whose
 * output could not have changed; with this it is 2.5 ms.
 *
 * So where a node of the document is drawn twice with the same component,
 * the same props and the same children, the second drawing returns the
 * first one's element, and React leaves that subtree alone.
 *
 * "The same" is decided by value, never by an object being the one it was:
 *
 *   - a prop is the same when it is the same text, number or boolean;
 *   - a list or record is never the same, even when it is the very object
 *     it was. A script may have changed what is inside it (a list a handler
 *     pushed to, a record another change reused), and a component that is
 *     not run again would go on showing the old contents;
 *   - `style` is the same when each of its properties is;
 *   - an event handler (`@click`, an `on…` prop) is always the same. A
 *     handler is called when something happens, not while the page is
 *     drawn, so the element keeps one stand-in that calls whichever handler
 *     the latest drawing made;
 *   - children are the same when each one is the element it was.
 *
 * The expressions are still all evaluated on every drawing. Nothing is
 * skipped on the strength of state looking unchanged; only the element is
 * reused once the values it would be made from have turned out equal.
 *
 * A host opts in by putting a cache it made with `createRenderCache()` in
 * the render context, one for each mounted document. Without one the
 * renderer makes every element afresh, as it always did.
 */

import type React from 'react';

/** What was drawn for one node of a document, at one place in the page. */
export interface ReuseEntry {
  /** The document node this was drawn from; a key reused by another node is not a match. */
  node: object;
  kind: ReuseKind;
  result: React.ReactNode;
  /** An element's component, or a tag name. */
  component?: unknown;
  /** The props the element was made with, stand-ins and all. */
  props?: Record<string, unknown>;
  /** What was drawn inside it, in order. */
  children?: readonly React.ReactNode[];
  /** The stand-in for each handler prop. */
  handlers?: Record<string, StableHandler>;
  /** What `style` said when the element was made, copied: the object itself may be changed later. */
  style?: Record<string, unknown>;
  /** An expression's text, or the key of the branch an `#if` took. */
  text?: string;
  /** Set by the element's error boundary when the component threw; such an element is made again. */
  failure?: { caught: boolean };
  /** The edit marks the element was made under (types' EditMarks), or none: one made under others is made again. */
  marks?: object;
}

export type ReuseKind = 'text' | 'expression' | 'element' | 'branch' | 'row' | 'each' | 'empty' | 'slot';

/** One place of the page: what the latest drawing that drew it kept there. */
export interface ReuseSlot {
  /** The drawing `kept` is from. */
  keptIn: number;
  /** What it kept; null when it drew two things there, which neither may reuse. */
  kept: ReuseEntry | null;
}

/**
 * Where a node of the document is drawn: the page, or one row of a loop in
 * it, which is a scope of its own (a row of a loop in a row has its own in
 * that). A place is a node in a scope, so it is found by the node, which
 * costs nothing to look up.
 *
 * It was found by a key that spelled the whole way down to the node, the
 * keys of the rows and elements around it and the node's place in the
 * source: text made afresh at every drawing, read through to be looked up,
 * and compared letter by letter with the last drawing's, for every node.
 * On a page of two thousand rows that was a quarter of a keystroke.
 */
export interface ReuseScope {
  /** What each node drew here, by the node. */
  readonly slots: Map<object, ReuseSlot>;
  /** The scopes of the rows drawn here: by the loop's node, then by the row's key. */
  rows: Map<object, Map<string, ReuseScope>> | null;
  /** The drawing that last drew in it. */
  drawnIn: number;
}

/** One document's drawings: every place the last finished drawing kept something at, and the one being made. */
export interface ReusePass {
  readonly root: ReuseScope;
  /** The drawing being made, counted from 1. */
  drawing: number;
  /** The scope being drawn in now. */
  scope: ReuseScope;
  /** The place `recall` found last, for the `keep` that follows it. */
  lastNode: object | undefined;
  lastSlot: ReuseSlot | undefined;
}

function newScope(drawing: number): ReuseScope {
  return { slots: new Map(), rows: null, drawnIn: drawing };
}

/** Let go of what `scope` holds that the drawing `last` did not draw. */
function sweep(scope: ReuseScope, last: number): void {
  const slots = scope.slots;
  slots.forEach((slot, node) => {
    if (slot.keptIn < last) slots.delete(node);
  });
  const byLoop = scope.rows;
  if (!byLoop) return;
  byLoop.forEach((rows, loop) => {
    rows.forEach((row, key) => {
      if (row.drawnIn < last) rows.delete(key);
      else sweep(row, last);
    });
    if (rows.size === 0) byLoop.delete(loop);
  });
}

/**
 * The drawings a mounted document keeps between one render and the next.
 * Opaque to a host: make one with `createRenderCache()` for each mount and
 * hand it over in the render context.
 */
export interface SoftNRenderCache {
  /** @internal */
  readonly passes: WeakMap<object, ReusePass>;
}

export function createRenderCache(): SoftNRenderCache {
  return { passes: new WeakMap() };
}

/**
 * Start drawing `document`: what the last drawing kept becomes what this
 * one may reuse, and anything not drawn again is let go with it.
 */
export function beginPass(cache: SoftNRenderCache, document: object): ReusePass {
  let pass = cache.passes.get(document);
  if (!pass) {
    const root = newScope(1);
    pass = { root, drawing: 1, scope: root, lastNode: undefined, lastSlot: undefined };
    cache.passes.set(document, pass);
    return pass;
  }
  // A place the last drawing did not draw is gone from the page.
  sweep(pass.root, pass.drawing);
  pass.drawing += 1;
  pass.root.drawnIn = pass.drawing;
  pass.scope = pass.root;
  pass.lastNode = undefined;
  pass.lastSlot = undefined;
  return pass;
}

/**
 * Draw one row of the loop `loop` in its own scope, the row `key` names:
 * answers the scope it was drawn in, for `leaveRow`. Two rows with one key
 * share one scope, and so every place in them is a place drawn twice.
 */
export function enterRow(pass: ReusePass, loop: object, key: string): ReuseScope {
  const outer = pass.scope;
  const byLoop = (outer.rows ??= new Map());
  let rows = byLoop.get(loop);
  if (!rows) {
    rows = new Map();
    byLoop.set(loop, rows);
  }
  let row = rows.get(key);
  if (!row) {
    row = newScope(pass.drawing);
    rows.set(key, row);
  }
  row.drawnIn = pass.drawing;
  pass.scope = row;
  pass.lastNode = undefined;
  return outer;
}

/** Back to the scope a row was entered from. */
export function leaveRow(pass: ReusePass, outer: ReuseScope): void {
  pass.scope = outer;
  pass.lastNode = undefined;
}

/**
 * What `node` drew here in the last drawing, when it was this kind of thing.
 *
 * A place drawn twice in one pass is two rows with one key: which of them an
 * entry belongs to cannot be told, so neither is reused, now or next time
 * (the place is marked, and stays marked while it keeps being drawn twice).
 */
export function recall(pass: ReusePass, node: object, kind: ReuseKind): ReuseEntry | undefined {
  const slot = pass.scope.slots.get(node);
  pass.lastNode = node;
  pass.lastSlot = slot;
  if (!slot) return undefined;
  if (slot.keptIn === pass.drawing) {
    // Kept already in this drawing: a second thing in the same place.
    slot.kept = null;
    return undefined;
  }
  const entry = slot.keptIn === pass.drawing - 1 ? slot.kept : null;
  return entry && entry.node === node && entry.kind === kind ? entry : undefined;
}

/** Keep `entry` here for the next drawing, unless the place has turned out to be shared. */
export function keep(pass: ReusePass, entry: ReuseEntry): void {
  const node = entry.node;
  const slot = pass.lastNode === node ? pass.lastSlot : pass.scope.slots.get(node);
  if (!slot) {
    const made: ReuseSlot = { keptIn: pass.drawing, kept: entry };
    pass.scope.slots.set(node, made);
    pass.lastNode = node;
    pass.lastSlot = made;
    return;
  }
  if (slot.keptIn === pass.drawing) {
    if (slot.kept !== null) slot.kept = entry;
    return;
  }
  slot.keptIn = pass.drawing;
  slot.kept = entry;
}

/** A function that stays the same while what it calls is replaced. */
export interface StableHandler {
  (...args: unknown[]): unknown;
  current: (...args: unknown[]) => unknown;
}

const STABLE = new WeakSet<object>();

export function stableHandler(handler: (...args: unknown[]) => unknown): StableHandler {
  const stable = ((...args: unknown[]) => stable.current(...args)) as StableHandler;
  stable.current = handler;
  STABLE.add(stable);
  return stable;
}

/** `onClick`, `onChange`, `onPress`: a prop a component calls when something happens. */
export function isHandlerProp(name: string): boolean {
  return name.length > 2 && name.startsWith('on') && name[2] >= 'A' && name[2] <= 'Z';
}

function isPrimitive(value: unknown): boolean {
  return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

/** Whether two style objects set the same properties to the same plain values. */
function sameStyle(a: unknown, b: Record<string, unknown>): boolean {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return false;
  const was = a as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length !== Object.keys(was).length) return false;
  for (const key of keys) {
    const value = b[key];
    if (!isPrimitive(value) || !Object.hasOwn(was, key) || !Object.is(was[key], value)) return false;
  }
  return true;
}

/** What `settleProps` found: the stand-ins to keep, and what `style` says now. */
export interface SettledProps {
  handlers?: Record<string, StableHandler>;
  /** A copy of the style as it is now, for the next comparison. */
  style?: Record<string, unknown>;
  /** The style says what it said when the element was made. */
  styleUnchanged: boolean;
}

/**
 * Make `props` comparable with what the element had before: each handler is
 * replaced by its stand-in (the one the element already has, pointed at the
 * new handler), and a style that says what the last one said is replaced by
 * the last one.
 *
 * The style is compared with a copy taken when the element was made, not
 * with the object the element holds: an app may hand over the same object
 * with different contents.
 */
export function settleProps(props: Record<string, unknown>, before: ReuseEntry | undefined): SettledProps {
  const settled: SettledProps = { styleUnchanged: false };
  for (const name of Object.keys(props)) {
    const value = props[name];
    if (typeof value === 'function') {
      if (!isHandlerProp(name)) continue;
      let stable = before?.handlers?.[name];
      if (stable) stable.current = value as StableHandler['current'];
      else stable = stableHandler(value as StableHandler['current']);
      props[name] = stable;
      (settled.handlers ??= {})[name] = stable;
    } else if (name === 'style' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const now = value as Record<string, unknown>;
      if (before?.style && before.props && sameStyle(before.style, now)) {
        props.style = before.props.style;
        settled.style = before.style;
        settled.styleUnchanged = true;
      } else {
        settled.style = { ...now };
      }
    }
  }
  return settled;
}

/**
 * Whether an element made from `props` would be the element made from `was`.
 * Both have been through `settleProps`, so a handler or a style that counts
 * as the same is by now the same object.
 */
export function sameProps(
  was: Record<string, unknown>,
  props: Record<string, unknown>,
  styleUnchanged: boolean
): boolean {
  const names = Object.keys(props);
  if (names.length !== Object.keys(was).length) return false;
  for (const name of names) {
    if (!Object.hasOwn(was, name)) return false;
    const value = props[name];
    if (!Object.is(was[name], value)) return false;
    if (isPrimitive(value)) continue;
    // The same object as before. That is only "the same" for the two things
    // made so above; anything else may have changed inside.
    if ((name === 'style' && styleUnchanged) || STABLE.has(value as object)) continue;
    return false;
  }
  return true;
}

/** Whether two lists of drawn children are the same elements in the same order. */
export function sameNodes(was: readonly React.ReactNode[] | undefined, now: readonly React.ReactNode[]): boolean {
  if (!was || was.length !== now.length) return false;
  for (let i = 0; i < now.length; i++) {
    if (was[i] !== now[i]) return false;
  }
  return true;
}
