/**
 * HTML sanitization for the few places SoftN injects markup directly.
 *
 * The renderer refuses to emit `<script>`, `<iframe>` and friends from `.ui`
 * markup, but two components take a string and hand it straight to the DOM:
 * `<Icon svg={…}>` and `<RichTextEditor value={…}>`. Both accept whatever a
 * bundle passes — typically a value read from XDB or arriving over sync — which
 * routed around the tag denylist entirely.
 *
 * Parsing rather than pattern-matching is deliberate. Every regex-based HTML
 * filter eventually loses to a case the author did not picture; the browser's
 * own parser sees exactly what the browser will later execute.
 */

/**
 * Schemes a URL-bearing attribute may use.
 *
 * Anything with no scheme — `/page`, `./img.png`, `#top`, `?q=1` — is relative
 * to the host document and always allowed. `blob:` is needed because `asset()`
 * hands out object URLs, and `data:` is restricted to media because bundles
 * legitimately inline images and audio while `data:text/html` carries script.
 */
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:', 'blob:']);
const SAFE_DATA_URL = /^data:(?:image|audio|video|font)\//i;

/**
 * Characters a browser strips before resolving a scheme. Leaving them in means
 * `java\tscript:` and `  javascript:` slip past a naive prefix check.
 *
 * Matching control characters is the entire purpose here — a NUL or tab inside
 * `java\0script:` is exactly the case this has to catch — so the lint rule that
 * normally flags them as a typo does not apply.
 */
// eslint-disable-next-line no-control-regex
const URL_IGNORED = /[\u0000-\u0020\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g;

/** Whether a URL is safe to hand to the DOM. */
export function isSafeUrl(value: string): boolean {
  const probe = value.replace(URL_IGNORED, '');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(probe);
  if (!scheme) return true; // relative, fragment, or query — same origin
  if (SAFE_DATA_URL.test(probe)) return true;
  return SAFE_URL_SCHEMES.has(scheme[1].toLowerCase() + ':');
}

/** Attributes whose value the browser will fetch or navigate to. */
export const URL_ATTRIBUTES = new Set([
  'href',
  'src',
  'srcset',
  'action',
  'formaction',
  'poster',
  'cite',
  'data',
  'ping',
  'background',
  'xlink:href',
]);

/** SVG elements that only describe shapes — no scripting, no external loads. */
const SVG_TAGS = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'title',
  'desc',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textpath',
  'marker',
  'mask',
  'clippath',
  'pattern',
  'lineargradient',
  'radialgradient',
  'stop',
  'filter',
  'fegaussianblur',
  'feoffset',
  'feblend',
  'femerge',
  'femergenode',
  'fecolormatrix',
  'fedropshadow',
  'fecomposite',
  'feflood',
]);

/** Inline formatting a rich-text value may contain. */
const RICH_TEXT_TAGS = new Set([
  'p',
  'br',
  'div',
  'span',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'del',
  'ins',
  'sub',
  'sup',
  'mark',
  'small',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'img',
  'hr',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'font',
]);

/**
 * Strip everything outside `allowed` from a fragment of markup.
 *
 * A disallowed element is unwrapped rather than deleted — its text survives, so
 * a stray `<div>` in an icon does not silently swallow the label inside it —
 * except for elements that carry executable content, which are removed whole.
 */
function sanitizeFragment(markup: string, allowed: Set<string>): string {
  // No DOM (server render, worker). Refusing is the safe answer: the value is
  // untrusted and there is nothing here to check it with.
  if (typeof DOMParser === 'undefined') return '';

  const doc = new DOMParser().parseFromString(`<body>${markup}</body>`, 'text/html');
  const body = doc.body;

  // Elements whose *content* is code or data rather than text, so unwrapping
  // them would paste that content into the document as markup.
  const DROP_WHOLE = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'link']);

  const walk = (node: Element): void => {
    // Snapshot first: the loop reparents and removes nodes as it goes.
    for (const child of Array.from(node.children)) walk(child);

    const tag = node.tagName.toLowerCase();

    if (DROP_WHOLE.has(tag)) {
      node.remove();
      return;
    }

    if (!allowed.has(tag)) {
      // Unwrap: keep the children, drop the element itself.
      const parent = node.parentNode;
      if (parent) {
        while (node.firstChild) parent.insertBefore(node.firstChild, node);
        parent.removeChild(node);
      }
      return;
    }

    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();

      // Event handlers, in any spelling the parser accepts.
      if (name.startsWith('on')) {
        node.removeAttribute(attr.name);
        continue;
      }
      // `<svg>` accepts a nested browsing context through these.
      if (name === 'xmlns:xlink' && attr.value.includes('script')) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRIBUTES.has(name) && !isSafeUrl(attr.value)) {
        node.removeAttribute(attr.name);
        continue;
      }
      // `style` can load remote resources via url(), which is a beacon.
      if (name === 'style' && /url\s*\(/i.test(attr.value)) {
        node.removeAttribute(attr.name);
      }
    }
  };

  for (const child of Array.from(body.children)) walk(child);
  return body.innerHTML;
}

/**
 * Restrict markup to inert SVG.
 *
 * `<Icon svg={record.body} />` used to inject its argument verbatim, so a
 * record containing `<img src=x onerror=…>` executed on the host origin.
 */
export function sanitizeSvg(markup: string): string {
  return sanitizeFragment(markup, SVG_TAGS);
}

/**
 * Restrict markup to inert rich text.
 */
export function sanitizeRichText(markup: string): string {
  return sanitizeFragment(markup, RICH_TEXT_TAGS);
}
