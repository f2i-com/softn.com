/**
 * The fields offered for a picked element: the attributes written on it that
 * are plain values, and the ones it could be given. A component's come from
 * the component manifest (./componentProps.generated.ts, which is what the
 * Builder's property panel reads too); an HTML element's are the handful a
 * person most often sets by hand.
 */

import { COMPONENT_PROPS, type PlainProp } from './componentProps.generated';
import type { ElementSource, PlainValue } from './sourceEdits';

export interface Field {
  name: string;
  /** What it takes: words, a number, yes or no, or one of some words (`open`: or any others). */
  kind: 's' | 'n' | 'b' | 'choice';
  options?: readonly string[];
  open?: boolean;
  /** Its value as written; undefined when it is not written on the element. */
  value?: PlainValue;
  written: boolean;
}

const HTML_ALWAYS = ['class', 'id', 'title'];
const HTML_BY_TAG: Record<string, string[]> = {
  a: ['href', 'target'],
  img: ['src', 'alt', 'width', 'height'],
  input: ['type', 'name', 'placeholder', 'value'],
  textarea: ['name', 'placeholder', 'rows'],
  button: ['type'],
  label: ['for'],
  form: ['name'],
  select: ['name'],
  video: ['src', 'poster'],
  audio: ['src'],
  source: ['src', 'type'],
  iframe: ['src', 'title'],
};

/** A component as the page writes it: `<Button>`, not `<button>` or `<BUTTON>`. */
export function isComponentTag(tag: string): boolean {
  return /^[A-Z]/.test(tag) && tag !== tag.toUpperCase();
}

function fieldFor(name: string, declared: PlainProp | undefined, value: PlainValue | undefined, written: boolean): Field {
  if (Array.isArray(declared)) {
    const open = declared[declared.length - 1] === '*';
    return { name, kind: 'choice', options: open ? declared.slice(0, -1) : declared, open, value, written };
  }
  if (declared === 'n' || declared === 'b' || declared === 's') return { name, kind: declared, value, written };
  // Nothing says what it takes: as it is written.
  return { name, kind: typeof value === 'number' ? 'n' : typeof value === 'boolean' ? 'b' : 's', value, written };
}

/** The fields of an element: those written on it first, in the order written, then what it could be given. */
export function fieldsOf(element: ElementSource): { written: Field[]; more: Field[] } {
  const declared: Readonly<Record<string, PlainProp>> = isComponentTag(element.tag) ? (COMPONENT_PROPS[element.tag] ?? {}) : {};
  const written: Field[] = [];
  const seen = new Set<string>();
  for (const attribute of element.attributes) {
    seen.add(attribute.name);
    // One whose value the app works out is not a field: it is listed as written, and left to the source.
    if (attribute.value === undefined) continue;
    written.push(fieldFor(attribute.name, declared[attribute.name], attribute.value, true));
  }
  const names = isComponentTag(element.tag) ? Object.keys(declared) : [...HTML_ALWAYS, ...(HTML_BY_TAG[element.tag.toLowerCase()] ?? [])];
  const more = names.filter((name) => !seen.has(name)).map((name) => fieldFor(name, declared[name], undefined, false));
  return { written, more };
}

/** What a field is given when a person adds it and has not said what yet. */
export function firstValue(field: Field): PlainValue {
  if (field.kind === 'b') return true;
  if (field.kind === 'n') return 0;
  if (field.kind === 'choice' && field.options && field.options.length > 0) return field.options[0];
  return '';
}
