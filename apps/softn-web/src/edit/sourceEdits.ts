/**
 * An element of a page, read where it is written, and the simple changes to
 * it made as changes to that text: its words, and the attributes whose values
 * are plain (words, a number, yes or no).
 *
 * A change is never trusted to have been written right. The file is read
 * again with it in place, by the parser the runtime uses, and the change is
 * given back only if the element then says exactly what was asked and the
 * page around it is the page it was. Text the page's own syntax would read
 * as something else (a brace, a tag, a quote) is escaped the way a person
 * would write it; where even that does not come out as asked, nothing is
 * changed, and the person is told to make the change in the source.
 */

import { parse, type ElementNode, type PropNode, type SoftNDocument, type TemplateNode } from '@softn/core';

/** A value an attribute can be given here. */
export type PlainValue = string | number | boolean;

export interface WrittenAttribute {
  name: string;
  /** From its name to the end of its value. */
  start: number;
  end: number;
  /** Its value when that is a plain one; undefined when it is worked out by the app. */
  value?: PlainValue;
}

export interface ElementSource {
  tag: string;
  /** Where its `<` is, and where its name begins: the place the parser knows it by. */
  start: number;
  nameStart: number;
  nameEnd: number;
  /** Just past the `>` of its opening tag. */
  openEnd: number;
  selfClosing: boolean;
  attributes: WrittenAttribute[];
  /** What else is written on it, as written: handlers, bindings, `if=` and `each=`. */
  wired: string[];
  /** Attributes written a second time, by name: the page reads the first of each and nothing of these. */
  twice: string[];
  /**
   * Its words, where what is inside it is words alone, on one line as a page
   * draws them: where they are and what they say. None for text whose line
   * breaks are kept (`<pre>`, `<textarea>`): a field of one line would write
   * it back as one line.
   */
  text?: { start: number; end: number; value: string };
  /** What is inside it keeps its line breaks and spaces as written, which is why it has no `text`. */
  keptLines: boolean;
  /** Inside a loop of this file, or one itself: drawn once for each item. */
  repeated: boolean;
}

const isSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/** Past the quoted value that opens at `from`; -1 when it never closes. */
function pastQuoted(text: string, from: number): number {
  const quote = text[from];
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i + 1;
  }
  return -1;
}

/** Past the `{…}` that opens at `from`, its strings and comments read as such; -1 when it never closes. */
function pastBraces(text: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const past = pastQuoted(text, i);
      if (past === -1) return -1;
      i = past;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 2;
    } else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end === -1) return -1;
      i = end;
    } else {
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return i + 1;
      i++;
    }
  }
  return -1;
}

interface ScannedTag {
  nameEnd: number;
  openEnd: number;
  selfClosing: boolean;
  attributes: Array<{ name: string; start: number; end: number }>;
}

/** An opening tag read from its name: where each thing written on it begins and ends. */
function scanTag(text: string, nameStart: number): ScannedTag | null {
  let i = nameStart;
  while (i < text.length && !isSpace(text[i]) && text[i] !== '>' && !(text[i] === '/' && text[i + 1] === '>')) i++;
  const nameEnd = i;
  const attributes: ScannedTag['attributes'] = [];
  for (;;) {
    while (isSpace(text[i])) i++;
    const ch = text[i];
    if (ch === undefined || ch === '<') return null;
    if (ch === '>') return { nameEnd, openEnd: i + 1, selfClosing: false, attributes };
    if (ch === '/' && text[i + 1] === '>') return { nameEnd, openEnd: i + 2, selfClosing: true, attributes };
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end === -1) return null;
      i = end;
      continue;
    }
    const start = i;
    if (ch === '{') {
      const past = pastBraces(text, i);
      if (past === -1) return null;
      attributes.push({ name: text.slice(start, past), start, end: past });
      i = past;
      continue;
    }
    while (i < text.length && !isSpace(text[i]) && !'=><{"\''.includes(text[i]) && !(text[i] === '/' && text[i + 1] === '>')) i++;
    if (i === start) return null;
    const name = text.slice(start, i);
    let end = i;
    let after = i;
    while (isSpace(text[after])) after++;
    if (text[after] === '=') {
      after++;
      while (isSpace(text[after])) after++;
      const first = text[after];
      if (first === '"' || first === "'" || first === '`') end = pastQuoted(text, after);
      else if (first === '{') end = pastBraces(text, after);
      else {
        end = after;
        while (end < text.length && !isSpace(text[end]) && text[end] !== '>' && !(text[end] === '/' && text[end + 1] === '>')) end++;
      }
      if (end === -1) return null;
    }
    attributes.push({ name, start, end });
    i = end;
  }
}

