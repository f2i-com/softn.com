/**
 * Where an app is, as one string its host can keep.
 *
 * An app written as a site has more than one page file, and a link between
 * them (`<a href="about.html">`) was left to the browser: the frame went to
 * an address that is FormLogic's own page, which refuses to be framed, and
 * the app went blank. The frame now shows the page itself, as SoftN Web and
 * the single-app page do (core's bundlePageAt and composePage; main.tsx),
 * and tells its parent where the app is (`{ type: 'place', place }` on the
 * port), so that a parent can keep it in its address bar and hand it back in
 * `init.place` when the app is next opened.
 *
 * A place is one string:
 *
 *   /                       the app's main page
 *   /about.html             another page file, by its path in the bundle
 *   /docs/guide.html
 *   /#settings              a named page inside the main page (NavItem's `page`)
 *   /docs/guide.html#team   and one inside another page file
 *
 * It starts with one `/` and never two, has no `\`, `?` or control character
 * in it, and is at most 2,000 characters, so a parent may write it after an
 * address of its own. Each part of the path, and the name, is
 * percent-encoded, as an address bar would have them anyway. The parent
 * reads nothing in it.
 *
 * Coming back it is anyone's text: the parent took it from an address a
 * person can type. It is read to a shape here and then held to the app's own
 * files, and what is not a place of this app is its main page.
 *
 * This module is the reading, the writing and the deciding. Core's
 * bundlePageAt is passed in, so it runs alone under `node --test`.
 */

/** Where an app is. */
export interface Place {
  /** Another page file of the app, by its path in the bundle; null for its main page. */
  file: string | null;
  /** The named page showing inside it (what NavItem's `page` sets, as the renderer reports it); null for none. */
  section: string | null;
}

/**
 * Core's bundlePageAt: the bundle path of the page `href` names from the page
 * at `from`, or null when it names none the bundle has (another site, a
 * fragment, a file that is not a page).
 */
export type PageAt = (files: ReadonlyMap<string, string>, from: string, href: string) => string | null;

/** The most characters a place has, written or read. */
export const PLACE_LIMIT = 2000;

const MAIN_PAGE: Place = Object.freeze({ file: null, section: null });

