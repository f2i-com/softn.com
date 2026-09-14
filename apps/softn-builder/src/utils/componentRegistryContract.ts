/**
 * What the Builder registry may say beyond a component's own props
 * interface, and which property-panel control each declared type may use.
 * `componentRegistry.manifest.test.ts` holds the registry to this; the
 * `check:components` script holds the names.
 */

import type { PropSchema } from '../types/builder';

/**
 * Props every element carries whether or not the component's interface
 * names them: the runtime's own attributes (`className`, `id`, `style`,
 * `children`), expression and event bindings the .ui format attaches to any
 * element, and the canvas-only fields the source generator strips.
 */
export const EDITORIAL_PROPS: ReadonlySet<string> = new Set([
  'className',
  'id',
  'style',
  'children',
  'key',
  'ref',
]);

/**
 * The controls a property of a given declared kind may be edited with. A
 * kind absent here (`other`, `array`, `node`, `unknown`, `function`) may use
 * any control: the registry is where an author decides that a union of
 * literals and string is a select, or that a handler is an event.
 */
export const PROP_TYPE_FOR_KIND: Record<string, ReadonlyArray<PropSchema['type']>> = {
  boolean: ['boolean', 'expression'],
  number: ['number', 'string', 'expression'],
  string: ['string', 'color', 'select', 'expression', 'json'],
  enum: ['select', 'string', 'expression'],
  function: ['event', 'expression'],
};
