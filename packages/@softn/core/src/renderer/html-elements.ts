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
 * A `<form>` with nowhere to send what it holds keeps its page. A form with
 * no `action` is submitted to the page's own address, which reloads the host
 * page and with it the app, its state and what the person typed. So the way
 * an HTML page most often handles a form, `onsubmit="save(event)"` with
 * `event.preventDefault()` in the code, took the app away: the code runs
 * apart from the page and cannot cancel what the browser does. A form that
 * names an `action` still goes there, and `method="dialog"` still closes
 * its dialog.
 */
export function keepFormOnPage(props: SoftNProps): void {
  if (typeof props.action === 'string' && props.action.trim() !== '') return;
  if (typeof props.method === 'string' && props.method.trim().toLowerCase() === 'dialog') return;
  const given = props.onSubmit;
  props.onSubmit = (event: unknown, ...rest: unknown[]) => {
    (event as { preventDefault?: () => void } | null | undefined)?.preventDefault?.();
    return typeof given === 'function' ? (given as (...args: unknown[]) => unknown)(event, ...rest) : undefined;
  };
}

/**
 * A path a page names a file of its own by, `images/logo.png` or
 * `../images/logo.png`, as the bundle path it most likely means: from the
 * bundle's root, where an `index.html` stands, with no leading `./` or
 * `../` (nothing climbs out of a bundle). Null for anything else: an
 * address on another site, `data:` and `blob:`, a fragment, a path from the
 * site's root.
 */
export function bundlePathOf(written: string): string | null {
  const path = written.trim();
  if (path === '' || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/') || path.startsWith('#')) return null;
  const file = path.replace(/^(?:\.\.?\/)+/, '').split(/[?#]/)[0];
  return file === '' ? null : file;
}

/** The attributes a page names one of its files in, to be shown or played. */
const FILE_ATTRIBUTES = ['src', 'poster'] as const;

/**
 * `<img src="images/logo.png">`: a file of the app's, named as an HTML page
 * names one, is shown from the bundle, as `asset("images/logo.png")` would
 * show it. Read against the host page's address, it was a request for a
 * file the server does not have. A path the bundle does not carry is left
 * as written, so a deployment that serves its pictures beside the page still
 * shows them. Only a value written in the page: one an expression makes is
 * the author's to resolve.
 */
export function showBundleFiles(node: ElementNode, props: SoftNProps, asset: unknown): void {
  if (typeof asset !== 'function') return;
  for (const name of FILE_ATTRIBUTES) {
    const value = props[name];
    if (typeof value !== 'string') continue;
    if (!node.props.some((prop) => prop.name === name && prop.value.type === 'static')) continue;
    const path = bundlePathOf(value);
    if (path === null) continue;
    let url: unknown;
    try {
      url = (asset as (path: string) => unknown)(path);
    } catch {
      continue;
    }
    if (typeof url === 'string' && url !== '') props[name] = url;
  }
}

/**
 * The same for a stylesheet: `background: url(images/paper.png)` in a page's
 * `<style>` or in a stylesheet it links shows the bundle's file. Run on the
 * rules after they are sanitised, which removes every address that leaves
 * the bundle, so what is left that names a file is relative.
 */
export function showBundleFilesInStyles(css: string, resolve: ((path: string) => string) | undefined): string {
  if (!resolve || !/url\(/i.test(css)) return css;
  return css.replace(/url\(\s*(["']?)([^"')\s]+)\1\s*\)/gi, (whole, _quote: string, written: string) => {
    const path = bundlePathOf(written);
    if (path === null) return whole;
    let url = '';
    try {
      url = resolve(path);
    } catch {
      return whole;
    }
    return typeof url === 'string' && url !== '' ? `url("${url}")` : whole;
  });
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
