/**
 * What a runtime route of the service worker (pwa-sw.js) is matched with.
 *
 * A pattern written as a path (`\/assets\/[^/?#]+\.js$`) was a RegExp route,
 * and Workbox tests that against the whole address, where a match anywhere
 * in a same-origin address counts: `/web/?n=1/assets/a.js` was a feature
 * chunk. An app's `<img src="/web/?n=1/assets/a.js">` needs no permission,
 * so any app could fill that cache (evicting the real chunks, which then
 * failed offline) and keep SoftN Web's own page in it under such a name,
 * which the offline fallback answered `/web/` with. A path pattern is now
 * tested against the path of a request to this origin that has no query.
 * An absolute pattern (`^https:\/\/fonts…`) is the RegExp route it was.
 */
export function routeMatcher(pattern, flags, origin) {
  const re = new RegExp(pattern, flags);
  if (!pattern.startsWith('\\/')) return re;
  return ({ url }) => url.origin === origin && url.search === '' && re.test(url.pathname);
}

/**
 * Whether a response is a page given in place of the file that was asked for.
 *
 * Every runtime route keeps scripts, stylesheets or WebAssembly, by a pattern on the end of
 * the path, so `/web/app/~x/assets/a.js` is a "feature chunk" to it. The shipped Apache and
 * nginx rules answer such an address 404, and a 404 is not kept. A host that falls back to
 * the app's page for every unknown address (a `_redirects` rule, most static hosts' single-
 * page setting) answers 200 with HTML: any app could fill a route's cache with the runtime's
 * own page under such names (an `<img src>` needs no permission), pushing out the real
 * chunks, the container's Worker and its engines, which then failed offline; and a chunk
 * asked for in the middle of a deployment was kept as that page for thirty days.
 *
 * A page is what it is named: an address that does not end in `.html` or `.htm` and is
 * answered as `text/html` is not kept.
 */
export function isPageInPlaceOfFile(url, response) {
  const type = (response.headers.get('content-type') || '').trim().toLowerCase();
  if (!type.startsWith('text/html')) return false;
  let path = String(url);
  try {
    path = new URL(url).pathname;
  } catch {
    // Not an address this can read: judged as written.
  }
  return !/\.html?$/i.test(path);
}
