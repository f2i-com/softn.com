/**
 * Source Parser - Parses SoftN .ui source code into canvas elements
 */

import type { CanvasElement, CollectionDef, UIImport } from '../types/builder';
import { debug } from './debug';
import { parse as parseSoftN } from '@softn/core';
import type {
  TemplateNode as AstTemplateNode,
  Expression as AstExpression,
  ElementNode as AstElementNode,
  PropValue as AstPropValue,
} from '@softn/core';

interface ParseResult {
  elements: Map<string, CanvasElement>;
  rootId: string;
  logicSource: string;
  logicSrc?: string; // External logic file reference
  collections: CollectionDef[];
  imports: UIImport[];
}

interface ParsedNode {
  type: string;
  props: Record<string, unknown>;
  events: Record<string, string>;
  bindings: Record<string, string>;
  conditionalIf?: string;
  loopEach?: string;
  loopAs?: string;
  expressionProps: string[];
  children: (ParsedNode | string)[];
  isSelfClosing: boolean;
}

let idCounter = 0;

function generateId(): string {
  return `elem_${Date.now()}_${idCounter++}`;
}

/**
 * Parse SoftN .ui source into canvas-compatible state
 */
export function parseSource(source: string): ParseResult {
  idCounter = 0;

  debug('[sourceParser] Parsing source:', source.substring(0, 500));

  const elements = new Map<string, CanvasElement>();
  let logicSource = '';
  let logicSrc: string | undefined;
  const collections: CollectionDef[] = [];
  const imports: UIImport[] = [];

  // Check for external logic file reference: logicSrc="./file.logic" or <logic src="./file.logic" />
  const logicSrcMatch = source.match(/logicSrc=["']([^"']+)["']/);
  if (logicSrcMatch) {
    logicSrc = logicSrcMatch[1];
  }

  // Also check for <logic src="..." /> format
  const logicTagSrcMatch = source.match(/<logic\s+src=["']([^"']+)["']\s*\/>/);
  if (logicTagSrcMatch) {
    logicSrc = logicTagSrcMatch[1];
  }

  // Use the canonical SoftN parser first so all supported .ui syntax is detectable.
  try {
    const doc = parseSoftN(source);

    if (doc.logic?.code) {
      logicSource = doc.logic.code.trim();
    } else if (doc.script?.code) {
      logicSource = doc.script.code.trim();
    }

    if (doc.data?.collections?.length) {
      for (const col of doc.data.collections) {
        collections.push({
          name: col.name,
          alias: col.as,
          fields: [],
          seedData: [],
        });
      }
    }

    if (doc.imports?.length) {
      for (const imp of doc.imports) {
        if (imp.defaultImport) {
          imports.push({ name: imp.defaultImport, source: imp.source });
        }
        for (const name of imp.namedImports || []) {
          imports.push({ name, source: imp.source });
        }
      }
    }

    const astRoots = flattenTemplateNodesToElements(doc.template || []);

    if (astRoots.length > 0) {
      const rootNode =
        astRoots.length === 1 && astRoots[0].type === 'App'
          ? astRoots[0]
          : {
              type: 'App',
              props: { theme: 'light' },
              events: {},
              bindings: {},
              expressionProps: [],
              children: astRoots,
              isSelfClosing: false,
            };

      const rootId = buildElementTree(rootNode, null, elements);

      return {
        elements,
        rootId,
        logicSource,
        logicSrc,
        collections,
        imports: dedupeImports(imports),
      };
    }
  } catch (err) {
    debug('[sourceParser] Core parser failed, using legacy parser fallback:', err);
  }

  // Fallback legacy import extraction
  const importRegex = /import\s*\{\s*([^}]+)\s*\}\s*from\s*["']([^"']+)["']/g;
  let importMatch;
  while ((importMatch = importRegex.exec(source)) !== null) {
    const names = importMatch[1].split(',').map((n) => n.trim());
    for (const name of names) {
      imports.push({ name, source: importMatch[2] });
    }
  }

  const xmlImportRegex = /<import\s+(?:\{\s*([^}]+)\s*\}|(\w+))\s+from=["']([^"']+)["']\s*\/>/g;
  let xmlImportMatch;
  while ((xmlImportMatch = xmlImportRegex.exec(source)) !== null) {
    const namesStr = xmlImportMatch[1] || xmlImportMatch[2];
    const importSource = xmlImportMatch[3];
    const names = namesStr.split(',').map((n) => n.trim());
    for (const name of names) {
      if (name && !imports.find((i) => i.name === name && i.source === importSource)) {
        imports.push({ name, source: importSource });
      }
    }
  }

  // Fallback legacy <data> parsing
  const dataMatch = source.match(/<data>([\s\S]*?)<\/data>/);
  if (dataMatch) {
    const dataContent = dataMatch[1];
    const collectionRegex = /<(\w+)\s+as="(\w+)"\s*\/>/g;
    let colMatch;
    while ((colMatch = collectionRegex.exec(dataContent)) !== null) {
      collections.push({
        name: colMatch[1],
        alias: colMatch[2],
        fields: [],
        seedData: [],
      });
    }
  }

  // Fallback legacy <logic> parsing
  const logicMatch = source.match(/<logic>([\s\S]*?)<\/logic>/);
  if (logicMatch) {
    logicSource = logicMatch[1].trim();
  }

  // Find the template content (everything after data/logic/import blocks, or the first element)
  const templateSource = source
    // Remove <data>...</data> blocks
    .replace(/<data>[\s\S]*?<\/data>/g, '')
    // Remove <logic>...</logic> blocks
    .replace(/<logic>[\s\S]*?<\/logic>/g, '')
    // Remove self-closing <logic src="..." /> tags
    .replace(/<logic\s+[^>]*\/>/g, '')
    // Remove JS-style import statements
    .replace(/import\s*\{[^}]+\}\s*from\s*["'][^"']+["']\s*;?/g, '')
    // Remove XML-style <import ... /> tags
    .replace(/<import\s+[^>]+\/>/g, '')
    // Remove single-line comments (// ...)
    .replace(/\/\/[^\n]*/g, '')
    // Remove multi-line comments (/* ... */)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();

  debug('[sourceParser] Template source:', templateSource.substring(0, 500));

  // Parse the template XML
  const rootNode = parseXML(templateSource);

  debug(
    '[sourceParser] Parsed root node:',
    rootNode
      ? `type=${rootNode.type}, props=${Object.keys(rootNode.props).join(',')}, children=${rootNode.children.length}, selfClosing=${rootNode.isSelfClosing}`
      : 'null'
  );

  if (rootNode && rootNode.children.length > 0) {
    debug(
      '[sourceParser] First child:',
      typeof rootNode.children[0] === 'string'
        ? `text: "${rootNode.children[0].substring(0, 50)}"`
        : `element: ${rootNode.children[0].type}`
    );
  }

  if (rootNode) {
    const rootId = buildElementTree(rootNode, null, elements);

    debug('[sourceParser] Built elements:', elements.size);

    return {
      elements,
      rootId,
      logicSource,
      logicSrc,
      collections,
      imports: dedupeImports(imports),
    };
  }

  // No template found, create empty App root
  const rootId = generateId();
  elements.set(rootId, {
    id: rootId,
    componentType: 'App',
    props: { theme: 'light' },
    children: [],
    parentId: null,
  });

  return {
    elements,
    rootId,
    logicSource,
    logicSrc,
    collections,
    imports: dedupeImports(imports),
  };
}

