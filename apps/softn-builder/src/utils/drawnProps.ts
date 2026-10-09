/**
 * What a component drawn for real on the canvas is given.
 *
 * The canvas drew ten components by hand and every other as a card with its
 * name on it, so a page of Badges, Tabs and form controls was a stack of
 * grey cards. A component the registry marks as `drawn` is now mounted
 * itself (see DrawnComponent.tsx), and this is the one place that decides
 * what it is handed. The page is not running on the canvas: there is no
 * state, no logic and no data, so nothing may be evaluated.
 *
 *  - What is written as the value itself is passed as it is: `title="Hello"`,
 *    a bare `disabled`.
 *  - What is written in braces is read, not run. A value that is one all
 *    the way down (`{20}`, `{false}`, `{["A", "B"]}`, `{[{ label: "Home" }]}`)
 *    is that value: the registry's own starter lists are kept as such text,
 *    and without this a Steps would never show the steps its author wrote.
 *    Anything with a name, a call or an operator in it is an expression.
 *  - An expression where words are shown is shown as written, `{task.title}`.
 *    Anywhere else it is replaced by what the registry starts the component
 *    with, or left out so the component draws its own default: the text of
 *    an expression is never handed to a component as a number, a list, a
 *    record or a handler.
 *  - A handler is never passed: not an `@event`, not a `:bind`, and not a
 *    prop that is a function.
 *  - Nothing is passed that the browser would fetch as the component draws:
 *    not a picture's address, at any depth of a list, and not a style or a
 *    piece of markup that loads one (see withoutFetches below).
 */

import { cssResourceReferences, isSafeUrl, parse, sanitizeSvg } from '@softn/core';
import type { Expression } from '@softn/core';
import type { CanvasElement, ComponentMeta } from '../types/builder';

/** A value read from the text of an expression, or the news that it is not a plain value. */
type Read = { literal: true; value: unknown } | { literal: false };

const NOT_LITERAL: Read = { literal: false };

function read(node: Expression): Read {
  switch (node.type) {
    case 'Literal':
      return { literal: true, value: node.value };
    case 'UnaryExpression': {
      // A negative number is written with a sign, which is an operator.
      if (node.operator !== '-' && node.operator !== '+') return NOT_LITERAL;
      const of = read(node.argument);
      if (!of.literal || typeof of.value !== 'number') return NOT_LITERAL;
      return { literal: true, value: node.operator === '-' ? -of.value : of.value };
    }
    case 'TemplateLiteral':
      // Backticks with nothing put into them are a string.
      if (node.expressions.length > 0) return NOT_LITERAL;
      return { literal: true, value: node.quasis.map((part) => part.value.cooked).join('') };
    case 'ArrayExpression': {
      const items: unknown[] = [];
      for (const element of node.elements) {
        const item = read(element);
        if (!item.literal) return NOT_LITERAL;
        items.push(item.value);
      }
      return { literal: true, value: items };
    }
    case 'ObjectExpression': {
      const record: Record<string, unknown> = {};
      for (const property of node.properties) {
        // `...base`, `{ name }` and `{ [key]: 1 }` all read a name.
        if (property.type !== 'ObjectProperty' || property.shorthand || property.computedKey) return NOT_LITERAL;
        const value = read(property.value);
        if (!value.literal) return NOT_LITERAL;
        // A key a page can write must not reach the prototype of what is built.
        if (property.key === '__proto__') return NOT_LITERAL;
        record[property.key] = value.value;
      }
      return { literal: true, value: record };
    }
    default:
      return NOT_LITERAL;
  }
}

/** Expression text already read: the same text is read on every draw of the canvas. */
const readBefore = new Map<string, Read>();

/**
 * The value `text` is when it is one all the way down, without running
 * anything: `20`, `false`, `"a"`, `["A", "B"]`, `{ label: "Home" }`.
 */
