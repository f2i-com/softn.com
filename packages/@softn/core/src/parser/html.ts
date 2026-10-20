/**
 * What the parser knows about HTML itself: the elements that have no closing
 * tag, the ones a whole HTML document wraps its page in, and the `<script>`
 * types that are code.
 *
 * A page can be written as an HTML page is written, because that is how most
 * people (and every model) learned to write one. These are the rules that
 * differ from a SoftN tag, and each applies to the lower-case HTML name only:
 * a capitalised name is a component, whatever it is called.
 */

/**
 * The void elements: `<br>`, `<img src="…">`, `<input type="text">` end
 * where their tag ends, with or without `/>`. Written without one, each used
 * to open an element that swallowed the rest of its parent. The list is the
 * one HTML's parser uses, with the obsolete names it still reads that way
 * (`param`, `keygen`, `basefont`, `bgsound`, `frame`); the renderer gives
 * none of these children either.
 */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'basefont',
  'bgsound',
  'br',
  'col',
  'embed',
  'frame',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * Every element name HTML's parser knows, the obsolete ones included: what a
 * name means when it is not written in lower case. HTML reads tag names in
 * any case, so `<DIV>` is a `div`; SoftN reads a capitalised name as a
 * component's, so only a name written all in capitals (`<DIV>`, `<BR>`,
 * `<TBODY>`) is taken for HTML's and lowered. Whether an element is drawn is
 * the renderer's decision (render.tsx), not this list's.
 */
export const HTML_ELEMENT_NAMES: ReadonlySet<string> = new Set([
  'a', 'abbr', 'acronym', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'basefont', 'bdi', 'bdo',
  'bgsound', 'big', 'blink', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'center', 'cite', 'code',
  'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'dir', 'div', 'dl', 'dt', 'em',
  'embed', 'fieldset', 'figcaption', 'figure', 'font', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'image', 'img', 'input', 'ins',
  'kbd', 'keygen', 'label', 'legend', 'li', 'link', 'listing', 'main', 'map', 'mark', 'marquee', 'math', 'menu',
  'meta', 'meter', 'nav', 'nobr', 'noembed', 'noframes', 'noscript', 'object', 'ol', 'optgroup', 'option',
  'output', 'p', 'param', 'picture', 'plaintext', 'pre', 'progress', 'q', 'rb', 'rp', 'rt', 'rtc', 'ruby', 's',
  'samp', 'script', 'search', 'section', 'select', 'slot', 'small', 'source', 'span', 'strike', 'strong', 'style',
  'sub', 'summary', 'sup', 'svg', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time',
  'title', 'tr', 'track', 'tt', 'u', 'ul', 'var', 'video', 'wbr', 'xmp',
]);

/**
 * A tag name as the parser keeps it. An HTML element's name written all in
 * capitals, `<DIV>` or `<BR>`, is that element's, in lower case, as HTML
 * reads it; any other name is kept as written, so `<Button>` is a component
 * and `<FAQ>` a page's import.
 */
export function normalizeTagName(name: string): string {
  if (name === '' || name !== name.toUpperCase()) return name;
  const lower = name.toLowerCase();
  return lower !== name && HTML_ELEMENT_NAMES.has(lower) ? lower : name;
}

/**
 * Whether a tag is an HTML element's, or a drawing's (`inDrawing`: inside an
 * `<svg>` or a `<math>`): a name HTML gives an element (as normalizeTagName
 * keeps it), a custom element's (`my-card`), or, in a drawing, any name that
 * begins in lower case (`path`, `linearGradient`). Not case alone: a
 * component may be written in lower case too (`<datatable>`), and its
 * attributes, events and bindings are the component's, as written.
 */
export function isHtmlElementTag(tag: string, inDrawing = false): boolean {
  if (tag === '') return false;
  if (HTML_ELEMENT_NAMES.has(tag) || (tag.includes('-') && tag === tag.toLowerCase())) return true;
  return inDrawing && /^[a-z]/.test(tag);
}

/** Whether two tag names are one tag's: HTML's close in any case, `<div>…</DIV>`, and so does `<Button>…</button>`. */
export function sameTagName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * HTML's attribute names, in lower case: the ones an HTML element's
 * attribute is read as in any case (`CLASS`, `TabIndex`, `HREF`). A name not
 * here is kept as written: `className`, `htmlFor` and SVG's `viewBox` keep
 * their capitals.
 */
