/**
 * Source Generator - Converts canvas state to SoftN .ui source code
 */

import type { CanvasElement, CollectionDef } from '../types/builder';
import { getComponentMeta } from './componentRegistry';

interface GeneratorOptions {
  indent?: string;
  includeDefaults?: boolean;
  /**
   * If true and the root element is an App wrapper that was auto-added by the
   * parser, skip it and generate only the child elements.  This avoids
   * injecting `<App>` into component files that originally had a different
   * root element.
   */
  skipRootAppWrapper?: boolean;
}

const defaultOptions: GeneratorOptions = {
  indent: '  ',
  includeDefaults: true,
};

/**
 * Generate SoftN .ui source from canvas elements
 */
export function generateSource(
  elements: Map<string, CanvasElement>,
  rootId: string,
  logicSource: string,
  collections: CollectionDef[] = [],
  options: GeneratorOptions = {}
): string {
  const opts = { ...defaultOptions, ...options };
  const lines: string[] = [];

  // Generate <data> block if there are collections
  if (collections.length > 0) {
    lines.push('<data>');
    for (const col of collections) {
      // `<collection name="x" as="y" />`, which is what the runtime's parser
      // actually reads (parser.ts parseCollectionDeclaration, and the form every
      // shipped demo uses). The builder used to emit `<clients as="clients" />`
      // — the collection's own name as the tag — a dialect nothing parses. The
      // .xdb files shipped, so the data was in the bundle, but no <data> entry
      // declared it and the running app could not see a single collection the
      // schema designer had produced.
      lines.push(`${opts.indent}<collection name="${col.name}" as="${col.alias}" />`);
    }
    lines.push('</data>');
    lines.push('');
  }

  // Generate <logic> block if there's logic source
  if (logicSource && logicSource.trim()) {
    lines.push('<logic>');
    lines.push(logicSource);
    lines.push('</logic>');
    lines.push('');
  }

  // Generate template
  const rootElement = elements.get(rootId);
  if (rootElement) {
    // If skipRootAppWrapper is set and the root is a synthetic App wrapper
    // (has exactly one child and type 'App'), generate only the child elements
    // to avoid injecting <App> into component files.
    if (
      opts.skipRootAppWrapper &&
      rootElement.componentType === 'App' &&
      rootElement.children.length > 0
    ) {
      for (const childId of rootElement.children) {
        const child = elements.get(childId);
        if (child) {
          const childLines = generateElement(child, elements, 0, opts);
          lines.push(...childLines);
        }
      }
    } else {
      const templateLines = generateElement(rootElement, elements, 0, opts);
      lines.push(...templateLines);
    }
  }

  return lines.join('\n');
}

/** Whether the element is a control-flow block rather than a component. */
function isBlock(element: CanvasElement): boolean {
  return element.block !== undefined && element.componentType.startsWith('#');
}

/** Whether the element is a branch that continues its parent block. */
function isContinuation(element: CanvasElement): boolean {
  return (
    isBlock(element) &&
    (element.block!.kind === 'elseif' || element.block!.kind === 'else' || element.block!.kind === 'empty')
  );
}

/**
 * The header line of a block as the canvas shows it — `#if (cond)`,
 * `#each (item, i in list)` — or null for an element that is not a block.
 */
export function blockHeaderText(element: CanvasElement): string | null {
  return isBlock(element) ? blockHeader(element) : null;
}

/** The header line of a block: `#if (cond)`, `#each (item, i in list) key={k}`, `#else`… */
function blockHeader(element: CanvasElement): string {
  const block = element.block!;
  switch (block.kind) {
    case 'if':
      return `#if (${block.condition ?? ''})`;
    case 'elseif':
      return `#elseif (${block.condition ?? ''})`;
    case 'else':
      return '#else';
    case 'each': {
      const vars = block.indexName ? `${block.itemName}, ${block.indexName}` : block.itemName ?? '';
      const head = `#each (${vars} in ${block.iterable ?? ''})`;
      return block.keyExpression ? `${head} key={${block.keyExpression}}` : head;
    }
    case 'empty':
      return '#empty';
  }
}

/**
 * Print a control-flow block. Its branch is its children; an `#elseif`,
 * `#else` or `#empty` child is a continuation printed at the block's own
 * indent, its branch one level in. `#end` closes an `#if` or `#each`; a
 * continuation printed on its own (moved out of its block) gets none.
 */
function generateBlock(
  element: CanvasElement,
  elements: Map<string, CanvasElement>,
  depth: number,
  options: GeneratorOptions
): string[] {
  const lines: string[] = [];
  const indent = options.indent!.repeat(depth);
  lines.push(`${indent}${blockHeader(element)}`);

  if (typeof element.props.children === 'string' && element.children.length === 0) {
    lines.push(`${indent}${options.indent}${escapeText(element.props.children)}`);
  }

  for (const childId of element.children) {
    const child = elements.get(childId);
    if (!child) continue;
    if (isContinuation(child)) {
      lines.push(...generateBlock(child, elements, depth, options));
    } else {
      lines.push(...generateElement(child, elements, depth + 1, options));
    }
  }

  if (!isContinuation(element)) {
    lines.push(`${indent}#end`);
  }
  return lines;
}

/**
 * Generate source for a single element and its children
 */
