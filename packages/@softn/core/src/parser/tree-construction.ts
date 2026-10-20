/**
 * HTML's tree construction, as the parser follows it: which elements end
 * which, the scopes an end tag is looked for in, the formatting elements an
 * end tag out of order opens again, what a table moves out of itself, and the
 * implied `<tbody>` and row. The parser (parser.ts) reads a page with these.
 */

import type { ElementNode, TemplateNode } from './ast';
import { createElementNode } from './ast';
import type { SourceLocation } from './token';
import { isHtmlElementTag, sameTagName } from './html';

/**
 * An element's attributes as HTML compares them for Noah's Ark: names and
 * values, an expression's by what it is, not where it was written.
 */
export function attributesKey(element: ElementNode): string {
  return JSON.stringify(element.props.map((prop) => [prop.name, prop.value]), (key, value: unknown) => (key === 'loc' ? undefined : value));
}

/** A formatting element's copy: its tag, attributes and events, holding nothing yet. */
export function copyElement(element: ElementNode, loc: SourceLocation): ElementNode {
  const copy = createElementNode(element.tag, loc);
  copy.props = element.props.map((prop) => ({ ...prop }));
  copy.events = element.events.map((event) => ({ ...event }));
  return copy;
}

/** Whether the end tag `closer` ends the open element `open`: its own, in any case, and any heading's a heading. */
export function closesElement(closer: string, open: string): boolean {
  return sameTagName(closer, open) || (HEADINGS.has(closer) && HEADINGS.has(open));
}

/** How many elements deep a page is read before what is deeper is placed beside them, as browsers cap it. */
export const MAX_TREE_DEPTH = 512;
/** How many formatting elements may be active at once after the last marker (see activate). */
export const MAX_ACTIVE_FORMATTING = 64;
/** Where a marker goes in the list of active formatting elements: what is opened inside stays inside. */
export const FORMATTING_MARKERS = new Set(['td', 'th', 'caption', 'applet', 'object', 'marquee', 'template']);
/** HTML's special elements before which the active formatting elements are opened again all the same. */
export const REOPENS_FORMATTING = new Set(['area', 'br', 'embed', 'img', 'keygen', 'wbr', 'input', 'applet', 'marquee', 'object', 'math', 'svg', 'button', 'select', 'xmp']);
/** A ruby's annotations and their containers. */
export const RUBY_ANNOTATIONS = new Set(['rb', 'rp', 'rt', 'rtc']);
/** What HTML ends without its end tag before an annotation in a ruby ("generate implied end tags"). */
export const IMPLIED_END_TAGS = new Set(['dd', 'dt', 'li', 'optgroup', 'option', 'p', 'rb', 'rp', 'rt', 'rtc']);

/** The HTML elements that end a drawing they are written in (HTML's "breakout" start tags in foreign content). */
export const BREAKS_OUT_OF_DRAWING = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr', 'ol', 'p', 'pre', 'ruby', 's',
  'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var',
]);
/**
 * HTML's "special" elements, the ones it gives structure: what an `<li>`,
 * `<dt>` or `<dd>` does not end its like through, what an inline element's
 * end tag does not reach past (endTagStopped), and the blocks a formatting
 * element's end tag moves out of it (adoptBlock).
 */