function dedupeImports(imports: UIImport[]): UIImport[] {
  const seen = new Set<string>();
  const result: UIImport[] = [];
  for (const imp of imports) {
    const key = `${imp.name}|${imp.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(imp);
  }
  return result;
}

function flattenTemplateNodesToElements(nodes: AstTemplateNode[]): ParsedNode[] {
  const result: ParsedNode[] = [];
  for (const node of nodes) {
    const parsed = astNodeToTopLevelElements(node);
    result.push(...parsed);
  }
  return result;
}

function astNodeToTopLevelElements(node: AstTemplateNode): ParsedNode[] {
  const converted = astNodeToChildren(node);
  const out: ParsedNode[] = [];
  for (const child of converted) {
    if (typeof child === 'string') {
      const text = child.trim();
      if (text) {
        out.push(createTextElement(text));
      }
    } else {
      out.push(child);
    }
  }
  return out;
}

function astNodeToChildren(node: AstTemplateNode): (ParsedNode | string)[] {
  switch (node.type) {
    case 'Element': {
      const parsed = astElementToParsedNode(node);
      return [parsed];
    }
    case 'Text': {
      const text = node.content?.trim();
      return text ? [text] : [];
    }
    case 'Expression':
      return [`{${expressionToString(node.expression)}}`];
    case 'IfBlock': {
      const condition = expressionToString(node.condition);
      const consequent = node.consequent.flatMap((n) => astNodeToChildren(n));
      const conditionedConsequent = consequent.map((item) =>
        applyDirectiveToChild(item, { conditionalIf: condition })
      );

      const alternateNodes: (ParsedNode | string)[] = [];
      if (node.alternate) {
        if (Array.isArray(node.alternate)) {
          alternateNodes.push(...node.alternate.flatMap((n) => astNodeToChildren(n)));
        } else {
          alternateNodes.push(...astNodeToChildren(node.alternate));
        }
      }
      const conditionedAlternate = alternateNodes.map((item) =>
        applyDirectiveToChild(item, { conditionalIf: `!(${condition})` })
      );

      return [...conditionedConsequent, ...conditionedAlternate];
    }
    case 'EachBlock': {
      const iterable = expressionToString(node.iterable);
      const as = node.indexName ? `${node.itemName}, ${node.indexName}` : node.itemName;
      const body = node.body.flatMap((n) => astNodeToChildren(n));
      return body.map((item) =>
        applyDirectiveToChild(item, {
          loopEach: iterable,
          loopAs: as,
        })
      );
    }
    case 'Slot': {
      const slotNode: ParsedNode = {
        type: 'Slot',
        props: node.name ? { name: node.name } : {},
        events: {},
        bindings: {},
        expressionProps: [],
        children: [],
        isSelfClosing: !node.fallback || node.fallback.length === 0,
      };
      if (node.fallback?.length) {
        slotNode.children = node.fallback.flatMap((n) => astNodeToChildren(n));
      }
      return [slotNode];
    }
    case 'TemplateSlot': {
      const slotTemplate: ParsedNode = {
        type: 'Template',
        props: { slot: node.name },
        events: {},
        bindings: {},
        expressionProps: [],
        children: node.children.flatMap((n) => astNodeToChildren(n)),
        isSelfClosing: node.children.length === 0,
      };
      return [slotTemplate];
    }
    default:
      return [];
  }
}

function createTextElement(text: string): ParsedNode {
  return {
    type: 'Text',
    props: { children: text },
    events: {},
    bindings: {},
    expressionProps: [],
    children: [],
    isSelfClosing: true,
  };
}

function applyDirectiveToChild(
  item: ParsedNode | string,
  directives: { conditionalIf?: string; loopEach?: string; loopAs?: string }
): ParsedNode | string {
  if (typeof item === 'string') {
    const wrapped = createTextElement(item);
    if (directives.conditionalIf) wrapped.conditionalIf = directives.conditionalIf;
    if (directives.loopEach) wrapped.loopEach = directives.loopEach;
    if (directives.loopAs) wrapped.loopAs = directives.loopAs;
    return wrapped;
  }

  const cloned: ParsedNode = {
    ...item,
    props: { ...item.props },
    events: { ...item.events },
    bindings: { ...item.bindings },
    expressionProps: [...item.expressionProps],
    children: [...item.children],
  };

  if (directives.conditionalIf && !cloned.conditionalIf) {
    cloned.conditionalIf = directives.conditionalIf;
  }
  if (directives.loopEach && !cloned.loopEach) {
    cloned.loopEach = directives.loopEach;
  }
  if (directives.loopAs && !cloned.loopAs) {
    cloned.loopAs = directives.loopAs;
  }

  return cloned;
}

function astElementToParsedNode(node: AstElementNode): ParsedNode {
  const parsed: ParsedNode = {
    type: node.tag,
    props: {},
    events: {},
    bindings: {},
    expressionProps: [],
    children: [],
    isSelfClosing: node.selfClosing,
  };

  for (const prop of node.props || []) {
    const { value, isExpression } = astPropValueToBuilderValue(prop.value);
    parsed.props[prop.name] = value;
    if (isExpression) {
      parsed.expressionProps.push(prop.name);
    }
  }

  for (const event of node.events || []) {
    parsed.events[event.name] = expressionToString(event.handler);
  }

  for (const binding of node.bindings || []) {
    parsed.bindings[binding.name] = expressionToString(binding.expression);
  }

  if (node.conditionalIf) {
    parsed.conditionalIf = expressionToString(node.conditionalIf);
  }
  if (node.inlineEach) {
    parsed.loopEach = expressionToString(node.inlineEach.iterable);
    parsed.loopAs = node.inlineEach.indexName
      ? `${node.inlineEach.itemName}, ${node.inlineEach.indexName}`
      : node.inlineEach.itemName;
  }

  for (const child of node.children || []) {
    parsed.children.push(...astNodeToChildren(child));
  }

  return parsed;
}

function astPropValueToBuilderValue(value: AstPropValue): { value: unknown; isExpression: boolean } {
  switch (value.type) {
    case 'static':
      return { value: value.value, isExpression: false };
    case 'number':
      return { value: value.value, isExpression: false };
    case 'boolean':
      return { value: value.value, isExpression: false };
    case 'expression':
      return { value: expressionToString(value.value), isExpression: true };
    default:
      return { value: '', isExpression: false };
  }
}

function expressionToString(expr: AstExpression): string {
  switch (expr.type) {
    case 'Identifier':
      return expr.name;
    case 'Literal':
      return expr.raw ?? JSON.stringify(expr.value);
    case 'BinaryExpression':
      return `${expressionToString(expr.left)} ${expr.operator} ${expressionToString(expr.right)}`;
    case 'UnaryExpression':
      return `${expr.operator}${expressionToString(expr.argument)}`;
    case 'MemberExpression':
      return expr.computed
        ? `${expressionToString(expr.object)}[${expressionToString(expr.property)}]`
        : `${expressionToString(expr.object)}.${expressionToString(expr.property)}`;
    case 'CallExpression':
      return `${expressionToString(expr.callee)}(${expr.arguments.map((a) => expressionToString(a)).join(', ')})`;
    case 'ConditionalExpression':
      return `${expressionToString(expr.test)} ? ${expressionToString(expr.consequent)} : ${expressionToString(expr.alternate)}`;
    case 'ArrowFunctionExpression': {
      const params =
        expr.params.length === 1 ? expr.params[0] : `(${expr.params.join(', ')})`;
      const body = typeof expr.body === 'string' ? expr.body : expressionToString(expr.body);
      return `${expr.async ? 'async ' : ''}${params} => ${body}`;
    }
    case 'ObjectExpression':
      return `{ ${expr.properties
        .map((p) =>
          p.shorthand ? p.key : `${p.key}: ${expressionToString(p.value)}`
        )
        .join(', ')} }`;
    case 'ArrayExpression':
      return `[${expr.elements.map((e) => expressionToString(e)).join(', ')}]`;
    case 'SpreadElement':
      return `...${expressionToString(expr.argument)}`;
    case 'TemplateLiteral': {
      const segments: string[] = [];
      for (let i = 0; i < expr.quasis.length; i++) {
        segments.push(expr.quasis[i].value.raw.replace(/`/g, '\\`'));
        if (i < expr.expressions.length) {
          segments.push(`\${${expressionToString(expr.expressions[i])}}`);
        }
      }
      return `\`${segments.join('')}\``;
    }
    default:
      return '';
  }
}

