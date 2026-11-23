/**
 * What a link the person clicks in the app does, in a frame that cannot go
 * anywhere itself.
 *
 * The frame is sandboxed with scripts alone: it may open no window, and an
 * address it goes to in place of the app is one of its parent's pages, which
 * refuse to be framed. So every link that left the app's own pages stopped
 * the app, until its parent opened it again: a link to another site, to a
 * mail address, to a file of the app's that is not a page (`styles.css`),
 * and one that names no page at all (`about`, `/`, a folder). A link with a
 * `target`, or clicked with a key held, did nothing, because the window it
 * asks for is never opened.
 *
 * Now the shell looks at every click on a link after the app and core have
 * had theirs (core shows a link to another page of the app in place, and
 * says so by cancelling the click):
 *
 * - A link to another site, a mail address or a phone number is handed to
 *   the parent, `{ type: 'link', href }` on the port, absolute and checked
 *   here, and the frame stays where it is. The parent decides what to do with
 *   it; FormLogic shows the address and opens it when the person says so.
 *   Only a link the person clicked is handed on: a SoftN page's code cannot
 *   send anyone elsewhere (core's onNavigate). An app whose code runs in the
 *   frame's own scripts (a host-js app, host-js-adapter.ts) can reach the
 *   port and post a link itself, with no click: so the parent checks every
 *   address it is handed, and asks the person (FormLogic shows it only right
 *   after a press of the person's, and opens it only when they say so).
 * - A link that names one of the app's pages, but with a `target` or a key
 *   held (which core leaves to the browser), is shown in place: there is no
 *   other window for it to open in.
 * - Anything else is kept from replacing the app, and said in the console,
 *   where its author looks: a link that names no page of the app, and a
 *   `data:` or `blob:` address, which would replace the app with itself.
 *   A `data:` or `blob:` link that downloads is the browser's, which saves it
 *   where the frame may download and does nothing where it may not.
 * - A link to a place on the same page (`#top`) is the browser's, as always.
 *   One with an empty address (`href=""`) would load the frame's own address
 *   again, which takes the app off it: kept, and said.
 *
 * Every click that may follow a link is held as it begins, by a listener on the
 * window that hears it before any of the app's, and decided once it is over, on
 * the link as it is then (`watchLinks`): the browser follows none of them itself.
 * Decided earlier, a click went where the app pointed its link after: an address
 * set after a stop (`@click.stop`), or in a microtask, as React's state is, or by
 * a window listener of the app's logic after the document's, all before the
 * browser follows a link, in Chromium, Firefox and WebKit alike. What the browser
 * would have done itself (a place on the page, a file a link saves) the frame
 * does. A click on a control (a box in a `<label>`, a `<summary>`) is the
 * browser's, as is a click on what no link holds.
 *
 * This module is the deciding and the listening; main.tsx carries out what is
 * decided. It runs alone under `node --test`.
 */

/** The most characters an address handed to the parent may have, as a place may (place.ts). */
export const LINK_LIMIT = 2000;

/**
 * What a link is, by what is written in its `href`:
 * - `outside`: another site (`https:`, `http:`, `//host`), a mail address (`mailto:`) or a phone number (`tel:`).
 * - `fragment`: a place on the same page.
 * - `empty`: no address at all (`href=""`), which is the frame's own address: following it loads the frame again.
 * - `inline`: a `data:` or `blob:` address, which is the frame's own and would take the app's place.
 * - `own`: an address on the app's own site with no scheme: a page of the app, or something it names that is not one.
 * - `other`: any other scheme (`javascript:`, `file:`, …), kept from going anywhere.
 */
export type LinkKind = 'outside' | 'fragment' | 'empty' | 'inline' | 'own' | 'other';

/**
 * `written` as the browser's address parser reads it: without the spaces and control characters
 * around it, and the tabs and line breaks in it, and nothing more. JavaScript's `trim()` takes more
 * (a no-break space, U+3000, U+FEFF, U+2028), so `"&nbsp;#top"` read as a place on the page here
 * while the browser went to the address `%C2%A0#top`, and the frame left the app.
 */
