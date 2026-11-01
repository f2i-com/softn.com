/**
 * The paths the shell reads and writes, resolved against the deployment base.
 *
 * The same build is served from `/` and from a subpath such as `/web/`, so no
 * route may be spelled as a literal starting with `/app/`: under a subpath the
 * router would never match its own URLs and every reload would land on Home.
 */

/**
 * `base` with exactly one leading and one trailing slash.
 *
 * `BASE_URL` is whatever was written in `VITE_BASE` — `/web`, `/web/` and `web/`
 * all mean the same deployment — and a relative base like `./` cannot be
 * matched against a pathname at all, so it is read as the root.
 */
function normalizeBase(base: string): string {
  const trimmed = base.replace(/^\.*\/*/, '').replace(/\/+$/, '');
  return trimmed ? `/${trimmed}/` : '/';
}

/** Read `<base>/app/<name>[/<page>]`. Anything else is Home. */
export function parseAppPath(
  pathname: string,
  base: string
): { appName: string | null; page: string | null } {
  const prefix = `${normalizeBase(base)}app/`;
  if (!pathname.startsWith(prefix)) return { appName: null, page: null };

  const match = pathname.slice(prefix.length).match(/^([^/]+)(?:\/(.+))?$/);
  if (!match) return { appName: null, page: null };

  try {
    return {
      appName: decodeURIComponent(match[1]),
      page: match[2] ? decodeURIComponent(match[2]) : null,
    };
  } catch {
    // A stray percent sign is not a route, and decodeURIComponent throws on it.
    return { appName: null, page: null };
  }
}

/** Write `<base>/app/<name>[/<page>]`, or the base itself for Home. */
export function buildAppPath(
  appName: string | null,
  page: string | null | undefined,
  base: string
): string {
  const root = normalizeBase(base);
  if (!appName) return root;
  let path = `${root}app/${encodeURIComponent(appName)}`;
  // A page's slashes stay slashes, which parseAppPath reads as they were: Apache
  // answers a path with %2F in it itself, before any rule of the site's. A page
  // is the app's to name, and the browser collapses `..`: left in, one named
  // `../twenty48` showed another app's address over this app's screen, and
  // `../../../publish` any page of the site. Such a page is no part of an address.
  if (page && !page.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    path += `/${encodeURIComponent(page).replace(/%2F/g, '/')}`;
  }
  return path;
}

/**
 * What marks an address as an app with no directory page: no slug can begin
 * with it (Catalog::validSlug), and the directory reads any other text as the
 * slug it spells (Apps::resolveSlug), `My Notes` as `my-notes`.
 */
const SAVED_ONLY = '~';

/**
 * A name as it stands in an address. A slash can be in no path a host will
 * pass on: Apache answers %2F itself, before any rule of the site's, and
 * AllowEncodedSlashes cannot be set from .htaccess, so `My/App` was lost on a
 * reload. A backslash is the same on Windows. Written `~2F`, and `~` as `~7E`,
 * so that what is read back is what was written, whatever the name holds.
 */
function escapeName(name: string): string {
  return name.replace(/[~/\\]/g, (mark) => `~${mark.charCodeAt(0).toString(16).toUpperCase()}`);
}

function unescapeName(written: string): string {
  return written.replace(/~([0-9A-F]{2})/g, (_, code: string) => String.fromCharCode(parseInt(code, 16)));
}

/**
 * The address a tab's app is at. A directory app's slug, which is what the
 * directory knows it by and what anyone given the link will be sent. The
 * manifest's name is the bundle's to choose, so it was no address: a listing
 * called notes that named itself after another app put that app's address in
 * the bar, and a name no listing has gave whoever got the link "not found".
 * An app that came from a file has only its name, marked, so that it names
 * nothing in the directory and is looked for in this browser alone.
 */
export function tabAddress(tab: { name: string; directorySlug?: string }): string {
  return tab.directorySlug ?? `${SAVED_ONLY}${escapeName(tab.name)}`;
}

/** The name in an address `tabAddress` marked as saved in this browser only, or null. */
export function savedOnlyName(address: string): string | null {
  return address.startsWith(SAVED_ONLY) ? unescapeName(address.slice(SAVED_ONLY.length)) : null;
}

/**
 * Where a tab's app can be fetched again, if that is a page of this site and
 * not the directory: an app opened by a link, whose address is otherwise only
 * good in the browser that has it. A path, as `?from=` carries it.
 */
export function tabLink(tab: { directorySlug?: string; bundleUrl?: string }): string | null {
  if (tab.directorySlug || !tab.bundleUrl) return null;
  const url = new URL(tab.bundleUrl);
  return url.pathname + url.search;
}

/** Where something shipped in `public/` lives once the base is applied. */
export function publicPath(relative: string, base: string): string {
  return normalizeBase(base) + relative.replace(/^\/+/, '');
}
