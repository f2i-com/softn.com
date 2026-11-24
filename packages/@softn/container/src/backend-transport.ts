/**
 * Transport-Agnostic Frontend <-> Backend Boundary & Container Cookie Jar.
 *
 * Designed from day one so:
 * 1. A SoftN app can run its entire frontend + backend + XDB SQLite locally in-browser
 *    on WebAssembly (`LocalBackendTransport`, backed by an isolated Backend Worker).
 * 2. Later, FormLogic can swap in a `RemoteBackendTransport` (or custom `BackendTransport`)
 *    running the backend in a separate multi-user sandbox with ZERO changes to app code.
 */

import { VIRTUAL_ORIGIN } from './archive';
import { bytesWithin } from './capped-body';
import type {
  BackendConfig,
  BackendHttpRequest,
  BackendHttpResponse,
  BackendTransport,
  BackendWsEvent,
  BackendWsHandle,
} from './types';

export interface StoredCookie {
  name: string;
  value: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
  expiresAt?: number; // epoch ms
}

const MAX_JAR_COOKIES = 256;
const MAX_JAR_COOKIE_BYTES = 4096;
const MAX_JAR_TOTAL_BYTES = 64 * 1024;
const BLOCKED_COOKIE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function cookieByteLength(c: Pick<StoredCookie, 'name' | 'value' | 'path'>): number {
  return (c.name.length + c.value.length + c.path.length) * 2;
}

