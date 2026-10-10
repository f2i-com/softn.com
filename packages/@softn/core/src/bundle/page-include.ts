/**
 * Reading a page as text, as far as placing one page inside another needs.
 *
 * `<import Header from="./header.ui" />` makes `Header` an include: where the
 * name is written the imported page's markup is put, in the importing page's
 * scope. That is done on the source text, before anything is parsed, so the
 * composer has to find four things without a parser: where a tag ends, where
 * the comments are, what stands at the top of a page, and the declarations
 * inside a `<data>` block.
 *
 * Everything here follows the lexer's rules for the same text (a quoted value
 * ends at its quote or at the end of the line, `{…}` is an expression, `//`
 * opens a comment where a token could start) and is deliberately no more than
 * that. Where the text is not markup this can follow — a brace that never
 * closes, an element that never does — the page is left exactly as written.
 */

const isSpace = (ch: string | undefined): boolean =>
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/** The offset of the end of the line `from` is on. */
function endOfLine(source: string, from: number): number {
  const end = source.indexOf('\n', from);
  return end === -1 ? source.length : end;
}

/** Past the quoted value that opens at `from`. A value left open ends with its line, as the lexer has it. */
function skipQuoted(source: string, from: number): number {
  const quote = source[from];
  let i = from + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') i += 2;
    else if (ch === quote) return i + 1;
    else if (ch === '\n' || ch === '\r') return i;
    else i++;
  }
  return source.length;
}

/** Past the template literal that opens at `from`, expressions inside it included. */
function skipTemplateLiteral(source: string, from: number): number {
  let i = from + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') i += 2;
    else if (ch === '`') return i + 1;
    else if (ch === '$' && source[i + 1] === '{') {
      const end = skipBalanced(source, i + 1);
      if (end === -1) return source.length;
      i = end;
    } else i++;
  }
  return source.length;
}

/** A stretch of text that is a comment: from its first character to just past its last. */
type Span = [start: number, end: number];

/**
 * Past the `{…}` or `(…)` that opens at `from`, or -1 when it never closes.
 * What is inside is an expression: its strings, template literals and
 * comments may hold any bracket, and `>` is a comparison or half of `=>`.
 * The comments passed over are added to `comments` when it is given.
 */
function skipBalanced(source: string, from: number, comments?: Span[]): number {
  const open = source[from];
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  let i = from;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") i = skipQuoted(source, i);
    else if (ch === '`') i = skipTemplateLiteral(source, i);
    else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const past = end === -1 ? source.length : end + 2;
      comments?.push([i, past]);
      i = past;
    } else if (ch === '/' && source[i + 1] === '/') {
      const past = endOfLine(source, i);
      comments?.push([i, past]);
      i = past;
    } else {
      if (ch === open) depth++;
      else if (ch === close && --depth === 0) return i + 1;
      i++;
    }
  }
  return -1;
}

/** An attribute as it is written: its name, and the text of its value when it has one. */
interface ScannedAttribute {
  name: string;
  value?: string;
}

interface ScannedTag {
  /** The offset just past the tag's `>` or `/>`. */
  end: number;
  selfClosing: boolean;
  attributes: ScannedAttribute[];
}

/**
 * Read an opening tag from just after its name to its end, or null when the
 * text there is not a tag (it runs into another `<`, or out of text).
 *
 * The end is the first `>` or `/>` that is not inside a quoted value or an
 * expression — which is what a pattern like `<Name[^>]*>` cannot find when
 * an attribute holds `() => save()`. The comments passed over are added to
 * `comments` when it is given.
 */