/**
 * Match opening tag handling balanced braces in attribute expressions
 * Returns [fullMatch, tagName, attributes, selfClosingSlash] or null
 */
function matchOpeningTag(source: string): [string, string, string, string] | null {
  if (!source.startsWith('<')) return null;

  // Match tag name
  const tagNameMatch = source.match(/^<(\w+)/);
  if (!tagNameMatch) return null;

  const tagName = tagNameMatch[1];
  let pos = tagNameMatch[0].length;
  let braceDepth = 0;
  let inString: string | null = null;

  // Find the end of the opening tag, respecting balanced braces and strings
  while (pos < source.length) {
    const char = source[pos];

    // Handle string literals
    if ((char === '"' || char === "'") && source[pos - 1] !== '\\') {
      if (inString === null) {
        inString = char;
      } else if (inString === char) {
        inString = null;
      }
      pos++;
      continue;
    }

    // Skip if inside string
    if (inString !== null) {
      pos++;
      continue;
    }

    // Track brace depth
    if (char === '{') {
      braceDepth++;
    } else if (char === '}') {
      braceDepth--;
    }

    // Check for self-closing or end of tag
    if (braceDepth === 0) {
      if (char === '/' && source[pos + 1] === '>') {
        // Self-closing tag
        const fullMatch = source.slice(0, pos + 2);
        const attrs = source.slice(tagNameMatch[0].length, pos).trim();
        return [fullMatch, tagName, attrs, '/'];
      }
      if (char === '>') {
        // Regular opening tag
        const fullMatch = source.slice(0, pos + 1);
        const attrs = source.slice(tagNameMatch[0].length, pos).trim();
        return [fullMatch, tagName, attrs, ''];
      }
    }

    pos++;
  }

  return null;
}

