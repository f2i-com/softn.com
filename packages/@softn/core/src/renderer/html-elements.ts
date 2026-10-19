/**
 * What a page written as HTML needs from the renderer that React does not
 * do by itself: the SVG elements an icon is drawn with, the attribute names
 * React knows HTML's by, and a field that stays editable when it is given a
 * starting value.
 */

import type { ElementNode, TemplateNode } from '../parser/ast';
import type { SoftNProps } from '../types';
import { cssResourceReferences, SVG_ELEMENT_NAMES } from './sanitize-html';

/**
 * The SVG elements a page may draw inside an `<svg>`, by their lower-case
 * spelling, to the name SVG gives them. SVG is case-sensitive where HTML is
 * not, so `<clippath>` would be an element no browser knows. The list is
 * the sanitiser's for `<Icon svg>`: shapes, text, gradients and filters, and
 * nothing that runs code or loads from another site by itself. `svg` itself
 * is an HTML element of the renderer's, and `title` is the document's.
 */
const SVG_CHILD_ELEMENTS: ReadonlyMap<string, string> = new Map(
  SVG_ELEMENT_NAMES.filter((name) => name !== 'svg' && name !== 'title').map((name) => [
    name.toLowerCase(),
    name,
  ])
);

/**
 * The SVG element a tag names, written as SVG spells it (`clipPath`) or in
 * lower case (`clippath`), or undefined. A capitalised name is a component's
 * even when it is a shape's too: `<Text>` is SoftN's, never SVG's `<text>`.
 */
export function svgChildElement(tag: string): string | undefined {
  const name = SVG_CHILD_ELEMENTS.get(tag.toLowerCase());
  return name !== undefined && (tag === name || tag === name.toLowerCase()) ? name : undefined;
}

/**
 * HTML's attribute names, to the names React gives them. React writes an
 * unknown name through as it is, so `tabindex="0"` worked; but it drops a
 * boolean under an unknown name, so `<input readonly>` was not read-only
 * and `<input autofocus>` took no focus, and a development build complained
 * of every one. Only names that differ are here.
 */
const REACT_ATTRIBUTE_NAMES: Readonly<Record<string, string>> = {
  'accept-charset': 'acceptCharset',
  accesskey: 'accessKey',
  allowfullscreen: 'allowFullScreen',
  autocapitalize: 'autoCapitalize',
  autocomplete: 'autoComplete',
  autofocus: 'autoFocus',
  autoplay: 'autoPlay',
  cellpadding: 'cellPadding',
  cellspacing: 'cellSpacing',
  charset: 'charSet',
  colspan: 'colSpan',
  contenteditable: 'contentEditable',
  crossorigin: 'crossOrigin',
  datetime: 'dateTime',
  enctype: 'encType',
  enterkeyhint: 'enterKeyHint',
  for: 'htmlFor',
  formaction: 'formAction',
  formenctype: 'formEncType',
  formmethod: 'formMethod',
  formnovalidate: 'formNoValidate',
  formtarget: 'formTarget',
  hreflang: 'hrefLang',
  inputmode: 'inputMode',
  maxlength: 'maxLength',
  minlength: 'minLength',
  novalidate: 'noValidate',
  playsinline: 'playsInline',
  readonly: 'readOnly',
  referrerpolicy: 'referrerPolicy',
  rowspan: 'rowSpan',
  spellcheck: 'spellCheck',
  srcset: 'srcSet',
  tabindex: 'tabIndex',
  usemap: 'useMap',
};

/** Rename the HTML attributes of a plain element to React's names for them. */
export function renameToReactAttributes(props: SoftNProps): void {
  for (const name of Object.keys(props)) {
    const react = REACT_ATTRIBUTE_NAMES[name];
    if (!react) continue;
    if (!(react in props)) props[react] = props[name];
    delete props[name];
  }
}

/** The `<input type>`s a person types a value into. */
const TEXT_ENTRY_TYPES: ReadonlySet<string> = new Set([
  'text',
  'email',
  'password',
  'search',
  'tel',
  'url',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
  'color',
  'range',
]);

/**
 * A field given a starting value in its markup, `<input value="Ada">` or
 * `<input type="checkbox" checked>`, starts with it and can be changed, as
 * in HTML. React takes `value` and `checked` for the field's whole state,
 * so a field with nothing to change them was frozen on what was written and
 * every keystroke was undone. A field the page keeps in step itself (with
 * `:bind`, a binding of `value` or `checked`, or a handler for its changes)
 * or one marked `readonly` is left as it is.
 */
export function keepFieldEditable(tag: string, node: ElementNode, props: SoftNProps): void {
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
  if (props.onChange !== undefined || props.onInput !== undefined || props.readOnly) return;
  if (node.bindings.some((binding) => ['bind', 'value', 'checked'].includes(binding.name))) return;
  const written = (name: string): boolean =>
    name in props && node.props.some((prop) => prop.name === name && prop.value.type !== 'expression');
  const type = typeof props.type === 'string' ? props.type.toLowerCase() : 'text';
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
    if (written('checked') && !('defaultChecked' in props)) {
      props.defaultChecked = props.checked;
      delete props.checked;
    }
    return;
  }
  if (tag === 'input' && !TEXT_ENTRY_TYPES.has(type)) return;
  if (written('value') && !('defaultValue' in props)) {
    props.defaultValue = props.value;
    delete props.value;
  }
}

/**
 * The text a `<textarea>` holds, written between its tags: words and `{…}`
 * values, joined. Undefined when it holds anything else. React takes a
 * textarea's text as its value only, and drew the content it was given as
 * children as "[object Object]".
 */
export function textareaText(
  children: readonly TemplateNode[],
  evaluate: (node: TemplateNode & { type: 'Expression' }) => unknown
): string | undefined {
  let text = '';
  for (const child of children) {
    if (child.type === 'Text') {
      text += child.content;
    } else if (child.type === 'Expression') {
      const value = evaluate(child);
      text += value === undefined || value === null || value === false ? '' : String(value);
    } else {
      return undefined;
    }
  }
  return text;
}

/**
 * Whether a value names something an SVG element would load from outside
 * the app: `fill="url(https://…#paint)"`, `filter="url(other.svg#blur)"`.
 * A reference to something in the page, `url(#gradient)`, is how a shape
 * names its gradient, and stays. The `<svg>` root was always allowed, and
 * these are fetches no `src` names, so no URL check ever saw them.
 */
export function loadsFromOutside(value: unknown): boolean {
  if (typeof value !== 'string' || !/\(/.test(value)) return false;
  const scan = cssResourceReferences(value);
  return scan.opaque || scan.urls.some((url) => !url.trim().startsWith('#'));
}