function scanTag(source: string, from: number, comments?: Span[]): ScannedTag | null {
  const attributes: ScannedAttribute[] = [];
  let i = from;
  for (;;) {
    while (isSpace(source[i])) i++;
    const ch = source[i];
    if (ch === undefined || ch === '<') return null;
    if (ch === '>') return { end: i + 1, selfClosing: false, attributes };
    if (ch === '/' && source[i + 1] === '>') return { end: i + 2, selfClosing: true, attributes };
    if (ch === '/' && source[i + 1] === '/') {
      const past = endOfLine(source, i);
      comments?.push([i, past]);
      i = past;
      continue;
    }
    if (ch === '{') {
      // `{...props}`: an attribute with no name of its own.
      const end = skipBalanced(source, i, comments);
      if (end === -1) return null;
      attributes.push({ name: source.slice(i, end) });
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i);
      continue;
    }
    if (ch === '=') {
      i++;
      continue;
    }

    const nameStart = i;
    while (i < source.length) {
      const c = source[i];
      if (isSpace(c) || c === '=' || c === '>' || c === '<' || c === '{' || c === '"' || c === "'") break;
      if (c === '/' && source[i + 1] === '>') break;
      i++;
    }
    const name = source.slice(nameStart, i);

    let valueStart = i;
    while (isSpace(source[valueStart])) valueStart++;
    if (source[valueStart] !== '=') {
      attributes.push({ name });
      continue;
    }
    valueStart++;
    while (isSpace(source[valueStart])) valueStart++;
    const first = source[valueStart];
    let valueEnd = valueStart;
    if (first === '"' || first === "'") valueEnd = skipQuoted(source, valueStart);
    else if (first === '{') {
      valueEnd = skipBalanced(source, valueStart, comments);
      if (valueEnd === -1) return null;
    } else {
      // A bare value: `gap=md`, `limit=10`.
      while (valueEnd < source.length) {
        const c = source[valueEnd];
        if (isSpace(c) || c === '>' || c === '<' || (c === '/' && source[valueEnd + 1] === '>')) break;
        valueEnd++;
      }
    }
    attributes.push({ name, value: source.slice(valueStart, valueEnd) });
    i = valueEnd;
  }
}

/** Where `</name>` next stands at or after `from`. */
function closingTag(source: string, name: string, from: number): { start: number; end: number } | null {
  const close = `</${name}`;
  let at = source.indexOf(close, from);
  while (at !== -1) {
    let i = at + close.length;
    while (isSpace(source[i])) i++;
    if (source[i] === '>') return { start: at, end: i + 1 };
    at = source.indexOf(close, at + close.length);
  }
  return null;
}

/** What was written on a use of an imported page, and is dropped. */
export interface IgnoredOnUse {
  attributes: string[];
  children: boolean;
}

/**
 * Put `markup` wherever `name` is used as a tag in `source`: `<Name />`,
 * `<Name … />` and `<Name …>…</Name>`.
 *
 * Attributes and children written on the use are not part of what replaces
 * it — an imported page has no properties, events or slots — so each use
 * that carries any is reported to `onIgnored`.
 *
 * The self-closing uses are placed first and the paired ones after, over the
 * text as it then stands, which is the order this has always been done in. A
 * paired use closes at the first `</Name>` after it.
 *
 * A use written inside a comment is not a use. It was replaced like any
 * other, so commenting one out did not take it out: where the page put in
 * its place had a comment of its own, that comment's `-->` ended the
 * author's and the rest was drawn, and behind `//` every line after the
 * first was.
 */
export function placeInclude(
  source: string,
  name: string,
  markup: string,
  onIgnored: (ignored: IgnoredOnUse) => void
): string {
  const open = `<${name}`;
  const place = (text: string, paired: boolean): string => {
    let out = '';
    let copied = 0;
    let search = 0;
    // Found when the name is first met: most passes meet it never or once.
    let comments: Span[] | null = null;
    let comment = 0;
    for (;;) {
      const at = text.indexOf(open, search);
      if (at === -1) break;
      search = at + open.length;
      // The name has to end here: `<RowHeader>` is not a use of `Row`.
      const next = text[search];
      if (!(next === '>' || isSpace(next) || (next === '/' && text[search + 1] === '>'))) continue;
      comments ??= commentSpans(text);
      while (comment < comments.length && comments[comment][1] <= at) comment++;
      if (comment < comments.length && comments[comment][0] <= at) {
        // Inside a comment: nothing in it is a use, to its end.
        search = Math.max(search, comments[comment][1]);
        continue;
      }
      const tag = scanTag(text, search);
      if (!tag || tag.selfClosing === paired) continue;

      let end = tag.end;
      let children = false;
      if (paired) {
        const close = closingTag(text, name, tag.end);
        if (!close) continue;
        children = text.slice(tag.end, close.start).trim() !== '';
        end = close.end;
      }
      if (tag.attributes.length > 0 || children) {
        onIgnored({ attributes: tag.attributes.map((attribute) => attribute.name), children });
      }
      out += text.slice(copied, at) + markup;
      copied = end;
      search = end;
    }
    return out + text.slice(copied);
  };
  return place(place(source, false), true);
}

