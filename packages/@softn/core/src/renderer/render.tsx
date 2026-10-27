/**
 * SoftN Renderer
 *
 * Converts SoftN AST to React elements.
 */

import React from 'react';
import type {
  SoftNDocument,
  TemplateNode,
  ElementNode,
  TextNode,
  ExpressionNode,
  IfBlock,
  EachBlock,
  Expression,
  SlotNode,
  TemplateSlotNode,
  BindingPattern,
  PropNode,
} from '../parser/ast';
import { EVENT_MODIFIERS, patternNames } from '../parser/ast';
import { VOID_ELEMENTS } from '../parser/html';
import type { SoftNRenderContext, SoftNProps } from '../types';
import { ComponentRegistry, SoftNComponent, type DeclaredPropKinds } from './registry';
import { cssPropertyName, inlineStyleObject } from './inline-style';
import { isCallbackProp } from '../runtime/drawn-functions';
import {
  beginPass,
  keep,
  recall,
  sameNodes,
  sameProps,
  settleProps,
  type ReuseKind,
  type ReusePass,
} from './reuse';
import type { DocumentShellView } from '../document-shell/host';
import {
  followPageLinks,
  keepFieldEditable,
  keepFormOnPage,
  showBundleFiles,
  textareaText,
  renameToReactAttributes,
  svgChildElement,
} from './html-elements';
import {
  dropCodeAttributes,
  dropDocumentName,
  dropRawMarkupProp,
  dropTopLayerProps,
  dropTopLayerStyle,
  egressPolicyFor,
  isPlainObject,
  keepOpenerFromLinks,
  sanitizeComponentUrlProps,
  sanitizeSvgReferences,
  sanitizeUrlProps,
  withholdRemoteStyleUrls,
} from './prop-safety';
import { isDevelopment } from './development';
import {
  BLOCKED_MEMBER_KEYS,
  beginDrawing,
  endDrawing,
  evaluateExpression,
  getExpressionPath,
  patternSuffixes,
  reportUnplacedWrite,
  takeApart,
  writableListPath,
} from './evaluate';

export { evaluateExpression };

/**
 * Per-component error boundary for isolating rendering failures.
 * When a registered SoftN component throws during render, this boundary
 * catches the error and shows an inline indicator instead of crashing the
 * entire document tree.
 */
class ComponentErrorBoundary extends React.Component<
  React.PropsWithChildren<{ tag: string; failure?: { caught: boolean } }>,
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Tell whoever kept this element that it holds a failure, so the next
    // drawing makes the component again rather than handing this back. A
    // component that failed has always been tried again when the page next
    // drew, which is how one recovers once whatever it lacked has arrived.
    if (this.props.failure) this.props.failure.caught = true;
    if (isDevelopment) {
      console.error(`[SoftN] Error in <${this.props.tag}>:`, error);
      console.error('[SoftN] Component stack:', info.componentStack);
    }
  }

  componentDidUpdate(prevProps: React.PropsWithChildren<{ tag: string }>) {
    // Auto-reset error state when children change (e.g., source code updated)
    if (this.state.error && prevProps.children !== this.props.children) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return React.createElement(
        'div',
        {
          style: {
            padding: '0.5rem 0.75rem',
            margin: '0.25rem 0',
            background: 'var(--softn-error-bg, #fef2f2)',
            border: '1px solid var(--softn-error-border, #fecaca)',
            borderRadius: '6px',
            color: 'var(--softn-error-text, #b91c1c)',
            fontSize: '0.75rem',
            fontFamily: 'ui-monospace, monospace',
            lineHeight: 1.5,
          },
        },
        React.createElement('strong', null, `<${this.props.tag}>`),
        ` ${this.state.error.message}`
      );
    }
    return this.props.children;
  }
}

/** A handler a template wires to an event. What it is given depends on the
 * component, so its arguments and result are whatever they turn out to be. */
type EventHandler = (...args: unknown[]) => unknown;

/**
 * For a change or input event, what changed rather than the event: VM
 * functions receive the field's value, not a React SyntheticEvent, which does
 * not survive the trip into a script. Anything that is not such an event --
 * a component that calls `@change` with its own data -- passes through.
 */
function changedValue(event: unknown): unknown {
  const target = eventTarget(event);
  return target && 'value' in target ? target.value : event;
}

/**
 * What `:bind` writes for a change: the field's value, and for a number
 * field the number it holds. A field's `value` is always text, so `<input
 * type="number" :bind={qty} />` made `qty` the string "5" and `qty + 1` in
 * the logic "51". A number field that holds a finite number writes it as a
 * number; one that is empty, or holds what is not a number, writes `''`, so a
 * page's `qty === ''` still means nothing was entered. Decided by the field
 * the event came from, so a component that hands on its input's event, as
 * `<Input type="number">` does, binds the same way.
 */