export const SPECIAL_ELEMENTS = new Set([
  'address', 'applet', 'area', 'article', 'aside', 'base', 'basefont', 'bgsound', 'blockquote', 'body', 'br', 'button',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dir', 'div', 'dl', 'dt', 'embed', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr',
  'html', 'iframe', 'img', 'input', 'keygen', 'li', 'link', 'listing', 'main', 'marquee', 'menu', 'meta', 'nav',
  'noembed', 'noframes', 'noscript', 'object', 'ol', 'p', 'param', 'plaintext', 'pre', 'script', 'search', 'section',
  'select', 'source', 'style', 'summary', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul', 'wbr', 'xmp', 'svg', 'math',
]);
/** What an element is not found open through (HTML's default scope), and the drawings' places that hold HTML. */
export const DEFAULT_SCOPE_BOUNDARIES = new Set([
  'applet', 'caption', 'html', 'marquee', 'object', 'table', 'td', 'th', 'template',
  'mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml', 'foreignObject', 'desc', 'title',
]);
/** What a paragraph is not ended through (HTML's "button scope"). */
export const BUTTON_SCOPE_BOUNDARIES = new Set([...DEFAULT_SCOPE_BOUNDARIES, 'button']);
/** What a list item is not ended through (HTML's "list item scope"). */
export const LIST_ITEM_SCOPE_BOUNDARIES = new Set([...DEFAULT_SCOPE_BOUNDARIES, 'ol', 'ul']);
/** What a table's own end tags are not read through (HTML's "table scope"). */
export const TABLE_SCOPE_BOUNDARIES = new Set(['html', 'table', 'template']);
/** What holds a table's rows: an element written straight in one is moved before the table (fostersOut). */
export const ROW_PARENTS = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr']);
/** A table and its parts, whose end tags reach through its cells. */
export const TABLE_PARTS = new Set(['table', 'caption', 'colgroup', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th']);
/** In openTags, a formatting element whose end tag has been read inside a block it holds (adoptBlock). */
export const ADOPTED = '#adopted';
/** The places in a drawing that hold HTML (HTML's integration points), in lower case. */
export const HOLDS_HTML_IN_DRAWING = new Set(['foreignobject', 'desc', 'title', 'mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml']);
/**
 * What may stand straight in a `<table>`. Anything else HTML gives an
 * element, and text, goes before the table (HTML's "foster parenting"); a
 * component, a block and an expression stay, as each may draw rows.
 */
export const TABLE_CONTENT = new Set(['caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'script', 'style', 'template', 'form', 'input']);

/**
 * HTML elements whose end tag may be left out (the HTML standard's "optional
 * end tags"), and what ends one when it is.
 */
export const OPTIONAL_END_TAGS = new Set([
  'li', 'dt', 'dd', 'p', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'rb', 'rt',
  'rtc', 'rp',
]);
/** The start tags that close an open `<p>`, as HTML's parser closes one. */
export const ENDS_A_PARAGRAPH = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'dd', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'li', 'listing', 'main', 'menu', 'nav', 'ol', 'p', 'plaintext', 'pre', 'search', 'section', 'summary', 'table',
  'ul', 'xmp',
]);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** What a table's caption ends at, unclosed: the table's structure. */
const ENDS_A_CAPTION = new Set(['caption', 'col', 'colgroup', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr']);
/** HTML's formatting elements: an end tag out of order opens them again (see parseChildren). */
export const FORMATTING_ELEMENTS = new Set([
  'a', 'b', 'big', 'code', 'em', 'font', 'i', 'nobr', 's', 'small', 'strike', 'strong', 'tt', 'u',
]);

/**
 * A run of `children` that `belongs` says is one group's, each in a new
 * element named `tag` (whitespace between them kept inside it).
 */
function wrapRuns(children: TemplateNode[], tag: string, belongs: (node: TemplateNode) => boolean): TemplateNode[] {
  if (!children.some(belongs)) return children;
  const out: TemplateNode[] = [];
  let group: ElementNode | null = null;
  let space: TemplateNode[] = [];
  for (const child of children) {
    if (belongs(child)) {
      if (!group) {
        out.push(...space);
        space = [];
        group = createElementNode(tag, child.loc);
        out.push(group);
      }
      group.children.push(...space, child);
      space = [];
    } else if (child.type === 'Text' && child.content.trim() === '') {
      space.push(child);
    } else {
      out.push(...space, child);
      space = [];
      group = null;
    }
  }
  out.push(...space);
  return out;
}

/**
 * A table's rows, written straight into it, inside the `<tbody>` HTML gives
 * them: `<table><tr>…` is `<table><tbody><tr>…`, as every browser reads it,
 * and React warns of a row straight in a table. Cells written straight in
 * are in a row of their own first. A `#each` or `#if` that draws nothing but
 * rows counts as rows.
 */
export function wrapTableRows(children: TemplateNode[]): TemplateNode[] {
  const isCell = (node: TemplateNode): boolean => node.type === 'Element' && (node.tag === 'td' || node.tag === 'th');
  return wrapRuns(wrapRuns(children, 'tr', isCell), 'tbody', isTableRow);
}

/** Whether a node draws table rows and nothing else: a `<tr>`, or a `#each` or `#if` of them. */
function isTableRow(node: TemplateNode): boolean {
  const onlyRows = (nodes: TemplateNode[]): boolean => {
    const drawn = nodes.filter((child) => !(child.type === 'Text' && child.content.trim() === ''));
    return drawn.length > 0 && drawn.every(isTableRow);
  };
  if (node.type === 'Element') return node.tag === 'tr';
  if (node.type === 'EachBlock') {
    return onlyRows(node.body) && (!node.emptyFallback || node.emptyFallback.length === 0 || onlyRows(node.emptyFallback));
  }
  if (node.type === 'IfBlock') {
    const otherwise = node.alternate === undefined ? [] : Array.isArray(node.alternate) ? node.alternate : [node.alternate];
    return onlyRows(node.consequent) && (otherwise.length === 0 || onlyRows(otherwise));
  }
  return false;
}

/**
 * Whether the open element `open` ends, with no end tag of its own, where
 * an element `next` begins; `within` is the tags open around it.
 */
export function endsBefore(open: string, next: string, within: readonly string[]): boolean {
  if (HEADINGS.has(open)) return HEADINGS.has(next);
  switch (open) {
    // A link, a button or a no-break run cannot hold another of itself: the
    // second ends the first, as HTML reads `<a>one<a>two`.
    case 'a':
    case 'button':
    case 'nobr':
      return next === open;
    case 'caption':
      return ENDS_A_CAPTION.has(next);
    case 'colgroup':
      return next !== 'col' && next !== 'template' && isHtmlElementTag(next);
    case 'li':
      return next === 'li';
    case 'dt':
    case 'dd':
      return next === 'dt' || next === 'dd';
    case 'p':
      return ENDS_A_PARAGRAPH.has(next);
    case 'option':
      return next === 'option' || next === 'optgroup';
    case 'optgroup':
      return next === 'optgroup' && within.includes('select');
    case 'table':
      return next === 'table';
    case 'tr':
      return next === 'tr' || next === 'tbody' || next === 'thead' || next === 'tfoot' || next === 'table';
    case 'td':
    case 'th':
      return next === 'td' || next === 'th' || next === 'tr' || next === 'tbody' || next === 'thead' || next === 'tfoot';
    case 'thead':
    case 'tbody':
      return next === 'tbody' || next === 'tfoot' || next === 'table';
    case 'tfoot':
      return next === 'table';
    case 'rt':
    case 'rp':
      return (next === 'rt' || next === 'rp') && within.includes('ruby');
    default:
      return false;
  }
}
