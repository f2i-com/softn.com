/**
 * Source fidelity — can the visual model write a .ui file back without
 * losing anything the source holds?
 *
 * The builder regenerates a file's template from its canvas elements after
 * a visual edit, and keeps the rest of the file as it stands
 * (sourceFrame.ts). The model is narrower than the language, so before a
 * file is written from it the question is asked of the file itself: write
 * it back from the elements it was just read into, and see whether what
 * comes out is the same file to the engine.
 *
 *   1. the parser reported no diagnostics for the file;
 *   2. every `{…}` region parses as one whole expression — parsed alone,
 *      it yields exactly one attribute and no diagnostics;
 *   3. nothing was met on the way into the model that it has no place for:
 *      an expression the printer refuses, a comment that does not stand
 *      before an element, a block between two parts of the template;
 *   4. the file written back parses, and its template is the same tree as
 *      the original's — positions, literal spellings, attribute quoting and
 *      the line breaks between elements aside, and with the spaces inside a
 *      line of words exactly as they were;
 *   5. it declares what the original declared: the same imports, logic,
 *      data, styles and component header;
 *   6. it holds the same comments in the same order.
 *
 * A file that fails any of these is edited as source only: the store keeps
 * `originalSource` authoritative and refuses the visual edit with these
 * reasons rather than writing the lossy model back.
 */

import { parse, tokenize, TokenType } from '@softn/core';
import type {
  Expression,
  PropValue,
  SoftNDocument,
  TemplateNode,
  Token,
} from '@softn/core';
import type { CanvasElement, SourceFidelity } from '../types/builder';
import { commentsOf, frameSource, writeBack } from './sourceFrame';

export type { SourceFidelity } from '../types/builder';
export { hasSingleAppRoot } from './sourceFrame';

