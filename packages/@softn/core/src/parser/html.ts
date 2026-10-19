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
 * to open an element that swallowed the rest of its parent.
 */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

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
 * all-lower-case name on an HTML element is one, as HTML spells them; on a
 * component, `onSave` is a property like any other.
 */
export function htmlHandlerEvent(tag: string, attribute: string): string | null {
  if (!/^[a-z]/.test(tag)) return null;
  const match = /^on([a-z]+)$/.exec(attribute);
  return match ? match[1] : null;
}
