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
 * Every click on a link is decided once (`watchLinks`): on the document after
 * the app's and core's handlers, or, for a click the app stops on its way
 * there (`@click.stop`, a component that stops its clicks, a page's code), at
 * the moment it is stopped. A stopped click was otherwise the browser's, and
 * took the frame wherever its link said.
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
  if (link.unclear) return { kind: 'keep', warning: 'A link drawn by an SVG <use> that draws more than one link was not followed: which of them was clicked cannot be told. Give each link a <use> of its own, or draw it in place.' };
  const kind = linkKind(link.written);
  if (kind === 'fragment') return { kind: 'browser' };
  if (kind === 'empty') return { kind: 'keep', warning: 'A link with an empty address would load the frame again and take the app off it, so it was not followed. Give it the page it opens ("about.html"), or "#" for a link that only runs its click.' };
  if (kind === 'outside') {
    if (!link.byPerson) return { kind: 'keep', warning: `The page's code clicked a link to ${shown(link.written)}; only a link the person clicks goes to another site.` };
    const href = outsideAddress(link.resolved);
    return href === null
      ? { kind: 'keep', warning: `A link to ${shown(link.written)} was not opened: it is not an address this app may hand on.` }
      : { kind: 'hand-on', href };
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
  /** One of several links an SVG `<use>` draws: which was clicked cannot be told, and none is followed. */
  unclear?: boolean;
}

const XLINK = 'http://www.w3.org/1999/xlink';
const SVG = 'http://www.w3.org/2000/svg';
/** How many `<use>`s deep the links one draws are looked for (one that draws one that draws …). */
const USE_DEPTH = 4;

/** What is written in a link's address: `href`, or an SVG link's older `xlink:href`; null for none. */
function addressOf(element: Partial<Element>): string | null {
  return element.getAttribute?.('href') ?? element.getAttributeNS?.(XLINK, 'href') ?? null;
}

/** Whether `element` is a link with an address: an `<a>` (HTML's or SVG's) or an `<area>`. */
function isLink(element: Partial<Element>): boolean {
  return typeof element.getAttribute === 'function' && (element.localName === 'a' || element.localName === 'area') && addressOf(element) !== null;
}

function found(element: Partial<Element>): FoundLink {
  const written = addressOf(element) ?? '';
  let resolved = written;
  try {
    resolved = new URL(written, element.baseURI ?? undefined).href;
  } catch {
    // (an address the browser cannot read stays as written: links.ts hands on none such)
  }
  return { written, resolved, download: element.hasAttribute?.('download') === true };
}

/** The element an SVG `<use>` draws, one of its page's own named `#id`; null for none (another document's is never loaded here). */
function drawnBy(use: Element): Element | null {
  const named = addressOf(use);
  if (named === null || !named.startsWith('#') || named.length < 2) return null;
  return use.ownerDocument?.getElementById(named.slice(1)) ?? null;
}

/**
 * The links `element` draws into the copy a `<use>` makes of it: itself where it is one, those in it,
 * and those its own `<use>`s draw, `depth` deep. False where they could not all be looked at. An
 * element already looked at (a `<use>` that draws itself, or what holds it) draws nothing more: a
 * browser draws no loop.
 */
function linksDrawn(element: Element, depth: number, into: Set<Element>, seen: Set<Element> = new Set()): boolean {
  if (seen.has(element)) return true;
  seen.add(element);
  if (isLink(element)) into.add(element);
  for (const link of element.querySelectorAll('a, area')) if (isLink(link)) into.add(link);
  const uses = element.localName === 'use' ? [element, ...element.querySelectorAll('use')] : [...element.querySelectorAll('use')];
  for (const use of uses) {
    const drawn = drawnBy(use);
    if (drawn === null || seen.has(drawn)) continue;
    if (depth === 0 || !linksDrawn(drawn, depth - 1, into, seen)) return false;
  }
  return true;
}

/**
 * The link a click is on, if any: an `<a>` (HTML's, or SVG's, whose address may be its older
 * `xlink:href`) or an `<area>` with an address, nearest the click first.
 *
 * Or one an SVG `<use>` draws: the copy it makes is in a shadow tree of its own, which the click's
 * path does not reach, and the browser follows the copy's link all the same. The link is looked for
 * in what the `<use>` draws: where that is one link, the click was on it; where it is several (or they
 * could not all be looked at), which was clicked cannot be told, and none is followed.
 */
export function linkAt(event: Event): FoundLink | null {
  let use: Element | null = null;
  for (const target of event.composedPath()) {
    const element = target as Partial<Element>;
    if (isLink(element)) return found(element);
    if (use === null && element.localName === 'use' && element.namespaceURI === SVG) use = element as Element;
  }
  if (use === null) return null;
  const links = new Set<Element>();
  const whole = linksDrawn(use, USE_DEPTH, links);
  if (links.size === 1 && whole) return found([...links][0]);
  if (links.size === 0 && whole) return null;
  return { written: '', resolved: '', download: false, unclear: true };
}

/** What `watchLinks` is given by the frame. */
export interface LinkWatch {
  /** Whether clicks are the frame's to look at now (not once it has ended). */
  open(): boolean;
  /** What a click on `link` comes to (`decideLink`, with what only the frame knows): `handled` is the app's cancelling. */
  decide(link: FoundLink, event: MouseEvent, handled: boolean): LinkAction;
  /** Carry out what was decided (never `browser`). */
  act(action: Exclude<LinkAction, { kind: 'browser' }>, link: FoundLink, event: MouseEvent): void;
  /** Run after the click's dispatch has ended (`setTimeout(run, 0)`). */
  later(run: () => void): void;
}

/**
 * Listen for clicks on links in `win`, and decide each once (see the top of this file):
 *
 * - on the document, on the way up, after the app's and core's handlers: as a link in a browser
 *   is, with the app's own cancelling (`preventDefault`) saying it has dealt with the click;
 * - where the app stops one on its way there (`stopPropagation`, `stopImmediatePropagation`,
 *   `cancelBubble`): what a listener on the window, which hears every click first, put on that
 *   click's own methods. Then the frame keeps the browser from following it there and then, and
 *   carries out what was decided once the click is over, unless the app cancels it after all.
 *
 * Nothing else about a click changes: the app sees `defaultPrevented` as it made it. Returns
 * a function that stops listening.
 */
export function watchLinks(win: Window, watch: LinkWatch): () => void {
  const decided = new WeakSet<Event>();
  const relevant = (click: MouseEvent): boolean => watch.open() && (click.type === 'click' ? click.button === 0 : click.button === 1);
  const proto = (win as Window & typeof globalThis).Event.prototype;
  const nativePrevent = proto.preventDefault;
  const nativeStop = proto.stopPropagation;
  const nativeStopNow = proto.stopImmediatePropagation;
  const cancelBubble = Object.getOwnPropertyDescriptor(proto, 'cancelBubble');
  const returnValue = Object.getOwnPropertyDescriptor(proto, 'returnValue');

  /** What the click comes to, or null where it is the browser's (or not one to act on now). */
  const deciding = (click: MouseEvent, link: FoundLink): Exclude<LinkAction, { kind: 'browser' }> | null => {
    const action = watch.decide(link, click, click.defaultPrevented);
    // A middle click asks for a window this frame cannot open: only a link to the outside is worth taking from it.
    if (action.kind === 'browser' || (click.type === 'auxclick' && action.kind !== 'hand-on')) return null;
    return action;
  };

  const onDocument = (event: Event): void => {
    const click = event as MouseEvent;
    if (decided.has(click) || !relevant(click)) return;
    decided.add(click);
    const link = linkAt(click);
    if (link === null) return;
    const action = deciding(click, link);
    if (action === null) return;
    nativePrevent.call(click);
    watch.act(action, link, click);
  };

  const onWindow = (event: Event): void => {
    const click = event as MouseEvent;
    if (!relevant(click)) return;
    const link = linkAt(click);
    if (link === null) return;
    /** The click was stopped here, and is carried out after it unless the app cancels it. */
    let stoppedHere = false;
    let cancelled = false;
    const stopped = (): void => {
      if (decided.has(click)) return;
      decided.add(click);
      const action = deciding(click, link);
      if (action === null) return;
      stoppedHere = true;
      nativePrevent.call(click);
      watch.later(() => {
        if (!cancelled) watch.act(action, link, click);
      });
    };
    const own = (name: string, value: unknown): void => {
      Object.defineProperty(click, name, { configurable: true, writable: true, value });
    };
    own('preventDefault', function preventDefault(): void {
      if (stoppedHere) cancelled = true;
      nativePrevent.call(click);
    });
    own('stopPropagation', function stopPropagation(): void {
      stopped();
      nativeStop.call(click);
    });
    own('stopImmediatePropagation', function stopImmediatePropagation(): void {
      stopped();
      nativeStopNow.call(click);
    });
    if (cancelBubble?.get && cancelBubble.set) {
      const { get, set } = cancelBubble;
      Object.defineProperty(click, 'cancelBubble', {
        configurable: true,
        get: () => get.call(click),
        set: (value: unknown) => {
          if (value) stopped();
          set.call(click, value);
        },
      });
    }
    if (returnValue?.get && returnValue.set) {
      const { get, set } = returnValue;
      Object.defineProperty(click, 'returnValue', {
        configurable: true,
        get: () => get.call(click),
        set: (value: unknown) => {
          // (`returnValue = false` is the old way to cancel)
          if (value === false && stoppedHere) cancelled = true;
          set.call(click, value);
        },
      });
    }
  };

  win.addEventListener('click', onWindow, true);
  win.addEventListener('auxclick', onWindow, true);
  win.document.addEventListener('click', onDocument);
  win.document.addEventListener('auxclick', onDocument);
  return () => {
    win.removeEventListener('click', onWindow, true);
    win.removeEventListener('auxclick', onWindow, true);
    win.document.removeEventListener('click', onDocument);
    win.document.removeEventListener('auxclick', onDocument);
  };
}
