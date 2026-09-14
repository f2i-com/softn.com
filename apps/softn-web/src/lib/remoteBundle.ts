/**
 * Fetching a `.softn` the page was pointed at with `?open=`.
 *
 * The value arrives in a link anyone can send the user, and what comes back is
 * handed straight to the bundle processor, so this module treats it as hostile
 * until it has proved to be a same-origin bundle of a plausible size.
 */

/** Refuse anything larger than this. Promptly Unemployed is about 18 MB. */
export const MAX_REMOTE_BUNDLE_BYTES = 32 * 1024 * 1024;

const MAX_MB = MAX_REMOTE_BUNDLE_BYTES / (1024 * 1024);

// The URL rule (http(s), this origin, no credentials, a .softn) and the name
// a bundle takes from its address are the bundle contract's, shared with the
// editors and the directory.
export { resolveBundleUrl, bundleNameFromUrl } from '@softn/bundle-format/url';

/** Download a bundle, giving up rather than growing without bound. */
export async function fetchRemoteBundle(url: URL, signal?: AbortSignal): Promise<Uint8Array> {
  // The signal lets a closed tab stop its own download rather than leaving a
  // bundle arriving for a tab that no longer exists.
  const response = await fetch(url.href, { credentials: 'same-origin', signal, cache: 'no-cache' });

  if (!response.ok) {
    throw new Error(`Could not fetch ${url.pathname} (HTTP ${response.status} ${response.statusText}).`);
  }

  // `resolveBundleUrl` vetted where the request was aimed; `response.url` is
  // where it landed. Fetch follows redirects by default, so an open redirect
  // anywhere on this origin would otherwise be enough to walk a bundle in from
  // somebody else's server past a check that already passed.
  if (response.url && new URL(response.url).origin !== url.origin) {
    throw new Error(
      `Refusing ${url.pathname}: it redirected to ${new URL(response.url).origin}, which is not this site.`
    );
  }

  // A static host answers an unknown path with the single-page shell and a 200,
  // so the status alone does not mean a bundle came back. The check is a
  // denylist because `.softn` has no registered media type: servers label it
  // application/zip, application/octet-stream, or nothing at all, and only HTML
  // is certainly wrong.
  const contentType = response.headers.get('content-type') ?? '';
  if (/^\s*text\/html\b/i.test(contentType)) {
    throw new Error(`${url.pathname} is not a bundle — the server returned a web page.`);
  }

  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > MAX_REMOTE_BUNDLE_BYTES) {
    throw new Error(`${url.pathname} is larger than the ${MAX_MB} MB limit for bundles opened by URL.`);
  }

  // Content-Length is a claim, so the cap is enforced again against the bytes
  // that actually arrive; a chunked response carries no length at all.
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_REMOTE_BUNDLE_BYTES) {
      throw new Error(`${url.pathname} is larger than the ${MAX_MB} MB limit for bundles opened by URL.`);
    }
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_REMOTE_BUNDLE_BYTES) {
      await reader.cancel();
      throw new Error(`${url.pathname} is larger than the ${MAX_MB} MB limit for bundles opened by URL.`);
    }
    chunks.push(value);
  }

  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}
