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
}

export type ReuseKind = 'text' | 'expression' | 'element' | 'branch' | 'row' | 'each' | 'empty' | 'slot';

/** One document's drawings: the last finished one, and the one being made. */
export interface ReusePass {
  prev: Map<string, ReuseEntry | null>;
  next: Map<string, ReuseEntry | null>;
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
    pass = { prev: new Map(), next: new Map() };
    cache.passes.set(document, pass);
  } else {
    pass.prev = pass.next;
    pass.next = new Map();
  }
  return pass;
}

/**
 * What was kept for `key` by the last drawing, when it was this node's.
 *
 * A key drawn twice in one pass is two rows with one id: which of them an
 * entry belongs to cannot be told, so neither is reused, now or next time
 * (the key is marked, and stays marked while it keeps being drawn twice).
 */
export function recall(pass: ReusePass, key: string, node: object, kind: ReuseKind): ReuseEntry | undefined {
  if (pass.next.has(key)) {
    pass.next.set(key, null);
    return undefined;
  }
  const entry = pass.prev.get(key);
  return entry && entry.node === node && entry.kind === kind ? entry : undefined;
}

/** Keep `entry` for the next drawing, unless the key has turned out to be shared. */
export function keep(pass: ReusePass, key: string, entry: ReuseEntry): void {
  if (pass.next.get(key) === null) return;
  pass.next.set(key, entry);
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