/**
 * Simple XML parser for SoftN templates
 */
function parseXML(source: string): ParsedNode | null {
  source = source.trim();
  if (!source.startsWith('<')) return null;

  // Parse opening tag - handle expressions with > inside by matching balanced braces
  const openTagMatch = matchOpeningTag(source);
  if (!openTagMatch) {
    debug('[parseXML] Failed to match opening tag in:', source.substring(0, 100));
    return null;
  }

  const type = openTagMatch[1];
  const attrsString = openTagMatch[2];
  const isSelfClosing = openTagMatch[3] === '/';

  // Parse attributes
  const parsed = parseAttributes(attrsString);

  if (isSelfClosing) {
    return {
      type,
      props: parsed.props,
      events: parsed.events,
      bindings: parsed.bindings,
      conditionalIf: parsed.conditionalIf,
      loopEach: parsed.loopEach,
      loopAs: parsed.loopAs,
      expressionProps: parsed.expressionProps,
      children: [],
      isSelfClosing: true,
    };
  }

  // Find content between opening and closing tags
  const openTag = openTagMatch[0];
  const closeTag = `</${type}>`;

  let depth = 1;
  let pos = openTag.length;
  const contentStart = pos;

  while (pos < source.length && depth > 0) {
    const nextOpen = source.indexOf(`<${type}`, pos);
    const nextClose = source.indexOf(closeTag, pos);

    if (nextClose === -1) break;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Check if it's a self-closing tag
      const tagEnd = source.indexOf('>', nextOpen);
      if (tagEnd !== -1 && source[tagEnd - 1] !== '/') {
        depth++;
      }
      pos = tagEnd + 1;
    } else {
      depth--;
      if (depth === 0) {
        const content = source.slice(contentStart, nextClose).trim();
        const children = parseChildren(content);

        return {
          type,
          props: parsed.props,
          events: parsed.events,
          bindings: parsed.bindings,
          conditionalIf: parsed.conditionalIf,
          loopEach: parsed.loopEach,
          loopAs: parsed.loopAs,
          expressionProps: parsed.expressionProps,
          children,
          isSelfClosing: false,
        };
      }
      pos = nextClose + closeTag.length;
    }
  }

  // Fallback: try simpler parsing
  const closeIndex = source.lastIndexOf(closeTag);
  if (closeIndex > openTag.length) {
    const content = source.slice(openTag.length, closeIndex).trim();
    const children = parseChildren(content);

    return {
      type,
      props: parsed.props,
      events: parsed.events,
      bindings: parsed.bindings,
      conditionalIf: parsed.conditionalIf,
      loopEach: parsed.loopEach,
      loopAs: parsed.loopAs,
      expressionProps: parsed.expressionProps,
      children,
      isSelfClosing: false,
    };
  }

  return {
    type,
    props: parsed.props,
    events: parsed.events,
    bindings: parsed.bindings,
    conditionalIf: parsed.conditionalIf,
    loopEach: parsed.loopEach,
    loopAs: parsed.loopAs,
    expressionProps: parsed.expressionProps,
    children: [],
    isSelfClosing: true,
  };
}

