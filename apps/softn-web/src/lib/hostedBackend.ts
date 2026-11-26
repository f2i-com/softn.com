/**
 * Which hosted backend an app from the directory is pointed at.
 *
 * The directory says where an app's backend is (`hosting.backendUrl` in
 * `GET /api/apps/<slug>`), and an app may have named one of its own there.
 * A web container's frontend then reaches that address through the runtime
 * (`RemoteBackendTransport`), whose requests to the runtime's own origin go
 * with what the browser holds for it, the visitor's cookies among them, and
 * the app chooses the paths it asks for underneath.
 *
 * The address was used as it came. One on this origin that was not the
 * app's own backend (`/api/apps/<another>/backend`, or the site itself)
 * had the app speaking to that as the visitor. The directory refuses to
 * store such an address and no longer gives one out, but it judges by the
 * name it believes it has, and this page knows the origin it is really on;
 * and an address is also kept on the app's record, where one saved by an
 * earlier build is read again with no directory to ask. So the rule is
 * applied here, where the address is used:
 *
 * - On this origin, only the app's own hosted backend,
 *   `/api/apps/<slug>/backend`, and that is given as the path however it
 *   was written. An app with no slug has no backend here.
 * - Elsewhere, an http(s) address as it was given: a request to another
 *   origin carries nothing of this one's.
 * - Anything else is no backend.
 */

/** A slug as the directory writes one (Catalog::validSlug). */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The address to use for `given`, or null when it is not one to use.
 * `slug` is the app's in the directory; `pageOrigin` is the runtime's own
 * (`location.origin`).
 */
export function hostedBackendUrl(given: unknown, slug: string | undefined, pageOrigin: string): string | null {
  if (typeof given !== 'string' || given.trim() === '') return null;
  let page: URL;
  let url: URL;
  try {
    page = new URL(pageOrigin);
    // As the browser will resolve it when the request is made: a path, an
    // address without a scheme and one written with backslashes are this origin's.
    url = new URL(given, page);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin !== page.origin) return given;
  if (!slug || !SLUG.test(slug)) return null;
  const own = `/api/apps/${slug}/backend`;
  const exact = !url.username && !url.password && !url.search && !url.hash && !given.includes('?') && !given.includes('#');
  return exact && url.pathname.replace(/\/+$/, '') === own ? own : null;
}

/**
 * The same for the page this runs in. Where there is no page with an origin
 * of its own (a document with an opaque one, a script outside a browser) a
 * path is still only ever the app's own backend, judged against a name that
 * is nobody's.
 */
export function usableBackendUrl(given: unknown, slug: string | undefined): string | null {
  const origin = typeof location !== 'undefined' && location.origin && location.origin !== 'null' ? location.origin : 'http://softn.invalid';
  return hostedBackendUrl(given, slug, origin);
}
