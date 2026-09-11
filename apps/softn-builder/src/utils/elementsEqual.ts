/**
 * Whether two canvas element trees describe the same document.
 *
 * The canvas hands its elements back to the file store on every flush — a
 * save, an export, a pre-flight check, a switch of tabs — and the store
 * used to take each flush as an edit, regenerating the file's source from
 * the visual model whether or not anything had changed. A file opened from
 * a bundle and never touched came out rewritten: comments gone, grouped
 * expressions flattened, nested blocks collapsed. Comparing the trees is
 * what lets an unchanged flush be a no-op and the original bytes stay
 * authoritative until a real visual edit.
 *
 * Structural, not by reference: the canvas copies its map on load and on
 * every mutation, so identity says nothing. Order of keys in `props`,
 * `events` and `bindings` does not count; order of `children` does.
 */

import type { CanvasElement } from '../types/builder';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

function elementKey(el: CanvasElement): string {
  return JSON.stringify(
    canonical({
      id: el.id,
      componentType: el.componentType,
      props: el.props ?? {},
      events: el.events ?? {},
      bindings: el.bindings ?? {},
      expressionProps: [...(el.expressionProps ?? [])].sort(),
      children: el.children ?? [],
      parentId: el.parentId ?? null,
      // Any further fields the element carries count too.
      ...Object.fromEntries(Object.entries(el).filter(([k]) => !['id', 'componentType', 'props', 'events', 'bindings', 'expressionProps', 'children', 'parentId'].includes(k))),
    }),
  );
}

export function elementsEqual(a: Map<string, CanvasElement>, b: Map<string, CanvasElement>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [id, el] of a) {
    const other = b.get(id);
    if (!other) return false;
    if (el !== other && elementKey(el) !== elementKey(other)) return false;
  }
  return true;
}
