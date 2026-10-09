/**
 * What a component dropped from the palette starts with.
 *
 * Every registry entry says what a new instance of its component should
 * have: a Button's label, a Text's words, a Steps' three steps, a chart's
 * height. Nothing read it. A dropped element was created with no props at
 * all, the canvas drew a placeholder of its own where the label would be
 * ("Button"), and the source that was generated, and so the app that ran,
 * was a bare `<Button />`: a button with nothing on it, a heading with no
 * words, a list with no steps. What the creator saw on the canvas was not
 * what they had made.
 *
 * The values are kept the way the source parser keeps them, so an element
 * that has just been dropped is the element the same file gives back when it
 * is reopened: text is text, `true` is a bare attribute, and anything written
 * in braces (a number, `false`, a list, a record) is its expression text,
 * printed as the parser prints it, and named in `expressionProps`.
 */

import { parse } from '@softn/core';
import type { CanvasElement } from '../types/builder';
import { getComponentMeta } from './componentRegistry';
import { printExpressionSafe } from './expressionPrinter';

export interface StarterProps {
  props: CanvasElement['props'];
  expressionProps: string[];
}

/** `value` as the text the visual model keeps for `name={value}`, or null when it is not an expression. */
function expressionText(source: string): string | null {
  const doc = parse(`<Box v={${source}} />`);
  if ((doc.diagnostics ?? []).length > 0) return null;
  const box = doc.template[0];
  if (!box || box.type !== 'Element') return null;
  const prop = box.props.find((p) => p.name === 'v');
  if (!prop || prop.value.type !== 'expression') return null;
  const printed = printExpressionSafe(prop.value.value);
  return printed.diagnostics.length > 0 ? null : printed.text;
}

/** The props, and which of them are expressions, a new element of this type is given. Empty for a type with no entry. */
export function starterProps(type: string): StarterProps {
  const starter: StarterProps = { props: {}, expressionProps: [] };
  const meta = getComponentMeta(type);
  if (!meta) return starter;

  for (const [name, value] of Object.entries(meta.defaultProps)) {
    if (value === undefined || value === null || value === '') continue;
    if (name === 'children') {
      if (typeof value === 'string' || typeof value === 'number') starter.props.children = String(value);
      continue;
    }
    if (value === true) {
      starter.props[name] = true;
      continue;
    }
    // A string the entry types as an expression or JSON is source text
    // already ("[]"); any other string is the attribute's text.
    const schema = meta.propSchema.find((prop) => prop.name === name);
    if (typeof value === 'string' && schema?.type !== 'expression' && schema?.type !== 'json') {
      starter.props[name] = value;
      continue;
    }
    const text = expressionText(typeof value === 'string' ? value : JSON.stringify(value));
    // An entry whose value cannot be written is left out, not written wrong.
    if (text === null) continue;
    starter.props[name] = text;
    starter.expressionProps.push(name);
  }
  return starter;
}
