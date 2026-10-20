/**
 * What a page's head says about how it is laid out and coloured — its
 * viewport, theme-color and color-scheme metas — read from the page's text
 * and put into the document's head.
 *
 * `softn.js` turns everything after its own tag into text, the head's metas
 * included, and without its viewport a page drew at a desktop's 980 pixels on
 * a phone. Kept apart from page.ts, which reads the rest of the site, so the
 * page entry (apps/softn-single/src/page.tsx) can apply them before it loads
 * the shell: the "Loading…" screen is then laid out at the phone's width too.
 */

/** A meta of the page's head that says how the page is laid out or coloured. */
export interface HeadMeta {
  /** `viewport`, `theme-color` or `color-scheme`, lower-cased. */
  name: string;
  content: string;
  /** A `theme-color` for one colour scheme or another (`media="(prefers-color-scheme: dark)"`). */
  media?: string;
}

/**
 * The metas a browser reads for the page as a whole and the shell carries
 * over. Not the charset: the document's encoding is settled by the browser's
 * prescan of its first bytes, before any script runs, so a `<meta charset>`
 * added afterwards changes nothing and is left where it was written.
 */
const LAYOUT_METAS = new Set(['viewport', 'theme-color', 'color-scheme']);

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

/** An attribute value as the browser reads it: the few character references a meta's content holds. */
function decodeAttribute(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (reference, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : reference;
    }
    return ENTITIES[body.toLowerCase()] ?? reference;
  });
}

/** A tag's attributes, by lower-cased name; the first of a repeated name is the one in effect. */
function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  // An unquoted value runs to the next space or `>`, `=` and `/` included, as
  // the browser reads `content=width=device-width`.
  for (const match of tag.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) attributes.set(name, decodeAttribute(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attributes;
}

/**
 * The viewport, theme-color and color-scheme metas of a page's head, in the
 * order it writes them. Read from the text, not a parsed document, so it
 * holds wherever the shell runs. Only the head counts: what follows
 * `</head>` or `<body>`, what a comment hides, and what a script, a style, a
 * template, a noscript or a title holds as text is not a meta of the page.
 */
export function pageHeadMetas(text: string): HeadMeta[] {
  const visible = text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|template|noscript|title|textarea)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  const end = visible.search(/<\/head\s*>|<body[\s>/]/i);
  const head = end === -1 ? visible : visible.slice(0, end);
  const metas: HeadMeta[] = [];
  for (const match of head.matchAll(/<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attributes = attributesOf(match[1]);
    const name = attributes.get('name')?.trim().toLowerCase();
    const content = attributes.get('content')?.trim();
    if (!name || !LAYOUT_METAS.has(name) || !content) continue;
    const media = attributes.get('media')?.trim();
    metas.push(media ? { name, content, media } : { name, content });
  }
  return metas;
}

/**
 * Put the page's layout metas in the document's head, where the browser acts
 * on them: a viewport the page names lays it out at the phone's width.
 *
 * Each name the page writes replaces what the head has under that name, so a
 * meta the browser did read (one written before `softn.js`, or a page whose
 * head was parsed because the runtime ran late) is not doubled; one already
 * as the page has it is left alone, so the layout is not thrown and redone.
 * A name the page does not write is not touched. Nothing happens where there
 * is no document.
 */
export function adoptHeadMetas(metas: readonly HeadMeta[], doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  const head = doc?.head;
  if (!doc || !head) return;
  for (const name of new Set(metas.map((meta) => meta.name))) {
    const wanted = metas.filter((meta) => meta.name === name);
    const present = [...head.querySelectorAll('meta[name]')].filter(
      (element) => element.getAttribute('name')?.trim().toLowerCase() === name
    );
    const same =
      present.length === wanted.length &&
      present.every(
        (element, i) =>
          element.getAttribute('content')?.trim() === wanted[i].content &&
          (element.getAttribute('media')?.trim() || undefined) === wanted[i].media
      );
    if (same) continue;
    for (const element of present) element.remove();
    for (const meta of wanted) {
      const element = doc.createElement('meta');
      element.setAttribute('name', meta.name);
      if (meta.media) element.setAttribute('media', meta.media);
      element.setAttribute('content', meta.content);
      head.appendChild(element);
    }
  }
}
