/**
 * The part of a .ui file the visual model writes, and the parts it leaves
 * exactly as they are.
 *
 * A visual edit regenerates a file's template from its canvas elements.
 * Everything else in the file used to be carried across by regular
 * expression: the `<logic>`, `<import>`, `<data>` and `<style>` blocks were
 * picked out of the old source and written back in a fixed order above the
 * new template. Whatever those expressions did not pick out was gone — a
 * comment at the head of the file, a `<script>` block, the blank lines an
 * author had left — and a `<style>` written after the template was moved
 * above it. So any file with a comment in it could not be edited in Design
 * at all, which was four in five of the shipped examples.
 *
 * A file is now three stretches of its own text. What stands before the
 * first thing of the template and what stands after the last are kept byte
 * for byte; only the stretch between them is written from the model. A
 * comment inside that stretch is kept with the element it stands directly
 * before (see CanvasComment); one that stands anywhere else there has no
 * element to stay with, and such a file is still edited as source.
 */

import { tokenize, TokenType } from '@softn/core';
import type { SoftNDocument, TemplateNode, Token } from '@softn/core';
import type { CanvasComment, CanvasElement } from '../types/builder';
import { generateSource } from './sourceGenerator';

/** The template nodes that carry content: whitespace-only text between roots is layout. */
export function contentNodes(nodes: TemplateNode[]): TemplateNode[] {
  return nodes.filter((n) => n.type !== 'Text' || n.content.trim() !== '');
}

/** Whether the document's template is a single `<App>` element. */
export function hasSingleAppRoot(doc: SoftNDocument): boolean {
  const roots = contentNodes(doc.template);
  return roots.length === 1 && roots[0].type === 'Element' && roots[0].tag === 'App';
}

/** Every list of nodes a node holds: an element's children, a block's branches, a slot's fallback. */
export function branchesOf(node: TemplateNode): TemplateNode[][] {
  switch (node.type) {
    case 'Element':
    case 'TemplateSlot':
      return [node.children];
    case 'IfBlock':
      return [node.consequent, node.alternate ? (Array.isArray(node.alternate) ? node.alternate : [node.alternate]) : []];
    case 'EachBlock':
      return [node.body, node.emptyFallback ?? []];
    case 'Slot':
      return [node.fallback ?? []];
    default:
      return [];
  }
}

/**
 * Where a node's own text begins. The parser records where a tag's name or
 * a block's keyword starts; the `<` or `#` that opens it is just before.
 */
export function anchorOf(node: { type: string; loc: { start: number } }, source: string): number {
  const opener =
    node.type === 'IfBlock' || node.type === 'EachBlock' ? '#' : node.type === 'Text' || node.type === 'Expression' ? null : '<';
  if (!opener) return node.loc.start;
  let at = node.loc.start - 1;
  while (at > 0 && /\s/.test(source[at])) at--;
  return source[at] === opener ? at : node.loc.start;
}

/** A comment of the source, and the token that follows the run of comments it is in. */
export interface SourceComment extends CanvasComment {
  line: number;
  start: number;
  end: number;
  /** Where the next thing that is not a comment begins, or null at the end of the file. */
  followedAt: number | null;
}

function safeTokenize(source: string): Token[] | null {
  try {
    return tokenize(source);
  } catch {
    return null;
  }
}

/** Every comment the lexer finds outside `<logic>`, `<script>` and `<style>`, in order; null when it cannot read the file. */
export function commentsOf(source: string): SourceComment[] | null {
  const tokens = safeTokenize(source);
  if (!tokens) return null;
  const comments: SourceComment[] = [];
  tokens.forEach((token, index) => {
    if (token.type !== TokenType.COMMENT) return;
    const raw = source.slice(token.start, token.end);
    let next = index + 1;
    while (next < tokens.length && tokens[next].type === TokenType.COMMENT) next++;
    const following = tokens[next];
    comments.push({
      // `/* … */` is a comment only inside braces, where the model has no
      // place for one; it is told apart so it is never written as another form.
      form: raw.startsWith('<!--') ? 'html' : 'line',
      text: raw.startsWith('/*') ? raw : token.literal,
      line: token.line,
      start: token.start,
      end: token.end,
      followedAt: following && following.type !== TokenType.EOF ? following.start : null,
    });
  });
  return comments;
}

export interface SourceFrame {
  /** The file up to the first thing of its template, as written. */
  prefix: string;
  /** The whitespace that ended the template's stretch, as written. */
  trailing: string;
  /** The file from the first thing after its template to its end, as written. */
  tail: string;
  /** Where the template's stretch begins and ends in the source. */
  bodyStart: number;
  tailStart: number;
  /** What about the file's layout the three stretches cannot hold. */
  reasons: string[];
}

