/**
 * Bridge connecting classic SoftN `.ui` apps (`SoftNRenderer` / `SoftNWithXDB`)
 * to an embedded sandboxed container backend (`manifest.backend` + `manifest.databases` SQLite)
 * via `@softn/container`'s `LocalBackendTransport`.
 *
 * This decouples frontend format from backend runtime: a `.ui` app can declare
 * `manifest.backend` (PHP, JS, TS, Rust, or Python) and `manifest.databases` (SQLite)
 * and call `softn.net.fetch('/api/...')` or `fetch('/api/...')` in SoftN Web,
 * Studio Preview, and Builder Preview, while external `https://...` calls continue
 * through `permission.json` + `AppNetwork.fetch`.
 */

import type { NetFetchHandler, NetFetchResult } from '@softn/core';
import type {
  BackendConfig,
  DatabaseConfig,
  LocalBackendTransport,
} from '@softn/container';
import { hostedContainerOptions } from './containerHost';

export interface UiBackendManifest {
  backend?: BackendConfig;
  databases?: DatabaseConfig[];
}

export interface UiBackendBridgeOptions {
  appId: string;
  manifest: Record<string, unknown> | null | undefined;
  textFiles?: Record<string, string>;
  binaryFiles?: Record<string, Uint8Array>;
  /** Optional raw `.softn` ZIP archive bytes (populates text & binary files lazily when the backend starts). */
  bundleBytes?: Uint8Array;
  /** Persist SQLite state in IndexedDB across reloads (true in SoftN Web, false in editor previews). */
  persistStorage?: boolean;
  /** Optional runtime base URL override; defaults to `hostedContainerOptions().runtimeUrl`. */
  runtimeUrl?: string;
  /** Worker vs inline isolation; defaults to `'worker'` in browsers. */
  isolation?: 'worker' | 'inline';
  onConsole?: (level: 'log' | 'info' | 'warn' | 'error', text: string) => void;
}

export interface UiBackendBridge {
  netFetchHandler: NetFetchHandler;
  dispose(): void;
}

/**
 * True when `manifest` declares an embedded sandboxed container backend (`manifest.backend`).
 */
export function hasEmbeddedBackend(manifest: Record<string, unknown> | null | undefined): boolean {
  if (!manifest || typeof manifest !== 'object') return false;
  const backend = manifest.backend as Record<string, unknown> | undefined;
  return Boolean(
    backend &&
      typeof backend === 'object' &&
      !Array.isArray(backend) &&
      typeof backend.runtime === 'string' &&
      backend.runtime.trim().length > 0 &&
      typeof backend.entry === 'string' &&
      backend.entry.trim().length > 0
  );
}

function extractBackendConfig(manifest: Record<string, unknown> | null | undefined): {
  backend: BackendConfig;
  databases: DatabaseConfig[];
} | null {
  if (!hasEmbeddedBackend(manifest)) return null;
  const backend = manifest!.backend as BackendConfig;
  const databases = Array.isArray(manifest!.databases)
    ? (manifest!.databases as DatabaseConfig[])
    : [];
  return { backend, databases };
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v !== undefined && v !== null) {
      out[k] = String(v);
    }
  }
  return out;
}

function hasHeader(headers: Record<string, string>, lowerName: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === lowerName);
}

/**
 * Create a lazy `NetFetchHandler` bridge for a `.ui` bundle that declares `manifest.backend`.
 * Returns `null` if the manifest does not declare an embedded sandboxed backend.
 */