export function asParsed(written: string): string {
  // The C0 controls are the point: they are what the address parser strips.
  // eslint-disable-next-line no-control-regex
  return written.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');
}

/** What a link is (above), from its written `href`. */
export function linkKind(written: string): LinkKind {
  const text = asParsed(written);
  if (text === '') return 'empty';
  if (text.startsWith('#')) return 'fragment';
  if (text.startsWith('//')) return 'outside';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1].toLowerCase();
  if (scheme === undefined) return 'own';
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') return 'outside';
  if (scheme === 'data' || scheme === 'blob') return 'inline';
  return 'other';
}

/** Text with no control character in it (as place.ts): nothing an address drops or a person cannot see. */
function printable(text: string): boolean {
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * The address a link to the outside is handed to the parent as: `resolved`
 * is the browser's own reading of it (`anchor.href`, already absolute). Null
 * for one that is not handed on: another scheme, a web address with a name
 * and password in it (a way to make one site's address read as another's),
 * no host, longer than the limit, or with a character a person cannot see.
 */
export function outsideAddress(resolved: string): string | null {
  if (typeof resolved !== 'string' || resolved.length > LINK_LIMIT || !printable(resolved)) return null;
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
    return url.href.length > LINK_LIMIT ? null : url.href;
  }
  if (url.protocol === 'mailto:' || url.protocol === 'tel:') {
    return url.pathname.trim() === '' ? null : url.href;
  }
  return null;
}

/** The host an address names, as the URL parser reads it (lower case, punycode); '' for none (`mailto:`, `tel:`). */
function hostOf(address: string): string {
  try {
    return new URL(address).hostname;
  } catch {
    return '';
  }
}

/** What the shell does with a click on a link (main.tsx carries it out). */
export type LinkAction =
  /** Hand `href` to the parent, and keep the frame where it is. */
  | { kind: 'hand-on'; href: string }
  /** Show the app's page the link names, in place. */
  | { kind: 'show-page' }
  /** Keep the frame where it is, and say why in the console. */
  | { kind: 'keep'; warning: string }
  /** The browser's: nothing to do here. */
  | { kind: 'browser' };

/** What a link the person clicked comes to. */
export interface ClickedLink {
  /** What is written in its `href`. */
  written: string;
  /** The browser's absolute reading of it (`anchor.href`). */
  resolved: string;
  /** It has a `download` attribute. */
  download: boolean;
  /** The app or core has already dealt with the click (core cancels one it showed in place). */
  handled: boolean;
  /**
   * The person clicked it (the event is the browser's own, `isTrusted`), rather than the page's
   * code calling `click()` on it: only a link the person clicked is handed on to the outside.
   */
  byPerson: boolean;
  /** Whether it names a page of the app (place.ts's linkedPage, over core's bundlePageAt). */
  isPage(written: string): boolean;
  /** It is one of several links an SVG `<use>` draws, and which the click was on cannot be told (`linkAt`). */
  unclear?: boolean;
  /**
   * The frame's own site, by its host (its runtime's). An address there is no other site, whatever
   * its scheme or port (a session's cookies are the host's, and http is sent on to https): an app's
   * `https:/api/…` (one slash, read against the frame) or `//host/…` was handed on as one, and a
   * person who opened it visited the host's own pages with their session. Empty: no site to keep.
   */
  ownHost?: string;
}