/**
 * Parse children content (mix of elements and text)
 */
function parseChildren(content: string): (ParsedNode | string)[] {
  const children: (ParsedNode | string)[] = [];
  let remaining = content.trim();

  while (remaining) {
    if (remaining.startsWith('<')) {
      // Find the element
      const elementResult = extractElement(remaining);
      if (elementResult) {
        const node = parseXML(elementResult.element);
        if (node) {
          children.push(node);
        }
        remaining = elementResult.remaining.trim();
      } else {
        break;
      }
    } else {
      // Text content
      const nextTagIndex = remaining.indexOf('<');
      if (nextTagIndex === -1) {
        // Rest is text
        const text = unescapeText(remaining.trim());
        if (text) children.push(text);
        break;
      } else {
        const text = unescapeText(remaining.slice(0, nextTagIndex).trim());
        if (text) children.push(text);
        remaining = remaining.slice(nextTagIndex).trim();
      }
    }
  }

  return children;
}

/**
 * Extract a complete element (including nested elements) from source
 */
function extractElement(source: string): { element: string; remaining: string } | null {
  if (!source.startsWith('<')) return null;

  // Use the same balanced brace matching for opening tag
  const openTagMatch = matchOpeningTag(source);
  if (!openTagMatch) return null;

  const tagName = openTagMatch[1];
  const isSelfClosing = openTagMatch[3] === '/';

  // If self-closing, return immediately
  if (isSelfClosing) {
    return {
      element: openTagMatch[0],
      remaining: source.slice(openTagMatch[0].length),
    };
  }

  // Find matching close tag
  const closeTag = `</${tagName}>`;
  let depth = 1;
  let pos = openTagMatch[0].length;

  while (pos < source.length) {
    // Look for next tag (opening or closing)
    const nextTagStart = source.indexOf('<', pos);
    if (nextTagStart === -1) break;

    // Check if it's a closing tag for our element
    if (source.slice(nextTagStart).startsWith(closeTag)) {
      depth--;
      if (depth === 0) {
        const element = source.slice(0, nextTagStart + closeTag.length);
        return {
          element,
          remaining: source.slice(nextTagStart + closeTag.length),
        };
      }
      pos = nextTagStart + closeTag.length;
      continue;
    }

    // Check if it's an opening tag of the same type
    const nestedOpenMatch = matchOpeningTag(source.slice(nextTagStart));
    if (nestedOpenMatch && nestedOpenMatch[1] === tagName && nestedOpenMatch[3] !== '/') {
      depth++;
      pos = nextTagStart + nestedOpenMatch[0].length;
    } else if (nestedOpenMatch) {
      // Different tag or self-closing, skip past it
      pos = nextTagStart + nestedOpenMatch[0].length;
    } else {
      // Not a valid tag, move past the <
      pos = nextTagStart + 1;
    }
  }

  return null;
}

