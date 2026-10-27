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
