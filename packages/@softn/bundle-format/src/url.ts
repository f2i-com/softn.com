/**
 * A bundle's address, as a page receives it in `?open=`.
 *
 * The value arrives in a link anyone can send the user, and what comes back
 * is handed straight to a bundle reader, so it is hostile until it has
 * proved to be a same-origin `.softn` served over http(s). The runtime, the
 * editors and the directory all apply this one rule.
 */

/**
 * Turn an `?open=` value into a URL that is safe to fetch, or throw explaining
 * why it is not.
 */
export function resolveBundleUrl(value: string, origin: string): URL {
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    throw new Error(`Cannot open "${value}": it is not a valid path.`);
  }

  // The scheme is settled before the origin, because a blob: URL borrows the
  // origin of the document that created it: "blob:https://softn.example/<uuid>"
  // is same-origin by the test below and its pathname can be made to end in
  // .softn, so the pair of checks would pass something that was never served
  // from this site — or from any site.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `Refusing to open a ${url.protocol} URL: only bundles served over http or https can be opened by URL.`
    );
  }

  // Resolving first and comparing origins afterwards is the whole defence.
  // "https://evil.example/x.softn" is the obvious case, but "//evil.example/
  // x.softn" is the one a startsWith('/') test waves through — it looks like a
  // path and resolves to somebody else's host.
  if (url.origin !== origin) {
    throw new Error(
      `Refusing to open a bundle from ${url.origin}: only bundles served from this site can be opened by URL.`
    );
  }

  // Credentials in the address would be sent with the request. Nothing this
  // site serves needs them, so a link that carries them is not one of ours.
  if (url.username || url.password) {
    throw new Error(`Refusing to open "${url.pathname}": a bundle address carries no credentials.`);
  }

  if (!/\.softn$/i.test(url.pathname)) {
    throw new Error(`Refusing to open "${url.pathname}": only .softn bundles can be opened by URL.`);
  }

  return url;
}

/**
 * The bundle's name from its address. The directory serves every bundle as
 * `bundle.softn` under the app's own segment (`/app/<slug>/bundle.softn`), so
 * that segment is the name; anywhere else it is the file name without its
 * extension.
 */
export function bundleNameFromUrl(url: URL): string {
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? 'app.softn';
  const name = segments.length >= 2 && /^bundle\.softn$/i.test(last) ? segments[segments.length - 2] : last.replace(/\.softn$/i, '');
  try {
    return decodeURIComponent(name) || 'app';
  } catch {
    return name || 'app';
  }
}