/**
 * Parsed attribute result with events, bindings, directives separated
 */
interface ParsedAttrs {
  props: Record<string, unknown>;
  events: Record<string, string>;
  bindings: Record<string, string>;
  conditionalIf?: string;
  loopEach?: string;
  loopAs?: string;
  expressionProps: string[];
}

/**
 * Parse XML attributes into structured result with events/bindings/directives separated
 */
function parseAttributes(attrsString: string): ParsedAttrs {
  const result: ParsedAttrs = {
    props: {},
    events: {},
    bindings: {},
    expressionProps: [],
  };
  attrsString = attrsString.trim();

  // String/quoted attributes — supports @event="handler", :binding="expr", and regular props
  let match;
  const stringPattern = /([@:]?\w+)\s*=\s*["']([^"']*)["']/g;
  while ((match = stringPattern.exec(attrsString)) !== null) {
    const rawName = match[1];
    const value = unescapeAttr(match[2]);
    classifyAttribute(rawName, value, false, result);
  }

  // Expression attributes — supports @event={handler}, :binding={expr}, and regular props
  const exprPattern = /([@:]?\w+)\s*=\s*\{([^}]+)\}/g;
  while ((match = exprPattern.exec(attrsString)) !== null) {
    const rawName = match[1];
    const rawValue = match[2].trim();

    // For events and bindings, always keep as string
    if (rawName.startsWith('@') || rawName.startsWith(':')) {
      classifyAttribute(rawName, rawValue, true, result);
      continue;
    }

    // For regular props, try to parse as typed value
    let value: unknown = rawValue;
    try {
      if (rawValue === 'true') {
        value = true;
      } else if (rawValue === 'false') {
        value = false;
      } else if (!isNaN(Number(rawValue))) {
        value = Number(rawValue);
      } else if (rawValue.startsWith('{') || rawValue.startsWith('[') || rawValue.startsWith('"')) {
        value = JSON.parse(rawValue);
      }
      // else keep as expression string
    } catch {
      // Keep as expression string
    }

    classifyAttribute(rawName, value, true, result);
  }

  // Boolean attributes (names without values)
  const remaining = attrsString
    .replace(/[@:]?\w+\s*=\s*["'][^"']*["']/g, '')
    .replace(/[@:]?\w+\s*=\s*\{[^}]+\}/g, '')
    .trim();

  const words = remaining.split(/\s+/).filter(Boolean);
  for (const word of words) {
    if (/^\w+$/.test(word)) {
      result.props[word] = true;
    }
  }

  return result;
}