export function readLiteral(text: string): Read {
  const known = readBefore.get(text);
  if (known) return known;
  let result: Read = NOT_LITERAL;
  try {
    const doc = parse(`<Probe v={${text}} />`);
    const [node, ...rest] = doc.template.filter((n) => n.type !== 'Text');
    if ((doc.diagnostics ?? []).length === 0 && node?.type === 'Element' && rest.length === 0) {
      const prop = node.props.length === 1 ? node.props[0] : undefined;
      if (prop?.name === 'v' && prop.value.type === 'expression') result = read(prop.value.value);
    }
  } catch {
    result = NOT_LITERAL;
  }
  if (readBefore.size > 2000) readBefore.clear();
  readBefore.set(text, result);
  return result;
}

/**
 * The props of each drawn component that show words: an expression written
 * for one of these is shown as written. Every other prop of an expression is
 * a size, a list, a choice, an address or a switch, where the text of an
 * expression would be the wrong kind of thing.
 */
export const WORDS: Readonly<Record<string, readonly string[]>> = {
  Badge: ['content'],
  Kbd: ['keys'],
  Divider: ['label'],
  Stat: ['label', 'value', 'prefix', 'suffix', 'change', 'changeLabel', 'helpText'],
  EmptyState: ['title', 'description'],
  Input: ['label', 'placeholder', 'helperText', 'value', 'defaultValue'],
  TextArea: ['label', 'placeholder', 'helperText', 'value', 'defaultValue'],
  Select: ['label', 'placeholder'],
  Checkbox: ['label', 'description'],
  Radio: ['label'],
  Switch: ['label', 'description'],
  NumberInput: ['placeholder'],
  DatePicker: ['label', 'placeholder'],
  ColorPicker: ['label'],
  Timeline: ['emptyText'],
  DescriptionList: ['emptyText'],
  Spinner: ['label'],
  Table: ['caption'],
  CopyButton: ['label', 'copiedLabel'],
};

/**
 * Props of the drawn components that are functions without being named as
 * handlers are (`onChange`). Held to the components' manifest by
 * drawnComponents.test.ts, so one that is added there fails here.
 */
const FUNCTIONS: Record<string, readonly string[]> = {
  Progress: ['formatLabel'],
  Select: ['createOptionText'],
  Slider: ['formatTooltip'],
};

/**
 * What React itself takes, and what the canvas decides for the component:
 * where the focus starts, and an `id`, which in the editor's own document
 * could be the `id` a label of the editor's points at.
 */
const NOT_THE_COMPONENTS = new Set(['key', 'ref', 'dangerouslySetInnerHTML', 'autoFocus', 'id', 'htmlFor', 'for', 'accessKey']);

/** Whether a prop of this name is never handed to a drawn component. */
export function neverPassed(componentType: string, name: string): boolean {
  return /^on[A-Z]/.test(name) || NOT_THE_COMPONENTS.has(name) || (FUNCTIONS[componentType]?.includes(name) ?? false);
}

/** Whether an expression written for this prop is shown as written. */
export function showsWords(componentType: string, name: string): boolean {
  return name === 'children' || (WORDS[componentType]?.includes(name) ?? false);
}

/** What the registry starts a component with for this prop, when that is a plain value. */
function started(meta: ComponentMeta, name: string): unknown {
  const starter = meta.defaultProps[name];
  if (starter !== undefined && starter !== null && starter !== '') return starter;
  return meta.propSchema.find((prop) => prop.name === name)?.default;
}

/*
 * Nothing drawn on the canvas makes the browser ask anything of a network.
 *
 * In a running app the renderer stands between a page and its components:
 * an address a component is given is judged by the app's permission to
 * reach that host, and held back until the person running it has agreed.
 * The canvas mounts the component itself, with no such permission to ask,
 * and a page is on the canvas the moment its file is opened: a picture
 * address in somebody else's bundle would be fetched by opening it to look.
 * So what would be fetched as the component draws is not handed over at
 * all, wherever in a value it is; a link, which nothing follows here, is
 * kept when it is one the runtime would write.
 */

/** Names under which a value is an address the browser fetches as the component draws. */
const FETCHED = new Set(['src', 'srcset', 'poster', 'fallbacksrc', 'xlinkhref', 'xlink:href']);
/** Names under which a value is a link: written into the page, and followed only when someone does. */
const LINKED = new Set(['href', 'formaction']);

/** How deep into a list of records an address is looked for; what is deeper is not handed on. */
const MAX_DEPTH = 24;