/** Text with no control character in it: nothing an address drops or a person cannot see. */
function printable(text: string): boolean {
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** One part of a bundle path: a name, and not a step out of the folder or a path of its own. */
function isPart(part: string): boolean {
  return part !== '' && part !== '.' && part !== '..' && !part.includes('/') && !part.includes('\\') && printable(part);
}

/** Text as an address carries it, or null for text no address can (half of a surrogate pair). */
function encoded(text: string): string | null {
  try {
    return encodeURIComponent(text);
  } catch {
    return null;
  }
}

/** What percent-encoded text says, or null where it is not percent-encoded text. */
function decoded(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * A place, written. Always a place a parent can take: a named page that
 * would make it longer than the limit, or that no address can carry, is left
 * out, and a page file whose path cannot be written is written as the main
 * page (no bundle a person made has one).
 */
export function writePlace(place: Place): string {
  let path = '/';
  if (place.file !== null) {
    const parts = place.file.split('/');
    const written = parts.every(isPart) ? parts.map(encoded) : [null];
    if (written.includes(null)) return '/';
    path = `/${written.join('/')}`;
    if (path.length > PLACE_LIMIT) return '/';
  }
  if (place.section === null || place.section === '' || !printable(place.section)) return path;
  const name = encoded(place.section);
  if (name === null || path.length + 1 + name.length > PLACE_LIMIT) return path;
  return `${path}#${name}`;
}

/**
 * A place, read: its shape and nothing more, or null for anything that is
 * not one. Whether the app has such a page is `startPlace`'s to say.
 *
 * Refused: what is not text, the empty text, more than the limit, a start
 * that is not one `/` (`//host` is another site to a browser), a `\`
 * anywhere (a browser reads it as `/`), a `?`, a part of the path that is
 * empty, `.` or `..` or that decodes to one holding a `/`, and text that is
 * not percent-encoded text.
 */
export function readPlace(value: unknown): Place | null {
  if (typeof value !== 'string' || value === '' || value.length > PLACE_LIMIT) return null;
  if (value[0] !== '/' || value[1] === '/') return null;
  if (value.includes('\\') || value.includes('?') || !printable(value)) return null;
  const hash = value.indexOf('#');
  const path = hash < 0 ? value : value.slice(0, hash);
  const name = hash < 0 ? '' : value.slice(hash + 1);
  let file: string | null = null;
  if (path !== '/') {
    const parts: string[] = [];
    for (const written of path.slice(1).split('/')) {
      const part = decoded(written);
      if (part === null || !isPart(part)) return null;
      parts.push(part);
    }
    file = parts.join('/');
  }
  // A `#` with nothing after it names no page, as in any address.
  if (name === '') return { file, section: null };
  const section = decoded(name);
  if (section === null || section === '' || !printable(section)) return null;
  return { file, section };
}

/**
 * Whether `files` has `path` as a page of the app other than its main one:
 * what a place may name, and what an app handed a newer version stays on.
 * Asked of core as a link from the root would ask it, so a page here is
 * exactly a page a link can go to.
 */
export function isOtherPage(files: ReadonlyMap<string, string>, main: string, path: string, pageAt: PageAt): boolean {
  return path !== main && pageAt(files, main, `/${path}`) === path;
}

/**
 * Whether the app keeps a named page where the renderer reports one, and
 * where a start on one is written: its `currentPage`.
 *
 * Asked before a name from `init.place` is given to the app. The frame
 * writes a name only when the renderer reports one, which it does for an app
 * with that variable, so a name for an app that never mentions it is not a
 * place of this app. And it must not be given: an app that keeps its page
 * under `page` (Studio's projects), or keeps none, would find a `currentPage`
 * it never made, and its NavItems would set that instead of what it reads.
 * Read from the files' text because the app has not run yet.
 */
export function keepsNamedPage(files: ReadonlyMap<string, string>): boolean {
  for (const text of files.values()) {
    if (text.includes('currentPage')) return true;
  }
  return false;
}

/**
 * Where the app starts: the place its parent names (`init.place`), as far as
 * it is a place of this app, and its main page for everything else. `main`
 * is the app's main page as core's mainPage reads it, null where it reads
 * none.
 */
export function startPlace(value: unknown, files: ReadonlyMap<string, string>, main: string | null, pageAt: PageAt): Place {
  const read = readPlace(value);
  if (read === null) return MAIN_PAGE;
  let file: string | null = null;
  if (read.file !== null && read.file !== main) {
    // No such page: the name that came with it was a page inside that one, so it goes too.
    if (main === null || !isOtherPage(files, main, read.file, pageAt)) return MAIN_PAGE;
    file = read.file;
  }
  return { file, section: read.section !== null && keepsNamedPage(files) ? read.section : null };
}

/**
 * What a link on the page showing comes to, as SoftN Web decides it
 * (AppRunner's followLink). Null: nothing of the app's (another site, an
 * address with a scheme, a file that is not a page), which stays the
 * browser's. Otherwise the page it names: `file` is null for the main page,
 * and `showing` says it is the page already on screen, which is left as it
 * is. `shown` is the page file on screen, null for the main page.
 */
export function linkedPage(
  files: ReadonlyMap<string, string>,
  main: string | null,
  shown: string | null,
  href: unknown,
  pageAt: PageAt,
): { file: string | null; showing: boolean } | null {
  if (main === null || typeof href !== 'string') return null;
  const from = shown ?? main;
  const path = pageAt(files, from, href);
  if (path === null) return null;
  return { file: path === main ? null : path, showing: path === from };
}
