/**
 * Which node of an app's page drew an element, for a host that edits the app
 * while it runs.
 *
 * The host makes the marks (`createEditMarks`), gives them to the renderer
 * (`<SoftNRenderer editMarks={…}>`), and asks here what drew the element a
 * person pressed (`drawnFrom`) and what a place in the source drew
 * (`drawnAt`). The renderer keeps its notes in the marks themselves, in the
 * host's memory: nothing is written on the page, so the app, its styles and
 * its code have nothing to find.
 *
 * An HTML element is noted by the element. A component (`<Button>`) draws
 * elements of its own, which have no place in the source; they are found in
 * React's own tree, from the element to the component around it, read as the
 * tree is on screen now (see `onScreen`). Where that tree cannot be read
 * (another build of React), the nearest HTML element of the page that holds
 * it answers instead.
 */

import type { ElementNode } from '../parser/ast';
import type { EditMarks } from '../types';

export type { EditMarks };

export function createEditMarks(): EditMarks {
  return { drawn: new WeakMap(), refs: new WeakMap(), components: new WeakSet() };
}

export interface DrawnFrom {
  /**
   * The node that drew it. `loc.start` is its place in the composed page;
   * below zero for an element the page's code made, which is in no source.
   */
  node: ElementNode;
  /** What the node drew here: the element, or a component's outermost elements. */
  elements: Element[];
  /** Drawn by a component, whose own elements are not in the source. */
  component: boolean;
}

/** As much of a React fiber as is read here. */
interface Fiber {
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  stateNode: unknown;
  memoizedProps: unknown;
}

/**
 * The fibers from the top of React's tree down to `fiber`, each as it is in
 * the tree that is on screen; null where that cannot be read.
 *
 * React keeps two of every fiber, the one drawn and the one it is working
 * on, and an element is tied to whichever was made first. Read from the
 * wrong one, a component says what it was drawn from some drawings ago, and
 * holds the elements it had then. So the way up from the element is taken
 * only to find the top, and the way down from there is the tree on screen.
 */
function onScreen(fiber: Fiber): Fiber[] | null {
  const up: Fiber[] = [];
  for (let at: Fiber | null = fiber; at; at = at.return) {
    up.push(at);
    if (up.length > 100_000) return null;
  }
  const top = up[up.length - 1];
  const root = top.stateNode as { current?: Fiber } | null;
  let current = root !== null && typeof root === 'object' ? root.current : undefined;
  if (!current || (current !== top && current !== top.alternate)) return null;
  const path = [current];
  for (let i = up.length - 2; i >= 0; i--) {
    const wanted = up[i];
    let child: Fiber | null = current.child;
    while (child && child !== wanted && child !== wanted.alternate) child = child.sibling;
    if (!child) return null;
    current = child;
    path.push(child);
  }
  return path;
}

const isElement = (value: unknown): value is Element => typeof Element !== 'undefined' && value instanceof Element;

function fiberOf(element: Element): Fiber | null {
  for (const key of Object.keys(element)) {
    if (key.startsWith('__reactFiber$')) {
      const fiber = (element as unknown as Record<string, unknown>)[key];
      return fiber && typeof fiber === 'object' ? (fiber as Fiber) : null;
    }
  }
  return null;
}

/**
 * The node a component was drawn from, when `fiber` is the boundary the
 * renderer put around one. Only a node the renderer itself noted counts: a
 * prop of that name an app gave one of its components is not one.
 */
function componentNode(marks: EditMarks, fiber: Fiber): ElementNode | undefined {
  const props = fiber.memoizedProps as { mark?: unknown } | null;
  const mark = props !== null && typeof props === 'object' ? props.mark : undefined;
  return mark !== null && typeof mark === 'object' && marks.components.has(mark) ? (mark as ElementNode) : undefined;
}

/** The outermost elements drawn under `fiber`. */
function elementsUnder(fiber: Fiber, into: Element[], depth = 0): Element[] {
  if (depth > 512) return into;
  for (let child = fiber.child; child; child = child.sibling) {
    if (isElement(child.stateNode)) into.push(child.stateNode);
    else elementsUnder(child, into, depth + 1);
  }
  return into;
}

/** What drew `target`: the nearest element or component of the page around it, itself included. */
export function drawnFrom(marks: EditMarks, target: Element): DrawnFrom | null {
  let from: Element | null = target;
  let fiber: Fiber | null = null;
  // An element a component put there by hand has no fiber: the nearest that has one stands for it.
  while (from && !(fiber = fiberOf(from))) from = from.parentElement;
  const path = fiber ? onScreen(fiber) : null;
  for (let i = (path?.length ?? 0) - 1; i >= 0; i--) {
    const at = path![i];
    if (isElement(at.stateNode)) {
      const node = marks.drawn.get(at.stateNode);
      if (node) return { node, elements: [at.stateNode], component: false };
      continue;
    }
    const node = componentNode(marks, at);
    if (node) return { node, elements: elementsUnder(at, []), component: true };
  }
  // React's tree could not be read: the page's own elements still can.
  for (let element: Element | null = target; element; element = element.parentElement) {
    const node = marks.drawn.get(element);
    if (node) return { node, elements: [element], component: false };
  }
  return null;
}

/**
 * Everything under `root` drawn from the node at `start` of the composed
 * page: one entry for each time it was drawn (each pass of a loop, each use
 * of an imported page it is in).
 */
export function drawnAt(marks: EditMarks, root: Element, start: number): DrawnFrom[] {
  const found: DrawnFrom[] = [];
  let top: Fiber | null = null;
  const own = fiberOf(root);
  if (own) {
    top = onScreen(own)?.pop() ?? null;
  } else {
    // An element React was mounted in has no fiber of its own: from the top
    // of what is mounted in it.
    for (const element of Array.from(root.querySelectorAll('*'))) {
      const inside = fiberOf(element);
      if (inside) {
        top = onScreen(inside)?.[0] ?? null;
        break;
      }
    }
  }
  if (!top) {
    for (const element of Array.from(root.querySelectorAll('*'))) {
      const node = marks.drawn.get(element);
      if (node && node.loc.start === start) found.push({ node, elements: [element], component: false });
    }
    return found;
  }
  // Down React's tree, without recursion: a page may be deep.
  const stack: Fiber[] = top.child ? [top.child] : [];
  while (stack.length > 0) {
    const fiber = stack.pop()!;
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
    if (isElement(fiber.stateNode)) {
      const node = marks.drawn.get(fiber.stateNode);
      if (node && node.loc.start === start) found.push({ node, elements: [fiber.stateNode], component: false });
      continue;
    }
    const node = componentNode(marks, fiber);
    if (node && node.loc.start === start) found.push({ node, elements: elementsUnder(fiber, []), component: true });
  }
  return found;
}