/** An element opened outside every other element of a page. */
interface TopLevelElement {
  name: string;
  start: number;
  /** Just past the opening tag. */
  openEnd: number;
  /** Where the closing tag begins; `end` for a self-closing element. */
  closeStart: number;
  end: number;
}

/** A block and what is between its tags. */
interface Block {
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
}

interface PageOutline {
  roots: TopLevelElement[];
  /** `<data>…</data>` blocks at the top of the page, where they are declarations. */
  dataBlocks: Block[];
  /** `<style>…</style>` blocks at the top of the page, where they are the document's style. */
  styleBlocks: Block[];
  /** Whether anything but elements is drawn at the top: words, an expression, an `#if` or `#each`. */
  loose: boolean;
  /** Whether the text could not be followed to its end. */
  broken: boolean;
}

/** The blocks the lexer reads as raw text up to their closing tag. */
const RAW_BLOCKS = new Set(['style', 'script', 'logic']);
const CONTROL_FLOW_WORD = /#(if|elseif|else|each|empty|end)(?![A-Za-z])/y;
const TAG_NAME = /[A-Za-z_$][\w$]*/y;

/** Where `pattern` (a sticky one) ends when it matches at `at`, or -1. */
function endOfMatch(pattern: RegExp, source: string, at: number): number {
  pattern.lastIndex = at;
  return pattern.test(source) ? pattern.lastIndex : -1;
}

/**
 * Where the comments of a page are: `<!-- … -->`, a `//` line where a token
 * could start, and the comments among a tag's attributes and inside `{…}`.
 *
 * In order, and never one inside another. Text this cannot follow — a brace
 * or a tag that never closes — is passed over a character at a time, so what
 * comes after it is still looked at.
 */
function commentSpans(source: string): Span[] {
  const spans: Span[] = [];
  // `//` is a comment only where a token could start, not inside a run of words.
  let atTokenStart = true;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (isSpace(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/' && atTokenStart) {
      const past = endOfLine(source, i);
      spans.push([i, past]);
      i = past;
      continue;
    }
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      const past = end === -1 ? source.length : end + 3;
      spans.push([i, past]);
      i = past;
      atTokenStart = true;
      continue;
    }

    // An expression, or the header of an `#if` or `#each`: its comments are
    // kept only if it closes.
    const wordEnd = ch === '#' ? endOfMatch(CONTROL_FLOW_WORD, source, i) : -1;
    let opens = ch === '{' ? i : -1;
    if (wordEnd !== -1) {
      let header = wordEnd;
      while (source[header] === ' ' || source[header] === '\t') header++;
      if (header > wordEnd && source.slice(wordEnd - 4, wordEnd) === 'else' && source.startsWith('if', header)) {
        header += 2;
        while (source[header] === ' ' || source[header] === '\t') header++;
      }
      if (source[header] === '(') opens = header;
      else {
        i = wordEnd;
        atTokenStart = true;
        continue;
      }
    }
    if (opens !== -1) {
      const inside: Span[] = [];
      const end = skipBalanced(source, opens, inside);
      if (end !== -1) {
        spans.push(...inside);
        i = end;
        atTokenStart = true;
        continue;
      }
    } else if (ch === '<' && source[i + 1] === '/') {
      const end = source.indexOf('>', i);
      i = end === -1 ? source.length : end + 1;
      atTokenStart = true;
      continue;
    } else if (ch === '<') {
      const nameEnd = endOfMatch(TAG_NAME, source, i + 1);
      const inside: Span[] = [];
      const tag = nameEnd === -1 ? null : scanTag(source, nameEnd, inside);
      if (tag) {
        spans.push(...inside);
        const name = source.slice(i + 1, nameEnd);
        i = tag.end;
        if (RAW_BLOCKS.has(name) && !tag.selfClosing) {
          // Read as text to its closing tag: nothing inside is a comment of the page's.
          const close = source.toLowerCase().indexOf(`</${name}>`, tag.end);
          i = close === -1 ? source.length : close + name.length + 3;
        }
        atTokenStart = true;
        continue;
      }
    }

    // Words, or a character that is only itself.
    i += ch === '\\' && '<{#\\'.includes(source[i + 1] ?? ' ') ? 2 : 1;
    atTokenStart = false;
  }
  return spans;
}

/**
 * What stands at the top of a page: its root elements, and its `<data>` and
 * `<style>` blocks. Elements are matched the way the parser matches them —
 * every opening tag needs its closing tag, and a closing tag that does not
 * match the element it is in is passed over.
 */