export function createUiBackendBridge(options: UiBackendBridgeOptions): UiBackendBridge | null {
  const extracted = extractBackendConfig(options.manifest);
  if (!extracted) return null;

  const { backend, databases } = extracted;
  let disposed = false;
  let transportPromise: Promise<{
    transport: LocalBackendTransport;
    match: typeof import('@softn/container').matchBackendTarget;
    routing: ReturnType<typeof import('@softn/container').buildBackendRoutingConfig>;
    statusTextFor: typeof import('@softn/container').statusTextFor;
  }> | null = null;
  let liveTransport: LocalBackendTransport | null = null;

  // Quick pre-check before starting the backend worker so unrelated external HTTPS calls
  // (like `https://api.github.com/...`) don't boot the PHP/JS/SQLite worker unnecessarily.
  const routes = Array.isArray(backend.routes) && backend.routes.length > 0
    ? backend.routes
    : (backend.mode ?? (backend.runtime === 'php' ? 'ssr' : 'api')) === 'ssr'
      ? ['/']
      : ['/api/', '/ws'];
  const interceptOrigins = (backend.interceptOrigins ?? []).map((o) => o.replace(/\/+$/, '').toLowerCase());

  function looksLikeBackendUrl(rawUrl: string): boolean {
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) return false;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
      const lower = trimmed.toLowerCase();
      return interceptOrigins.some((origin) => lower.startsWith(origin));
    }
    const cleanPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return routes.some((prefix) => {
      if (prefix === '/') return true;
      const norm = prefix.startsWith('/') ? prefix : `/${prefix}`;
      const bare = norm.endsWith('/') ? norm.slice(0, -1) : norm;
      return cleanPath === bare || cleanPath.startsWith(norm) || cleanPath.startsWith(`${bare}?`);
    });
  }

  async function ensureTransport() {
    if (transportPromise) return transportPromise;
    transportPromise = (async () => {
      const container = await import('@softn/container');
      const routing = container.buildBackendRoutingConfig(backend);
      const hosted = hostedContainerOptions();
      const runtimeUrl = options.runtimeUrl ?? hosted.runtimeUrl;
      const cleanId = options.appId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'ui_app';
      const textFiles: Record<string, string> = {};
      const binaryFiles: Record<string, Uint8Array> = {};
      if (options.bundleBytes && options.bundleBytes.byteLength > 0) {
        const archive = await container.ContainerArchive.open(options.bundleBytes);
        const exported = archive.exportBackendVfs();
        Object.assign(textFiles, exported.textFiles);
        Object.assign(binaryFiles, exported.binaryFiles);
      }
      if (options.textFiles) {
        for (const [k, v] of Object.entries(options.textFiles)) textFiles[k] = v;
      }
      if (options.binaryFiles) {
        for (const [k, v] of Object.entries(options.binaryFiles)) binaryFiles[k] = v;
      }
      const transport = new container.LocalBackendTransport({
        appId: options.appId,
        storagePrefix: `softn-ui-backend:${cleanId}:`,
        persistStorage: options.persistStorage ?? false,
        backend,
        databases,
        textFiles,
        binaryFiles,
        runtimeUrl,
        isolation: options.isolation ?? 'worker',
        onConsole: options.onConsole,
      });
      if (disposed) {
        transport.dispose();
        throw new Error('Backend bridge was disposed while starting.');
      }
      liveTransport = transport;
      await transport.ready;
      return {
        transport,
        match: container.matchBackendTarget,
        routing,
        statusTextFor: container.statusTextFor,
      };
    })();
    return transportPromise;
  }

  const netFetchHandler: NetFetchHandler = async (
    url: string,
    reqOptions: Record<string, unknown>
  ): Promise<NetFetchResult | null> => {
    if (disposed || !looksLikeBackendUrl(url)) return null;

    const { transport, match, routing, statusTextFor } = await ensureTransport();
    const method = typeof reqOptions.method === 'string' && reqOptions.method.trim()
      ? reqOptions.method.trim().toUpperCase()
      : 'GET';

    const target = match(url, routing, { method });
    if (!target) return null;

    const headers = normalizeHeaders(reqOptions.headers);
    let body: string | Uint8Array | undefined;
    if (reqOptions.body !== undefined && reqOptions.body !== null) {
      if (typeof reqOptions.body === 'string' || reqOptions.body instanceof Uint8Array) {
        body = reqOptions.body;
      } else {
        body = JSON.stringify(reqOptions.body);
        if (!hasHeader(headers, 'content-type')) {
          headers['content-type'] = 'application/json';
        }
      }
    }

    const resp = await transport.fetch({
      method,
      path: target.path,
      query: target.query,
      headers,
      body,
      url,
    });

    const respHeaders: Record<string, string> = {};
    for (const [k, v] of resp.headers) {
      const lower = k.toLowerCase();
      respHeaders[lower] = respHeaders[lower] ? `${respHeaders[lower]}, ${v}` : v;
    }

    const textBody = new TextDecoder().decode(resp.body);
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      statusText: resp.statusText ?? statusTextFor(resp.status),
      headers: respHeaders,
      body: textBody,
    };
  };

  return {
    netFetchHandler,
    dispose() {
      disposed = true;
      liveTransport?.dispose();
      liveTransport = null;
      transportPromise = null;
    },
  };
}
