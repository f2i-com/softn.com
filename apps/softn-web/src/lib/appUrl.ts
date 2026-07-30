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
  if (page) path += `/${encodeURIComponent(page)}`;
  return path;
}

/** Where something shipped in `public/` lives once the base is applied. */
export function publicPath(relative: string, base: string): string {
  return normalizeBase(base) + relative.replace(/^\/+/, '');
}
