/**
 * Source Generator - Converts canvas state to SoftN .ui source code
 */

import { parse } from '@softn/core/authoring';
import type { CanvasComment, CanvasElement, CollectionDef } from '../types/builder';
import { TEXT_NODE_TYPE } from '../types/builder';
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
  /**
   * The file's `<logic src>`, written first. A file's logic is linked, never
   * inlined: the runtime reads a logic file only through this tag, and an
   * inline copy is one that later edits to the file never reach. Python
   * cannot be inlined at all.
   */
  logicSrc?: string;
  /**
   * The pages this page uses, written first of all:
   * `<import Row from="./row.ui" />`. A page made on the canvas has no
   * source to keep them in, and written without them it used a page the app
   * that ran did not know.
   */
  imports?: ReadonlyArray<{ name: string; source: string }>;
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

  for (const imported of opts.imports ?? []) {
    lines.push(`<import ${imported.name} from="${imported.source}" />`);
  }
  if (opts.logicSrc) {
    lines.push(`<logic src="${opts.logicSrc}" />`);
  }

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
    // If skipRootAppWrapper is set and the root is the App the parser put
    // around a file that has none of its own, write only what it holds. With
    // nothing left in it that is nothing: it used to be `<App />`, which made
    // a component file an app the moment its last element was deleted.
    if (opts.skipRootAppWrapper && rootElement.componentType === 'App') {
      if (rootElement.children.length === 0 && typeof rootElement.props.children === 'string') {
        lines.push(escapeText(rootElement.props.children).trimEnd());
      }
      lines.push(...generateChildren(childrenOf(rootElement, elements), elements, 0, opts));
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

/** The elements an element holds, in order. */
function childrenOf(element: CanvasElement, elements: Map<string, CanvasElement>): CanvasElement[] {
  return element.children.map((id) => elements.get(id)).filter((child): child is CanvasElement => child !== undefined);
}

/** Whether the element is words standing beside elements. */
function isTextNode(element: CanvasElement): boolean {
  return element.componentType === TEXT_NODE_TYPE;
}

/** A comment as it is written on a line of its own. */
function commentLine(comment: CanvasComment, indent: string): string {
  return comment.form === 'html' ? `${indent}<!-- ${comment.text} -->` : `${indent}// ${comment.text}`;
}

/**
 * The lines of a run of siblings.
 *
 * One to a line is how elements are written, and the line breaks between
 * them are layout the engine does not see. Where words stand among them, or
 * a space stands between two of them on one line, the whitespace is part of
 * what is drawn, so the run is written as one line with exactly the spaces
 * the model holds.
 */
function generateChildren(
  children: CanvasElement[],
  elements: Map<string, CanvasElement>,
  depth: number,
  options: GeneratorOptions
): string[] {
  const indent = options.indent!.repeat(depth);
  if (!children.some((child) => isTextNode(child) || child.spaceBefore)) {
    return children.flatMap((child) => generateElement(child, elements, depth, options));
  }
  let line = '';
  for (const child of children) {
    if (isTextNode(child)) {
      line += escapeText(String(child.props.children ?? ''));
      continue;
    }
    if (child.spaceBefore) line += ' ';
    const lines = generateElement(child, elements, depth, options);
    if (isBlock(child) || child.leadingComments?.length) {
      // A block and a comment each need a line of their own.
      line += `\n${lines.join('\n')}\n${indent}`;
    } else {
      line += lines.join('\n').trimStart();
    }
  }
  return [`${indent}${line}`];
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
  for (const comment of element.leadingComments ?? []) lines.push(commentLine(comment, indent));
  lines.push(`${indent}${blockHeader(element)}`);

  if (typeof element.props.children === 'string' && element.children.length === 0) {
    // The line break after it is read as one trailing space, so one the
    // text already ends with is not written twice.
    lines.push(`${indent}${options.indent}${escapeText(element.props.children).trimEnd()}`);
  }

  // The branch is every child up to the next continuation, written as a run.
  let branch: CanvasElement[] = [];
  const flush = () => {
    lines.push(...generateChildren(branch, elements, depth + 1, options));
    branch = [];
  };
  for (const child of childrenOf(element, elements)) {
    if (isContinuation(child)) {
      flush();
      lines.push(...generateBlock(child, elements, depth, options));
    } else {
      branch.push(child);
    }
  }
  flush();

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
  if (isTextNode(element)) {
    // Words on a line of their own: only where no element stands beside them.
    return [`${indent}${escapeText(String(element.props.children ?? '')).trim()}`];
  }
  for (const comment of element.leadingComments ?? []) lines.push(commentLine(comment, indent));
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

    const children = childrenOf(element, elements);
    if (children.some((child) => isTextNode(child) || child.spaceBefore)) {
      // Words among the children: the tags go on the line with them, so no
      // line break is read as a space the author did not write. The line
      // comes back indented as a child; only that is taken off, since a
      // space the words begin with is one the page draws.
      const [line] = generateChildren(children, elements, depth + 1, options);
      lines.push(`${indent}${open}${line.slice(options.indent!.length * (depth + 1))}${close}`);
      return lines;
    }

    lines.push(`${indent}${open}`);
    lines.push(...generateChildren(children, elements, depth + 1, options));

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
    // That includes one that is empty: `alt=""` says a picture is decoration,
    // and a file that had one used to be refused for it. A field that is
    // emptied in the panel removes its property instead.

    // Format attribute based on type. `open=false` is read as the boolean
    // false and written so: written as nothing, the property was gone from
    // the file, and a page that had one could not be written back at all.
    if (typeof value === 'boolean') {
      attrs.push(value ? key : `${key}=false`);
    } else if (typeof value === 'number') {
      attrs.push(`${key}={${value}}`);
    } else if (typeof value === 'string') {
      // Use expressionProps set to determine if it's an expression
      if (expressionPropSet.has(key)) {
        attrs.push(`${key}={${value}}`);
      } else {
        attrs.push(`${key}="${escapeAttr(value, element.componentType)}"`);
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
 *
 * A brace typed into the words that opens no expression the parser reads to
 * its end (`Press { to open`, a half-made `{a b}`) is a brace, written as
 * `&#123;`. Written as it stood, it opened an expression the parser read on
 * through the closing tag, and the rest of the page came back as one broken
 * expression. Words are written as they stand whenever that reads back.
 */
function escapeText(text: string): string {
  const written = spellWords(text, () => true, true);
  if (!text.includes('{') || readsAsWords(written)) return written;
  const repaired = spellWords(text, (inner) => readsAsWords(`{${inner}}`), false);
  return readsAsWords(repaired) ? repaired : spellWords(text, () => false, false);
}

/**
 * A `#` that the lexer would take for the start of a block: one before a whole
 * word that opens one, in any case (core lexer, `hashStartsControlFlow`). In
 * words it is the character, written `&#35;`: written as it was, `#end` was
 * read as the end of a block and was gone from the page, `a #else b` came back
 * as `a b`, and `see #if (x)` was a block.
 */
const BLOCK_WORD = /#(?=(?:if|elseif|else|each|empty|end)(?![A-Za-z]))/gi;

/**
 * The words spelled for the parser: each `{…}` that `keep` takes written as
 * the expression it is, and any other as words, its braces literal; a `{`
 * that is never closed is written as it is when `openAsIs`, else as words.
 * (A brace in a string of an expression is counted here as any other, so a
 * whole that reads is written as it is, whatever the count says.)
 */
function spellWords(text: string, keep: (inner: string) => boolean, openAsIs: boolean): string {
  let out = '';
  let depth = 0;
  let plain = '';
  let region = '';
  const words = (part: string) =>
    // A no-break space is written as its entity: as a character the lexer
    // takes it for whitespace and collapses it with the spaces around it.
    part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00A0/g, '&nbsp;').replace(/\{/g, '&#123;').replace(BLOCK_WORD, '&#35;');
  for (const ch of text) {
    if (ch === '{') {
      if (depth === 0) {
        out += words(plain);
        plain = '';
      }
      depth++;
      region += ch;
    } else if (ch === '}' && depth > 0) {
      depth--;
      region += ch;
      if (depth === 0) {
        out += keep(region.slice(1, -1)) ? region : words(region);
        region = '';
      }
    } else if (depth > 0) {
      region += ch;
    } else {
      plain += ch;
    }
  }
  // A `{` with no `}` after it opens nothing.
  return out + words(plain) + (openAsIs ? region : words(region));
}

/** Words as written, by whether the parser reads them back without an error: every expression in them read to its end. */
const readsBack = new Map<string, boolean>();
function readsAsWords(written: string): boolean {
  let reads = readsBack.get(written);
  if (reads === undefined) {
    try {
      reads = !(parse(`<Text>${written}</Text>`).diagnostics ?? []).some((d) => d.severity === 'error');
    } catch {
      reads = false;
    }
    if (readsBack.size >= 10_000) readsBack.clear();
    readsBack.set(written, reads);
  }
  return reads;
}

/**
 * A text property as the inside of a double-quoted attribute, spelled so
 * that the parser reads the same text back. It reads entities, a backslash
 * as the start of an escape, and a line break as the end of the string, so
 * each of those is written as what it reads them from.
 */
function escapeAttr(value: string, tag: string): string {
  const escaped = value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // An HTML element's attribute (a tag in lower case: `div`, `my-card`) has
  // no escapes, as in HTML, and a backslash in it is a backslash: one there
  // came back doubled. A backslash and a line break are written as the
  // characters they are, which reads the same for every tag.
  if (/^[a-z]/.test(tag)) return escaped.replace(/\\/g, '&#92;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
  return escaped.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}