function outlinePage(source: string): PageOutline {
  const outline: PageOutline = { roots: [], dataBlocks: [], styleBlocks: [], loose: false, broken: false };
  const open: string[] = [];
  let root: { name: string; start: number; openEnd: number } | null = null;
  // `//` is a comment only where a token could start, not inside a run of words.
  let atTokenStart = true;
  const broken = (): PageOutline => ({ ...outline, broken: true });
  const drawn = (): void => {
    if (open.length === 0) outline.loose = true;
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (isSpace(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/' && atTokenStart) {
      i = endOfLine(source, i);
      continue;
    }
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      i = end === -1 ? source.length : end + 3;
      atTokenStart = true;
      continue;
    }
    if (ch === '{') {
      const end = skipBalanced(source, i);
      if (end === -1) return broken();
      drawn();
      i = end;
      atTokenStart = true;
      continue;
    }

    const wordEnd = ch === '#' ? endOfMatch(CONTROL_FLOW_WORD, source, i) : -1;
    if (wordEnd !== -1) {
      drawn();
      // The header, when there is one: `#if (…)`, `#each (…)`, `#else if (…)`.
      let header = wordEnd;
      while (source[header] === ' ' || source[header] === '\t') header++;
      if (header > wordEnd && source.slice(wordEnd - 4, wordEnd) === 'else' && source.startsWith('if', header)) {
        header += 2;
        while (source[header] === ' ' || source[header] === '\t') header++;
      }
      i = wordEnd;
      if (source[header] === '(') {
        i = skipBalanced(source, header);
        if (i === -1) return broken();
      }
      atTokenStart = true;
      continue;
    }

    if (ch === '<' && source[i + 1] === '/') {
      const nameEnd = endOfMatch(TAG_NAME, source, i + 2);
      const end = source.indexOf('>', i);
      const closeEnd = end === -1 ? source.length : end + 1;
      if (nameEnd !== -1 && open[open.length - 1] === source.slice(i + 2, nameEnd)) {
        open.pop();
        if (open.length === 0 && root) {
          outline.roots.push({ ...root, closeStart: i, end: closeEnd });
          root = null;
        }
      }
      i = closeEnd;
      atTokenStart = true;
      continue;
    }

    const nameEnd = ch === '<' ? endOfMatch(TAG_NAME, source, i + 1) : -1;
    if (nameEnd !== -1) {
      const name = source.slice(i + 1, nameEnd);
      const tag = scanTag(source, nameEnd);
      if (!tag) return broken();
      atTokenStart = true;
      const top = open.length === 0;
      const dataClose = top && name === 'data' && !tag.selfClosing ? closingTag(source, name, tag.end) : null;
      if (RAW_BLOCKS.has(name) && !tag.selfClosing) {
        // Read as text to its closing tag, whatever is inside; never a root.
        const close = source.toLowerCase().indexOf(`</${name}>`, tag.end);
        const end = close === -1 ? source.length : close + name.length + 3;
        if (top && name === 'style' && close !== -1) {
          outline.styleBlocks.push({ start: i, end, innerStart: tag.end, innerEnd: close });
        }
        i = end;
      } else if (RAW_BLOCKS.has(name) || (top && name === 'import')) {
        // A declaration with nothing inside it; the parser does not draw it.
        i = tag.end;
      } else if (dataClose) {
        outline.dataBlocks.push({ start: i, end: dataClose.end, innerStart: tag.end, innerEnd: dataClose.start });
        i = dataClose.end;
      } else {
        if (tag.selfClosing) {
          if (top) outline.roots.push({ name, start: i, openEnd: tag.end, closeStart: tag.end, end: tag.end });
        } else {
          if (top) root = { name, start: i, openEnd: tag.end };
          open.push(name);
        }
        i = tag.end;
      }
      continue;
    }

    // Words, or a character that is only itself. `\<`, `\{`, `\#` and `\\`
    // are the escapes that keep a character from being read as markup.
    drawn();
    i += ch === '\\' && '<{#\\'.includes(source[i + 1] ?? ' ') ? 2 : 1;
    atTokenStart = false;
  }
  return open.length > 0 ? broken() : outline;
}

/** A `<collection …/>` declaration as an imported page wrote it. */
export interface IncludedCollection {
  /** The collection it reads. */
  name: string;
  /** The name the page reads it by; the collection's own when none is given. */
  as: string;
  /** The declaration's text, self-closing, to be written into a `<data>` block. */
  tag: string;
}

