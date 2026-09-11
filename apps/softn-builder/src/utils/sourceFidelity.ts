/**
 * Source fidelity — can the visual model write a .ui file back without
 * losing anything the source holds?
 *
 * The builder regenerates a file's template from its canvas elements after
 * a visual edit. That model is narrower than the language: the parser
 * drops comments before the model ever sees them, stops reading an
 * expression it does not understand part way through without a diagnostic
 * (`() => count = count + 1` becomes `() => count` plus a stray boolean
 * attribute named `count`), text that sits between child elements has no
 * place in the model, and the header the store splices back together by
 * regular expression knows only some of the blocks a file can have. Until
 * BLD-01 the builder regenerated anyway and every one of those was
 * discarded in silence.
 *
 * This module says, for a given source, whether the round trip
 * source → model → source is exact for everything the engine reads — and
 * if not, why, in words the editor can show. The checks:
 *
 *   1. the lexer's token stream has no COMMENT tokens (the parser skips
 *      them and the generator cannot print what it never saw);
 *   2. every `{…}` region parses as one whole expression — parsed alone,
 *      it yields exactly one attribute and no diagnostics;
 *   3. the parser reported no diagnostics for the file;
 *   4. the header holds only blocks the regenerator carries across;
 *   5. the template of the regenerated source, parsed again, is the same
 *      tree as the original's — positions, literal spellings, attribute
 *      quoting and insignificant whitespace aside.
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
import { generateSource } from './sourceGenerator';

export type { SourceFidelity } from '../types/builder';

// ---------------------------------------------------------------------------
// 1. Comments
// ---------------------------------------------------------------------------

function safeTokenize(source: string): Token[] | null {
  try {
    return tokenize(source);
  } catch {
    return null;
  }
}

/** Reasons for every comment the parser would drop. */
export function findDroppedComments(source: string): string[] {
  const tokens = safeTokenize(source);
  if (!tokens) return ['the SoftN lexer could not read this file'];
  return tokens
    .filter((t) => t.type === TokenType.COMMENT)
    .map((t) => `a comment on line ${t.line} (the visual model has no place for comments)`);
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
export function findTruncatedExpressions(source: string): string[] {
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
// 4. Header blocks the regenerator carries across
// ---------------------------------------------------------------------------

/**
 * Reasons for header constructs the store's regeneration would not write
 * back. It keeps `<logic src>` or an inline `<logic>` (not both), every
 * `<import … />` tag, `<data>`, `<style>` and `<component>` blocks.
 */
export function findUnpreservedHeader(source: string, doc: SoftNDocument): string[] {
  const reasons: string[] = [];
  if (doc.script) {
    reasons.push('a <script> block (only <logic> is written back)');
  }
  const hasLogicSrc = /<logic\s+src=["'][^"']+["']\s*\/>/i.test(source);
  const hasInlineLogic = /<logic>[\s\S]*?<\/logic>/i.test(source);
  if (hasLogicSrc && hasInlineLogic) {
    reasons.push('both a <logic src> reference and an inline <logic> block (only one is written back)');
  }
  const importTags = source.match(
    /<import\s+(?:\{\s*[^}]+\s*\}|\w+)\s+from=["'][^"']+["']\s*\/>/gi
  );
  if ((doc.imports?.length ?? 0) > (importTags?.length ?? 0)) {
    reasons.push('an import that is not written as an <import … from="…" /> tag');
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// 5. Template comparison
// ---------------------------------------------------------------------------

/** The template nodes that carry content — whitespace-only text is layout. */
export function contentNodes(nodes: TemplateNode[]): TemplateNode[] {
  return nodes.filter((n) => n.type !== 'Text' || n.content.trim() !== '');
}

/** Whether the document's template is a single `<App>` element. */
export function hasSingleAppRoot(doc: SoftNDocument): boolean {
  const roots = contentNodes(doc.template);
  return roots.length === 1 && roots[0].type === 'Element' && roots[0].tag === 'App';
}

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

function shapeText(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

/**
 * The template with everything that does not reach the engine removed:
 * positions, literal spellings, attribute order, whether a tag was written
 * self-closing, and whitespace at the edges of text.
 */
export function shapeTemplate(nodes: TemplateNode[]): Shape[] {
  const out: Shape[] = [];
  for (const node of contentNodes(nodes)) {
    out.push(shapeNode(node));
  }
  return out;
}

function shapeNode(node: TemplateNode): Shape {
  switch (node.type) {
    case 'Text':
      return { type: 'Text', content: shapeText(node.content) };
    case 'Expression':
      return { type: 'Expression', expression: shapeExpression(node.expression) };
    case 'Element':
      return {
        type: 'Element',
        tag: node.tag,
        props: sortedByName(node.props).map((p) => ({ name: p.name, value: shapePropValue(p.value) })),
        events: sortedByName(node.events).map((e) => ({ name: e.name, handler: shapeExpression(e.handler) })),
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
export function firstDifference(a: unknown, b: unknown, path = 'template'): string | null {
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

/**
 * Compare the original template with the template the visual model would
 * write. Returns a reason when they differ.
 */
export function templateDifference(
  original: SoftNDocument,
  elements: Map<string, CanvasElement>,
  rootId: string,
  syntheticRoot: boolean
): string | null {
  const regenerated = generateSource(elements, rootId, '', [], { skipRootAppWrapper: syntheticRoot });
  let doc: SoftNDocument;
  try {
    doc = parse(regenerated);
  } catch (err) {
    return `the template the visual model writes does not parse (${err instanceof Error ? err.message : String(err)})`;
  }
  const bad = doc.diagnostics?.find((d) => d.severity === 'error');
  if (bad) {
    return `the template the visual model writes does not parse (${bad.message})`;
  }
  const difference = firstDifference(shapeTemplate(original.template), shapeTemplate(doc.template));
  return difference ? `the visual model does not reproduce the template (${difference})` : null;
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
  reasons.push(...findDroppedComments(input.source));
  reasons.push(...findTruncatedExpressions(input.source));
  reasons.push(...findUnpreservedHeader(input.source, input.doc));
  reasons.push(...input.conversionReasons);
  const difference = templateDifference(input.doc, input.elements, input.rootId, input.syntheticRoot);
  if (difference) reasons.push(difference);
  return { lossless: reasons.length === 0, reasons: dedupe(reasons) };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