const HTML_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  'accept', 'accept-charset', 'accesskey', 'action', 'align', 'allow', 'allowfullscreen', 'alt', 'as', 'async',
  'autocapitalize', 'autocomplete', 'autofocus', 'autoplay', 'background', 'bgcolor', 'border', 'capture',
  'cellpadding', 'cellspacing', 'charset', 'checked', 'cite', 'class', 'color', 'cols', 'colspan', 'content',
  'contenteditable', 'controls', 'coords', 'crossorigin', 'datetime', 'decoding', 'default', 'defer', 'dir',
  'dirname', 'disabled', 'download', 'draggable', 'enctype', 'enterkeyhint', 'face', 'for', 'form', 'formaction',
  'formenctype', 'formmethod', 'formnovalidate', 'formtarget', 'headers', 'height', 'hidden', 'high', 'href',
  'hreflang', 'http-equiv', 'id', 'inert', 'inputmode', 'integrity', 'ismap', 'itemprop', 'kind', 'label',
  'lang', 'list', 'loading', 'loop', 'low', 'max', 'maxlength', 'media', 'method', 'min', 'minlength', 'multiple',
  'muted', 'name', 'nomodule', 'nonce', 'novalidate', 'open', 'optimum', 'pattern', 'placeholder', 'playsinline',
  'popover', 'poster', 'preload', 'readonly', 'referrerpolicy', 'rel', 'required', 'reversed', 'role', 'rows',
  'rowspan', 'sandbox', 'scope', 'selected', 'shape', 'size', 'sizes', 'span', 'spellcheck', 'src', 'srcdoc',
  'srclang', 'srcset', 'start', 'step', 'style', 'summary', 'tabindex', 'target', 'title', 'translate', 'type',
  'usemap', 'valign', 'value', 'width', 'wrap',
]);

/**
 * The name an attribute of an HTML element is read by: HTML's own names, the
 * `on…` handlers and `data-`/`aria-` names in lower case, as HTML reads them
 * (`ONCLICK`, `onClick`, `DATA-ID`); any other as written.
 */
export function htmlAttributeName(name: string): string {
  const lower = name.toLowerCase();
  if (lower === name) return name;
  return HTML_ATTRIBUTE_NAMES.has(lower) || /^on[a-z]+$/.test(lower) || /^(?:data|aria)-/.test(lower) ? lower : name;
}

/**
 * The name an event (`@click`) or a binding (`:value`) is read by. On an HTML
 * element, in lower case, as the DOM names every event (`@KeyDown` is
 * `keydown`). On a component the name is a property's, whose case is the
 * component's: one written all in capitals is lowered (`@CLICK`), and a
 * leading capital is (`@Click` is `click`, `@RowClick` is `rowClick`).
 */
export function callbackName(name: string, onHtmlElement: boolean): string {
  if (onHtmlElement || name === name.toUpperCase()) return name.toLowerCase();
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * The tags a whole HTML document wraps its page in. They say where the page
 * is, not what to draw, so the parser reads what is inside them as if they
 * were not there (a `<body>` with attributes is kept, as a `<div>`).
 */
export type DocumentWrapper = 'html' | 'head' | 'body';

export function documentWrapper(name: string): DocumentWrapper | null {
  return name === 'html' || name === 'head' || name === 'body' ? name : null;
}

/**
 * What a document's `<head>` holds besides its blocks. Nothing in it is
 * drawn: `<title>` names the page, and the rest describe it to a browser
 * that is not the one drawing it here.
 */
export const HEAD_ELEMENTS: ReadonlySet<string> = new Set([
  'title',
  'meta',
  'link',
  'base',
  'noscript',
]);

/** A `<script type>` that is JavaScript: no type, or one of these. */
const JAVASCRIPT_TYPES: ReadonlySet<string> = new Set([
  '',
  'module',
  'javascript',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
]);

/** A `<script type>` that is Python, which a page refers to by file. */
const PYTHON_TYPES: ReadonlySet<string> = new Set([
  'python',
  'text/python',
  'text/x-python',
  'application/python',
  'application/x-python',
]);

/**
 * What a `<script type="…">` holds: the app's code in one of its languages,
 * or something else (JSON data, a template, an import map) that is not run.
 */
export function scriptLanguage(type: string | undefined): 'javascript' | 'python' | 'other' {
  const normalized = (type ?? '').trim().toLowerCase();
  if (JAVASCRIPT_TYPES.has(normalized)) return 'javascript';
  if (PYTHON_TYPES.has(normalized)) return 'python';
  return 'other';
}

/** Whether a `src` or `href` names a file on another site rather than one in the app. */
export function isRemoteReference(path: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path.trim());
}

/**
 * The event an HTML handler attribute is for: `onclick` is `click`. Only an
 * all-lower-case name on an HTML element (isHtmlElementTag) is one, as HTML
 * spells them; on a component, `onSave` is a property like any other.
 */
export function htmlHandlerEvent(onHtmlElement: boolean, attribute: string): string | null {
  if (!onHtmlElement) return null;
  const match = /^on([a-z]+)$/.exec(attribute);
  return match ? match[1] : null;
}