function normalizeCookiePath(raw: string): string {
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const out: string[] = [];
  for (const seg of withSlash.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return '/' + out.join('/');
}

/**
 * Strictly container-scoped RFC-6265 cookie jar.
 * Never touches `document.cookie` of the embedding host page!
 */
export class VirtualCookieJar {
  private readonly cookies = new Map<string, StoredCookie>();
  private totalBytes = 0;

  private key(name: string, path: string): string {
    return `${path}\0${name}`;
  }

  private removeKey(k: string): boolean {
    const existing = this.cookies.get(k);
    if (!existing) return false;
    this.totalBytes = Math.max(0, this.totalBytes - cookieByteLength(existing));
    this.cookies.delete(k);
    return true;
  }

  private putCookie(cookie: StoredCookie): boolean {
    if (/[\u0000-\u001f\u007f;]/.test(cookie.name) || /[\u0000-\u001f\u007f;]/.test(cookie.value) || /[\u0000-\u001f\u007f]/.test(cookie.path)) {
      return false;
    }
    const size = cookieByteLength(cookie);
    if (size > MAX_JAR_COOKIE_BYTES) return false;
    const k = this.key(cookie.name, cookie.path);
    const existing = this.cookies.get(k);
    const prevSize = existing ? cookieByteLength(existing) : 0;
    // Prune expired entries before checking caps.
    const now = Date.now();
    if (!existing && (this.cookies.size >= MAX_JAR_COOKIES || this.totalBytes + size > MAX_JAR_TOTAL_BYTES)) {
      for (const [ek, ec] of this.cookies) {
        if (ec.expiresAt !== undefined && ec.expiresAt <= now) {
          this.removeKey(ek);
        }
      }
    }
    // Evict oldest non-HttpOnly cookies first if still over cap (preserving HttpOnly session cookies).
    if ((!existing && this.cookies.size >= MAX_JAR_COOKIES) || this.totalBytes - prevSize + size > MAX_JAR_TOTAL_BYTES) {
      for (const [ek, ec] of this.cookies) {
        if (ek === k || ec.httpOnly) continue;
        this.removeKey(ek);
        if ((existing || this.cookies.size < MAX_JAR_COOKIES) && this.totalBytes - prevSize + size <= MAX_JAR_TOTAL_BYTES) {
          break;
        }
      }
    }
    if (!existing && this.cookies.size >= MAX_JAR_COOKIES) return false;
    if (this.totalBytes - prevSize + size > MAX_JAR_TOTAL_BYTES) return false;
    if (existing) this.cookies.delete(k);
    this.cookies.set(k, cookie);
    this.totalBytes = this.totalBytes - prevSize + size;
    return true;
  }

  /** Ingest all `Set-Cookie` headers from a backend response. Returns `true` when jar state changed. */
  ingestResponseHeaders(headers: ReadonlyArray<[string, string]>): boolean {
    let changed = false;
    for (const [k, v] of headers) {
      if (k.toLowerCase() === 'set-cookie') {
        if (this.setCookieHeader(v)) changed = true;
      }
    }
    return changed;
  }

  /** Parse and store a single `Set-Cookie` header value. Returns `true` if jar state changed. */
  setCookieHeader(headerValue: string): boolean {
    if (headerValue.length > MAX_JAR_COOKIE_BYTES * 2) return false;
    const parts = headerValue.split(';').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return false;
    const eq = parts[0].indexOf('=');
    if (eq <= 0) return false;
    const name = parts[0].slice(0, eq).trim();
    const value = parts[0].slice(eq + 1).trim();
    if (!name || BLOCKED_COOKIE_KEYS.has(name)) return false;

    let path = '/';
    let httpOnly = false;
    let secure = false;
    let sameSite: string | undefined;
    let expiresAt: number | undefined;

    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i];
      const aEq = attr.indexOf('=');
      const attrName = (aEq >= 0 ? attr.slice(0, aEq) : attr).trim().toLowerCase();
      const attrVal = aEq >= 0 ? attr.slice(aEq + 1).trim() : '';

      if (attrName === 'path' && attrVal) {
        path = normalizeCookiePath(attrVal);
      } else if (attrName === 'httponly') {
        httpOnly = true;
      } else if (attrName === 'secure') {
        secure = true;
      } else if (attrName === 'samesite') {
        sameSite = attrVal;
      } else if (attrName === 'max-age') {
        const secs = Number(attrVal);
        if (Number.isFinite(secs)) {
          expiresAt = secs <= 0 ? 0 : Date.now() + secs * 1000;
        }
      } else if (attrName === 'expires' && expiresAt === undefined) {
        const parsed = Date.parse(attrVal);
        if (!Number.isNaN(parsed)) {
          expiresAt = parsed;
        }
      }
    }

    const k = this.key(name, path);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      return this.removeKey(k);
    }
    return this.putCookie({ name, value, path, httpOnly, secure, sameSite, expiresAt });
  }

  /** Build the `Cookie` request header for `pathname` (includes `HttpOnly` cookies for backend requests). */
  getCookieHeader(pathname: string, includeHttpOnly = true): string {
    const now = Date.now();
    const cleanPath = normalizeCookiePath(pathname);
    const matched: StoredCookie[] = [];

    for (const [k, c] of this.cookies) {
      if (c.expiresAt !== undefined && c.expiresAt <= now) {
        this.removeKey(k);
        continue;
      }
      if (!includeHttpOnly && c.httpOnly) continue;
      if (
        c.path === '/' ||
        cleanPath === c.path ||
        cleanPath.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`)
      ) {
        matched.push(c);
      }
    }

    // Longer paths take precedence (RFC 6265 §5.4)
    matched.sort((a, b) => b.path.length - a.path.length);
    return matched.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** Parse cookies for `pathname` into a `{ name: decodedValue }` map (for PHP `$_COOKIE`). */
  getCookieMap(pathname: string): Record<string, string> {
    const hdr = this.getCookieHeader(pathname, true);
    return parseCookieHeader(hdr);
  }

  /** Serialize all non-expired cookies into a compact JSON string for IndexedDB persistence. */
  serialize(): string {
    const now = Date.now();
    const list: StoredCookie[] = [];
    for (const [k, c] of this.cookies) {
      if (c.expiresAt !== undefined && c.expiresAt <= now) {
        this.removeKey(k);
        continue;
      }
      list.push(c);
    }
    return JSON.stringify(list);
  }

  /** Restore previously serialized cookies (skipping expired entries). */
  hydrate(json: string): void {
    if (json.length > MAX_JAR_TOTAL_BYTES * 2) return;
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!Array.isArray(parsed)) return;
      const now = Date.now();
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const c = item as Partial<StoredCookie>;
        if (typeof c.name !== 'string' || typeof c.value !== 'string' || BLOCKED_COOKIE_KEYS.has(c.name)) continue;
        if (typeof c.expiresAt === 'number' && c.expiresAt <= now) continue;
        const path = typeof c.path === 'string' && c.path.startsWith('/') ? normalizeCookiePath(c.path) : '/';
        this.putCookie({
          name: c.name,
          value: c.value,
          path,
          httpOnly: Boolean(c.httpOnly),
          secure: Boolean(c.secure),
          sameSite: typeof c.sameSite === 'string' ? c.sameSite : undefined,
          expiresAt: typeof c.expiresAt === 'number' ? c.expiresAt : undefined,
        });
      }
    } catch {
      // Ignore malformed persisted cookie payload
    }
  }

  clear(): void {
    this.cookies.clear();
    this.totalBytes = 0;
  }
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k || BLOCKED_COOKIE_KEYS.has(k)) continue;
    try {
      out[k] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export interface BackendRoutingConfig {
  enabled: boolean;
  mode: 'api' | 'ssr';
  routes: string[];
  interceptOrigins: string[];
}

export function buildBackendRoutingConfig(backend: BackendConfig | undefined): BackendRoutingConfig | undefined {
  if (!backend) return undefined;
  const mode = backend.mode ?? (backend.runtime === 'php' ? 'ssr' : 'api');
  const routes = backend.routes && backend.routes.length > 0
    ? backend.routes
    : mode === 'ssr'
      ? ['/']
      : ['/api/', '/ws'];
  const interceptOrigins = (backend.interceptOrigins ?? []).map((o) => o.replace(/\/+$/, '').toLowerCase());
  return {
    enabled: true,
    mode,
    routes,
    interceptOrigins,
  };
}

export interface ParsedBackendTarget {
  /** Normalized pathname starting with `/`. */
  path: string;
  /** Raw query string without leading `?`. */
  query: string;
  /** Matched origin (either virtual origin or an intercepted origin). */
  origin: string;
}

/**
 * Determine whether a URL from the sandboxed frontend (`fetch`, `XHR`, `WebSocket`,
 * navigation, or `<form>`) should be routed to the container's `BackendTransport`.
 *
 * Returns the normalized `{ path, query, origin }` if it targets the backend, or `null`
 * if it should be handled as a static VFS file or external network request.
 */
export function matchBackendTarget(
  rawUrl: string,
  routing: BackendRoutingConfig | undefined,
  options?: {
    baseUrl?: string;
    isStaticVfsFile?: (relPath: string) => boolean;
    method?: string;
  }
): ParsedBackendTarget | null {
  if (!routing || !routing.enabled) return null;
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('javascript:')) {
    return null;
  }

  let parsed: URL;
  try {
    // Support ws:// and wss:// transparently for WebSocket routing
    const normalizedScheme = /^wss:/i.test(trimmed)
      ? `https:${trimmed.slice(4)}`
      : /^ws:/i.test(trimmed)
        ? `http:${trimmed.slice(3)}`
        : trimmed;
    parsed = new URL(normalizedScheme, options?.baseUrl || `${VIRTUAL_ORIGIN}/`);
  } catch {
    return null;
  }

  const originLower = parsed.origin.toLowerCase();
  const pathname = parsed.pathname || '/';
  const query = parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search;

  // 1. Intercepted external origin (e.g. `http://localhost:8080/api/v1/health` for pit_software!)
  if (routing.interceptOrigins.includes(originLower)) {
    return { path: pathname, query, origin: parsed.origin };
  }

  // 2. Virtual container origin (`https://app.softn.local/...`)
  if (originLower !== VIRTUAL_ORIGIN.toLowerCase()) {
    return null;
  }

  // Explicit `.php` / `.phtml` scripts always route to backend in SSR mode
  if (routing.mode === 'ssr' && /\.(?:php|phtml)$/i.test(pathname)) {
    return { path: pathname, query, origin: VIRTUAL_ORIGIN };
  }

  // In SSR mode, non-GET/HEAD requests on virtual origin target the backend (e.g. form POSTs)
  const method = (options?.method ?? 'GET').toUpperCase();
  if (routing.mode === 'ssr' && method !== 'GET' && method !== 'HEAD') {
    return { path: pathname, query, origin: VIRTUAL_ORIGIN };
  }

  // Check declared route prefixes
  for (const prefix of routing.routes) {
    if (prefix === '/' || prefix === '/*') {
      // In SSR mode, static frontend files (CSS/JS/images/fonts) serve from VFS directly unless missing
      const rel = pathname.replace(/^\/+/, '');
      if (rel && options?.isStaticVfsFile?.(rel) && !/\.html?$/i.test(rel)) {
        return null;
      }
      return { path: pathname, query, origin: VIRTUAL_ORIGIN };
    }
    const cleanPrefix = prefix.startsWith('/') ? prefix : `/${prefix}`;
    const bare = cleanPrefix.endsWith('/') ? cleanPrefix.slice(0, -1) : cleanPrefix;
    if (pathname === bare || pathname.startsWith(cleanPrefix) || pathname.startsWith(`${bare}/`)) {
      return { path: pathname, query, origin: VIRTUAL_ORIGIN };
    }
  }

  return null;
}

const STATUS_TEXTS: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export function statusTextFor(status: number): string {
  return STATUS_TEXTS[status] ?? 'OK';
}

export const FORBIDDEN_FETCH_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'content-length',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'transfer-encoding',
  'cookie',
  'accept-encoding',
  'forwarded',
  'x-real-ip',
  'x-http-method-override',
  'x-method-override',
  'x-original-url',
  'x-rewrite-url',
]);

