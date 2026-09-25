/**
 * A bundle's network access on the desktop, made by the native side.
 *
 * The webview's CSP does not open `connect-src` to arbitrary hosts, so the
 * page's own `fetch` cannot be what `softn.net.fetch` or a remote `import`
 * uses. Both go to the `net_fetch` command instead (src-tauri/src/net.rs),
 * which makes the request with the granted `net` entry and refuses a
 * destination or a redirect that entry does not permit.
 *
 * Supplying the renderer's `netFetchHandler` MOVES the capability, checks
 * included: the script runtime skips its own `net` check and host allowlist
 * when a handler is present. So this handler repeats both, in the runtime's
 * words, before anything is sent — the native side's check is the second
 * line, not the only one.
 */

import {
  describeNetDestination,
  type NetFetchHandler,
  type NetFetchResult,
  type PermissionConfig,
} from '@softn/core';

export type NativeInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** The runtime's refusal for a `net` the config does not grant, word for word. */
function refuseUngranted(config: PermissionConfig): Error | null {
  if (config.consentPending) {
    return new Error(
      'net access not permitted yet: this app has asked for it and you have not allowed it. ' +
        'Choose Allow in the permission bar at the top of the app to grant it.'
    );
  }
  if (config.permissions?.net?.enabled !== true) {
    return new Error('Network access not permitted. Add net.enabled to permission.json');
  }
  return null;
}

/** The `net` entry as the native side receives it: only its two rules. */
function nativePolicy(config: PermissionConfig): { allowHttp: boolean; allowedHosts: string[] } {
  const net = config.permissions?.net;
  return {
    allowHttp: net?.allow_http === true,
    allowedHosts: Array.isArray(net?.allowed_hosts)
      ? net!.allowed_hosts.filter((host): host is string => typeof host === 'string')
      : [],
  };
}

/** Header values as strings; anything else the script put there is dropped. */
function headerRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(value as Record<string, unknown>)) {
    if (typeof header === 'string' || typeof header === 'number' || typeof header === 'boolean') {
      headers[name] = String(header);
    }
  }
  return headers;
}

/**
 * `softn.net.fetch` for a bundle running under `config`: the runtime's own
 * checks, then the request through the native side.
 */
export function createNativeNetFetch(config: PermissionConfig, invoke: NativeInvoke): NetFetchHandler {
  return async (url, options) => {
    const refused = refuseUngranted(config);
    if (refused) throw refused;
    const verdict = describeNetDestination(url, config.permissions.net);
    if (!verdict.allowed) throw new Error(verdict.reason);

    const opts = options ?? {};
    const timeout = Number(opts.timeout);
    const reply = (await invoke('net_fetch', {
      request: {
        url,
        method: typeof opts.method === 'string' ? opts.method : 'GET',
        headers: headerRecord(opts.headers),
        // As the runtime sends it: a string body as written, an object body
        // as JSON, and nothing for an empty one.
        body:
          typeof opts.body === 'string'
            ? opts.body || undefined
            : opts.body
              ? JSON.stringify(opts.body)
              : undefined,
        timeoutMs: Number.isFinite(timeout) ? timeout : undefined,
        ...nativePolicy(config),
      },
    })) as NetFetchResult;
    return reply;
  };
}

/**
 * A `fetch` for remote imports, through the same command. The import
 * resolver has already judged the URL against the granted config; this adds
 * the native judgement and makes the request under the CSP. Statuses the
 * Fetch API forbids a body for are given none.
 */
export function createNativeFetch(config: PermissionConfig, invoke: NativeInvoke): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (init?.signal?.aborted) throw new DOMException('The request was aborted', 'AbortError');
    const reply = (await invoke('net_fetch', {
      request: { url, method: 'GET', ...nativePolicy(config) },
    })) as NetFetchResult;
    if (init?.signal?.aborted) throw new DOMException('The request was aborted', 'AbortError');
    const bodyless = [101, 204, 205, 304].includes(reply.status);
    return new Response(bodyless ? null : reply.body, {
      status: reply.status,
      statusText: reply.statusText ?? '',
      headers: { 'content-type': reply.headers?.['content-type'] ?? 'text/plain' },
    });
  }) as typeof fetch;
}
