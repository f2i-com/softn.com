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
      lines.push(`${opts.indent}<${col.name} as="${col.alias}" />`);
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

/**
 * Generate source for a single element and its children
 */
function generateElement(
  element: CanvasElement,
  elements: Map<string, CanvasElement>,
  depth: number,
  options: GeneratorOptions
): string[] {
  const lines: string[] = [];
  const indent = options.indent!.repeat(depth);
  const meta = getComponentMeta(element.componentType);

  // Build attributes
  const attrs = generateAttributes(element, meta, options);
  const hasChildren = element.children.length > 0 || typeof element.props.children === 'string';

  if (hasChildren) {
    // Opening tag
    if (attrs.length > 0) {
      lines.push(`${indent}<${element.componentType} ${attrs}>`);
    } else {
      lines.push(`${indent}<${element.componentType}>`);
    }

    // Text children
    if (typeof element.props.children === 'string' && element.children.length === 0) {
      lines.push(`${indent}${options.indent}${escapeText(element.props.children as string)}`);
    }

    // Child elements
    for (const childId of element.children) {
      const child = elements.get(childId);
      if (child) {
        const childLines = generateElement(child, elements, depth + 1, options);
        lines.push(...childLines);
      }
    }

    // Closing tag
    lines.push(`${indent}</${element.componentType}>`);
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
  meta: ReturnType<typeof getComponentMeta>,
  options: GeneratorOptions
): string {
  const attrs: string[] = [];
  const expressionPropSet = new Set(element.expressionProps || []);

  // Regular props
  for (const [key, value] of Object.entries(element.props)) {
    // Skip children prop (handled separately)
    if (key === 'children') continue;

    // Skip undefined/null values
    if (value === undefined || value === null) continue;

    // Skip default values if not including them
    if (!options.includeDefaults && meta) {
      const propMeta = meta.propSchema.find((p) => p.name === key);
      if (propMeta && propMeta.default === value) continue;
    }

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
 * Escape text content
 */
function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