export const ALLOWED_BACKEND_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

const DEFAULT_REMOTE_TIMEOUT_MS = 30_000;
const MAX_REMOTE_RESPONSE_BYTES = 32 * 1024 * 1024;

function validateRemoteBackendPath(baseUrl: string, rawInputPath: string): { cleanPath: string; targetUrl: string } {
  const cleanPath = rawInputPath.startsWith('/') ? rawInputPath : `/${rawInputPath}`;
  if (
    cleanPath.startsWith('//') ||
    cleanPath.includes('\\') ||
    cleanPath.includes('\0') ||
    cleanPath.includes('?') ||
    cleanPath.includes('#') ||
    /[\u0000-\u001f\u007f]/.test(cleanPath) ||
    /(?:^|\/)\.\.(?:\/|$)/.test(cleanPath) ||
    /%(?:2e|2f|5c|00|25)/i.test(cleanPath)
  ) {
    throw new Error(`Invalid backend request path: ${rawInputPath}`);
  }
  const fallbackOrigin =
    typeof location !== 'undefined' && location.origin && location.origin !== 'null'
      ? location.origin
      : 'https://softn.invalid';
  const resolvedBase = new URL(baseUrl ? `${baseUrl}/` : '/', fallbackOrigin);
  const resolvedTarget = new URL(baseUrl ? `${baseUrl}${cleanPath}` : cleanPath, fallbackOrigin);
  const basePrefix = resolvedBase.pathname.endsWith('/') ? resolvedBase.pathname : `${resolvedBase.pathname}/`;
  const targetWithSlash = resolvedTarget.pathname.endsWith('/') ? resolvedTarget.pathname : `${resolvedTarget.pathname}/`;
  if (resolvedTarget.origin !== resolvedBase.origin || !targetWithSlash.startsWith(basePrefix)) {
    throw new Error(`Backend request path escapes configured baseUrl: ${rawInputPath}`);
  }
  return { cleanPath, targetUrl: baseUrl ? `${baseUrl}${cleanPath}` : cleanPath };
}