function read(text: string): SoftNDocument | null {
  try {
    return parse(text);
  } catch {
    return null;
  }
}

/** The element whose name begins at `nameStart`, and the nodes it is inside, outermost first. */
function find(nodes: readonly TemplateNode[], nameStart: number, trail: TemplateNode[] = []): { node: ElementNode; trail: TemplateNode[] } | null {
  for (const node of nodes) {
    if (node.type === 'Element') {
      if (node.loc.start === nameStart) return { node, trail };
      const inside = find(node.children, nameStart, [...trail, node]);
      if (inside) return inside;
    } else if (node.type === 'IfBlock') {
      const inside =
        find(node.consequent, nameStart, [...trail, node]) ??
        (Array.isArray(node.alternate) ? find(node.alternate, nameStart, [...trail, node]) : node.alternate ? find([node.alternate], nameStart, trail) : null);
      if (inside) return inside;
    } else if (node.type === 'EachBlock') {
      const inside = find(node.body, nameStart, [...trail, node]) ?? find(node.emptyFallback ?? [], nameStart, trail);
      if (inside) return inside;
    } else if (node.type === 'TemplateSlot') {
      const inside = find(node.children, nameStart, [...trail, node]);
      if (inside) return inside;
    } else if (node.type === 'Slot') {
      const inside = find(node.fallback ?? [], nameStart, [...trail, node]);
      if (inside) return inside;
    }
  }
  return null;
}

function countElements(nodes: readonly TemplateNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === 'Element') count += 1 + countElements(node.children);
    else if (node.type === 'IfBlock') count += countElements(node.consequent) + (Array.isArray(node.alternate) ? countElements(node.alternate) : node.alternate ? countElements([node.alternate]) : 0);
    else if (node.type === 'EachBlock') count += countElements(node.body) + countElements(node.emptyFallback ?? []);
    else if (node.type === 'TemplateSlot') count += countElements(node.children);
    else if (node.type === 'Slot') count += countElements(node.fallback ?? []);
  }
  return count;
}

/** A prop's value when it is a plain one, written bare, quoted, or as a literal in braces. */
function plainValue(prop: PropNode): PlainValue | undefined {
  const value = prop.value;
  if (value.type !== 'expression') return value.value;
  const expression = value.value as { type: string; value?: unknown };
  if (expression.type !== 'Literal') return undefined;
  return typeof expression.value === 'string' || typeof expression.value === 'number' || typeof expression.value === 'boolean' ? expression.value : undefined;
}

/**
 * Words as a page draws them on a line: runs of spaces, tabs and line breaks
 * are one space, and none at either end. Only those: a no-break space is a
 * character a person typed, and is kept and compared as one.
 */
const collapsed = (text: string): string => text.replace(/[ \t\r\n\f]+/g, ' ').replace(/^ | $/g, '');

/** The elements whose text keeps its line breaks and its runs of spaces. */
const PREFORMATTED = new Set(['pre', 'textarea', 'xmp', 'listing', 'plaintext']);

/** The element whose name begins at `nameStart` of `text`, as it is written; null where there is none to read. */
export function readElement(text: string, nameStart: number): ElementSource | null {
  if (text[nameStart - 1] !== '<') return null;
  const doc = read(text);
  const found = doc ? find(doc.template, nameStart) : null;
  const tag = scanTag(text, nameStart);
  if (!found || !tag) return null;
  const { node, trail } = found;

  const attributes: WrittenAttribute[] = [];
  const wired: string[] = [];
  const twice: string[] = [];
  const seen = new Set<string>();
  for (const written of tag.attributes) {
    const prop = node.props.find((candidate) => candidate.loc.start === written.start);
    if (prop) attributes.push({ name: prop.name, start: written.start, end: written.end, value: plainValue(prop) });
    // The same name again: the parser kept the first and dropped this one.
    else if (seen.has(written.name.toLowerCase())) twice.push(written.name);
    else wired.push(written.name);
    seen.add(written.name.toLowerCase());
  }

  // Text whose line breaks and runs of spaces are kept is not words on a
  // line: no field for it. Told by where it is (a <pre>, a <textarea>), and
  // by what the parser read: a break left in a text is one it kept.
  const keepsLines = (around: TemplateNode | ElementNode): boolean => around.type === 'Element' && PREFORMATTED.has(around.tag.toLowerCase());
  const only = node.children.length === 1 && node.children[0].type === 'Text' ? node.children[0] : null;
  const keptLines = keepsLines(node) || trail.some(keepsLines) || (only !== null && /[\r\n]/.test(only.content));
  let words: ElementSource['text'];
  if (!tag.selfClosing && !node.selfClosing && !keptLines) {
    if (only) {
      const child = only;
      const raw = text.slice(child.loc.start, child.loc.end);
      const lead = raw.length - raw.trimStart().length;
      const kept = raw.trimEnd().length;
      if (kept > lead) words = { start: child.loc.start + lead, end: child.loc.start + kept, value: collapsed(child.content) };
    } else if (node.children.length === 0) {
      // Nothing inside it yet: words go between its tags, where its closing tag follows.
      const close = /^\s*<\//.exec(text.slice(tag.openEnd));
      if (close) words = { start: tag.openEnd, end: tag.openEnd + close[0].length - 2, value: '' };
    }
  }

  const repeated = Boolean(node.inlineEach) || trail.some((around) => around.type === 'EachBlock' || (around.type === 'Element' && Boolean(around.inlineEach)));
  return {
    tag: node.tag,
    start: nameStart - 1,
    nameStart,
    nameEnd: tag.nameEnd,
    openEnd: tag.openEnd,
    selfClosing: tag.selfClosing,
    attributes,
    twice,
    keptLines,
    wired,
    text: words,
    repeated,
  };
}

