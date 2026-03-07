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
    // @ts-expect-error - Vite injects import.meta.env
    if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
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
 * Set of valid HTML element tags
 */
const HTML_ELEMENTS = new Set([
  // Main root
  'html',
  // Document metadata
  'base',
  'head',
  'link',
  'meta',
  'style',
  'title',
  // Sectioning root
  'body',
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
  // Embedded content
  'embed',
  'iframe',
  'object',
  'param',
  'picture',
  'portal',
  'source',
  // SVG and MathML
  'svg',
  'math',
  // Scripting
  'canvas',
  'noscript',
  'script',
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
  // Web Components
  'slot',
  'template',
]);

/**
 * Check if a tag is a valid HTML element
 */
function isHTMLElement(tag: string): boolean {
  return HTML_ELEMENTS.has(tag.toLowerCase());
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
 * Render an element node
 * Supports inline conditionals (if=) and loops (each=/as=)
 */
function renderElement(
  node: ElementNode,
  context: SoftNRenderContext,
  registry: ComponentRegistry,
  key?: number | string
): React.ReactNode {
  // Check inline conditional first
  if (node.conditionalIf) {
    const condition = evaluateExpression(node.conditionalIf, context);
    if (!condition) {
      return null; // Don't render if condition is falsy
    }
  }

  // Check for inline loop
  if (node.inlineEach) {
    const iterable = evaluateExpression(node.inlineEach.iterable, context);

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

    if (binding.name === 'bind') {
      // Two-way binding shorthand
      props.value = value;
      // Handle both native elements (pass event) and custom components (pass value directly)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props.onChange = (eventOrValue: any) => {
        // Extract path from expression (supports complex paths)
        const path = getExpressionPath(binding.expression);
        if (path) {
          const rootVar = path.split('.')[0].split('[')[0]; // Handle array access

          // Determine the new value:
          // - If it's an event object with target.value (native elements), use that
          // - Otherwise, treat the argument as the value directly (custom components like Select)
          let newValue: unknown;
          if (
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
    return fn;
  };

  for (const event of node.events) {
    // If the handler is a function call (e.g., @click={handleClick()}),
    // we need to wrap it in a closure to prevent immediate execution during render.
    // If it's a function reference or arrow function, evaluate it directly.
    const handlerExpr = event.handler;

    if (handlerExpr.type === 'CallExpression') {
      // Wrap in closure - execute the call when the event fires
      props[`on${capitalize(event.name)}`] = wrapEventHandler(event.name, () => {
        return evaluateExpression(handlerExpr, callbackContext);
      });
    } else if (handlerExpr.type === 'ArrowFunctionExpression') {
      // Arrow functions are already deferred - evaluate to get the function
      const handler = evaluateExpression(handlerExpr, callbackContext);
      props[`on${capitalize(event.name)}`] = typeof handler === 'function' ? wrapEventHandler(event.name, handler as (...args: any[]) => any) : handler;
    } else if (handlerExpr.type === 'Identifier' || handlerExpr.type === 'MemberExpression') {
      // Function reference - evaluate to get the function, wrap to ensure it's callable
      const handler = evaluateExpression(handlerExpr, callbackContext);
      if (typeof handler === 'function') {
        props[`on${capitalize(event.name)}`] = wrapEventHandler(event.name, handler as (...args: any[]) => any);
      } else {
        // If not a function, wrap in a no-op to prevent errors.
        // Only warn if the script has finished loading — before that, functions
        // aren't available yet and this is expected.
        if (isDevelopment && context.scriptLoaded) {
          console.warn(`Event handler for ${event.name} is not a function:`, handler);
        }
        props[`on${capitalize(event.name)}`] = () => {};
      }
    } else {
      // Other expression types - wrap in closure for safety
      props[`on${capitalize(event.name)}`] = wrapEventHandler(event.name, () => {
        return evaluateExpression(handlerExpr, callbackContext);
      });
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

  const element = React.createElement(FinalComponent, props, children);

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
  // Properly escape and render the value
  const text = String(value ?? '');
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
function getConditionIdentifier(condition: Expression, context: SoftNRenderContext): string {
  if (condition.type === 'BinaryExpression') {
    // For comparisons like `currentPage === "dashboard"`, extract the right value
    if (condition.operator === '===' || condition.operator === '==') {
      const rightValue = evaluateExpression(condition.right, context);
      if (typeof rightValue === 'string' || typeof rightValue === 'number') {
        return String(rightValue);
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
  const condition = evaluateExpression(node.condition, context);

  // Get a unique identifier for the condition value
  const conditionId = getConditionIdentifier(node.condition, context);

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
  const iterable = evaluateExpression(node.iterable, context);

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
                state: { ...context.state, [node.itemName]: item },
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
        return context.computed[expr.name];
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
          // Block body - try to extract return value or execute with FormLogic
          // For now, attempt to parse simple return statements
          const bodyStr = expr.body.trim();
          if (bodyStr.startsWith('return ')) {
            // Simple return statement - this is a limitation
            // Full support would require FormLogic integration
            if (isDevelopment) {
              console.warn(
                '[SoftN] Block body arrow functions with complex logic require FormLogic integration'
              );
            }
          }
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
function getExpressionPath(expr: Expression): string | null {
  if (expr.type === 'Identifier') {
    return expr.name;
  }

  if (expr.type === 'MemberExpression') {
    const objectPath = getExpressionPath(expr.object);
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
        // Dynamic index - use placeholder notation
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