const HEADER_NAMES: Array<[keyof SoftNDocument, string]> = [
  ['logic', 'logic'],
  ['script', 'script'],
  ['data', 'data'],
  ['style', 'style'],
  ['component', 'component'],
];

/** The tags that declare something, by the token the lexer gives their name after `<`. */
const HEADER_TOKENS: ReadonlyMap<TokenType, string> = new Map([
  [TokenType.LOGIC, 'logic'],
  [TokenType.SCRIPT, 'script'],
  [TokenType.DATA, 'data'],
  [TokenType.STYLE, 'style'],
  [TokenType.COMPONENT, 'component'],
  [TokenType.IMPORT, 'import'],
]);

/**
 * Where each declaring block of the file opens, every one of them.
 *
 * The parsed page has one place for its `<data>` and one for its `<style>`,
 * the first of each, since the parser reads every block of a kind as one.
 * A second block written after the template was therefore unknown here, was
 * taken for the end of the template and written over by the first visual
 * edit, and a page that had one could only be edited as source. So the
 * places are read from the file's own tokens: a `<` followed by one of the
 * declaring names, where no element of the template begins (`anchors`).
 */
function declaringBlocks(source: string, doc: SoftNDocument, anchors: ReadonlySet<number>): Array<{ name: string; at: number }> {
  const blocks: Array<{ name: string; at: number }> = [];
  const tokens = safeTokenize(source);
  if (tokens) {
    tokens.forEach((token, index) => {
      if (token.type !== TokenType.TAG_OPEN || anchors.has(token.start)) return;
      const name = HEADER_TOKENS.get(tokens[index + 1]?.type);
      if (name) blocks.push({ name, at: token.start });
    });
    return blocks;
  }
  // A file the lexer cannot read again: the places the parser kept.
  for (const [key, name] of HEADER_NAMES) {
    const block = doc[key] as { type: string; loc: { start: number } } | undefined;
    if (block) blocks.push({ name, at: anchorOf({ type: 'Element', loc: block.loc }, source) });
  }
  for (const imported of doc.imports ?? []) {
    blocks.push({ name: 'import', at: anchorOf({ type: 'Element', loc: imported.loc }, source) });
  }
  return blocks;
}

/** The three stretches of `source`, or null when it has no template to write. */
export function frameSource(source: string, doc: SoftNDocument): SourceFrame | null {
  const roots = contentNodes(doc.template);
  if (roots.length === 0) return null;
  const reasons: string[] = [];

  const bodyStart = anchorOf(roots[0], source);
  // The last node of the template, however deep: nothing of the template
  // begins after it, so a block that begins after it is past the template.
  let lastStart = bodyStart;
  const anchors = new Set<number>();
  const visit = (nodes: TemplateNode[]): void => {
    for (const node of nodes) {
      const at = anchorOf(node, source);
      anchors.add(at);
      lastStart = Math.max(lastStart, at);
      for (const branch of branchesOf(node)) visit(branch);
    }
  };
  visit(doc.template);

  const blocks = declaringBlocks(source, doc, anchors);

  let tailStart = source.length;
  for (const block of blocks) {
    if (block.at < bodyStart) continue;
    if (block.at > lastStart) tailStart = Math.min(tailStart, block.at);
    else reasons.push(`a <${block.name}> block stands between parts of the template (the visual model writes the template as one piece)`);
  }
  // Comments that stand after the template belong to what follows it.
  const comments = commentsOf(source) ?? [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment.end > tailStart || comment.start < lastStart) continue;
    if (source.slice(comment.end, tailStart).trim() !== '') break;
    tailStart = comment.start;
  }

  const body = source.slice(bodyStart, tailStart);
  const trailing = /\s*$/.exec(body)?.[0] ?? '';
  // A root that begins its own line: its indentation is not kept before a
  // template that is written from the margin.
  const prefix = source.slice(0, bodyStart).replace(/(^|\n)[ \t]+$/, '$1');
  return { prefix, trailing, tail: source.slice(tailStart), bodyStart, tailStart, reasons };
}

/**
 * `source` with its template written from the canvas elements and the rest
 * of it as it was. `doc` is `source` parsed.
 */
export function writeBack(
  source: string,
  doc: SoftNDocument,
  elements: Map<string, CanvasElement>,
  rootId: string
): string {
  const template = generateSource(elements, rootId, '', [], { skipRootAppWrapper: !hasSingleAppRoot(doc) });
  const frame = frameSource(source, doc);
  if (!frame) return template;
  return `${frame.prefix}${template}${frame.trailing}${frame.tail}`;
}