function boundValue(event: unknown): unknown {
  const target = eventTarget(event);
  if (!target || !('value' in target)) return event;
  const value = target.value;
  if (target.type !== 'number' || typeof value !== 'string') return value;
  if (value.trim() === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? number : '';
}

/** The `target` of something shaped like a DOM event, or `undefined` when it
 * is not one -- a custom component hands its handler plain data instead. */
function eventTarget(event: unknown): Record<string, unknown> | undefined {
  if (!event || typeof event !== 'object' || !('target' in event)) return undefined;
  const target = (event as { target: unknown }).target;
  return target && typeof target === 'object' ? (target as Record<string, unknown>) : undefined;
}

/**
 * Render a SoftN document to React elements
 */
export function renderDocument(
  document: SoftNDocument,
  context: SoftNRenderContext,
  registry: ComponentRegistry
): React.ReactNode {
  // A page whose code is given the document: its body is what the code has
  // made of it (see document-shell/host.ts).
  if (context.documentShell) {
    return React.createElement(ShellBody, { shell: context.documentShell, template: document.template, context, registry });
  }
  // A host that keeps a cache for this mount gets back, for everything that
  // comes out the same as last time, the element it was given last time; see
  // reuse.ts. Without one every element is made afresh.
  if (!context.renderCache) return renderNodes(document.template, context, registry);
  const outer = pass;
  pass = beginPass(context.renderCache, document);
  try {
    return renderNodes(document.template, context, registry);
  } finally {
    pass = outer;
  }
}

/**
 * What the page's code has put on its `html` and `body` (a class, a style,
 * a data attribute), as props for the app's own root element, which those
 * are in an app: drawn through the same checks as any element's, then the
 * few a root takes. An `id` is not one: the root is the host's element.
 */
export function rootProps(
  attrs: Record<string, string>,
  context: SoftNRenderContext,
  registry: ComponentRegistry
): Record<string, unknown> {
  const props: PropNode[] = [];
  const loc = { line: 0, column: 0, start: 0, end: 0 };
  for (const [name, value] of Object.entries(attrs)) props.push({ type: 'Prop', name, value: { type: 'static', value }, loc });
  const drawn = renderElement({ type: 'Element', tag: 'div', props, events: [], bindings: [], children: [], selfClosing: true, loc }, context, registry);
  const out: Record<string, unknown> = {};
  if (!React.isValidElement(drawn)) return out;
  for (const [name, value] of Object.entries(drawn.props as Record<string, unknown>)) {
    if (/^(?:className|style|lang|dir|title|role)$|^(?:data|aria)-/.test(name) && value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * The drawing in progress, when the host keeps what is drawn between one
 * render and the next. Module state, like the drawing depth (beginDrawing): a drawing is one
 * synchronous call, and the functions below are too many to hand it through.
 */
let pass: ReusePass | null = null;

/**
 * A fragment holding `children`, or the one this place had last time when
 * the children are the elements they were.
 */
function reusableFragment(
  node: object,
  kind: ReuseKind,
  cacheKey: number | string | undefined,
  reactKey: number | string | undefined,
  children: React.ReactNode
): React.ReactNode {
  const active = pass;
  if (!active || typeof cacheKey !== 'string' || !Array.isArray(children)) {
    return React.createElement(React.Fragment, { key: reactKey }, children);
  }
  const before = recall(active, cacheKey, node, kind);
  if (before && before.text === String(reactKey) && sameNodes(before.children, children)) {
    keep(active, cacheKey, before);
    return before.result;
  }
  const result = React.createElement(React.Fragment, { key: reactKey }, children);
  keep(active, cacheKey, { node, kind, result, children, text: String(reactKey) });
  return result;
}

/**
 * Generate a stable key for a template node based on its location
 */
function generateNodeKey(node: TemplateNode, index: number, parentKey?: string): string {
  const prefix = parentKey ? `${parentKey}-` : '';

  // Use source location if available for stable keys
  if (node.loc) {
    return `${prefix}${node.type}-L${node.loc.line}-C${node.loc.column}`;
  }

  // Fallback to index-based key (less stable but better than nothing)
  return `${prefix}${node.type}-${index}`;
}

/**
 * Render an array of template nodes
 */
export function renderNodes(
  nodes: TemplateNode[],
  context: SoftNRenderContext,
  registry: ComponentRegistry,
  parentKey?: string
): React.ReactNode {
  return nodes.map((node, index) => {
    const key = generateNodeKey(node, index, parentKey);
    return renderNode(node, context, registry, key);
  });
}

/**
 * Render a single template node
 */
export function renderNode(
  node: TemplateNode,
  context: SoftNRenderContext,
  registry: ComponentRegistry,
  key?: number | string
): React.ReactNode {
  const depth = beginDrawing();
  try {
    if (depth > MAX_NESTING) {
      if (!reportedTooDeep) {
        reportedTooDeep = true;
        console.warn(`[SoftN] This page nests more than ${MAX_NESTING} levels deep, elements and blocks together; what is deeper is not drawn.`);
      }
      return null;
    }
    return renderNodeOfKind(node, context, registry, key);
  } finally {
    endDrawing();
  }
}

/**
 * How deep a page is drawn, elements and blocks together; past it, nothing.
 * Browsers cap nesting too (Chromium's HTML parser stops at 512). Deeper,
 * drawing ran out of stack, at about 800 levels, and the app went with it.
 */
const MAX_NESTING = 512;
let reportedTooDeep = false;

function renderNodeOfKind(
  node: TemplateNode,
  context: SoftNRenderContext,
  registry: ComponentRegistry,
  key?: number | string
): React.ReactNode {
  switch (node.type) {
    case 'Element': {
      const shell = context.documentShell;
      const id = shell?.idOf(node);
      if (shell && id !== undefined) {
        return React.createElement(ShellElement, { key, shell, id, context, registry });
      }
      return renderElement(node, context, registry, key);
    }

    case 'Text':
      return renderText(node, key);

    case 'Expression':
      return renderExpression(node, context, key);

    case 'IfBlock':
      return renderIfBlock(node, context, registry, key);

    case 'EachBlock':
      return renderEachBlock(node, context, registry, key);

    case 'Slot':
      return renderSlot(node, context, registry, key);

    case 'TemplateSlot':
      // Template slots are collected by parent elements and passed via context
      // They should not be rendered directly - return null here
      return null;

    default:
      return null;
  }
}

/**
 * Safe-by-default HTML allowlist for untrusted bundles.
 * Excludes all active content tags (script, iframe, embed, object, etc.)
 * and document metadata tags that could bypass security policies.
 */
const HTML_ELEMENTS = new Set([
  // Content sectioning
  'address',
  'article',
  'aside',
  'footer',
  'header',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hgroup',
  'main',
  'nav',
  'section',
  'search',
  // Text content
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'hr',
  'li',
  'menu',
  'ol',
  'p',
  'pre',
  'ul',
  // Inline text semantics
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'data',
  'dfn',
  'em',
  'i',
  'kbd',
  'mark',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
  // Image and multimedia
  'area',
  'audio',
  'img',
  'map',
  'track',
  'video',
  // Safe embedded content (no active content loaders)
  'picture',
  'source',
  // SVG and MathML
  'svg',
  'math',
  // Canvas (drawing API, no script execution)
  'canvas',
  // Demarcating edits
  'del',
  'ins',
  // Table content
  'caption',
  'col',
  'colgroup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  // Forms
  'button',
  'datalist',
  'fieldset',
  'form',
  'input',
  'label',
  'legend',
  'meter',
  'optgroup',
  'option',
  'output',
  'progress',
  'select',
  'textarea',
  // Interactive elements
  'details',
  'dialog',
  'summary',
]);

/**
 * Explicitly blocked tags — active content, document metadata, and embedded
 * contexts that could execute code or load external resources in the host DOM.
 * Checked as a denylist safeguard even if the allowlist evolves.
 */
const BLOCKED_TAGS = new Set([
  'script',    // JS execution
  'iframe',    // embedded browsing context
  'embed',     // plugin content
  'object',    // plugin/embedded content
  'portal',    // embedded browsing context
  'link',      // external resource loading
  'meta',      // http-equiv redirects, CSP overrides
  'base',      // base URL hijacking
  'style',     // CSS injection (handled separately by sanitizer)
  'template',  // inert but can be activated by scripts
  'noscript',  // content injection when scripts disabled
  'html',      // document root
  'head',      // document metadata container
  'body',      // document body
  'title',     // document title
  'param',     // object parameters
  'slot',      // web component slot
]);

/**
 * Whether the document a page's code is given holds this tag as plain HTML
 * it may change: an element the renderer draws as itself, written in lower
 * case, and not an `<svg>`, whose inside is a drawing of its own.
 */
export function shellOwnsTag(tag: string): boolean {
  return tag === tag.toLowerCase() && tag !== 'svg' && isHTMLElement(tag);
}

interface ShellProps {
  shell: DocumentShellView;
  context: SoftNRenderContext;
  registry: ComponentRegistry;
}

/**
 * An element of the document the page's code is given: drawn as its markup
 * says, with what the code has done to it over that, or as the markup for
 * an element the code made would be, through the renderer's one path for
 * elements and its checks. Drawn again when the code changes it, and no
 * more than it.
 */
function ShellElement({ shell, id, context, registry }: ShellProps & { id: number }): React.ReactElement {
  const subscribe = React.useCallback((onChange: () => void) => shell.subscribe(id, onChange), [shell, id]);
  const read = () => shell.version(id);
  const version = React.useSyncExternalStore(subscribe, read, read);
  // A value, a tick or focus the code asked for is the drawn element's own
  // state, not markup: done to it once it is on the page.
  React.useLayoutEffect(() => shell.settle(id), [shell, id, version]);
  return React.createElement(React.Fragment, null, renderElement(shell.elementFor(id), context, registry));
}

/** The page's body, as the code has made it. */
function ShellBody({ shell, template, context, registry }: ShellProps & { template: TemplateNode[] }): React.ReactElement {
  const subscribe = React.useCallback((onChange: () => void) => shell.subscribe(shell.bodyId, onChange), [shell]);
  const read = () => shell.version(shell.bodyId);
  React.useSyncExternalStore(subscribe, read, read);
  return React.createElement(React.Fragment, null, renderNodes(shell.bodyFor(template), context, registry));
}

/**
 * A component's props given the kinds it declares (DeclaredPropKinds), from
 * what the page wrote. A number written as text, as an HTML page writes every
 * attribute (`<Progress value="40">`, `<Rating max="7">`), is the number: a
 * component that asks `Number.isFinite(value)` showed 0, and one that adds to
 * it joined text (`5 + "1"` was page "51"). A number where a yes or no goes
 * (`required={0}`, `checked={count}`) is that yes or no: `{flag && …}` drew
 * the 0 as text, and `aria-checked="1"` is no value a screen reader reads.
 * Text that is no number, and anything that is not a number or text, reach
 * the component as written.
 */
function coerceDeclaredProps(props: SoftNProps, kinds: DeclaredPropKinds | undefined): void {
  if (!kinds) return;
  for (const name of kinds.numbers ?? []) {
    const number = numberWritten(props[name]);
    if (number !== undefined) props[name] = number;
  }
  for (const [name, choices] of Object.entries(kinds.choices ?? {})) {
    const number = numberWritten(props[name]);
    if (number !== undefined && choices.includes(number)) props[name] = number;
  }
  for (const name of kinds.booleans ?? []) {
    if (typeof props[name] === 'number') props[name] = Boolean(props[name]);
  }
}

/** The finite number `value` is written as, when it is text that writes one (`"40"`, `" 2.5 "`). */
function numberWritten(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * Check if a tag is a valid HTML element (safe for untrusted rendering)
 */
function isHTMLElement(tag: string): boolean {
  const lower = tag.toLowerCase();
  if (BLOCKED_TAGS.has(lower)) return false;
  return HTML_ELEMENTS.has(lower);
}

/** How a modal <dialog> is drawn: over the app, with the app dimmed behind it. */
const MODAL_DIALOG: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  margin: 'auto',
  zIndex: 2147483000,
  maxWidth: 'calc(100% - 2em)',
  maxHeight: 'calc(100% - 2em)',
  boxShadow: '0 0 0 100vmax rgba(0, 0, 0, 0.45)',
};

/** HTML's boolean attributes: on when present, whatever their value says. */
const HTML_BOOLEAN_ATTRIBUTES = new Set([
  'allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled',
  'formnovalidate', 'hidden', 'inert', 'ismap', 'itemscope', 'loop', 'multiple', 'muted', 'nomodule',
  'novalidate', 'open', 'playsinline', 'readonly', 'required', 'reversed', 'selected',
]);

/**
 * Get a unified context for event handlers and callbacks.
 * Cached on the context object to avoid re-creating per element (~100+ elements per render).
 */
const _callbackCtxCache = new WeakMap<SoftNRenderContext, SoftNRenderContext>();
function createCallbackContext(context: SoftNRenderContext): SoftNRenderContext {
  let cached = _callbackCtxCache.get(context);
  if (cached) return cached;
  cached = { ...context, functions: callbackFunctions(context) };
  _callbackCtxCache.set(context, cached);
  return cached;
}

/**
 * The functions a callback may call: the app's, with the state-tracking
 * version of each in place of the plain one. Kept for the pair of tables it
 * was made from. Every row of a loop is drawn in a context of its own, and
 * each of them used to merge the two tables again.
 */
type FunctionTable = SoftNRenderContext['functions'];
const _callbackFunctions = new WeakMap<FunctionTable, { tracked: FunctionTable; merged: FunctionTable }>();
function callbackFunctions(context: SoftNRenderContext): FunctionTable {
  const made = _callbackFunctions.get(context.functions);
  if (made && made.tracked === context.asyncFunctions) return made.merged;
  const merged = { ...context.functions, ...context.asyncFunctions };
  _callbackFunctions.set(context.functions, { tracked: context.asyncFunctions, merged });
  return merged;
}

/**
 * Apply an event's modifiers (`@submit.prevent`, `@keydown.enter`,
 * `@click.self`) around its handler.
 *
 * The filters come first: a key the event is not for, a held key that is not
 * down or a target that is not the element itself means the handler does not
 * run and the event is left alone. Then `prevent` and `stop` act on the
 * event, then the handler is called with what it would have been given.
 *
 * A component decides what its callback receives, and some hand over plain
 * data rather than an event. `prevent` and `stop` then have nothing to act
 * on and do nothing; a filter has nothing to test and does not pass.
 */
function withEventModifiers(handler: EventHandler, modifiers: readonly string[]): EventHandler {
  const keys: string[] = [];
  const held: string[] = [];
  for (const modifier of modifiers) {
    if (Object.hasOwn(EVENT_MODIFIERS.key, modifier)) keys.push(...EVENT_MODIFIERS.key[modifier]);
    if (Object.hasOwn(EVENT_MODIFIERS.held, modifier)) held.push(EVENT_MODIFIERS.held[modifier]);
  }
  const self = modifiers.includes('self');
  const prevent = modifiers.includes('prevent');
  const stop = modifiers.includes('stop');

  return (...args: unknown[]) => {
    const first = args[0];
    const event =
      typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : undefined;

    if (keys.length > 0 && !(event && typeof event.key === 'string' && keys.includes(event.key))) {
      return undefined;
    }
    if (held.some((flag) => !(event && event[flag] === true))) return undefined;
    if (self && !(event && event.target !== undefined && event.target === event.currentTarget)) {
      return undefined;
    }

    if (event) {
      if (prevent && typeof event.preventDefault === 'function') {
        (event.preventDefault as () => void).call(event);
      }
      if (stop && typeof event.stopPropagation === 'function') {
        (event.stopPropagation as () => void).call(event);
      }
    }
    return handler(...args);
  };
}

/**
 * Evaluate an expression that decides STRUCTURE — a condition or an iterable —
 * and survive it throwing.
 *
 * The same bad data should not be survivable in one position and fatal in
 * another. `{JSON.parse(raw).n}` in a text node is caught and shown as a small
 * inline marker; in a condition or an iterable it escaped the runtime's error
 * boundary and replaced the whole application with an error screen. Which one
 * you got depended only on where you had written it.
 *
 * Commit 8e9366b set out to fix all four positions and reached one: #if. #each,
 * inline `if=` and inline `each=` still tore the app down, which is how this
 * came back — the message said it was handled everywhere, so nobody looked.
 *
 * An unanswerable condition is false. An iterable that cannot be evaluated is
 * empty, which also means an `#each` renders its `#empty` fallback — the right
 * thing to put on screen when the list could not be worked out.
 */
function evaluateStructural<T>(
  expr: Expression,
  context: SoftNRenderContext,
  fallback: T,
  what: string
): unknown {
  try {
    return evaluateExpression(expr, context);
  } catch (error) {
    if (isDevelopment) {
      console.error(`[SoftN] ${what} threw; using ${JSON.stringify(fallback)}:`, error);
    }
    return fallback;
  }
}

/**
 * The class names a list or a record of conditions stands for: a list's
 * entries that are text, a record's keys whose values hold, either inside
 * the other. Anything else in a list (`false` from `cond && "name"`, `null`)
 * is nothing.
 */
function classText(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (value === null || typeof value !== 'object' || depth > 8) return '';
  const names = Array.isArray(value)
    ? value.map((entry) => classText(entry, depth + 1))
    : Object.keys(value as Record<string, unknown>).filter((name) => Boolean((value as Record<string, unknown>)[name]));
  return names.filter(Boolean).join(' ');
}

/**
 * The components a `selectTo="path"` is wired for: the chosen row is written
 * to `path` from their `onSelect` (see renderElement). By tag name, as
 * BOUND_STATE is, and only where a component declares the prop.
 */
const SELECT_TO_TAGS: ReadonlySet<string> = new Set(['SmartGrid']);

/**
 * Write `value` at `path` as a page writes state: through the handler a
 * parent gave for it (`on<Root>Change`, or `onUpdate`), not at all where the
 * root is a read-only prop, or into the app's own state.
 */
function writeStateAt(path: string, value: unknown, context: SoftNRenderContext): void {
  const rootVar = path.split('.')[0].split('[')[0]; // Handle array access
  // Look for an external handler first (on[VarName]Change or onUpdate)
  // This allows parent components to manage state externally
  const updateHandler = context.functions[`on${capitalize(rootVar)}Change`] || context.functions['onUpdate'];
  if (typeof updateHandler === 'function') {
    updateHandler(path, value);
  } else if (rootVar in context.props) {
    // Props are read-only and no handler was provided
    if (isDevelopment) {
      console.warn(
        `Cannot update prop "${path}" directly. Props are read-only. ` +
          `Define an on${capitalize(rootVar)}Change or onUpdate handler to propagate changes.`
      );
    }
  } else {
    // It's internal state - update directly
    context.setState(path, value);
  }
}

/**
 * What `:bind` holds on a component whose state is not called `value`.
 *
 * `:bind` gives a control the variable as `value` and writes back what its
 * `onChange` reports. A Modal has neither: it is `open`, and it asks to be
 * shut through `onClose`. Bound the ordinary way it was handed a `value` it
 * does not read and an `onChange` it never calls, so every page that opens
 * a dialog carried a function whose whole body was `showAdd = false`.
 *
 * `prop` is given the variable (as a plain true or false where `flag`);
 * each callback in `writes` writes it, with the callback's own argument or
 * with the value fixed here. By tag name, as the checkable controls are:
 * a component is registered lazily and cannot be asked before it is drawn.
 */
const BOUND_STATE: Record<string, { prop: string; flag?: boolean; writes: Array<[callback: string, fixed?: unknown]> }> = {
  Modal: { prop: 'open', flag: true, writes: [['onClose', false]] },
  Drawer: { prop: 'open', flag: true, writes: [['onClose', false]] },
  // Either answer ends the question; the answer itself is still `@confirm`.
  Confirm: { prop: 'open', flag: true, writes: [['onCancel', false], ['onConfirm', false]] },
  Popover: { prop: 'open', flag: true, writes: [['onOpenChange']] },
  Tooltip: { prop: 'open', flag: true, writes: [['onOpenChange']] },
  Collapse: { prop: 'isOpen', flag: true, writes: [] },
  Sidebar: { prop: 'collapsed', flag: true, writes: [['onCollapse']] },
  Tabs: { prop: 'activeKey', writes: [['onChange']] },
  Pagination: { prop: 'currentPage', writes: [['onPageChange']] },
  Accordion: { prop: 'openKeys', writes: [['onChange']] },
};

/**
 * Render an element node
 * Supports inline conditionals (if=) and loops (each=/as=)
 */
function renderElement(
  node: ElementNode,
  context: SoftNRenderContext,
  registry: ComponentRegistry,
  key?: number | string,
  inLoopPass = false
): React.ReactNode {
  // Check inline conditional first.
  //
  // Not when the element also loops: such a condition almost always names the
  // loop variable, which is not bound out here, so testing it now answers
  // falsy and drops the whole loop. The per-item recursion below re-enters
  // with the variable bound and keeps `conditionalIf`, which is where an
  // `each` + `if` pair is meant to be resolved.
  if (node.conditionalIf && (inLoopPass || !node.inlineEach)) {
    const condition = evaluateStructural(node.conditionalIf, context, false, 'if= condition');
    if (!condition) {
      return null; // Don't render if condition is falsy
    }
  }

  // Check for inline loop
  if (node.inlineEach && !inLoopPass) {
    const iterable = evaluateStructural(node.inlineEach.iterable, context, [], 'each= iterable');
    const { items, keys } = iterationOf(iterable);

    if (items.length === 0) {
      reportEachCount(node, iterable, 'each=');
      return null; // Don't render if iterable is empty
    }

    const binding = loopBinding(node.inlineEach.itemName, node.inlineEach.indexName);
    const list = writableListPath(node.inlineEach.iterable, context);

    // Render element once per item
    const renderedItems = items.map((item, index) => {
      const iterContext = loopPassContext(context, binding, list, item, index, keys?.[index]);

      // Generate a unique key for each iteration
      const itemKey =
        typeof item === 'object' && item !== null && 'id' in item
          ? String((item as { id: unknown }).id)
          : (keys?.[index] ?? String(index));

      // The same element, drawn for this pass rather than looped again.
      return renderElement(node, iterContext, registry, `${key}-${itemKey}`, true);
    });

    return reusableFragment(node, 'each', key, key, renderedItems);
  }

  // A <template> is never drawn, as in a browser: what it holds is for the
  // page's code to copy (document-shell/), not something on the page.
  if (node.tag === 'template' && !registry.get(node.tag)) return null;

  // First, check the registry for a custom component
  let Component: SoftNComponent | keyof JSX.IntrinsicElements | undefined = registry.get(node.tag);

  // If not in registry, check if it's a valid HTML element
  if (!Component) {
    if (isHTMLElement(node.tag)) {
      // Use the lowercase HTML tag as the component
      Component = node.tag.toLowerCase() as keyof JSX.IntrinsicElements;
    } else if (svgChildElement(node.tag)) {
      // A shape inside an `<svg>`, by the name SVG gives it. Only `svg` was
      // allowed, so an icon drew "Unknown component" for each of its paths.
      Component = svgChildElement(node.tag) as keyof JSX.IntrinsicElements;
    } else if (registry.resolveName(node.tag) !== undefined) {
      // A component's name written in another case: `<datagrid>` is
      // DataGrid, `<STACK>` is Stack (see ComponentRegistry.resolveName).
      Component = registry.get(registry.resolveName(node.tag)!) as SoftNComponent;
    } else {
      if (isDevelopment) {
        console.warn(
          `Unknown component: ${node.tag}. Not a registered component or valid HTML element.`
        );
      }
      // Return a visible error placeholder in development
      return React.createElement(
        'div',
        {
          key,
          style: {
            padding: '0.5rem',
            margin: '0.25rem',
            background: 'var(--softn-error-bg, #fef2f2)',
            border: '1px solid var(--softn-error-border, #fecaca)',
            borderRadius: '0.25rem',
            color: 'var(--softn-error-text, #b91c1c)',
            fontSize: '0.875rem',
            fontFamily: 'monospace',
          },
        },
        `Unknown component: <${node.tag}>`
      );
    }
  }

  // TypeScript guard: Component is now definitely defined
  const FinalComponent = Component;

  // Build props
  const props: SoftNProps = { key };

  // The unified context for callbacks, made when the element has one.
  let madeCallbackContext: SoftNRenderContext | undefined;
  const callbackContext = (): SoftNRenderContext =>
    (madeCallbackContext ??= createCallbackContext(context));

  // Static and dynamic props
  // `class:active={cond}` adds "active" to the class list when the condition
  // holds, and contributes nothing when it does not. Collected here and merged
  // after the loop so it composes with a plain `class="card"` instead of
  // fighting it for the same prop slot.
  const classToggles: string[] = [];
  // `style:color={accent}` sets one style property and leaves the rest of
  // `style` alone, the way `class:` does for one class. Merged after the
  // bindings below, so it also composes with a `:style` binding.
  let styleDirectives: Record<string, unknown> | null = null;

  for (const prop of node.props) {
    if (prop.name.startsWith('class:')) {
      const cssClass = prop.name.slice('class:'.length);
      let on: unknown;
      if (prop.value.type === 'expression') {
        try {
          on = evaluateExpression(prop.value.value, context);
        } catch (error) {
          if (isDevelopment) {
            console.warn(`Error evaluating class:${cssClass} on <${node.tag}>:`, error);
          }
          on = false;
        }
      } else {
        on = prop.value.value;
      }
      if (on) classToggles.push(cssClass);
      continue;
    }
    if (prop.name.startsWith('style:')) {
      const cssProperty = prop.name.slice('style:'.length);
      let value: unknown;
      if (prop.value.type === 'expression') {
        try {
          value = evaluateExpression(prop.value.value, context);
        } catch (error) {
          if (isDevelopment) {
            console.warn(`Error evaluating style:${cssProperty} on <${node.tag}>:`, error);
          }
          value = undefined;
        }
      } else {
        value = prop.value.value;
      }
      // Nothing to say is nothing set: `style:color={error && "red"}` leaves
      // the colour to the stylesheet when there is no error.
      if (typeof value === 'string' ? value !== '' : typeof value === 'number' && Number.isFinite(value)) {
        if (!styleDirectives) styleDirectives = {};
        styleDirectives[cssPropertyName(cssProperty)] = value;
      }
      continue;
    }
    if (prop.value.type === 'static' || prop.value.type === 'number' || prop.value.type === 'boolean') {
      props[prop.name] = prop.value.value;
      // In HTML an attribute like `disabled` is on when it is there, whatever
      // it says: `disabled=""` and `hidden="hidden"` both mean yes. React reads
      // the empty string as no, so `<input disabled="">`, and an element a
      // script hid with `el.hidden = true`, were drawn as if it were not there.
      if (typeof FinalComponent === 'string' && prop.value.type === 'static' && HTML_BOOLEAN_ATTRIBUTES.has(prop.name.toLowerCase())) {
        props[prop.name] = true;
      }
    } else {
      try {
        // Use callbackContext for props that look like callbacks (on*) to ensure
        // state changes from these handlers trigger re-renders
        const isCallback = isCallbackProp(prop.name);
        const evalContext = isCallback ? callbackContext() : context;

        // `onClick={doThing()}` names the call to make on click, not a value to
        // compute now — the same reading `@click={doThing()}` already gets from
        // the events loop below. Evaluating it here ran the handler on every
        // render and then passed its return value as the callback.
        // An assignment or `++` is the same: `onClose={open = false}` says
        // what to do when it closes, as `@close={open = false}` does.
        const deferred = prop.value.value.type;
        if (
          isCallback &&
          (deferred === 'CallExpression' || deferred === 'AssignmentExpression' || deferred === 'UpdateExpression')
        ) {
          const callExpr = prop.value.value;
          props[prop.name] = () => evaluateExpression(callExpr, evalContext);
          continue;
        }

        const evaluated = evaluateExpression(prop.value.value, evalContext);

        props[prop.name] = evaluated;
      } catch (error) {
        if (isDevelopment) {
          console.warn(`Error evaluating prop "${prop.name}" on <${node.tag}>:`, error);
        }
        props[prop.name] = undefined;
      }
    }
  }

  // A class written as a list or a record of conditions is the text it
  // stands for. React writes a list joined by commas and a record as
  // "[object Object]", and the element had none of its classes.
  for (const key of ['className', 'class'] as const) {
    const given = props[key];
    if (given !== null && typeof given === 'object') {
      const text = classText(given);
      if (text) props[key] = text;
      else delete props[key];
    }
  }

  // `class` is `className`: the word HTML teaches, under the name React has
  // for it.
  //
  // On a component, because a component reads only the second: `<Heading
  // class="title">` was drawn with no class and the rule written for it never
  // applied, with nothing to say so. On a plain tag, because React writes
  // the attribute for either word but a development build reports the first
  // — "Invalid DOM property `class`. Did you mean `className`?" — once for
  // every kind of element that carries it, about markup written the way the
  // documentation writes it. A `className` written beside it is kept, and
  // the two are one list.
  //
  // A custom element (a tag with a hyphen) is left as it is written: React
  // hands such an element its attributes by the names they are given.
  const customElement = typeof FinalComponent === 'string' && FinalComponent.includes('-');
  const svgElement =
    typeof FinalComponent === 'string' &&
    (FinalComponent === 'svg' || svgChildElement(FinalComponent) !== undefined);
  if (!customElement && 'class' in props) {
    // What was drawn for a plain tag still is: a number was written as text.
    const plainTag = typeof FinalComponent === 'string';
    const written = [props.className, props.class]
      .map((value) => (plainTag && typeof value === 'number' ? String(value) : value))
      .filter((value) => typeof value === 'string' && value !== '');
    if (written.length > 0) props.className = written.join(' ');
    delete props.class;
  }

  if (classToggles.length > 0) {
    // Added to what was written. Only a custom element still has two words
    // for it, and there the one its author used is the one written back.
    const key = customElement && typeof props.className !== 'string' ? 'class' : 'className';
    const base = typeof props[key] === 'string' ? (props[key] as string) : '';
    props[key] = [base, ...classToggles].filter(Boolean).join(' ');
  }

  // `for`, `readonly`, `tabindex`: HTML's names, as React knows them.
  if (typeof FinalComponent === 'string' && !customElement && !svgElement) {
    renameToReactAttributes(props);
  }

  // Bindings
  for (const binding of node.bindings) {
    let value: unknown;
    try {
      value = evaluateExpression(binding.expression, context);
    } catch (error) {
      if (isDevelopment) {
        console.warn(`Error evaluating binding ":${binding.name}" on <${node.tag}>:`, error);
      }
      value = undefined;
    }

    // A checkbox-shaped control carries its state in `checked`, not `value` —
    // its `value` is the constant "on". Binding `value` left `checked`
    // undefined, so the control ran uncontrolled and never reflected the bound
    // variable, while the change wrote the string "on" back over it.
    // One radio: a plain `<input type="radio">`, or a host's own Radio
    // that is one option with a `value`. The built-in Radio is a group: it
    // takes `options` and the chosen `value`, and hands its callback the new
    // one, like any other control that holds a value. Wired as one radio it
    // was told `checked` and never the value, so the chosen option was not
    // shown, and choosing one wrote the group's own `value` prop, which it
    // does not have: `undefined`, over the answer.
    const isRadio =
      props.type === 'radio' ||
      (node.tag === 'Radio' && props.options === undefined && props.value !== undefined);
    const isCheckable =
      node.tag === 'Checkbox' ||
      node.tag === 'Switch' ||
      props.type === 'checkbox' ||
      isRadio;

    const held = binding.name === 'bind' ? BOUND_STATE[node.tag] : undefined;

    // Write the bound variable: the row it is on inside a loop, through the
    // handler a parent gave for it, or the app's own state.
    const writeBound = (newValue: unknown): void => {
      const path = getExpressionPath(binding.expression, context);
      if (!path) {
        reportUnplacedWrite(binding.expression, context.locals);
        return;
      }
      writeStateAt(path, newValue, context);
    };

    // A callback the binding installs runs before one the page gave under
    // the same name as a prop, so the page's sees the variable written.
    const installBound = (name: string, write: (...args: unknown[]) => void): void => {
      const given = props[name];
      props[name] =
        typeof given === 'function'
          ? (...args: unknown[]) => {
              write(...args);
              return (given as (...a: unknown[]) => unknown)(...args);
            }
          : write;
    };

    if (held) {
      // A component whose state is not called `value`: see BOUND_STATE.
      props[held.prop] = held.flag ? value === true : value;
      for (const [callback, fixed] of held.writes) {
        installBound(callback, (argument: unknown) => writeBound(fixed === undefined ? argument : fixed));
      }
    } else if (binding.name === 'bind') {
      // Two-way binding shorthand
      // Default to "" when value is undefined/null to keep the input controlled
      // from the first render (avoids React "uncontrolled to controlled" warning)
      if (isRadio) {
        // A radio is checkable but not boolean. It is checked when the bound
        // variable equals THIS radio's value, and choosing it should write that
        // value. Treated as a checkbox it was `value === true` — never true for
        // a real choice — so every radio in the group rendered unchecked, and
        // clicking one wrote `true` over the selection, destroying the answer it
        // was meant to record.
        props.checked = value !== undefined && value !== null && String(value) === String(props.value);
      } else if (isCheckable) {
        props.checked = value === true;
      } else {
        props.value = value ?? '';
      }
      // Handle both native elements (pass event) and custom components (pass value directly)
      installBound('onChange', (eventOrValue: unknown) => {
        // Determine the new value:
        // - If it's an event object with target.value (native elements), use that
        // - Otherwise, treat the argument as the value directly (custom components like Select)
        let newValue: unknown;
        if (isRadio) {
          // The chosen option, not a boolean. A radio's `value` is the answer.
          newValue = props.value;
        } else if (isCheckable) {
          // Read `checked`, and as a boolean: `target.value` on a checkbox is
          // the constant "on", which would make the bound variable a string
          // that never compares false again.
          const target = eventTarget(eventOrValue);
          newValue = target ? Boolean(target.checked) : Boolean(eventOrValue);
        } else {
          // A native event's value, or the value a custom component such
          // as Select passed directly; a number field's as a number.
          newValue = boundValue(eventOrValue);
        }
        writeBound(newValue);
      });
    } else {
      props[binding.name] = value;
    }
  }

  // `<SmartGrid selectTo="picked" />`: keep the row the person chooses in
  // `picked`. The grid took the prop and did nothing with it, because a
  // component cannot write app state; the renderer can. It is taken off the
  // props, and the grid's `onSelect` writes the row first, by the rules
  // `:bind` writes by, then calls what the page gave, so an `@select` sees
  // the row written.
  if (SELECT_TO_TAGS.has(node.tag) && typeof props.selectTo === 'string' && props.selectTo !== '') {
    const path = props.selectTo;
    delete props.selectTo;
    const given = props.onSelect;
    props.onSelect = (row: unknown, ...rest: unknown[]) => {
      writeStateAt(path, row, context);
      return typeof given === 'function' ? (given as (...a: unknown[]) => unknown)(row, ...rest) : undefined;
    };
  }

  // Event handlers - use unified callback context
  // For change/input events, auto-extract target.value so VM functions
  // receive the string value instead of a React SyntheticEvent object.
  const wrapEventHandler = (name: string, fn: EventHandler, givenEvent = false) => {
    if ((name === 'change' || name === 'input') && !givenEvent) {
      return (e: unknown) => fn(changedValue(e));
    }
    // Everything else gets its arguments forwarded.
    //
    // These are not all DOM events: a component decides what it hands its own
    // callback, and several pass plain data — DPad gives `@press` the direction
    // pressed, and dropping it left every on-screen control doing nothing while
    // the keyboard path still worked. Where the argument really is a DOM event,
    // neither kind of handler holds it: the VM adapter reduces it to a plain
    // record before it can reach a script (see `sanitizeArgs`), and an arrow
    // written in the template is given that record with `preventDefault()`
    // and the element's own values added (see `markupValue`).
    return (...args: unknown[]) => fn(...args);
  };

  for (const event of node.events) {
    // What :bind already installed for this event, if anything.
    //
    // `<input :bind={q} @change={note()} />` used to lose its binding entirely:
    // the bindings loop sets onChange to write state back, and this loop then
    // assigned over it. The field stopped updating — every keystroke was
    // discarded and the input sat frozen on its initial value — while the
    // handler the author added ran perfectly, so nothing looked broken except
    // the typing. Both are wanted; both run, binding first so the handler sees
    // the new value.
    const boundHandlerName = reactEventProp(event.name);
    const boundHandler = props[boundHandlerName];

    // If the handler is a function call (e.g., @click={handleClick()}),
    // we need to wrap it in a closure to prevent immediate execution during render.
    // If it's a function reference or arrow function, evaluate it directly.
    const handlerExpr = event.handler;
    const handlerContext = callbackContext();

    if (handlerExpr.type === 'CallExpression') {
      // Wrap in closure - execute the call when the event fires
      props[reactEventProp(event.name)] = wrapEventHandler(event.name, () => {
        return evaluateExpression(handlerExpr, handlerContext);
      });
    } else if (handlerExpr.type === 'ArrowFunctionExpression') {
      // Arrow functions are already deferred - evaluate to get the function
      const handler = evaluateExpression(handlerExpr, handlerContext);
      props[reactEventProp(event.name)] =
        typeof handler === 'function'
          ? wrapEventHandler(event.name, handler as EventHandler, event.quoted === true)
          : handler;
    } else if (handlerExpr.type === 'Identifier' || handlerExpr.type === 'MemberExpression') {
      // Function reference - evaluate to get the function, wrap to ensure it's callable
      const handler = evaluateExpression(handlerExpr, handlerContext);
      if (typeof handler === 'function') {
        props[reactEventProp(event.name)] = wrapEventHandler(event.name, handler as EventHandler);
      } else {
        // If not a function, wrap in a no-op to prevent errors.
        // Only warn if the script has finished loading — before that, functions
        // aren't available yet and this is expected.
        if (isDevelopment && context.scriptLoaded) {
          console.warn(`Event handler for ${event.name} is not a function:`, handler);
        }
        props[reactEventProp(event.name)] = () => {};
      }
    } else {
      // Other expression types - wrap in closure for safety
      props[reactEventProp(event.name)] = wrapEventHandler(event.name, () => {
        return evaluateExpression(handlerExpr, handlerContext);
      });
    }

    // `@submit.prevent`, `@keydown.enter`: outside the value-extracting
    // wrapper above, because the modifiers read the event itself. Whatever
    // :bind installed is folded in after this and so is never filtered.
    if (event.modifiers && event.modifiers.length > 0 && typeof props[boundHandlerName] === 'function') {
      props[boundHandlerName] = withEventModifiers(
        props[boundHandlerName] as EventHandler,
        event.modifiers
      );
    }

    const authored = props[boundHandlerName];
    if (typeof boundHandler === 'function' && authored !== boundHandler) {
      props[boundHandlerName] = (...args: unknown[]) => {
        (boundHandler as (...a: unknown[]) => unknown)(...args);
        if (typeof authored === 'function') {
          return (authored as (...a: unknown[]) => unknown)(...args);
        }
        return undefined;
      };
    }
  }

  if (typeof FinalComponent === 'string') {
    keepFieldEditable(FinalComponent, node, props);
  }

  if (styleDirectives) {
    const base =
      typeof props.style === 'string'
        ? inlineStyleObject(props.style)
        : isPlainObject(props.style)
          ? props.style
          : {};
    props.style = { ...base, ...styleDirectives };
  }

  // Extract slot content from children (template slots and default content)
  const { slotContent, defaultChildren } = slotContentOf(node.children);

  // Create context with slots for child components
  const childContext: SoftNRenderContext = slotContent
    ? { ...context, slots: slotContent }
    : context;

  // A textarea's content is the text it starts with, not children.
  let contentNodes = defaultChildren;
  if (FinalComponent === 'textarea' && defaultChildren.length > 0) {
    const text = textareaText(defaultChildren, (child) =>
      evaluateStructural(child.expression, context, '', 'textarea text')
    );
    if (text !== undefined) {
      if (!('value' in props) && !('defaultValue' in props)) props.defaultValue = text;
      contentNodes = [];
    }
  }

  // Render non-slot children with parent key for stable keys
  let children = renderNodes(contentNodes, childContext, registry, String(key));
  // What a block inside a textarea draws (`#if`, `#each`) is its text too,
  // where textareaText above could not read it: React throws for a textarea
  // with more than one child, and the page went with it.
  if (FinalComponent === 'textarea' && contentNodes.length > 0) {
    if (!('value' in props) && !('defaultValue' in props)) props.defaultValue = drawnText(children);
    children = [];
  }

  // A string tag means these props go straight to the DOM, so every name HTML
  // treats as a URL can be judged by name. A registered component gets the
  // narrower, unambiguous set instead, applied through the whole prop value
  // rather than only its top level.
  const egressPolicy = egressPolicyFor(context);
  if (typeof FinalComponent === 'string') {
    // `src="images/logo.png"`: the bundle's file, before the URL check.
    showBundleFiles(node, props, context.functions?.asset);
    sanitizeUrlProps(props, node.tag, egressPolicy);
    if (svgElement) sanitizeSvgReferences(props, node.tag, egressPolicy);
    // After the URL check, which drops an action it refuses, and a link
    // it refuses.
    if (FinalComponent === 'form') keepFormOnPage(props);
    // A dialog the page's code opened with showModal(): drawn over the app,
    // inside the app's box, rather than in the browser's top layer, which
    // no box keeps in.
    if (FinalComponent === 'dialog' && props['data-softn-modal'] !== undefined) {
      props.style = { ...MODAL_DIALOG, ...(isPlainObject(props.style) ? props.style : {}) };
    }
    if (FinalComponent === 'a') followPageLinks(props, context.followLink);
    keepOpenerFromLinks(props, FinalComponent);
    dropCodeAttributes(props);
    dropTopLayerProps(props);
    dropDocumentName(props, FinalComponent);
  } else {
    sanitizeComponentUrlProps(props, node.tag, egressPolicy);
    coerceDeclaredProps(props, registry.getPropKinds(registry.resolveName(node.tag) ?? node.tag));
  }
  dropRawMarkupProp(props);
  // CSS text becomes an object first, so it is checked the way an object is
  // (see inline-style.ts for why a string reached React at all).
  if (typeof props.style === 'string') props.style = inlineStyleObject(props.style);
  // A style that is neither CSS text nor a record of properties draws no
  // style: a bare `<div style>`, `style={busy && {…}}` while busy is false,
  // a number. React throws for every one of them, and the page went with it.
  if (props.style !== undefined && props.style !== null && !isPlainObject(props.style)) delete props.style;
  // Applies to both: a registered component that spreads `style` onto its root
  // element reaches the network by exactly the same route a raw <div> does.
  withholdRemoteStyleUrls(props, egressPolicy);
  dropTopLayerStyle(props);
  if (context.appStyleNames && isPlainObject(props.style)) props.style = context.appStyleNames(props.style);

  // A tag with nothing inside it has no children, as in JSX. It was given
  // the empty list `renderNodes` returns, and a component that asks whether
  // it was given children took that for a yes: `<Avatar name="Ada" />` drew
  // its absent children where its initials belong.
  //
  // A void element takes none whatever is written, and React throws rather
  // than ignoring the argument, even for that empty list. `img`, `br`, `hr`,
  // `input` and `source` are all on the allowlist above, so every one of
  // them crashed the render of any `.ui` that used the plain HTML tag. The
  // demos only reach them through wrapper components like `<Image>`, which
  // is why it went unnoticed.
  //
  // The same goes for a tag whose contents all come to nothing: an `#if`
  // that does not hold, an `#each` with nothing to go through. A list of
  // nothings is as much a yes to "was I given children?" as an empty one.
  const isVoid = typeof FinalComponent === 'string' && VOID_ELEMENTS.has(node.tag.toLowerCase());
  const childless = isVoid || (children as React.ReactNode[]).every(isNothingDrawn);

  // With everything this element would be made from in hand, see whether it
  // is what this place was made from last time; see reuse.ts.
  const active = typeof key === 'string' ? pass : null;
  const before = active ? recall(active, key as string, node, 'element') : undefined;
  const settled = active ? settleProps(props, before) : undefined;
  const drawn = childless ? NO_CHILDREN : (children as React.ReactNode[]);
  if (
    active &&
    settled &&
    before &&
    before.component === FinalComponent &&
    !before.failure?.caught &&
    before.props &&
    sameProps(before.props, props, settled.styleUnchanged) &&
    sameNodes(before.children, drawn)
  ) {
    keep(active, key as string, before);
    return before.result;
  }

  // An `<option>`'s words as one text, which React reads its value from: as
  // a list they drew the same, with a warning that the value could not be
  // read from them.
  const optionText = FinalComponent === 'option' && !childless ? textOf(children as React.ReactNode[]) : undefined;
  const element = childless
    ? React.createElement(FinalComponent, props)
    : React.createElement(FinalComponent, props, optionText ?? children);

  // Wrap registered (non-HTML) components in a per-component error boundary
  // so a single component crash doesn't take down the entire document
  const failure = active && typeof FinalComponent !== 'string' ? { caught: false } : undefined;
  const result =
    typeof FinalComponent !== 'string'
      ? React.createElement(ComponentErrorBoundary, { key, tag: node.tag, failure }, element)
      : element;

  if (active && settled) {
    keep(active, key as string, {
      node,
      kind: 'element',
      result,
      component: FinalComponent,
      props,
      children: drawn,
      handlers: settled.handlers,
      style: settled.style,
      failure,
    });
  }
  return result;
}

const NO_CHILDREN: readonly React.ReactNode[] = [];

/**
 * Drawn children as the one text they make, when they are only words and
 * values (each drawn in a fragment of its own), or undefined.
 */
function textOf(children: readonly React.ReactNode[]): string | undefined {
  let text = '';
  for (const child of children) {
    if (isNothingDrawn(child)) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      text += child;
      continue;
    }
    if (React.isValidElement(child) && child.type === React.Fragment) {
      const inner = (child.props as { children?: unknown }).children;
      if (typeof inner === 'string' || typeof inner === 'number') {
        text += inner;
        continue;
      }
      if (inner === null || inner === undefined || inner === false) continue;
    }
    return undefined;
  }
  return text;
}

/** All the text `drawn` holds, through the fragments and lists blocks draw: a textarea's content. */
function drawnText(drawn: React.ReactNode): string {
  if (typeof drawn === 'string' || typeof drawn === 'number') return String(drawn);
  if (Array.isArray(drawn)) return drawn.map(drawnText).join('');
  if (React.isValidElement(drawn)) return drawnText((drawn.props as { children?: React.ReactNode }).children);
  return '';
}

/** What a condition that does not hold, or a list with nothing in it, draws. */
function isNothingDrawn(child: React.ReactNode): boolean {
  return child === null || child === undefined || child === false;
}

/**
 * Extract slot content from children
 * Returns slot content mapping and remaining default children
 *
 * The logic is:
 * - TemplateSlot nodes are extracted into slotContent by their name
 * - Non-slot children are kept as defaultChildren and rendered normally
 * - If there are no template slots, children are rendered normally (no slot extraction)
 */
type ExtractedSlots = {
  slotContent: Record<string, TemplateNode[]> | null;
  defaultChildren: TemplateNode[];
};

/**
 * `extractSlotContent` for a node's children, worked out once. It depends on
 * the parsed children alone, which nothing changes after parsing, and it was
 * done again for every element on every drawing: two lists and a record made
 * to find, nearly always, that there were no slots.
 */
const extractedSlots = new WeakMap<TemplateNode[], ExtractedSlots>();
function slotContentOf(children: TemplateNode[]): ExtractedSlots {
  let extracted = extractedSlots.get(children);
  if (!extracted) {
    extracted = extractSlotContent(children);
    extractedSlots.set(children, extracted);
  }
  return extracted;
}

function extractSlotContent(children: TemplateNode[]): ExtractedSlots {
  const slotContent: Record<string, TemplateNode[]> = {};
  const defaultChildren: TemplateNode[] = [];
  let hasTemplateSlots = false;

  for (const child of children) {
    if (child.type === 'TemplateSlot') {
      // This is an explicit <template slot="name">...</template> block
      hasTemplateSlots = true;
      const slotNode = child as TemplateSlotNode;
      const name = slotNode.name || 'default';
      if (!slotContent[name]) {
        slotContent[name] = [];
      }
      slotContent[name].push(...slotNode.children);
    } else {
      // Regular child - render normally
      defaultChildren.push(child);
    }
  }

  // If we have template slots, also add non-slot children to default slot
  // This allows mixing explicit slots with default content
  if (hasTemplateSlots && defaultChildren.length > 0) {
    if (!slotContent['default']) {
      slotContent['default'] = [];
    }
    slotContent['default'].push(...defaultChildren);
  }

  // Return slots only if we found template slots
  // Otherwise just render children normally
  return {
    slotContent: hasTemplateSlots ? slotContent : null,
    defaultChildren: hasTemplateSlots ? [] : defaultChildren,
  };
}

/**
 * Render a slot node
 */
function renderSlot(
  node: SlotNode,
  context: SoftNRenderContext,
  registry: ComponentRegistry,
  key?: number | string
): React.ReactNode {
  const slotName = node.name || 'default';

  // Check if we have content for this slot from parent
  if (context.slots && context.slots[slotName]) {
    const slotChildren = context.slots[slotName];
    return reusableFragment(
      node,
      'slot',
      key,
      key,
      renderNodes(slotChildren, context, registry, `${key ?? ''}-slot-${slotName}`)
    );
  }

  // Use fallback content if provided
  if (node.fallback && node.fallback.length > 0) {
    return reusableFragment(
      node,
      'slot',
      key,
      key,
      renderNodes(node.fallback, context, registry, `${key ?? ''}-slot-fallback-${slotName}`)
    );
  }

  // No content and no fallback
  return null;
}

/**
 * Render a text node
 */
function renderText(node: TextNode, key?: number | string): React.ReactNode {
  const active = pass;
  if (active && typeof key === 'string') {
    const before = recall(active, key, node, 'text');
    if (before) {
      keep(active, key, before);
      return before.result;
    }
    const result = React.createElement(React.Fragment, { key }, node.content);
    keep(active, key, { node, kind: 'text', result });
    return result;
  }
  // Use React.Fragment to properly handle text nodes
  return React.createElement(React.Fragment, { key }, node.content);
}

/**
 * Render an expression node (interpolation)
 */
function renderExpression(
  node: ExpressionNode,
  context: SoftNRenderContext,
  key?: number | string
): React.ReactNode {
  let value: unknown;
  try {
    value = evaluateExpression(node.expression, context);
  } catch {
    return null; // Gracefully handle expression evaluation errors
  }
  // Booleans render as nothing, as they do in JSX. `{ready && "Go"}` yields
  // `false` when the guard fails, and printing that put the word "false" in the
  // UI — which is what the idiom is meant to avoid. A bundle that wants to show
  // one can ask for it with `{String(flag)}`.
  const text = value == null || typeof value === 'boolean' ? '' : String(value);
  const active = pass;
  if (active && typeof key === 'string') {
    const before = recall(active, key, node, 'expression');
    if (before && before.text === text) {
      keep(active, key, before);
      return before.result;
    }
    const result = React.createElement(React.Fragment, { key }, text);
    keep(active, key, { node, kind: 'expression', result, text });
    return result;
  }
  return React.createElement(React.Fragment, { key }, text);
}

/**
 * Extract a descriptive identifier from a condition expression
 * Used to generate more unique keys for conditional branches
 */
function getConditionIdentifier(condition: Expression): string {
  if (condition.type === 'BinaryExpression') {
    // For comparisons like `currentPage === "dashboard"`, extract the right value
    if (condition.operator === '===' || condition.operator === '==') {
      // Read a literal operand directly instead of evaluating it. This only
      // builds a React key, and the condition has already been evaluated by the
      // caller — evaluating the operand again ran any call inside it a second
      // time on every render.
      if (condition.right.type === 'Literal') {
        const rightValue = condition.right.value;
        if (typeof rightValue === 'string' || typeof rightValue === 'number') {
          return String(rightValue);
        }
      }
    }
  }
  // For identifiers, use the name
  if (condition.type === 'Identifier') {
    return condition.name;
  }
  return 'cond';
}

/**
 * Render an if block
 *
 * Uses unique keys to force React to completely unmount and remount content
 * when switching between conditional branches.
 */
function renderIfBlock(
  node: IfBlock,
  context: SoftNRenderContext,
  registry: ComponentRegistry,
  key?: number | string,
  branchPath: string = ''
): React.ReactNode {
  const condition = evaluateStructural(node.condition, context, false, '#if condition');

  // Get a unique identifier for the condition value
  const conditionId = getConditionIdentifier(node.condition);

  // Get currentPage for making keys truly unique across navigation
  const currentPage = context.state['currentPage'] ?? 'unknown';

  // Get the source line number to make keys truly unique across different #if blocks
  const conditionLine = node.loc?.line ?? 0;

  if (condition) {
    // Build a unique key that identifies THIS specific branch
    // Include conditionLine to distinguish #if blocks at same position in different parents
    // Include currentPage to force remount when navigating
    const branchKey = `softn-if-${key ?? '0'}-L${conditionLine}-${conditionId}-${currentPage}${branchPath}`;

    // Render the children
    const children = renderNodes(node.consequent, context, registry, branchKey);

    // Use React.Fragment with key to avoid DOM pollution and ensure proper React reconciliation
    // The key forces React to unmount/remount when switching between branches
    return reusableFragment(node, 'branch', branchKey, branchKey, children);
  }

  if (node.alternate) {
    if (Array.isArray(node.alternate)) {
      // #else branch
      const branchKey = `softn-if-${key ?? '0'}-L${conditionLine}-else-${currentPage}${branchPath}`;
      const children = renderNodes(node.alternate, context, registry, branchKey);

      return reusableFragment(node, 'branch', branchKey, branchKey, children);
    } else {
      // Chained #elseif - extend the path to track which elseif branch we're in
      return renderIfBlock(node.alternate, context, registry, key, branchPath + '-elif');
    }
  }

  return null;
}

/**
 * The most a count may be in `#each (n in count)`. A count comes from state,
 * and one that is wrong by a few orders of magnitude should not be a page
 * that never finishes drawing.
 */
const MAX_EACH_COUNT = 100_000;

/** What an `#each` goes through: its items in order and, for a record, the key of each. */
interface Iteration {
  items: readonly unknown[];
  keys?: readonly string[];
}

const NOTHING_TO_ITERATE: Iteration = { items: [] };

/**
 * What `#each` goes through for a value.
 *
 * A list is its items. So is anything else that holds several things: a
 * Set's members and a Map's `[key, value]` pairs, in the order JavaScript
 * gives them; a record's values, with the key where a list has the index;
 * and a whole number, which counts from 1. These used to draw the `#empty`
 * branch as though they held nothing, which for a Set built in the template
 * (`new Set(tags)`) said the opposite of the truth.
 *
 * Text is not a list of its characters here: a string where a list was
 * expected is a list that has not arrived in the right shape, and the empty
 * branch is the right thing to draw for it.
 */
function iterationOf(value: unknown): Iteration {
  if (Array.isArray(value)) return { items: value };
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1 || value > MAX_EACH_COUNT) return NOTHING_TO_ITERATE;
    const items = new Array<number>(value);
    for (let i = 0; i < value; i++) items[i] = i + 1;
    return { items };
  }
  if (value === null || typeof value !== 'object') return NOTHING_TO_ITERATE;
  if (typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
    return { items: Array.from(value as Iterable<unknown>) };
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((key) => !BLOCKED_MEMBER_KEYS.has(key));
    return { items: keys.map((key) => value[key]), keys };
  }
  return NOTHING_TO_ITERATE;
}

/** Loops already told that their count is not one. */
const reportedEachCounts = new WeakSet<object>();

/** Say, once, that a number given to `#each` is not a count it can make. */
function reportEachCount(node: object, value: unknown, what: string): void {
  if (typeof value !== 'number' || value === 0 || reportedEachCounts.has(node)) return;
  if (Number.isInteger(value) && value >= 1 && value <= MAX_EACH_COUNT) return;
  reportedEachCounts.add(node);
  console.error(
    `[SoftN] ${what} was given the number ${value}, which is not a count it can go through: ` +
      `a count is a whole number from 0 to ${MAX_EACH_COUNT}. Nothing was drawn for it.`
  );
}

/**
 * The names one loop binds, and how a pass of it is laid over what was bound
 * around it. Made once for a drawing of the loop, not once a row.
 */
interface LoopBinding {
  names: readonly string[];
  /** For each name, what follows the item's own place in state; see SoftNLocalScope. */
  suffixes: readonly (string | undefined)[];
  /** The values of `names` for this item and its index or key. */
  values: (item: unknown, second: number | string) => unknown[];
}

function loopBinding(
  itemName: string,
  indexName: string | undefined,
  itemPattern?: BindingPattern
): LoopBinding {
  if (itemPattern) {
    // `#each ({ id, title } in tasks)`: each name is bound to its part of
    // the item, and knows its part of the item's place in state.
    const names = patternNames(itemPattern);
    const suffixes: Array<string | undefined> = [];
    patternSuffixes(itemPattern, '', suffixes);
    if (indexName) {
      names.push(indexName);
      suffixes.push(undefined);
    }
    return {
      names,
      suffixes,
      values: (item, second) => {
        const values: unknown[] = [];
        takeApart(itemPattern, item, values);
        if (indexName) values.push(second);
        return values;
      },
    };
  }
  return indexName
    ? { names: [itemName, indexName], suffixes: ['', undefined], values: (item, second) => [item, second] }
    : { names: [itemName], suffixes: [''], values: (item) => [item] };
}

/** The context one pass of a loop is drawn in. */
function loopPassContext(
  context: SoftNRenderContext,
  binding: LoopBinding,
  list: string | null,
  item: unknown,
  index: number,
  recordKey: string | undefined
): SoftNRenderContext {
  const second = recordKey ?? index;
  return {
    ...context,
    locals: {
      names: binding.names,
      values: binding.values(item, second),
      list: list ?? undefined,
      position: second,
      suffixes: binding.suffixes,
      parent: context.locals,
    },
    each: { item, index, key: recordKey ?? String(index) },
  };
}

/**
 * Render an each block
 */
function renderEachBlock(
  node: EachBlock,
  context: SoftNRenderContext,
  registry: ComponentRegistry,
  key?: number | string
): React.ReactNode {
  const iterable = evaluateStructural(node.iterable, context, [], '#each iterable');
  const { items, keys } = iterationOf(iterable);

  if (items.length === 0) {
    reportEachCount(node, iterable, '#each');
    if (node.emptyFallback) {
      return reusableFragment(
        node,
        'empty',
        key,
        key,
        renderNodes(node.emptyFallback, context, registry, `${key}-empty`)
      );
    }
    return null;
  }

  const binding = loopBinding(node.itemName, node.indexName, node.itemPattern);
  const list = writableListPath(node.iterable, context);

  // Warn in development if using index as key for items that might have state
  if (!node.keyExpression && !keys && isDevelopment) {
    console.warn(
      `[SoftN] Each block without key expression detected. Consider adding a key for better performance: ` +
        `#each (${node.itemName}${node.indexName ? `, ${node.indexName}` : ''} in iterable) key={${node.itemName}.id}`
    );
  }

  const renderedItems = items.map((item, index) => {
    const iterContext = loopPassContext(context, binding, list, item, index, keys?.[index]);

    // `key={…}` is worked out with the row's own names bound, the index among
    // them. Without it, `#each (row, i in rows) key={i}` evaluated `i` against
    // a state that had never heard of it: every row got the key "undefined",
    // React warned about duplicate children, and component state attached to
    // whichever row happened to be matched — so editing one row's input moved
    // the text to another when the list reordered.
    const itemKey = node.keyExpression
      ? String(evaluateExpression(node.keyExpression, iterContext))
      : (iterContext.each?.key ?? String(index));
    if (node.keyExpression && iterContext.each) iterContext.each.key = itemKey;

    const rowKey = `${key}-item-${itemKey}`;
    const children = renderNodes(node.body, iterContext, registry, rowKey);

    return reusableFragment(node, 'row', rowKey, itemKey, children);
  });

  return reusableFragment(node, 'each', key, key, renderedItems);
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * DOM event names whose React prop is not `on` + the capitalised name.
 *
 * `@click` works because React calls it `onClick`. `@keydown` does not, because
 * React calls it `onKeyDown` and no rule turns one into the other — `dblclick`
 * becomes `onDoubleClick`, which no amount of casing gets you to. React silently
 * ignores a prop it does not recognise, so the handler was simply never wired
 * up: the control looked normal and did nothing, while `@click` on the same
 * element worked, which reads as a broken handler rather than a broken name.
 *
 * It is reachable from the tools in this repo. The visual builder's event picker
 * offers 'keydown' and 'keyup' (apps/softn-builder PropertyPanel), and the demo
 * bundle in @softn/core uses `@keydown` on its edit field and `@dblclick` to
 * open the editor, so in that bundle neither did anything.
 *
 * Only irregular names are listed. Anything absent keeps the old behaviour,
 * which is what a COMPONENT callback needs: `@press` must stay `onPress`, and a
 * custom `@clearCompleted` must stay `onClearCompleted`. The lookup is on the
 * name exactly as authored, so `@keyDown` written in camelCase already resolved
 * correctly and still does.
 */
const REACT_EVENT_PROPS: Readonly<Record<string, string>> = {
  keydown: 'onKeyDown',
  keyup: 'onKeyUp',
  keypress: 'onKeyPress',
  dblclick: 'onDoubleClick',
  doubleclick: 'onDoubleClick',
  // React's onFocus and onBlur are the bubbling focus events, focusin and focusout.
  focusin: 'onFocus',
  focusout: 'onBlur',
  beforeinput: 'onBeforeInput',
  mousedown: 'onMouseDown',
  mouseup: 'onMouseUp',
  mouseenter: 'onMouseEnter',
  mouseleave: 'onMouseLeave',
  mousemove: 'onMouseMove',
  mouseover: 'onMouseOver',
  mouseout: 'onMouseOut',
  contextmenu: 'onContextMenu',
  pointerdown: 'onPointerDown',
  pointerup: 'onPointerUp',
  pointermove: 'onPointerMove',
  pointerenter: 'onPointerEnter',
  pointerleave: 'onPointerLeave',
  pointerover: 'onPointerOver',
  pointerout: 'onPointerOut',
  pointercancel: 'onPointerCancel',
  lostpointercapture: 'onLostPointerCapture',
  gotpointercapture: 'onGotPointerCapture',
  touchstart: 'onTouchStart',
  touchend: 'onTouchEnd',
  touchmove: 'onTouchMove',
  touchcancel: 'onTouchCancel',
  dragstart: 'onDragStart',
  dragend: 'onDragEnd',
  dragenter: 'onDragEnter',
  dragleave: 'onDragLeave',
  dragover: 'onDragOver',
  animationstart: 'onAnimationStart',
  animationend: 'onAnimationEnd',
  animationiteration: 'onAnimationIteration',
  transitionend: 'onTransitionEnd',
  compositionstart: 'onCompositionStart',
  compositionend: 'onCompositionEnd',
  compositionupdate: 'onCompositionUpdate',
  timeupdate: 'onTimeUpdate',
  volumechange: 'onVolumeChange',
  ratechange: 'onRateChange',
  durationchange: 'onDurationChange',
  loadeddata: 'onLoadedData',
  loadedmetadata: 'onLoadedMetadata',
  loadstart: 'onLoadStart',
  canplay: 'onCanPlay',
  canplaythrough: 'onCanPlayThrough',
  contextlost: 'onContextLost',
  contextrestored: 'onContextRestored',
};

/** The React prop name for an authored `@event`. */
export function reactEventProp(name: string): string {
  return REACT_EVENT_PROPS[name] ?? `on${capitalize(name)}`;
}
