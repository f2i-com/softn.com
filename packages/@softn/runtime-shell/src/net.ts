/**
 * What every host that runs one bundle asks of the network on the bundle's
 * behalf, decided once: whether a remote `import` may be fetched, how a
 * response body is read without letting it grow past a bound, and which sync
 * server the manifest names.
 *
 * Each of these had a copy per host, and the copies drifted. The web runtime
 * and the single-app shell judged a remote import by scheme and host list
 * alone, the desktop loader the same, while `softn.net.fetch` to the same
 * address was refused by core as this computer or its local network: an
 * `import "https://192.168.1.1/x.js"` reached a router's admin page that a
 * fetch could not. The web runtime appended `/sync` to the whole server URL,
 * query and all, and passed any scheme; the loader made `https://h` into
 * `wss://h//sync`. One copy now, judged by core's own rule.
 */

import { describeNetDestination, type EgressVerdict, type PermissionConfig } from '@softn/core';

// ── Remote imports ───────────────────────────────────────────────────

/**
 * Whether a bundle running under `config` may fetch `url` as code.
 *
 * A remote import is network access as surely as `softn.net.fetch` is, so it
 * needs the same two things: `net` declared and granted (a withheld config,
 * while the consent bar is unanswered, has none), and a destination core's
 * rule permits — scheme, `allow_http`, `allowed_hosts`, and nothing on this
 * computer or its local network unless the bundle names that host. Missing
 * permission.json is deny-by-default too.
 */
export function judgeRemoteImport(url: string, config: PermissionConfig | null | undefined): EgressVerdict {
  const permissions = config?.permissions;
  const net = permissions && typeof permissions === 'object' ? permissions.net : undefined;
  if (!net || typeof net !== 'object' || net.enabled !== true) {
    return {
      allowed: false,
      reason:
        'Network access not permitted: a remote import needs { "net": { "enabled": true } } in permission.json, allowed by the person running the app',
    };
  }
  return describeNetDestination(url, net);
}

// ── Bounded bodies ───────────────────────────────────────────────────

export interface BoundedReadOptions {
  /**
   * Told when each piece of the body arrives. Returning `false` stops the
   * read: the body is cancelled and the read gives null, as for one past the
   * bound. A stall deadline is reset from here, and a disposed resolver stops.
   */
  onChunk?: () => boolean | void;
  /** Handed the reader while it is in use, so its owner can cancel it; returns the release. */
  onReader?: (reader: ReadableStreamDefaultReader<Uint8Array>) => () => void;
}

/**
 * A response body, read whole only if it stays within `limit` bytes.
 *
 * Content-Length is a claim, so the bound is held against the bytes as they
 * arrive, and a chunked body, which declares nothing, is held to it too; the
 * rest is never downloaded. Null when the body was past the bound (declared or
 * actual) or `onChunk` stopped it; the caller says why in its own words, since
 * each has its own ("larger than the 32 MB limit", "File exceeds size limit").
 */
export async function readBoundedBody(
  response: Response,
  limit: number,
  options: BoundedReadOptions = {}
): Promise<Uint8Array | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) {
    await cancelBody(response);
    return null;
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (options.onChunk?.() === false) return null;
    return bytes.byteLength > limit ? null : bytes;
  }
  const reader = response.body.getReader();
  const release = options.onReader?.(reader);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (options.onChunk?.() === false || size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    release?.();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** Stop downloading a body nothing will read. Best effort: it may already be locked or aborted. */
export async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already locked by a reader, or aborted with its request.
  }
}

// ── The manifest's sync server ───────────────────────────────────────

/** `config.server` in a manifest, as the bundle wrote it: nothing in it is trusted to be the right type. */
export interface BundleServerConfig {
  url?: unknown;
  token?: unknown;
  /** The spelling older desktop bundles used. */
  auth_token?: unknown;
  collections?: unknown;
}

/** What a host hands the renderer for server sync. */
export interface ServerSyncSettings {
  serverUrl?: string;
  serverToken?: string;
  serverCollections?: string[];
}

const SERVER_SCHEMES: Record<string, string> = { 'http:': 'ws:', 'https:': 'wss:', 'ws:': 'ws:', 'wss:': 'wss:' };

/**
 * The WebSocket address and credentials for the sync server a manifest names.
 *
 * `http` becomes `ws` and `https` becomes `wss`; the path gets `/sync` after
 * it unless it already ends there, with the query kept and the fragment
 * dropped, so `https://h`, `https://h/` and `https://h/sync/` are all
 * `wss://h/sync` and `https://h/api?t=a` is `wss://h/api/sync?t=a`. Any other
 * scheme, or an address that is not one, names no server: the app opens and
 * runs unsynced, and `warn` says why. Opening still needs the bundle to
 * declare `sync` and the person to allow it (core's xdb-bindings).
 *
 * The token is `token`, else the older `auth_token`.
 */
export function resolveServerConfig(
  config?: BundleServerConfig | null,
  warn: (message: string) => void = (message) => console.warn(message)
): ServerSyncSettings {
  if (!config || typeof config !== 'object') return {};
  const token =
    typeof config.token === 'string' ? config.token : typeof config.auth_token === 'string' ? config.auth_token : undefined;
  const collections = Array.isArray(config.collections)
    ? config.collections.filter((name): name is string => typeof name === 'string')
    : undefined;
  let serverUrl: string | undefined;
  if (config.url !== undefined) {
    serverUrl = syncSocketUrl(config.url);
    if (serverUrl === undefined) {
      warn(
        `[SoftN] Server sync not started: config.server.url in manifest.json must be an http, https, ws or wss address (it is ${JSON.stringify(config.url)}).`
      );
    }
  }
  return { serverUrl, serverToken: token, serverCollections: collections };
}

function syncSocketUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  const scheme = SERVER_SCHEMES[url.protocol];
  if (!scheme) return undefined;
  url.protocol = scheme;
  // Set once, from a string: emptying the path and then appending to it is
  // how `https://h` became `wss://h//sync`.
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/sync') ? path : `${path}/sync`;
  url.hash = '';
  return url.href;
}
