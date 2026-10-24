/**
 * What a script reaches over the network through `softn.*`: `softn.net.fetch`,
 * a page's `fetch()` of its own files (`bundle.read`), the app's database on
 * the directory that published it (`softn.storage.*`), and the app's files
 * as Blobs for a model it ships. Every request it starts is cancelled when
 * the app closes.
 */

import type { BundleFileProvider } from '../ai-manager';
import type { PendingHostCall } from '../script-runtime-types';
import { storageVisitorToken } from '../visitor-token';
import type { HostGate } from './permissions';

/** The most a response may be before it is refused. */
const MAX_NET_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Whether an address the asset resolver gave for one of the app's files is
 * read without the network rules: a `blob:` (a bundle's file), a `data:` (a
 * file the host holds as text, as Studio's preview gives every one), or a
 * path on the page's own site. Any other scheme, or `//host`, would be a
 * fetch past `net`. `data:` was refused with the rest, so in Studio's preview
 * a page's `fetch('data.json')` was not found, and a model it ships too.
 */
function isOwnFileUrl(url: string): boolean {
  return /^(?:blob|data):/i.test(url) || !/^[a-z][a-z0-9+.-]*:|^[\\/]{2}/i.test(url);
}

export interface AppNetworkOptions {
  /** Where the app's own files are, as its markup's `src="images/x.png"` finds them. */
  assetResolver: ((path: string) => string) | null;
  /** The bundle's files, when the host supplies them (see `readBlob`). */
  bundleFileProvider: BundleFileProvider | null;
  /** Where `softn.storage.*` sends its operations; null for an app opened from a file. */
  storageEndpoint: string | null;
  /** The visitor identity sent with storage requests; undefined means this browser's, null none. */
  visitorToken: string | null | undefined;
}

export class AppNetwork {
  /** Network requests owned by this app, cancelled when the app closes. */
  private readonly controllers = new Set<AbortController>();
  private readonly assetResolver: ((path: string) => string) | null;
  private readonly bundleFileProvider: BundleFileProvider | null;
  private readonly storageEndpoint: string | null;
  private readonly visitorToken: string | null | undefined;

  constructor(
    private readonly gate: HostGate,
    options: AppNetworkOptions
  ) {
    this.assetResolver = options.assetResolver;
    this.bundleFileProvider = options.bundleFileProvider;
    this.storageEndpoint = options.storageEndpoint;
    this.visitorToken = options.visitorToken;
  }

  async fetch(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('net');
    const [url, optionsJson] = call.args;
    this.gate.checkNetHost(url);
    const options = optionsJson ? JSON.parse(optionsJson) : {};

    // Disable redirects to prevent allowlist bypass: a redirect from an
    // allowed host to an internal/disallowed host would skip checkNetHost.
    const requestedTimeout = Number(options.timeout);
    const timeoutMs = Number.isFinite(requestedTimeout)
      ? Math.max(1, Math.min(60_000, requestedTimeout))
      : 15_000;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    this.controllers.add(abortController);

    try {
      const resp = await fetch(url, {
        method: options.method || 'GET',
        headers: options.headers,
        // The bridge serialises the whole options object once, so a string
        // body arrives here as the string the script wrote; encoding it again
        // sent `"a=1"` as `"\"a=1\""` and no form or text endpoint could read
        // it. An object body is what the second encoding was for.
        body:
          typeof options.body === 'string'
            ? options.body || undefined
            : options.body
              ? JSON.stringify(options.body)
              : undefined,
        signal: abortController.signal,
        redirect: 'error',
        // The app's request, not the host's: no cookie or login of the page
        // it is drawn in goes with it, and the server is not told that page's
        // address. An app that signs in says so itself (an Authorization
        // header), or asks the host's backend (`softn.backend`).
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });

      const declaredHeader = resp.headers.get('content-length');
      const declaredLength = declaredHeader === null ? NaN : Number(declaredHeader);
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_NET_RESPONSE_BYTES
      ) {
        try {
          await resp.body?.cancel();
        } catch {
          // Preserve the response-size error if the stream was disturbed.
        }
        throw new Error('Network response is too large');
      }

      let body: string;
      if (resp.body) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        const textChunks: string[] = [];
        let total = 0;
        try {
          let next = await reader.read();
          while (!next.done) {
            if (next.value) {
              total += next.value.byteLength;
              if (total > MAX_NET_RESPONSE_BYTES) {
                try {
                  await reader.cancel();
                } catch {
                  // Preserve the response-size error if cancellation fails.
                }
                throw new Error('Network response is too large');
              }
              textChunks.push(decoder.decode(next.value, { stream: true }));
            }
            next = await reader.read();
          }
          textChunks.push(decoder.decode());
        } finally {
          reader.releaseLock();
        }
        body = textChunks.join('');
      } else {
        const bytes = await resp.arrayBuffer();
        if (bytes.byteLength > MAX_NET_RESPONSE_BYTES) {
          throw new Error('Network response is too large');
        }
        body = new TextDecoder().decode(bytes);
      }

      return {
        ok: resp.ok,
        status: resp.status,
        statusText: resp.statusText,
        body,
        headers: Object.fromEntries(resp.headers),
      };
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(abortController);
    }
  }

  /**
   * A page's `fetch('data.json')`: the app's own file, read where its
   * markup's `src` would find it, with no network and no permission, as an
   * image of its is. A bundle's file is a `blob:` address; a site's (page
   * mode) a path in the page's own folder. Anything else is not one of the
   * app's files, and is not found.
   */
  async readFile(call: PendingHostCall): Promise<unknown> {
    const notFound = { ok: false, status: 404, statusText: 'Not Found', body: '', headers: {} };
    const path = String(call.args[0] ?? '').replace(/[?#].*$/, '').replace(/^\.\//, '');
    const url = path && this.assetResolver ? this.assetResolver(path) : '';
    if (!url || !isOwnFileUrl(url)) return notFound;
    try {
      const resp = await fetch(url, { redirect: 'error' });
      if (!resp.ok) return { ...notFound, status: resp.status, statusText: resp.statusText };
      const body = await resp.text();
      if (body.length > MAX_NET_RESPONSE_BYTES) throw new Error('The file is too large');
      const type = resp.headers.get('content-type');
      return { ok: true, status: 200, statusText: 'OK', body, headers: type ? { 'content-type': type } : {} };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'The file could not be read' };
    }
  }

  /**
   * One of the app's own files as a Blob, for a model it ships: from the
   * bundle provider a host supplied, else where the app's markup would find
   * it (the `fetch('data.json')` rule above). Null when it has no such file.
   */
  async readBlob(path: string): Promise<Blob | null> {
    const clean = path.replace(/^\.\//, '');
    if (this.bundleFileProvider) {
      const data = await this.bundleFileProvider.readFile(clean);
      return data ? new Blob([data]) : null;
    }
    const url = this.assetResolver ? this.assetResolver(clean) : '';
    if (!url || !isOwnFileUrl(url)) return null;
    const resp = await fetch(url, { redirect: 'error' });
    return resp.ok ? resp.blob() : null;
  }

  // ── Server storage (softn.storage.*) ──

  /**
   * One operation against the app's own database on the directory that
   * published it. The runtime knows nothing of SQL: the script asks for
   * records and keys, the request carries the operation and its arguments as
   * JSON, and the server enforces its quotas and its limits. An app opened
   * from a file rather than from a directory has no endpoint and is told so,
   * in the same `{error}` shape every other refused call uses.
   */
  async storage(call: PendingHostCall): Promise<unknown> {
    this.gate.checkPermission('storage');
    const [op, argsJson] = call.args;
    if (!this.storageEndpoint) {
      return {
        error: 'This app has no server storage: it was not opened from a directory that publishes it.',
      };
    }
    let args: Record<string, unknown> = {};
    if (argsJson) {
      try {
        args = JSON.parse(argsJson) as Record<string, unknown>;
      } catch {
        return { error: 'The storage arguments are not valid JSON.' };
      }
    }
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 20_000);
    this.controllers.add(abortController);
    try {
      // The visitor's standing for collections that record who added what.
      // The host's token if it gave one; else this browser's; else none, and
      // such collections refuse with a message that says why.
      const token = this.visitorToken === undefined ? storageVisitorToken() : this.visitorToken;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['X-Visitor-Token'] = token;
      const resp = await fetch(this.storageEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ op, ...args }),
        signal: abortController.signal,
        credentials: 'same-origin',
      });
      const text = await resp.text();
      let json: { ok?: boolean; result?: unknown; error?: string; retryAfter?: number } | null = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (!resp.ok || !json || json.ok !== true) {
        return {
          error: json?.error ?? `The storage server answered ${resp.status}.`,
          status: resp.status,
          retryAfter: json?.retryAfter,
        };
      }
      return json.result ?? null;
    } catch (err) {
      if (abortController.signal.aborted) return { error: 'The storage request timed out.' };
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(abortController);
    }
  }

  /** An app that has closed no longer owns network work: its requests are aborted. */
  dispose(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}