// What the parser accepts for a collection's name and for the name it is read by.
const COLLECTION_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const COLLECTION_ALIAS = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/** The text of a quoted attribute value, or undefined when it is not written as one. */
function quotedValue(value: string | undefined): string | undefined {
  if (value === undefined || value.length < 2) return undefined;
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) return undefined;
  return value.slice(1, -1);
}

/**
 * The declarations inside a `<data>` block. `unusable` counts those the
 * parser would refuse: one of them fails the whole block it is in, so they
 * are kept out of a block they did not come from.
 */
function readCollections(inner: string): { collections: IncludedCollection[]; unusable: number } {
  const collections: IncludedCollection[] = [];
  let unusable = 0;
  let atTokenStart = true;
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (isSpace(ch)) {
      i++;
    } else if (ch === '/' && inner[i + 1] === '/' && atTokenStart) {
      i = endOfLine(inner, i);
    } else if (inner.startsWith('<!--', i)) {
      const end = inner.indexOf('-->', i + 4);
      i = end === -1 ? inner.length : end + 3;
      atTokenStart = true;
    } else if (inner.startsWith('<collection', i) && !/[\w$]/.test(inner[i + 11] ?? '')) {
      const tag = scanTag(inner, i + 11);
      if (!tag) break;
      const value = (attribute: string): string | undefined =>
        quotedValue(tag.attributes.find((written) => written.name === attribute)?.value);
      const name = value('name') ?? '';
      const as = value('as') || name;
      if (COLLECTION_NAME.test(name) && COLLECTION_ALIAS.test(as)) {
        const text = inner.slice(i, tag.end);
        collections.push({ name, as, tag: tag.selfClosing ? text : `${text.slice(0, -1).trimEnd()} />` });
      } else {
        unusable++;
      }
      i = tag.end;
      atTokenStart = true;
    } else {
      i++;
      atTokenStart = ch === '>';
    }
  }
  return { collections, unusable };
}

/** One line ending after `at`, so a block taken out does not leave an empty line behind. */
function pastLineEnding(source: string, at: number): number {
  if (source[at] === '\r' && source[at + 1] === '\n') return at + 2;
  return source[at] === '\n' ? at + 1 : at;
}

export interface IncludeReading {
  /** The page as it is placed inside another. */
  markup: string;
  /** The collections its `<data>` blocks declare, for the document to declare instead. */
  collections: IncludedCollection[];
  /** How many declarations were left out because the parser would refuse them. */
  unusable: number;
  /** The rules of its `<style>` blocks, for the document's one style block. */
  styles: string[];
}

/**
 * Read an imported page as something to place inside another page.
 *
 * Three things a page carries when it stands on its own do not belong inside
 * another page's markup, and are taken out here:
 *
 * - Its `<data>` blocks. `<data>` is a declaration only at the top of a
 *   document; inside an element the parser reads it as an element named
 *   `data`, so pasted in with the page it would declare nothing and draw two
 *   stray elements. Its collections are returned for the composer to declare
 *   on the document.
 * - Its `<style>` blocks, for the same reason and with a worse result: inside
 *   an element `<style>` is an element with nothing in it, which the renderer
 *   refuses to draw, so the rules were lost and "Unknown component: <style>"
 *   stood where the page was placed — once for every use of it. The rules are
 *   returned for the composer to add to the document's one style block.
 * - An `<App>` wrapper, when the page is one `<App>…</App>` and nothing else.
 *   A page used inside another is that page's content, not a second app, so
 *   it contributes what is inside its App. The wrapper's own attributes — a
 *   theme, a style, a condition — go with it: they describe the app, and the
 *   app is the page doing the importing.
 *
 * Comments beside any of them are kept where they are. A page with none of
 * the three is returned exactly as it was given.
 */