function generateElement(
  element: CanvasElement,
  elements: Map<string, CanvasElement>,
  depth: number,
  options: GeneratorOptions
): string[] {
  if (isBlock(element)) {
    return generateBlock(element, elements, depth, options);
  }

  const lines: string[] = [];
  const indent = options.indent!.repeat(depth);
  const meta = getComponentMeta(element.componentType);

  // Build attributes
  const attrs = generateAttributes(element, meta, options);
  const hasChildren = element.children.length > 0 || typeof element.props.children === 'string';

  if (hasChildren) {
    const open = attrs.length > 0 ? `<${element.componentType} ${attrs}>` : `<${element.componentType}>`;
    const close = `</${element.componentType}>`;

    // Text-only content is written inline, `<Text>Hello</Text>`: on a line
    // of its own the lexer keeps one leading and one trailing space of the
    // indentation as part of the text, and the engine renders them.
    if (typeof element.props.children === 'string' && element.children.length === 0) {
      lines.push(`${indent}${open}${escapeText(element.props.children)}${close}`);
      return lines;
    }

    lines.push(`${indent}${open}`);

    // Child elements
    for (const childId of element.children) {
      const child = elements.get(childId);
      if (child) {
        const childLines = generateElement(child, elements, depth + 1, options);
        lines.push(...childLines);
      }
    }

    // Closing tag
    lines.push(`${indent}${close}`);
  } else {
    // Self-closing tag
    if (attrs.length > 0) {
      lines.push(`${indent}<${element.componentType} ${attrs} />`);
    } else {
      lines.push(`${indent}<${element.componentType} />`);
    }
  }

  return lines;
}

/**
 * Generate attributes string from element props, events, bindings, and directives
 */
function generateAttributes(
  element: CanvasElement,
  _meta: ReturnType<typeof getComponentMeta>,
  _options: GeneratorOptions
): string {
  const attrs: string[] = [];
  const expressionPropSet = new Set(element.expressionProps || []);

  // Regular props
  for (const [key, value] of Object.entries(element.props)) {
    // Skip children prop (handled separately)
    if (key === 'children') continue;

    // Skip undefined/null values
    if (value === undefined || value === null) continue;

    // Always include props that are explicitly set on the element — stripping
    // default-matching values causes data loss on round-trip serialization.

    // Skip empty strings
    if (value === '') continue;

    // Format attribute based on type
    if (typeof value === 'boolean') {
      if (value) {
        attrs.push(key);
      }
    } else if (typeof value === 'number') {
      attrs.push(`${key}={${value}}`);
    } else if (typeof value === 'string') {
      // Use expressionProps set to determine if it's an expression
      if (expressionPropSet.has(key)) {
        attrs.push(`${key}={${value}}`);
      } else {
        attrs.push(`${key}="${escapeAttr(value)}"`);
      }
    } else if (typeof value === 'object') {
      // JSON objects
      attrs.push(`${key}={${JSON.stringify(value)}}`);
    }
  }

  // Events: @click={handler}
  if (element.events) {
    for (const [event, handler] of Object.entries(element.events)) {
      if (handler) {
        attrs.push(`@${event}={${handler}}`);
      }
    }
  }

  // Bindings: :bind={expression}
  if (element.bindings) {
    for (const [binding, expr] of Object.entries(element.bindings)) {
      if (expr) {
        attrs.push(`:${binding}={${expr}}`);
      }
    }
  }

  // Conditional: if={condition}
  if (element.conditionalIf) {
    attrs.push(`if={${element.conditionalIf}}`);
  }

  // Loop: each={collection} as="alias"
  if (element.loopEach) {
    attrs.push(`each={${element.loopEach}}`);
    if (element.loopAs) {
      attrs.push(`as="${element.loopAs}"`);
    }
  }

  return attrs.join(' ');
}

/**
 * Escape text content — outside `{…}` interpolations only. Text is one
 * string in the model, expressions included, and `{items.length > 0}`
 * used to come back as `{items.length &gt; 0}`, which the expression lexer
 * does not decode: the comparison became an error.
 */
function escapeText(text: string): string {
  let out = '';
  let depth = 0;
  let plain = '';
  const flush = () => {
    out += plain.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    plain = '';
  };
  for (const ch of text) {
    if (ch === '{') {
      if (depth === 0) flush();
      depth++;
      out += ch;
    } else if (ch === '}' && depth > 0) {
      depth--;
      out += ch;
    } else if (depth > 0) {
      out += ch;
    } else {
      plain += ch;
    }
  }
  flush();
  return out;
}

/**
 * Escape attribute value
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Format source code with proper indentation
 */
export function formatSource(source: string, indentStr: string = '  '): string {
  const lines = source.split('\n');
  const result: string[] = [];
  let depth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      result.push('');
      continue;
    }

    // Decrease depth for closing tags
    if (trimmed.startsWith('</') || trimmed.startsWith('-->')) {
      depth = Math.max(0, depth - 1);
    }

    result.push(indentStr.repeat(depth) + trimmed);

    // Increase depth for opening tags (but not self-closing)
    if (
      trimmed.startsWith('<') &&
      !trimmed.startsWith('</') &&
      !trimmed.startsWith('<!') &&
      !trimmed.startsWith('<?') &&
      !trimmed.endsWith('/>') &&
      !trimmed.endsWith('-->')
    ) {
      depth++;
    }
  }

  return result.join('\n');
}