/**
 * Classify an attribute into the correct bucket (event, binding, directive, or prop)
 */
function classifyAttribute(
  rawName: string,
  value: unknown,
  isExpression: boolean,
  result: ParsedAttrs
): void {
  if (rawName.startsWith('@')) {
    // Event handler: @click → events.click
    const eventName = rawName.slice(1);
    result.events[eventName] = String(value);
  } else if (rawName.startsWith(':')) {
    // Binding: :bind → bindings.bind
    const bindingName = rawName.slice(1);
    result.bindings[bindingName] = String(value);
  } else if (rawName === 'if') {
    result.conditionalIf = String(value);
  } else if (rawName === 'each') {
    result.loopEach = String(value);
  } else if (rawName === 'as') {
    result.loopAs = String(value);
  } else {
    result.props[rawName] = value;
    if (isExpression && typeof value === 'string') {
      result.expressionProps.push(rawName);
    }
  }
}

/**
 * Build element tree from parsed nodes
 */
function buildElementTree(
  node: ParsedNode,
  parentId: string | null,
  elements: Map<string, CanvasElement>
): string {
  const id = generateId();

  const childIds: string[] = [];
  const textSegments: string[] = [];

  for (const child of node.children) {
    if (typeof child === 'string') {
      const normalized = child.trim();
      if (normalized) {
        textSegments.push(normalized);
      }
    } else {
      const childId = buildElementTree(child, id, elements);
      childIds.push(childId);
    }
  }

  // Build props
  const props: Record<string, unknown> = { ...node.props };
  if (textSegments.length > 0 && childIds.length === 0) {
    props.children = textSegments.join(' ');
  }

  const element: CanvasElement = {
    id,
    componentType: node.type,
    props,
    children: childIds,
    parentId,
  };

  // Set events, bindings, directives if present
  if (Object.keys(node.events).length > 0) {
    element.events = { ...node.events };
  }
  if (Object.keys(node.bindings).length > 0) {
    element.bindings = { ...node.bindings };
  }
  if (node.conditionalIf) {
    element.conditionalIf = node.conditionalIf;
  }
  if (node.loopEach) {
    element.loopEach = node.loopEach;
  }
  if (node.loopAs) {
    element.loopAs = node.loopAs;
  }
  if (node.expressionProps.length > 0) {
    element.expressionProps = [...node.expressionProps];
  }

  elements.set(id, element);

  return id;
}

/**
 * Unescape XML text content
 */
function unescapeText(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Unescape XML attribute value
 */
function unescapeAttr(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Parse a .logic file and extract imports/exports
 */
export function parseLogicFile(content: string): {
  imports: { names: string[]; source: string }[];
  exports: string[];
} {
  const imports: { names: string[]; source: string }[] = [];
  const exports: string[] = [];

  // Parse imports
  const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const names = match[1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    imports.push({ names, source: match[2] });
  }

  // Parse exports
  const exportFuncRegex = /export\s+function\s+(\w+)/g;
  while ((match = exportFuncRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }

  const exportVarRegex = /export\s+(?:const|let|var)\s+(\w+)/g;
  while ((match = exportVarRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }

  return { imports, exports };
}