/** `value` with no address in it that would be fetched, at any depth. Undefined when nothing of it may be handed on. */
function withoutFetches(name: string, value: unknown, depth = 0): unknown {
  const lower = name.toLowerCase();
  if (FETCHED.has(lower)) return undefined;
  if (LINKED.has(lower)) return typeof value === 'string' && isSafeUrl(value) ? value : undefined;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => withoutFetches('', item, depth + 1)).filter((item) => item !== undefined);
  }
  const kept: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const safe = withoutFetches(key, inner, depth + 1);
    if (safe !== undefined) kept[key] = safe;
  }
  return kept;
}

/** A CSS property name as a React style object spells it. */
function styleName(name: string): string {
  if (name.startsWith('--')) return name;
  const camel = name.toLowerCase().replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return name.toLowerCase().startsWith('-ms-') ? `ms${camel.slice(2)}` : camel;
}

/** `style="gap: 8px; color: red"` as its declarations, split outside quotes and brackets. */
function declarations(text: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const take = (end: number) => {
    const declaration = text.slice(start, end);
    const colon = declaration.indexOf(':');
    if (colon > 0) {
      const name = declaration.slice(0, colon).trim();
      const value = declaration.slice(colon + 1).replace(/!\s*important\s*$/i, '').trim();
      if (value !== '' && /^-?-?[A-Za-z_][\w-]*$/.test(name)) found.push([name, value]);
    }
    start = end + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) take(i);
  }
  take(text.length);
  return found;
}

/**
 * The style a component is drawn with: what the page wrote, as the object
 * React takes, without any declaration that would load something (an image
 * in a background) or that says what it says in a way that cannot be read.
 */
function drawnStyle(written: unknown): Record<string, string | number> | undefined {
  const pairs: Array<[string, unknown]> =
    typeof written === 'string'
      ? declarations(written)
      : written !== null && typeof written === 'object' && !Array.isArray(written)
        ? Object.entries(written as Record<string, unknown>)
        : [];
  const style: Record<string, string | number> = {};
  for (const [name, value] of pairs) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      style[styleName(name)] = value;
    } else if (typeof value === 'string') {
      const scan = cssResourceReferences(value);
      if (!scan.opaque && scan.urls.length === 0) style[styleName(name)] = value;
    }
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

/**
 * The props a drawn component is mounted with for `element`. Nothing here
 * is run: see the rules at the head of this file.
 */
export function drawnProps(element: CanvasElement, meta: ComponentMeta): Record<string, unknown> {
  const type = element.componentType;
  const marked = new Set(element.expressionProps ?? []);
  const given: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(element.props)) {
    if (value === undefined || neverPassed(type, name)) continue;
    // The words of an element are text with their expressions in it already.
    if (name === 'children') {
      if (typeof value === 'string' || typeof value === 'number') given.children = String(value);
      continue;
    }
    let plain: unknown;
    if (!marked.has(name)) {
      plain = value;
    } else {
      const text = String(value);
      const written = readLiteral(text);
      if (written.literal) plain = written.value;
      else if (showsWords(type, name)) plain = `{${text}}`;
      else plain = started(meta, name);
    }
    if (plain === undefined) continue;

    if (name === 'style') {
      const style = drawnStyle(plain);
      if (style) given.style = style;
    } else if (name === 'class' || name === 'className') {
      // On a component `class` is its `className`, as the runtime has it.
      if (typeof plain === 'string' && plain.trim() !== '') given.className = given.className ? `${String(given.className)} ${plain}` : plain;
    } else if (name === 'svg' && typeof plain === 'string') {
      // Markup of the page's own: what in it would fetch is taken out here,
      // whatever the component would have let through for a running app.
      given.svg = sanitizeSvg(plain, () => false);
    } else {
      const safe = withoutFetches(name, plain);
      if (safe !== undefined) given[name] = safe;
    }
  }

  // A field bound to state shows what it is bound to, as an expression for
  // its value would be shown.
  const bound = element.bindings?.bind;
  if (typeof bound === 'string' && bound.trim() !== '' && showsWords(type, 'value') && given.value === undefined) {
    given.value = `{${bound.trim()}}`;
  }
  return given;
}