function safeTokenize(source: string): Token[] | null {
  try {
    return tokenize(source);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2. Expressions the parser stops reading part way through
// ---------------------------------------------------------------------------

/** The text of every outermost `{…}` region, as the lexer delimits them. */
function expressionRegions(source: string, tokens: Token[]): Array<{ text: string; line: number }> {
  const regions: Array<{ text: string; line: number }> = [];
  let depth = 0;
  let openAt = -1;
  let openLine = 0;
  for (const token of tokens) {
    if (token.type === TokenType.EXPR_START || token.type === TokenType.TEMPLATE_EXPR_START) {
      if (depth === 0) {
        openAt = token.end;
        openLine = token.line;
      }
      depth++;
    } else if (token.type === TokenType.EXPR_END || token.type === TokenType.TEMPLATE_EXPR_END) {
      depth--;
      if (depth === 0 && openAt >= 0) {
        regions.push({ text: source.slice(openAt, token.start), line: openLine });
        openAt = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return regions;
}

/**
 * Whether `text` is one whole expression to the parser. Parsed as the
 * value of a single attribute, a complete expression yields that one
 * attribute and nothing else; anything the parser left unread turns into
 * further attributes or a diagnostic.
 */
function isWholeExpression(text: string): boolean {
  if (!text.trim()) return false;
  let doc: SoftNDocument;
  try {
    doc = parse(`<Probe v={${text}} />`);
  } catch {
    return false;
  }
  if (doc.diagnostics?.some((d) => d.severity === 'error')) return false;
  const [node, ...rest] = doc.template.filter((n) => n.type !== 'Text');
  if (!node || rest.length > 0 || node.type !== 'Element') return false;
  if (node.events.length > 0 || node.bindings.length > 0 || node.conditionalIf || node.inlineEach) {
    return false;
  }
  if (node.props.length !== 1 || node.props[0].name !== 'v') return false;
  return node.props[0].value.type === 'expression';
}

/** Reasons for every `{…}` the parser would not read to the end. */
function findTruncatedExpressions(source: string): string[] {
  const tokens = safeTokenize(source);
  if (!tokens) return [];
  const reasons: string[] = [];
  for (const region of expressionRegions(source, tokens)) {
    if (!isWholeExpression(region.text)) {
      const shown = region.text.trim().replace(/\s+/g, ' ');
      const excerpt = shown.length > 60 ? `${shown.slice(0, 57)}…` : shown;
      reasons.push(
        `the expression {${excerpt}} on line ${region.line} is not fully supported by the parser (part of it would be dropped)`
      );
    }
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// 5. Template comparison
// ---------------------------------------------------------------------------

type Shape = unknown;

function shapeExpression(expr: Expression): Shape {
  if (!expr || typeof expr !== 'object') return expr;
  if (expr.type === 'Literal') return { type: 'Literal', value: expr.value };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(expr)) {
    if (key === 'loc' || value === undefined) continue;
    out[key] = shapeAny(value);
  }
  return out;
}

function shapeAny(value: unknown): Shape {
  if (Array.isArray(value)) return value.map(shapeAny);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.type === 'string' && 'loc' in record) {
      return shapeExpression(value as Expression);
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(record)) {
      if (key === 'loc' || v === undefined) continue;
      out[key] = shapeAny(v);
    }
    return out;
  }
  return value;
}

function shapePropValue(value: PropValue): Shape {
  switch (value.type) {
    case 'number':
      // `n=5` and `n={5}` are the same number to the engine.
      return { type: 'expression', value: { type: 'Literal', value: value.value } };
    case 'expression':
      return { type: 'expression', value: shapeExpression(value.value) };
    default:
      return { type: value.type, value: value.value };
  }
}

function sortedByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The template with everything that does not reach the engine removed:
 * positions, literal spellings, attribute order and whether a tag was
 * written self-closing.
 *
 * Text is compared as the engine has it. The lexer takes the layout out
 * (the line breaks and indentation between elements are no node at all) and
 * leaves the spaces that are drawn: `Hello ` before `<b>`, the space
 * between two elements on one line. Those used to be trimmed away on both
 * sides of this comparison, which called a file lossless that came back
 * with its words run together. Neighbouring text nodes are one text: what
 * splits them (a comment between two words) is not the engine's concern.
 */
function shapeTemplate(nodes: TemplateNode[]): Shape[] {
  const out: Shape[] = [];
  let text: string | null = null;
  const flush = () => {
    if (text !== null && text !== '') out.push({ type: 'Text', content: text });
    text = null;
  };
  for (const node of nodes) {
    if (node.type === 'Text') {
      text = (text ?? '') + node.content;
      continue;
    }
    flush();
    out.push(shapeNode(node));
  }
  flush();
  return out;
}

/**
 * The top of a template, where a run of whitespace on its own is the gap
 * between two roots on one line and nothing the page shows differently for.
 */
function shapeRoots(nodes: TemplateNode[]): Shape[] {
  return shapeTemplate(nodes.filter((n) => n.type !== 'Text' || n.content.trim() !== ''));
}

function shapeNode(node: TemplateNode): Shape {
  switch (node.type) {
    case 'Text':
      return { type: 'Text', content: node.content };
    case 'Expression':
      return { type: 'Expression', expression: shapeExpression(node.expression) };
    case 'Element':
      return {
        type: 'Element',
        tag: node.tag,
        props: sortedByName(node.props).map((p) => ({ name: p.name, value: shapePropValue(p.value) })),
        events: sortedByName(node.events).map((e) => ({
          name: e.name,
          // `@submit.prevent` without its modifier is a different handler.
          modifiers: e.modifiers?.length ? e.modifiers : undefined,
          handler: shapeExpression(e.handler),
        })),
        bindings: sortedByName(node.bindings).map((b) => ({
          name: b.name,
          expression: shapeExpression(b.expression),
        })),
        conditionalIf: node.conditionalIf ? shapeExpression(node.conditionalIf) : undefined,
        inlineEach: node.inlineEach
          ? {
              iterable: shapeExpression(node.inlineEach.iterable),
              itemName: node.inlineEach.itemName,
              indexName: node.inlineEach.indexName,
            }
          : undefined,
        children: shapeTemplate(node.children),
      };
    case 'IfBlock':
      return {
        type: 'IfBlock',
        condition: shapeExpression(node.condition),
        consequent: shapeTemplate(node.consequent),
        alternate: node.alternate
          ? Array.isArray(node.alternate)
            ? shapeTemplate(node.alternate)
            : shapeNode(node.alternate)
          : undefined,
      };
    case 'EachBlock':
      return {
        type: 'EachBlock',
        iterable: shapeExpression(node.iterable),
        itemName: node.itemName,
        indexName: node.indexName,
        keyExpression: node.keyExpression ? shapeExpression(node.keyExpression) : undefined,
        body: shapeTemplate(node.body),
        emptyFallback: node.emptyFallback ? shapeTemplate(node.emptyFallback) : undefined,
      };
    case 'Slot':
      return {
        type: 'Slot',
        name: node.name,
        fallback: node.fallback ? shapeTemplate(node.fallback) : undefined,
      };
    case 'TemplateSlot':
      return { type: 'TemplateSlot', name: node.name, children: shapeTemplate(node.children) };
    default:
      return shapeAny(node);
  }
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 37)}…` : value);
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `${value.length} node(s)`;
  const record = value as Record<string, unknown>;
  if (typeof record.type === 'string') {
    if (record.type === 'Element') return `<${String(record.tag)}>`;
    if (record.type === 'Text') return `text ${describe(record.content)}`;
    return String(record.type);
  }
  return 'a value';
}

/**
 * The first place two shaped trees differ, as a sentence, or null when they
 * are the same.
 */
function firstDifference(a: unknown, b: unknown, path = 'template'): string | null {
  if (a === b) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    if (a.length !== b.length) {
      const extra = a.length > b.length ? a[n] : b[n];
      return a.length > b.length
        ? `${path}: ${describe(extra)} would be dropped`
        : `${path}: ${describe(extra)} would be added`;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    if (typeof ra.type === 'string' && ra.type !== rb.type) {
      return `${path}: ${describe(ra)} would become ${describe(rb)}`;
    }
    const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
    for (const key of keys) {
      const d = firstDifference(ra[key], rb[key], `${path}.${key}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${describe(a)} would become ${describe(b)}`;
}

/** What a document declares outside its template, positions aside. */
function shapeHeader(doc: SoftNDocument): Shape {
  return shapeAny({
    imports: doc.imports ?? [],
    logic: doc.logic,
    script: doc.script,
    data: doc.data,
    style: doc.style,
    component: doc.component,
  });
}

/** How many declaring tags a source opens, whichever the parser kept of two of a kind. */
function declarationCount(source: string): number {
  return (source.match(/<(?:logic|script|style|data|import|component)\b/gi) ?? []).length;
}

/**
 * Write the file back from the model and compare what comes out with what
 * went in. Returns every reason they are not the same file.
 */
function writtenBackDifferences(
  source: string,
  original: SoftNDocument,
  elements: Map<string, CanvasElement>,
  rootId: string,
  commentsPlaced: boolean
): string[] {
  const written = writeBack(source, original, elements, rootId);
  let doc: SoftNDocument;
  try {
    doc = parse(written);
  } catch (err) {
    return [`the file the visual model writes does not parse (${err instanceof Error ? err.message : String(err)})`];
  }
  const bad = doc.diagnostics?.find((d) => d.severity === 'error');
  if (bad) return [`the file the visual model writes does not parse (${bad.message})`];

  const reasons: string[] = [];
  const difference = firstDifference(shapeRoots(original.template), shapeRoots(doc.template));
  if (difference) reasons.push(`the visual model does not reproduce the template (${difference})`);

  const header = firstDifference(shapeHeader(original), shapeHeader(doc), 'file');
  if (header) {
    reasons.push(`the visual model does not keep what the file declares (${header})`);
  } else if (declarationCount(source) !== declarationCount(written)) {
    reasons.push('the visual model does not keep every block the file declares');
  }

  // A comment the model had no element for has been named already.
  if (!commentsPlaced) return reasons;
  const before = commentsOf(source) ?? [];
  const after = commentsOf(written) ?? [];
  const lost = before.find((comment, index) => after[index]?.text !== comment.text || after[index]?.form !== comment.form);
  if (lost) {
    reasons.push(`a comment on line ${lost.line} would not be written back where it stands`);
  } else if (after.length !== before.length) {
    reasons.push('the visual model would write a comment the file does not have');
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

export interface FidelityInput {
  source: string;
  /** The parsed document, when the core parser read the file. */
  doc: SoftNDocument | null;
  elements: Map<string, CanvasElement>;
  rootId: string;
  /** Whether parseSource wrapped several roots in an `<App>` of its own. */
  syntheticRoot: boolean;
  /** Reasons collected while converting the AST into elements. */
  conversionReasons: string[];
}

export function computeFidelity(input: FidelityInput): SourceFidelity {
  const reasons: string[] = [];
  if (!input.doc) {
    reasons.push('the SoftN parser could not read this file (the legacy reader was used)');
    return { lossless: false, reasons };
  }
  for (const d of input.doc.diagnostics ?? []) {
    if (d.severity === 'error') reasons.push(`the parser reported "${d.message}" on line ${d.loc.line}`);
  }
  reasons.push(...findTruncatedExpressions(input.source));
  reasons.push(...(frameSource(input.source, input.doc)?.reasons ?? []));
  reasons.push(...input.conversionReasons);
  const commentsPlaced = !input.conversionReasons.some((reason) => reason.startsWith('a comment on line'));
  reasons.push(...writtenBackDifferences(input.source, input.doc, input.elements, input.rootId, commentsPlaced));
  return { lossless: reasons.length === 0, reasons: dedupe(reasons) };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
