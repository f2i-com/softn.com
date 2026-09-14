/**
 * Fetching a bundle an editor was pointed at with `?open=`, bound to the
 * workspace the request was started for.
 *
 * The link is same-origin by the time it reaches here (see
 * `resolveBundleUrl` in @softn/bundle-format), so the checks left are about
 * the response: it must not have redirected away from this site, it must be
 * a bundle and not a page, and it must not grow without bound. And it must
 * not overtake what came after it: the caller says when the workspace the
 * request was for has moved on — a new project, an import, a restore, the
 * editor unmounting — and that is re-checked after every await, because a
 * fetch may ignore its signal. A superseded response is dropped quietly,
 * its body cancelled; the person has moved on.
 *
 * Builder used to have the workspace check and the "replace unsaved work?"
 * question; Studio had the redirect check and the body cancel. Both now
 * have all of it, and each keeps its own outer shape on top.
 */

import { MAX_ZIP_INPUT_BYTES } from '@softn/bundle-format/zip';

// The limit the message names is the bundle format's, whatever cap a caller
// passes (tests pass small ones): that is the number a person can act on.
const TOO_LARGE = `Choose a project file smaller than ${MAX_ZIP_INPUT_BYTES / 1024 / 1024} MB.`;

/** Bound the download itself, before the importer allocates or unzips it. */
export async function readRemoteBundle(
  response: Response,
  signal: AbortSignal,
  maxBytes = MAX_ZIP_INPUT_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = Number(response.headers.get('content-length'));
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (declaredLength > maxBytes || contentType === 'text/html' || contentType === 'application/json') {
    void response.body?.cancel().catch(() => {});
    throw new Error(declaredLength > maxBytes ? TOO_LARGE : 'The link returned a page instead of a .softn app.');
  }
  signal.throwIfAborted();
  if (!response.body) throw new Error('The app download was empty.');

  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) throw new Error(TOO_LARGE);
      chunks.push(next.value);
    }
    if (length === 0) throw new Error('The app download was empty.');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export interface RemoteBundleFetch {
  fetch?: typeof fetch;
  /** Aborted by whatever supersedes the request. */
  signal: AbortSignal;
  /** True once the workspace the request was started for has moved on; asked after every await. */
  superseded?: () => boolean;
  maxBytes?: number;
}

export type RemoteBundleResult =
  | { kind: 'bytes'; bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'superseded' };

/**
 * Fetch a bundle from a same-origin link. Resolves with its bytes, or with
 * `superseded` (quietly, body cancelled) when the workspace moved on while
 * the response was on its way; throws for a response that is not a bundle
 * of this site. An abort surfaces as the fetch's own AbortError, which the
 * caller treats as superseded too.
 */
export async function fetchSameOriginBundle(url: URL, deps: RemoteBundleFetch): Promise<RemoteBundleResult> {
  const doFetch = deps.fetch ?? fetch;
  const superseded = () => deps.signal.aborted || (deps.superseded?.() ?? false);
  const resp = await doFetch(url.href, { credentials: 'same-origin', mode: 'same-origin', signal: deps.signal });
  const drop = () => { void resp.body?.cancel().catch(() => {}); };
  if (superseded()) {
    drop();
    return { kind: 'superseded' };
  }
  if (!resp.ok) {
    drop();
    throw new Error(`${url.pathname} responded ${resp.status}`);
  }
  // Directory endpoints may redirect within this site, including to a path
  // without an extension. The response must still belong to this origin.
  if (resp.url && new URL(resp.url).origin !== url.origin) {
    drop();
    throw new Error('The app download redirected away from this site.');
  }
  const bytes = await readRemoteBundle(resp, deps.signal, deps.maxBytes);
  if (superseded()) return { kind: 'superseded' };
  return { kind: 'bytes', bytes };
}

/** Whether an error is the quiet kind: our own abort, from a superseding action or unmount. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