/** The address as it may be shown in a console line: printable, and not longer than a line. */
function shown(written: string): string {
  let text = '';
  for (const char of written) {
    const code = char.charCodeAt(0);
    text += code < 0x20 || code === 0x7f ? '?' : char;
  }
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** What to do with a click on a link: the rules at the top of this file. */
export function decideLink(link: ClickedLink): LinkAction {
  if (link.handled) return { kind: 'browser' };
  if (link.unclear) return { kind: 'keep', warning: 'A link drawn by an SVG <use> was not followed: which link the click was on cannot be told (the <use> draws more than one, is itself inside a link, or draws from a file whose links are not followed). Give each link a <use> of its own, outside other links, or draw it in place.' };
  const kind = linkKind(link.written);
  if (kind === 'fragment') return { kind: 'browser' };
  if (kind === 'empty') return { kind: 'keep', warning: 'A link with an empty address would load the frame again and take the app off it, so it was not followed. Give it the page it opens ("about.html"), or "#" for a link that only runs its click.' };
  if (kind === 'outside') {
    if (!link.byPerson) return { kind: 'keep', warning: `The page's code clicked a link to ${shown(link.written)}; only a link the person clicks goes to another site.` };
    const href = outsideAddress(link.resolved);
    if (href === null) return { kind: 'keep', warning: `A link to ${shown(link.written)} was not opened: it is not an address this app may hand on.` };
    if (link.ownHost && hostOf(href) === link.ownHost.toLowerCase()) {
      return { kind: 'keep', warning: `A link to ${shown(link.written)} was not opened: it goes to the site this app is hosted on, not to another site.` };
    }
    return { kind: 'hand-on', href };
  }
  if (kind === 'inline') {
    if (link.download) return { kind: 'browser' };
    const scheme = asParsed(link.written).toLowerCase().startsWith('blob:') ? 'blob:' : 'data:';
    return { kind: 'keep', warning: `A link to a ${scheme} address would replace the app, so it was not followed. Give the link a download attribute to save the file instead.` };
  }
  if (kind === 'own') {
    if (link.isPage(link.written)) return { kind: 'show-page' };
    return { kind: 'keep', warning: `A link to ${shown(link.written)} names no page of this app, so it was not followed. A link opens a page file of the app, named in full with its ending as it is reached from the page that shows the link ("about.html", "docs/guide.html"), or a place on the same page ("#top").` };
  }
  return { kind: 'keep', warning: `A link to ${shown(link.written)} was not followed: this app's links open its own pages, other sites and mail addresses.` };
}

/** A link a click is on: what is written in it, the browser's absolute reading of it, and whether it downloads. */
export interface FoundLink {
  written: string;
  resolved: string;
  download: boolean;
  /** The name a link that downloads gives its file (its `download` attribute's value). */
  saveAs?: string;
  /** One of several links an SVG `<use>` draws: which was clicked cannot be told, and none is followed. */
  unclear?: boolean;
}

const XLINK = 'http://www.w3.org/1999/xlink';
const SVG = 'http://www.w3.org/2000/svg';
const MATHML = 'http://www.w3.org/1998/Math/MathML';
/** How many `<use>`s deep the links one draws are looked for (one that draws one that draws …). */
const USE_DEPTH = 4;
const UNCLEAR: FoundLink = Object.freeze({ written: '', resolved: '', download: false, unclear: true });

/** What is written in a link's address: `href`, or an SVG link's older `xlink:href`; null for none. */
function addressOf(element: Partial<Element>): string | null {
  return element.getAttribute?.('href') ?? element.getAttributeNS?.(XLINK, 'href') ?? null;
}

/**
 * Whether `element` is a link with an address: an `<a>` (HTML's or SVG's), an `<area>`, or a MathML
 * element with an `href`, which WebKit and Firefox follow as a link (`<math href>`).
 */
function isLink(element: Partial<Element>): boolean {
  if (typeof element.getAttribute !== 'function' || addressOf(element) === null) return false;
  return element.localName === 'a' || element.localName === 'area' || element.namespaceURI === MATHML;
}

function found(element: Partial<Element>): FoundLink {
  const written = addressOf(element) ?? '';
  let resolved = written;
  try {
    resolved = new URL(written, element.baseURI ?? undefined).href;
  } catch {
    // (an address the browser cannot read stays as written: links.ts hands on none such)
  }
  const download = element.hasAttribute?.('download') === true;
  return download ? { written, resolved, download, saveAs: element.getAttribute?.('download') ?? '' } : { written, resolved, download };
}

/**
 * What a `<use>` may draw from besides its own page: the text of an SVG file the frame serves at a
 * `blob:` address it made (media.ts), or undefined for an address it did not make; and, kept by
 * `watchLinks`, each such file read once.
 */
export interface Drawing {
  svgText?(url: string): string | undefined;
  read?: Map<string, Document | null>;
}

/** An address without its fragment. */
function withoutFragment(address: string): string {
  const at = address.indexOf('#');
  return at < 0 ? address : address.slice(0, at);
}

/**
 * The document a `<use>` of `url` (another document than its own page) draws from: one the frame can
 * read (an SVG file it serves, or a `data:` address's own text); null for one the browser does not load
 * here (an `http:` address or a path: a `<use>` loads only from its page's origin, and this frame's is
 * opaque); undefined for one it may load and the frame cannot read (a `blob:` address it did not make).
 */
function documentAt(url: URL, from: Document, drawing: Drawing): Document | null | undefined {
  const address = withoutFragment(url.href);
  const read = drawing.read ?? new Map<string, Document | null>();
  drawing.read = read;
  if (read.has(address)) return read.get(address);
  let text: string | undefined;
  if (url.protocol === 'blob:') {
    text = drawing.svgText?.(address);
    if (text === undefined) return undefined;
  } else if (url.protocol === 'data:') {
    const comma = address.indexOf(',');
    if (comma < 0) return null;
    try {
      const body = address.slice(comma + 1);
      text = /;base64$/i.test(address.slice(0, comma)) ? atob(decodeURIComponent(body)) : decodeURIComponent(body);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  const Parser = from.defaultView?.DOMParser;
  const doc = Parser ? new Parser().parseFromString(text, 'image/svg+xml') : null;
  // (the files read last are kept, a few: an app's sprite is clicked again and again, its media come and go)
  if (read.size >= READ_KEPT) read.delete(read.keys().next().value as string);
  read.set(address, doc);
  return doc;
}

/** How many of the frame's own SVG files, read for what a `<use>` of them draws, are kept read. */
const READ_KEPT = 16;

/** A fragment with each `%XX` read as the byte it names, a character each (as Firefox reads a `<use>`'s). */
function bytesDecoded(fragment: string): string {
  return fragment.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * The elements of `doc` a fragment may name: its text percent-decoded as UTF-8 (as Chromium and WebKit
 * read a `<use>`'s), byte by byte (as Firefox does), and as it is written. A browser looks up only a
 * decoded id, so one element whose id was the fragment as written (`id="%65"` beside `id="e"`, for
 * `#%65`) hid the link drawn: every one of them is looked in, and their links taken together.
 */
function byFragment(doc: Document, fragment: string): Element[] {
  const ids = new Set([fragment, bytesDecoded(fragment)]);
  try {
    ids.add(decodeURIComponent(fragment));
  } catch {
    // (not UTF-8: its bytes' reading stands)
  }
  const named: Element[] = [];
  for (const id of ids) {
    const element = doc.getElementById(id);
    if (element !== null && !named.includes(element)) named.push(element);
  }
  return named;
}

/**
 * What an SVG `<use>` draws, its address read as the browser reads it: an address the URL parser
 * takes as its page's own (`" #a"`, `"\n#a"`, `"#%61"`, `"index.html#a"` all draw `#a`, where
 * `#a` alone was looked for) or another document's ({@link documentAt}). `nothing` for none, and
 * `unknown` where what it draws cannot be read. `external` is set for an element of another document.
 */
function drawnBy(use: Element, drawing: Drawing): { elements: Element[]; external: boolean } | 'nothing' | 'unknown' {
  const written = addressOf(use);
  const page = use.ownerDocument;
  if (written === null || page === null) return 'nothing';
  let url: URL;
  try {
    url = new URL(written, use.baseURI);
  } catch {
    return 'nothing';
  }
  const fragment = url.hash.slice(1);
  if (withoutFragment(url.href) === withoutFragment(page.URL)) {
    const elements = fragment === '' ? [] : byFragment(page, fragment);
    return elements.length === 0 ? 'nothing' : { elements, external: false };
  }
  const doc = documentAt(url, page, drawing);
  if (doc === undefined) return 'unknown';
  if (doc === null) return 'nothing';
  // (a whole document where no fragment names a part of it)
  const elements = fragment === '' ? (doc.documentElement ? [doc.documentElement] : []) : byFragment(doc, fragment);
  return elements.length === 0 ? 'nothing' : { elements, external: true };
}

/**
 * The links `element` draws into the copy a `<use>` makes of it: itself where it is one, those in it,
 * and those its own `<use>`s draw, `depth` deep. False where they could not all be looked at, or one
 * is in another document (an SVG file of the app's, whose addresses the browser reads against that
 * file's: none is followed). An element already looked at (a `<use>` that draws itself, or what holds
 * it) draws nothing more: a browser draws no loop.
 */
function linksDrawn(element: Element, depth: number, into: Set<Element>, drawing: Drawing, external = false, seen: Set<Element> = new Set()): boolean {
  if (seen.has(element)) return true;
  seen.add(element);
  const before = into.size;
  if (isLink(element)) into.add(element);
  for (const link of element.querySelectorAll('a, area, [href]')) if (isLink(link)) into.add(link);
  if (external && into.size > before) return false;
  const uses = element.localName === 'use' ? [element, ...element.querySelectorAll('use')] : [...element.querySelectorAll('use')];
  for (const use of uses) {
    const drawn = drawnBy(use, drawing);
    if (drawn === 'unknown') return false;
    if (drawn === 'nothing') continue;
    for (const target of drawn.elements) {
      if (seen.has(target)) continue;
      if (depth === 0 || !linksDrawn(target, depth - 1, into, drawing, external || drawn.external, seen)) return false;
    }
  }
  return true;
}

/**
 * The link a click whose path is `path` is on, if any: an `<a>` (HTML's, or SVG's, whose address may
 * be its older `xlink:href`), an `<area>` or a MathML element with an address, nearest the click first.
 *
 * Or one an SVG `<use>` draws: the copy it makes is in a shadow tree of its own, which the click's
 * path does not reach, and the browser follows the copy's link all the same, before any link that
 * holds the `<use>` (`<a href="#top"><svg><use href="#a"/></svg></a>` went where `#a` goes). The link
 * is looked for in what the `<use>` draws: where that is one link, and no link holds the `<use>`, the
 * click was on it; where it is several, where a link holds the `<use>` too (the click was on the
 * drawn link or beside it), or where they could not all be looked at, which was clicked cannot be
 * told, and none is followed. `drawnBefore`: what each `<use>` drew as the click began, the copy the
 * browser follows, taken with what it draws now (an app that draws another icon as it is clicked).
 */
export function linkIn(path: readonly EventTarget[], drawing: Drawing = {}, drawnBefore?: ReadonlyMap<Element, ReadonlySet<Element> | 'unknown'>): FoundLink | null {
  for (let at = 0; at < path.length; at++) {
    const element = path[at] as Partial<Element>;
    if (isLink(element)) return found(element);
    if (element.localName !== 'use' || element.namespaceURI !== SVG) continue;
    const links = new Set<Element>();
    let whole = linksDrawn(element as Element, USE_DEPTH, links, drawing);
    const before = drawnBefore?.get(element as Element);
    if (before === 'unknown') whole = false;
    else if (before) for (const link of before) links.add(link);
    // A drawing with no link in it: the click is on whatever holds it.
    if (links.size === 0 && whole) continue;
    const held = path.slice(at + 1).some((target) => isLink(target as Partial<Element>));
    return links.size === 1 && whole && !held ? found([...links][0]) : UNCLEAR;
  }
  return null;
}

const HTML = 'http://www.w3.org/1999/xhtml';
/**
 * Whether an HTML element genuinely consumes a click instead of allowing an enclosing link to
 * activate: a `<label>` only when associated with a non-disabled control, a `<summary>` only when
 * it is the first `<summary>` child of a `<details>`, and enabled non-hidden form controls.
 */
function isInteractiveControl(element: Partial<Element>): boolean {
  if (element.namespaceURI !== HTML) return false;
  const tag = element.localName ?? '';
  if (tag === 'label') {
    const ctrl = (element as Partial<HTMLLabelElement>).control;
    return ctrl != null && !(ctrl as Partial<HTMLInputElement>).disabled;
  }
  if (tag === 'summary') {
    const parent = (element as Element).parentElement;
    if (!parent || parent.namespaceURI !== HTML || parent.localName !== 'details') return false;
    for (let child = parent.firstElementChild; child; child = child.nextElementSibling) {
      if (child.namespaceURI === HTML && child.localName === 'summary') {
        return child === element;
      }
    }
    return false;
  }
  if (tag === 'input') {
    const inp = element as Partial<HTMLInputElement>;
    if (inp.disabled) return false;
    const t = typeof inp.getAttribute === 'function' ? (inp.getAttribute('type') ?? '').toLowerCase() : '';
    return t !== 'hidden';
  }
  if (tag === 'select' || tag === 'textarea') {
    return !(element as Partial<HTMLSelectElement>).disabled;
  }
  return false;
}

/**
 * Whether the browser may follow a link from a click whose path is `path`, read as the click begins:
 * the first of these from the click outward is an `<a>` or an `<area>` (with an address now or
 * without one yet: the browser reads it as it follows it), a MathML element with an address, or a
 * `<use>` that draws a link (or whose drawing cannot all be read), and no control comes before it.
 * A `<use>` that draws no link is an icon, passed for what holds it. What each `<use>` draws is kept
 * in `drawnBefore`: the copy the browser follows is the one drawn as the click began.
 */
function mayFollow(path: readonly EventTarget[], drawing: Drawing, drawnBefore: Map<Element, ReadonlySet<Element> | 'unknown'>): boolean {
  for (const target of path) {
    const element = target as Partial<Element>;
    if (typeof element.getAttribute !== 'function') continue;
    if (isInteractiveControl(element)) return false;
    if (element.localName === 'a' || element.localName === 'area') return true;
    if (element.namespaceURI === MATHML && addressOf(element) !== null) return true;
    if (element.localName === 'use' && element.namespaceURI === SVG) {
      const links = new Set<Element>();
      const whole = linksDrawn(element as Element, USE_DEPTH, links, drawing);
      drawnBefore.set(element as Element, whole ? links : 'unknown');
      if (!whole || links.size > 0) return true;
    }
  }
  return false;
}

/** Elements the frame clicks itself, doing what it held a click for (a file a link saves): those clicks are the browser's. */
const framesOwn = new WeakSet<EventTarget>();

/** Lets the frame's own click on `element` through to the browser (main.tsx's `followHere`). */
export function letThrough(element: Element): void {
  framesOwn.add(element);
}

/** {@link linkIn} of a click as it is dispatched (its path is gone once the dispatch is over). */
export function linkAt(event: Event, drawing: Drawing = {}): FoundLink | null {
  return linkIn(event.composedPath(), drawing);
}

/** What `watchLinks` is given by the frame. */
export interface LinkWatch {
  /** Whether clicks are the frame's to look at now (not once it has ended). */
  open(): boolean;
  /**
   * What a click on `link` comes to (`decideLink`, with what only the frame knows). `handled` is the
   * app's cancelling: a click the app cancelled is never decided, so it is false here.
   */
  decide(link: FoundLink, event: MouseEvent, handled: boolean): LinkAction;
  /** Carry out what was decided (never `browser`). */
  act(action: Exclude<LinkAction, { kind: 'browser' }>, link: FoundLink, event: MouseEvent): void;
  /**
   * Do what the browser would have done with a link decided as its own (a place on the page, or a
   * file a `data:` or `blob:` link saves): the frame held the click, so the browser did not. A click
   * the frame makes for it is let through (`letThrough`).
   */
  follow?(link: FoundLink): void;
  /** Run after the click's dispatch has ended (`setTimeout(run, 0)`). */
  later(run: () => void): void;
  /** The text of an SVG file the frame serves at a `blob:` address it made, for a `<use>` of it ({@link Drawing}). */
  svgText?(url: string): string | undefined;
}

/**
 * Listen for clicks on links in `win`, and decide each once the click is over (see the top of this
 * file). A listener on the window, set before any of the app's code runs, hears every click first:
 * a click that may follow a link (`mayFollow`) is held there, before the app's handlers have it, so
 * the browser follows nothing whatever the app does in the click (points the link elsewhere, in a
 * handler, a microtask or a listener of its logic's own on the window, stops it, draws another icon).
 * Once the click is over it is decided on the link as it is then, and carried out, unless the app
 * cancelled it (`preventDefault`, `returnValue = false`): the app has dealt with it (core cancels a
 * link to one of the app's pages it showed in place). What the browser would have done itself, a
 * place on the page or a file a link saves, the frame does (`follow`). A middle click asks for a
 * window this frame cannot open: only a link to the outside is taken from it.
 *
 * Nothing else about a click changes: the app reads `defaultPrevented` and `returnValue` as it made
 * them. Returns a function that stops listening.
 */
export function watchLinks(win: Window, watch: LinkWatch): () => void {
  const relevant = (click: MouseEvent): boolean => watch.open() && (click.type === 'click' ? click.button === 0 : click.button === 1);
  const proto = (win as Window & typeof globalThis).Event.prototype;
  const nativePrevent = proto.preventDefault;
  const returnValue = Object.getOwnPropertyDescriptor(proto, 'returnValue');
  const defaultPrevented = Object.getOwnPropertyDescriptor(proto, 'defaultPrevented');
  /** Whether the click's default is prevented, as the browser has it. */
  const prevented = (click: MouseEvent): boolean => (defaultPrevented?.get ? defaultPrevented.get.call(click) === true : click.defaultPrevented);
  // What the page's `<use>`s draw from: the frame's own SVG files, read as they are needed.
  const drawing: Drawing = { svgText: watch.svgText ? (url) => watch.svgText!(url) : undefined, read: new Map() };

  const onClick = (event: Event): void => {
    const click = event as MouseEvent;
    if (!relevant(click) || prevented(click)) return;
    // The click's path, kept: once the click is over it is gone, and the link it is on is read again then.
    const path = click.composedPath();
    if (path.some((target) => framesOwn.has(target))) return;
    const drawnBefore = new Map<Element, ReadonlySet<Element> | 'unknown'>();
    if (!mayFollow(path, drawing, drawnBefore)) return;
    let cancelled = false;
    nativePrevent.call(click);
    const own = (name: string, value: unknown): void => {
      Object.defineProperty(click, name, { configurable: true, writable: true, value });
    };
    own('preventDefault', function preventDefault(): void {
      cancelled = true;
      nativePrevent.call(click);
    });
    // The frame's holding is its own: the app reads the click as it made it.
    Object.defineProperty(click, 'defaultPrevented', { configurable: true, get: () => cancelled });
    if (returnValue?.set) {
      const { set } = returnValue;
      Object.defineProperty(click, 'returnValue', {
        configurable: true,
        get: () => !cancelled,
        set: (value: unknown) => {
          // (`returnValue = false` is the old way to cancel)
          if (value === false) cancelled = true;
          set.call(click, value);
        },
      });
    }
    watch.later(() => {
      if (cancelled || !watch.open()) return;
      const link = linkIn(path, drawing, drawnBefore);
      if (link === null) return;
      const action = watch.decide(link, click, false);
      if (action.kind === 'browser') {
        if (click.type === 'click') watch.follow?.(link);
        return;
      }
      if (click.type === 'auxclick' && action.kind !== 'hand-on') return;
      watch.act(action, link, click);
    });
  };

  win.addEventListener('click', onClick, true);
  win.addEventListener('auxclick', onClick, true);
  return () => {
    win.removeEventListener('click', onClick, true);
    win.removeEventListener('auxclick', onClick, true);
  };
}