export function readInclude(source: string): IncludeReading {
  const untouched: IncludeReading = { markup: source, collections: [], unusable: 0, styles: [] };
  if (!/<(?:data|style|App)[\s/>]/.test(source)) return untouched;
  const outline = outlinePage(source);
  if (outline.broken) return untouched;

  const cuts: Array<[number, number]> = [];
  const collections: IncludedCollection[] = [];
  let unusable = 0;
  for (const block of outline.dataBlocks) {
    const read = readCollections(source.slice(block.innerStart, block.innerEnd));
    collections.push(...read.collections);
    unusable += read.unusable;
    cuts.push([block.start, pastLineEnding(source, block.end)]);
  }

  const styles: string[] = [];
  for (const block of outline.styleBlocks) {
    const rules = source.slice(block.innerStart, block.innerEnd).trim();
    if (rules !== '') styles.push(rules);
    cuts.push([block.start, pastLineEnding(source, block.end)]);
  }

  const [root] = outline.roots;
  if (outline.roots.length === 1 && root.name === 'App' && !outline.loose) {
    // The wrapper goes, with the white space that only laid out its inside.
    let innerStart = root.openEnd;
    let innerEnd = root.closeStart;
    while (innerStart < innerEnd && isSpace(source[innerStart])) innerStart++;
    while (innerEnd > innerStart && isSpace(source[innerEnd - 1])) innerEnd--;
    if (root.closeStart === root.end) cuts.push([root.start, root.end]);
    else cuts.push([root.start, innerStart], [innerEnd, root.end]);
  }
  if (cuts.length === 0) return untouched;

  cuts.sort((a, b) => a[0] - b[0]);
  let markup = '';
  let copied = 0;
  for (const [start, end] of cuts) {
    markup += source.slice(copied, start);
    copied = end;
  }
  return { markup: markup + source.slice(copied), collections, unusable, styles };
}

/**
 * Add imported pages' rules to the main page's style.
 *
 * They go inside the page's own `<style>` block, after its own rules, so a
 * document has one block however many pages brought rules to it; a page with
 * no block of its own is given one after its markup. Where the page has
 * several blocks they are one stylesheet in the order written, and the last
 * is where the stylesheet ends.
 */
export function declareStyles(source: string, styles: readonly string[]): string {
  if (styles.length === 0) return source;
  const rules = styles.map((style) => `${style}\n`).join('');
  const { styleBlocks } = outlinePage(source);
  const block = styleBlocks.length > 0 ? styleBlocks[styleBlocks.length - 1] : undefined;
  if (!block) return `${source}\n<style>\n${rules}</style>`;
  const before = source.slice(0, block.innerEnd);
  const lead = before.endsWith('\n') ? '' : '\n';
  return `${before}${lead}${rules}${source.slice(block.innerEnd)}`;
}

export interface DeclaredCollections<T extends IncludedCollection> {
  source: string;
  /** Declarations not made, because the document already reads another collection by that name. */
  refused: Array<{ declaration: T; holder: string }>;
}

/**
 * Declare the collections imported pages asked for on the main page.
 *
 * They go inside the page's own `<data>` block when it has one — the last,
 * when it has several — and into a block added after its markup when it has
 * none, so a document has one more block at most however many pages brought
 * declarations to it. One the document already declares, the same collection
 * by the same name, is not repeated. A name can be read as one collection
 * only, so the first declaration of it stands: the page's own, then the
 * imported pages' in the order they were imported, a page's before those of
 * a page it imports in turn.
 */
export function declareCollections<T extends IncludedCollection>(
  source: string,
  declarations: readonly T[]
): DeclaredCollections<T> {
  if (declarations.length === 0) return { source, refused: [] };
  // A page's blocks are one set of declarations, joined by the parser with
  // the same rule as here, and the last block is where the set ends. A block
  // found before the text stopped being followable is still the page's.
  const { dataBlocks } = outlinePage(source);
  const block = dataBlocks.length > 0 ? dataBlocks[dataBlocks.length - 1] : undefined;

  const holders = new Map<string, string>();
  dataBlocks.forEach((own, index) => {
    for (const declared of readCollections(source.slice(own.innerStart, own.innerEnd)).collections) {
      if (index === 0 || !holders.has(declared.as)) holders.set(declared.as, declared.name);
    }
  });
  const added: string[] = [];
  const refused: DeclaredCollections<T>['refused'] = [];
  for (const declaration of declarations) {
    const holder = holders.get(declaration.as);
    if (holder === declaration.name) continue;
    if (holder !== undefined) {
      refused.push({ declaration, holder });
      continue;
    }
    holders.set(declaration.as, declaration.name);
    added.push(`  ${declaration.tag}\n`);
  }
  if (added.length === 0) return { source, refused };

  if (!block) return { source: `${source}\n<data>\n${added.join('')}</data>`, refused };
  const before = source.slice(0, block.innerEnd);
  const lead = before.endsWith('\n') ? '' : '\n';
  return { source: `${before}${lead}${added.join('')}${source.slice(block.innerEnd)}`, refused };
}
