/**
 * What a field of the property panel shows for a property, and what the
 * model holds after the field is changed.
 *
 * The model keeps a property as a value and a mark: whether the value is an
 * expression, written in braces (`open={showModal}`), or is the value itself
 * (`title="Hello"`, `rows={4}`, a bare `disabled`). A field edits both at
 * once or it writes the wrong thing: text under an expression's mark is
 * `placeholder={Your name}`, which does not parse, and an expression without
 * its mark is `open="showModal"`, which is text and always true.
 *
 * One rule covers every field. A field the registry types as an expression
 * (or as JSON, which is an expression that is a list or a record) holds an
 * expression and nothing else. Every other field holds a plain value, and a
 * property that is an expression where a plain value was expected is shown
 * as the expression it is: in braces in a text field, and as an expression
 * field in place of a checkbox, a number or a list of choices, which have no
 * way to show one.
 */

import { parse } from '@softn/core';
import type { CanvasElement, PropSchema } from '../types/builder';

/** A property as the model holds it. `value` undefined is a property that is not written. */
export interface PropState {
  value: unknown;
  isExpression: boolean;
}

/** The property `name` of `element` as the model holds it. */
export function propState(element: CanvasElement, name: string): PropState {
  return { value: element.props[name], isExpression: (element.expressionProps ?? []).includes(name) };
}

/** Whether `text` is one whole expression, as it would stand between an attribute's braces. */
export function isExpressionText(text: string): boolean {
  if (text.trim() === '') return false;
  try {
    const doc = parse(`<Probe v={${text}} />`);
    if ((doc.diagnostics ?? []).length > 0) return false;
    const [node, ...rest] = doc.template.filter((n) => n.type !== 'Text');
    if (!node || rest.length > 0 || node.type !== 'Element') return false;
    return node.props.length === 1 && node.props[0].name === 'v' && node.props[0].value.type === 'expression';
  } catch {
    return false;
  }
}

/**
 * The expression a person meant by `{…}` typed where an expression is
 * expected, or null when the braces are the expression's own. `{count}` is
 * typed for `count` (the field's own hint used to ask for braces), while
 * `{ a: 1 }` and `{ ...base }` are records.
 */
function unwrapped(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '' || inner.startsWith('...')) return null;
  // A colon or comma at the top level makes it a record.
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && (ch === ',' || (ch === ':' && !inner.slice(0, i).includes('?')))) return null;
  }
  return isExpressionText(inner) ? inner : null;
}

/** Which control a property is edited with. */
export type PropControl = 'string' | 'number' | 'boolean' | 'select' | 'color' | 'expression' | 'json';

/** A number written as a literal, which a number field can show. */
const NUMBER_LITERAL = /^-?(?:\d+\.?\d*|\.\d+)$/;

/**
 * The control for a property as it stands. A checkbox, a number field and a
 * list of choices show a plain value; given an expression they cannot show,
 * the property is edited as that expression until it is emptied.
 */
export function controlFor(propDef: PropSchema, state: PropState): PropControl {
  const declared = (['string', 'number', 'boolean', 'select', 'color', 'expression', 'json'] as const).find((t) => t === propDef.type) ?? 'string';
  if (!state.isExpression || typeof state.value !== 'string') return declared;
  const text = state.value.trim();
  switch (declared) {
    case 'boolean':
      return text === 'true' || text === 'false' ? 'boolean' : 'expression';
    case 'number':
      return NUMBER_LITERAL.test(text) ? 'number' : 'expression';
    case 'select':
    case 'color':
      return 'expression';
    default:
      return declared;
  }
}

/** What the control shows for the property. */
export function shownValue(propDef: PropSchema, state: PropState): string | number | boolean {
  const { value, isExpression } = state;
  switch (controlFor(propDef, state)) {
    case 'boolean':
      if (value === true || (isExpression && String(value).trim() === 'true')) return true;
      if (value === false || (isExpression && String(value).trim() === 'false')) return false;
      // Not written: the component does what it does by default.
      return value === undefined || value === null || value === '' ? propDef.default === true : Boolean(value);
    case 'number':
      if (isExpression) return Number(String(value).trim());
      return typeof value === 'number' ? value : '';
    case 'expression':
    case 'json':
      if (value === undefined || value === null) return '';
      if (isExpression) return String(value);
      // A plain value where an expression is expected, as the expression it is.
      return typeof value === 'object' ? JSON.stringify(value, null, 2) : JSON.stringify(value);
    case 'string':
      if (value === undefined || value === null) return '';
      // The words of an element are text with its expressions inline already.
      return isExpression && propDef.name !== 'children' ? `{${String(value)}}` : String(value);
    default:
      return value === undefined || value === null ? '' : String(value);
  }
}

/**
 * The property after `input` is entered in its control, or null when the
 * input is not yet something to write (an expression half typed) and the
 * model should stay as it is.
 */
export function writtenValue(propDef: PropSchema, state: PropState, input: string | number | boolean): PropState | null {
  const removed: PropState = { value: undefined, isExpression: false };
  switch (controlFor(propDef, state)) {
    case 'boolean': {
      const on = input === true;
      // The component's own default is written as nothing at all.
      if (on === (propDef.default === true)) return removed;
      return on ? { value: true, isExpression: false } : { value: 'false', isExpression: true };
    }
    case 'number': {
      if (input === '' || input === undefined || input === null) return removed;
      const number = Number(input);
      return Number.isFinite(number) ? { value: number, isExpression: false } : null;
    }
    case 'expression':
    case 'json': {
      const text = String(input);
      if (text.trim() === '') return removed;
      const meant = unwrapped(text) ?? text.trim();
      return isExpressionText(meant) ? { value: meant, isExpression: true } : null;
    }
    case 'string': {
      const text = String(input);
      if (text === '') return removed;
      if (propDef.name === 'children') return { value: text, isExpression: false };
      // Braces around one whole expression are an expression, as they are
      // in the source; anything else is the text it is.
      const trimmed = text.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}') && isExpressionText(trimmed.slice(1, -1))) {
        return { value: trimmed.slice(1, -1).trim(), isExpression: true };
      }
      return { value: text, isExpression: false };
    }
    default: {
      const text = String(input);
      return text === '' ? removed : { value: text, isExpression: false };
    }
  }
}

/** `element`'s props and expression marks with `name` set to `next`. */
export function withProp(
  element: CanvasElement,
  name: string,
  next: PropState
): Pick<CanvasElement, 'props' | 'expressionProps'> {
  const marks = (element.expressionProps ?? []).filter((prop) => prop !== name);
  if (next.isExpression && next.value !== undefined) marks.push(name);
  return { props: { ...element.props, [name]: next.value }, expressionProps: marks.length > 0 ? marks : undefined };
}