/**
 * Reference remote `BackendTransport` for multi-user deployments (`softn-server` / FormLogic):
 * forwards container frontend requests to a separate remote ZIPP-sandboxed backend URL
 * with identical request/response/WS contracts and zero app code changes.
 */
export class RemoteBackendTransport implements BackendTransport {
  readonly kind = 'remote' as const;
  readonly ready: Promise<void> = Promise.resolve();
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly credentials: RequestCredentials;
  private readonly timeoutMs: number;
  private readonly sockets = new Set<WebSocket>();
  private disposed = false;

  constructor(options: {
    baseUrl: string;
    headers?: Record<string, string>;
    credentials?: RequestCredentials;
    timeoutMs?: number;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.extraHeaders = options.headers ?? {};
    this.credentials = options.credentials ?? 'same-origin';
    this.timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_REMOTE_TIMEOUT_MS;
  }

  async fetch(req: BackendHttpRequest): Promise<BackendHttpResponse> {
    if (this.disposed) {
      throw new Error('RemoteBackendTransport is disposed');
    }
    const method = (req.method || 'GET').toUpperCase();
    if (!ALLOWED_BACKEND_METHODS.has(method)) {
      throw new Error(`Disallowed HTTP method: ${method}`);
    }
    const { targetUrl } = validateRemoteBackendPath(this.baseUrl, req.path);
    const query = req.query ? String(req.query) : '';
    if (query && (query.includes('#') || /[\u0000-\u001f\u007f]/.test(query))) {
      throw new Error('Invalid backend request query');
    }
    const url = query ? `${targetUrl}?${query}` : targetUrl;
    const headers: Record<string, string> = {};
    // Apply guest-supplied headers first (filtering forbidden & host identity headers),
    // then apply trusted host `extraHeaders` last so guest headers can never overwrite them.
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const lower = k.toLowerCase();
      if (
        !/^[a-z0-9-]+$/.test(lower) ||
        FORBIDDEN_FETCH_REQUEST_HEADERS.has(lower) ||
        lower.startsWith('sec-') ||
        lower.startsWith('proxy-') ||
        lower.startsWith('x-forwarded-') ||
        lower.startsWith('x-formlogic') ||
        /[\r\n\0]/.test(v)
      ) {
        continue;
      }
      headers[lower] = v;
    }
    for (const [k, v] of Object.entries(this.extraHeaders)) {
      const lower = k.toLowerCase();
      if (FORBIDDEN_FETCH_REQUEST_HEADERS.has(lower) || lower.startsWith('sec-') || lower.startsWith('proxy-')) {
        continue;
      }
      headers[lower] = v;
    }
    let body: BodyInit | undefined;
    if (method !== 'GET' && method !== 'HEAD' && req.body !== undefined) {
      if (typeof req.body === 'string') {
        body = req.body;
      } else {
        const copy = new Uint8Array(req.body.byteLength);
        copy.set(req.body);
        body = copy;
      }
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    let resp: Response;
    let buf: Uint8Array;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body,
        credentials: this.credentials,
        redirect: 'manual',
        ...(controller ? { signal: controller.signal } : {}),
      });
      buf = await bytesWithin(resp, MAX_REMOTE_RESPONSE_BYTES);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    const outHeaders: Array<[string, string]> = [];
    resp.headers.forEach((v, k) => outHeaders.push([k, v]));
    return {
      status: resp.status,
      statusText: resp.statusText || statusTextFor(resp.status),
      headers: outHeaders,
      body: buf,
    };
  }

  openWebSocket(
    path: string,
    protocols: string[],
    onEvent: (event: BackendWsEvent) => void
  ): BackendWsHandle {
    if (this.disposed) {
      throw new Error('RemoteBackendTransport is disposed');
    }
    const qIdx = path.indexOf('?');
    const pathPart = qIdx >= 0 ? path.slice(0, qIdx) : path;
    const queryPart = qIdx >= 0 ? path.slice(qIdx + 1) : '';
    if (queryPart && (queryPart.includes('#') || /[\u0000-\u001f\u007f]/.test(queryPart))) {
      throw new Error('Invalid backend WebSocket query');
    }
    const { cleanPath } = validateRemoteBackendPath(this.baseUrl, pathPart);
    const wsBase = this.baseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    const wsUrl = queryPart ? `${wsBase}${cleanPath}?${queryPart}` : `${wsBase}${cleanPath}`;
    const ws = protocols.length > 0 ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    this.sockets.add(ws);
    ws.onopen = () => onEvent({ type: 'open', protocol: ws.protocol });
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') onEvent({ type: 'message', data: e.data });
      else if (e.data instanceof ArrayBuffer) onEvent({ type: 'message', data: new Uint8Array(e.data) });
    };
    ws.onerror = () => onEvent({ type: 'error', message: 'WebSocket error' });
    ws.onclose = (e) => {
      this.sockets.delete(ws);
      onEvent({ type: 'close', code: e.code, reason: e.reason, wasClean: e.wasClean });
    };
    return {
      send(data) {
        if (ws.readyState === 1) ws.send(data);
      },
      close(code, reason) {
        try {
          if (code !== undefined) ws.close(code, reason);
          else ws.close();
        } catch {
          // ignore
        }
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const ws of this.sockets) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.sockets.clear();
  }
}