/**
 * The space characters that are not the space bar's: a no-break space, the
 * line and paragraph separators, the wide and thin spaces. A page's reader
 * takes one written as itself for an ordinary space, and one written as a
 * character reference for what it is. So they are written as references:
 * a person who typed a no-break space gets one.
 */
const OTHER_SPACE_CODES = [0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
const isOtherSpace = (code: number): boolean => OTHER_SPACE_CODES.includes(code) || (code >= 0x2000 && code <= 0x200a);
/** `text` with each of them written as a character reference. Named by number, so that none is in this file as itself. */
const otherSpacesAsReferences = (text: string): string => Array.from(text, (ch) => (ch.length === 1 && isOtherSpace(ch.charCodeAt(0)) ? `&#${ch.charCodeAt(0)};` : ch)).join('');

/** Words as a page writes them between tags: what its syntax would read as markup is escaped. */
function writtenText(value: string, entities: boolean): string {
  const escaped = collapsed(value).replace(/[\\{<#]/g, (ch) => `\\${ch}`);
  const text = entities ? otherSpacesAsReferences(escaped.replace(/&/g, '&amp;')) : escaped;
  // `//` where words begin is a comment.
  return text.startsWith('//') ? `&#47;${text.slice(1)}` : text;
}

/** An attribute as a page writes it. */
function writtenAttribute(name: string, value: PlainValue): string | null {
  if (typeof value === 'boolean') return value ? name : `${name}={false}`;
  if (typeof value === 'number') return Number.isFinite(value) ? `${name}={${String(value)}}` : null;
  const text = value.replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\\/g, '&#92;');
  return `${name}="${otherSpacesAsReferences(text)}"`;
}

const ATTRIBUTE_NAME = /^[A-Za-z_][\w.-]*(?::[\w-]+)?$/;

/** How many of the page's problems stop it: a change must not add one. */
function errors(doc: SoftNDocument): number {
  return (doc.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 'error').length;
}

/** `text` changed to `next`, when the element at `nameStart` then passes `holds` and the page around it is the page it was. */
function checked(text: string, next: string, nameStart: number, holds: (node: ElementNode) => boolean): string | null {
  if (next === text) return text;
  const before = read(text);
  const after = read(next);
  if (!before || !after) return null;
  const node = find(after.template, nameStart)?.node;
  const was = find(before.template, nameStart)?.node;
  if (!node || !was || node.tag !== was.tag) return null;
  if (countElements(after.template) !== countElements(before.template) || errors(after) > errors(before)) return null;
  return holds(node) ? next : null;
}

/**
 * `text` with the attribute `name` of `element` set to `value`, or taken off
 * it for `undefined`. Null when it cannot be written so that it reads back
 * as asked.
 */
export function withAttribute(text: string, element: ElementSource, name: string, value: PlainValue | undefined): string | null {
  if (!ATTRIBUTE_NAME.test(name)) return null;
  const existing = element.attributes.find((attribute) => attribute.name === name);
  let next: string;
  if (value === undefined) {
    if (!existing) return text;
    let from = existing.start;
    while (from > element.nameEnd && (text[from - 1] === ' ' || text[from - 1] === '\t')) from--;
    // An attribute alone on its line takes the line with it.
    if (text[from - 1] === '\n' && /^[ \t]*\r?\n/.test(text.slice(existing.end))) from -= text[from - 2] === '\r' ? 2 : 1;
    next = text.slice(0, from) + text.slice(existing.end);
  } else {
    const written = writtenAttribute(name, value);
    if (written === null) return null;
    next = existing
      ? text.slice(0, existing.start) + written + text.slice(existing.end)
      : `${text.slice(0, element.nameEnd)} ${written}${text.slice(element.nameEnd)}`;
  }
  return checked(text, next, element.nameStart, (node) => {
    const props = node.props.filter((prop) => prop.name === name);
    if (value === undefined) return props.length === 0;
    return props.length === 1 && plainValue(props[0]) === (typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ') : value);
  });
}

/** `text` with the words of `element` changed to `value`. Null when it has no words to change, or they do not read back as asked. */
export function withText(text: string, element: ElementSource, value: string): string | null {
  const words = element.text;
  if (!words) return null;
  const asked = collapsed(value);
  for (const entities of [true, false]) {
    const written = writtenText(value, entities);
    const next = text.slice(0, words.start) + written + text.slice(words.end);
    const result = checked(text, next, element.nameStart, (node) => {
      if (asked === '') return node.children.length === 0;
      return node.children.length === 1 && node.children[0].type === 'Text' && collapsed(node.children[0].content) === asked;
    });
    if (result !== null) return result;
  }
  return null;
}

/** Where what a node of a page draws from ends in its text, as far as it can be told. */
function endOf(text: string, node: TemplateNode, spans: Array<{ node: ElementNode; start: number; end: number }>): number {
  if (node.type === 'Element') {
    const tag = scanTag(text, node.loc.start);
    if (!tag) return node.loc.end;
    let end = tag.openEnd;
    if (!tag.selfClosing && !node.selfClosing) {
      for (const child of node.children) end = Math.max(end, endOf(text, child, spans));
      // Its closing tag is the next tag after everything inside it, where
      // that is one of its name. An element left unclosed (a <p> or an <li>
      // that the next block closes) ends where that next tag begins: the
      // closing tag of a later element of the same name is not its own.
      const next = text.indexOf('<', end);
      const close = next < 0 ? null : new RegExp(`^</${node.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`, 'i').exec(text.slice(next, next + node.tag.length + 64));
      if (close) end = next + close[0].length;
      else if (next >= 0) end = Math.max(end, text.slice(0, next).trimEnd().length);
    }
    spans.push({ node, start: node.loc.start - 1, end });
    return end;
  }
  let end = node.loc.end;
  const inside: TemplateNode[] =
    node.type === 'IfBlock'
      ? [...node.consequent, ...(Array.isArray(node.alternate) ? node.alternate : node.alternate ? [node.alternate] : [])]
      : node.type === 'EachBlock'
        ? [...node.body, ...(node.emptyFallback ?? [])]
        : node.type === 'TemplateSlot'
          ? node.children
          : node.type === 'Slot'
            ? (node.fallback ?? [])
            : [];
  for (const child of inside) end = Math.max(end, endOf(text, child, spans));
  return end;
}

/**
 * The element whose lines the place `caret` of `text` is in: the innermost
 * one, from its opening tag to its closing tag. For picking an element from
 * the keyboard, by where the caret is in the source. Null where the caret is
 * in no element, or the page cannot be read.
 */
export function elementAtCaret(text: string, caret: number): ElementSource | null {
  const doc = read(text);
  if (!doc) return null;
  const spans: Array<{ node: ElementNode; start: number; end: number }> = [];
  for (const node of doc.template) endOf(text, node, spans);
  let found: { node: ElementNode; start: number; end: number } | null = null;
  for (const span of spans) {
    // From just before its `<` to just before the end of its closing tag: a
    // caret between two elements is in the one around them, not the one it
    // follows. The one that begins last is the innermost: an element begins
    // after the ones it is inside.
    if (span.start <= caret && caret < span.end && (!found || span.start > found.start)) found = span;
  }
  return found ? readElement(text, found.node.loc.start) : null;
}

/**
 * Where a place in a text is after the text was changed to another: the same
 * place when the change was after it, moved along when the change was before
 * it, and null when the change took it.
 */
export function movedPlace(before: string, after: string, place: number): number | null {
  if (before === after) return place;
  let same = 0;
  const shortest = Math.min(before.length, after.length);
  while (same < shortest && before.charCodeAt(same) === after.charCodeAt(same)) same++;
  if (place < same) return place;
  let tail = 0;
  while (tail < shortest - same && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
  return place >= before.length - tail ? place + (after.length - before.length) : null;
}
