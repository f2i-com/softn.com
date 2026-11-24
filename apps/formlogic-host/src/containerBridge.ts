/**
 * Pure v2 Web Container helpers for the FormLogic sandboxed app frame.
 *
 * Kept free of DOM and Vite-only imports so Node 24 can execute and test it
 * directly alongside the other pure modules of `apps/formlogic-host/src/`.
 */

export interface ContainerBackendRequest {
  method: string;
  path: string;
  query?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  url?: string;
}

export interface ContainerBackendResponse {
  status: number;
  statusText?: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

export interface ContainerBackendTransport {
  readonly kind: 'remote';
  readonly ready: Promise<void>;
  fetch(req: ContainerBackendRequest): Promise<ContainerBackendResponse>;
  dispose(): void;
}

export type FrameBackendCall = (action: string, input: Record<string, unknown>) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether an `init` payload describes a SoftN v2 Web Container rather than a v1 `.ui` app:
 * explicit `"engine": 2`, `"container": true`, a `backend` declaration, or a zero-config
 * HTML archive with no `manifest.json`.
 */
export function isContainerBundle(manifest: unknown, files: ReadonlyMap<string, string>): boolean {
  if (isRecord(manifest)) {
    const main = typeof manifest.main === 'string' ? manifest.main : '';
    const isUiMain = /\.ui$/i.test(main);
    if ((manifest.engine === 2 || manifest.container === true) && !isUiMain) return true;
    if (isRecord(manifest.backend) && !isUiMain) return true;
  }
  if (!files.has('manifest.json')) {
    if (files.has('index.html') || files.has('app.html')) return true;
    for (const key of files.keys()) {
      if (!key.includes('/') && /\.html?$/i.test(key)) return true;
    }
  }
  return false;
}

function decodeBase64(text: string): Uint8Array {
  const clean = text.includes(',') ? text.slice(text.indexOf(',') + 1) : text;
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function isSafeNormalizedPath(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\') || /^[A-Za-z]:/.test(name)) return false;
  if (!name.split('/').every((part) => part !== '' && part !== '.' && part !== '..')) return false;
  return true;
}

function normalizeManifestRel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
    .toLowerCase();
}

/** Whether a path is safe to mount into the guest VFS (never traversal, never server/private/secret files). */
export function isSafeClientPath(name: string, manifest?: Record<string, unknown> | null): boolean {
  if (!isSafeNormalizedPath(name)) return false;
  const lower = name.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (
    /^(?:__softn_generated__\/)?(?:server|backend|private|db|database|migrations)\//.test(lower) ||
    /(?:^|\/)\.git(?:\/|$)/.test(lower) ||
    /\.(?:sql|php|phtml|php5|php8|phar|inc|tpl|rs|py|logic|db|sqlite|sqlite3|db-wal|db-shm|db-journal|htpasswd|htaccess|ini|bak|sh)$/i.test(lower) ||
    base === '.env' ||
    base.startsWith('.env.') ||
    base === 'seed.json' ||
    base === 'cargo.toml' ||
    base === 'cargo.lock' ||
    base === 'composer.json' ||
    base === 'composer.lock'
  ) {
    return false;
  }
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    const backend = isRecord(manifest.backend) ? manifest.backend : null;
    if (backend) {
      const root = normalizeManifestRel(backend.root);
      if (root && (lower === root || lower.startsWith(`${root}/`))) return false;
      const entry = normalizeManifestRel(backend.entry);
      if (entry) {
        if (lower === entry) return false;
        const slash = entry.indexOf('/');
        if (slash > 0 && lower.startsWith(entry.slice(0, slash + 1))) return false;
      }
    }
    const ssrEntry = normalizeManifestRel(manifest.ssrEntry);
    if (ssrEntry && lower === ssrEntry) return false;
    if (Array.isArray(manifest.databases)) {
      for (const dbCfg of manifest.databases) {
        if (!isRecord(dbCfg)) continue;
        const dbFile = normalizeManifestRel(dbCfg.file);
        if (
          dbFile &&
          (lower === dbFile ||
            lower === `${dbFile}-wal` ||
            lower === `${dbFile}-shm` ||
            lower === `${dbFile}-journal`)
        ) {
          return false;
        }
        const seedSql = normalizeManifestRel(dbCfg.seedSql);
        if (seedSql && lower === seedSql) return false;
        const seedJson = normalizeManifestRel(dbCfg.seedJson);
        if (seedJson && lower === seedJson) return false;
      }
    }
  }
  return true;
}

/**
 * Whether a path is safe to pass to `@softn/container` when running an embedded backend
 * locally inside the browser sandbox (not `containerBackend === 'host'`).
 *
 * `private/` is still always rejected; `@softn/container`'s `ContainerArchive` separates
 * backend/SQL files into `exportBackendVfs()` so the untrusted frontend Worker never sees them.
 */
export function isSafeLocalContainerPath(name: string): boolean {
  if (!isSafeNormalizedPath(name)) return false;
  if (/^(?:__softn_generated__\/)?private\//i.test(name)) return false;
  return true;
}

/**
 * Combine `init.client` text files and `init.assets` (bytes or base64 strings) into the
 * VFS map `@softn/container` mounts from. Unsafe and server-only paths are dropped unless
 * `options.allowLocalBackend` is enabled for a local-sandbox container.
 */
export function buildContainerSource(
  files: ReadonlyMap<string, string>,
  assets: Record<string, unknown> | undefined,
  options?: { allowLocalBackend?: boolean; manifest?: Record<string, unknown> | null }
): Record<string, string | Uint8Array> {
  const out: Record<string, string | Uint8Array> = Object.create(null);
  let parsedManifest: Record<string, unknown> | null = options?.manifest ?? null;
  if (!parsedManifest && !options?.allowLocalBackend) {
    const rawManifest = files.get('manifest.json');
    if (typeof rawManifest === 'string') {
      try {
        const parsed = JSON.parse(rawManifest);
        if (isRecord(parsed)) parsedManifest = parsed;
      } catch {
        // Malformed manifest falls back to default static deny rules.
      }
    }
  }
  const allow = options?.allowLocalBackend
    ? isSafeLocalContainerPath
    : (path: string) => isSafeClientPath(path, parsedManifest);

  for (const [path, text] of files.entries()) {
    if (allow(path) && typeof text === 'string') out[path] = text;
  }
  if (isRecord(assets)) {
    for (const [path, value] of Object.entries(assets)) {
      if (!allow(path)) continue;
      if (value instanceof Uint8Array) {
        out[path] = value;
      } else if (value instanceof ArrayBuffer) {
        out[path] = new Uint8Array(value);
      } else if (typeof value === 'string') {
        try {
          out[path] = decodeBase64(value);
        } catch {
          // Ignore malformed asset payload.
        }
      }
    }
  }
  return out;
}

/**
 * Capabilities granted to a v2 container from the parent's `FramePermissions`.
 * Only capabilities explicitly enabled in the parent's grant map are forwarded.
 */
export function grantedContainerCapabilities(permissions: { permissions?: Record<string, { enabled?: boolean } | undefined> } | undefined): string[] {
  const map = permissions?.permissions;
  if (!isRecord(map)) return [];
  const granted: string[] = [];
  for (const [cap, cfg] of Object.entries(map)) {
    if (isRecord(cfg) && cfg.enabled === true) granted.push(cap);
  }
  return granted.sort();
}

const MAX_PORT_HTTP_BODY_BYTES = 16 * 1024 * 1024;
const MAX_PORT_HTTP_PATH_LEN = 2048;
const MAX_PORT_HEADERS = 64;
const MAX_PORT_HEADER_VALUE_BYTES = 8192;
const MAX_PORT_QUERY_BYTES = 8192;
const textEncoder = new TextEncoder();
const ALLOWED_PORT_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const FORBIDDEN_PORT_HEADERS = new Set([
  'host', 'origin', 'referer', 'cookie', 'content-length', 'connection', 'keep-alive',
  'upgrade', 'te', 'trailer', 'transfer-encoding', 'accept-encoding',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded',
  'x-original-url', 'x-rewrite-url', 'x-http-method-override', 'x-method-override',
]);

function isSafePortHttpPath(rawPath: string): boolean {
  if (!rawPath || typeof rawPath !== 'string') return false;
  const clean = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  if (
    clean.length > MAX_PORT_HTTP_PATH_LEN ||
    clean.startsWith('//') ||
    clean.includes('\\') ||
    /[\r\n\0?#]/.test(clean) ||
    /(?:^|\/)\.\.(?:\/|$)/.test(clean) ||
    /%(?:2e|2f|5c|00|25)/i.test(clean)
  ) {
    return false;
  }
  return true;
}

const MAX_PORT_COOKIES = 50;
const MAX_PORT_COOKIE_BYTES = 4096;
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

class PortCookieJar {
  private readonly cookies = new Map<string, { value: string; path: string; expiresAt: number | null }>();

  ingest(headers: ReadonlyArray<[string, string]>): void {
    const now = Date.now();
    for (const [k, raw] of headers) {
      if (k.toLowerCase() !== 'set-cookie') continue;
      if (raw.length > MAX_PORT_COOKIE_BYTES || /[\r\n\0]/.test(raw)) continue;
      const parts = raw.split(';');
      const eq = parts[0].indexOf('=');
      if (eq <= 0) continue;
      const name = parts[0].slice(0, eq).trim();
      const value = parts[0].slice(eq + 1).trim();
      if (!name || !COOKIE_NAME_RE.test(name) || /[;\r\n\0]/.test(value)) continue;
      let path = '/';
      let expiresAt: number | null = null;
      let expired = false;
      for (let i = 1; i < parts.length; i++) {
        const attr = parts[i].trim();
        const aEq = attr.indexOf('=');
        const aKey = (aEq >= 0 ? attr.slice(0, aEq) : attr).trim().toLowerCase();
        const aVal = aEq >= 0 ? attr.slice(aEq + 1).trim() : '';
        if (aKey === 'path' && aVal.startsWith('/') && !/[\r\n\0]/.test(aVal)) {
          path = aVal;
        } else if (aKey === 'max-age') {
          const secs = Number(aVal);
          if (Number.isFinite(secs)) {
            if (secs <= 0) expired = true;
            else expiresAt = now + secs * 1000;
          }
        } else if (aKey === 'expires' && expiresAt === null) {
          const ts = Date.parse(aVal);
          if (Number.isFinite(ts)) {
            if (ts <= now) expired = true;
            else expiresAt = ts;
          }
        }
      }
      const key = `${name}\0${path}`;
      if (expired) {
        this.cookies.delete(key);
      } else {
        if (!this.cookies.has(key) && this.cookies.size >= MAX_PORT_COOKIES) {
          const oldest = this.cookies.keys().next().value;
          if (oldest !== undefined) this.cookies.delete(oldest);
        }
        this.cookies.set(key, { value, path, expiresAt });
      }
    }
  }

  headerFor(reqPath: string): string {
    const now = Date.now();
    const normPath = reqPath.startsWith('/') ? reqPath : `/${reqPath}`;
    const matched: Array<[string, string]> = [];
    for (const [key, entry] of this.cookies) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.cookies.delete(key);
        continue;
      }
      const cookiePath = entry.path;
      const matchesPath =
        cookiePath === '/' ||
        normPath === cookiePath ||
        normPath.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
      if (matchesPath) {
        const name = key.slice(0, key.indexOf('\0'));
        matched.push([name, entry.value]);
      }
    }
    return matched.map(([n, v]) => `${n}=${v}`).join('; ');
  }

  clear(): void {
    this.cookies.clear();
  }
}

/**
 * Bridge a v2 container's `/api/*` backend traffic across FormLogic's MessagePort
 * (`containerHttp` action) so authenticated multi-user backends run on the server
 * without opening direct network egress from the opaque-origin iframe.
 */
export function createPortBackendTransport(call: FrameBackendCall): ContainerBackendTransport {
  let disposed = false;
  const cookieJar = new PortCookieJar();
  return {
    kind: 'remote',
    ready: Promise.resolve(),
    async fetch(req: ContainerBackendRequest): Promise<ContainerBackendResponse> {
      if (disposed) {
        return {
          status: 503,
          statusText: 'Service Unavailable',
          headers: [['content-type', 'application/json']],
          body: textEncoder.encode(JSON.stringify({ error: 'Container backend disposed' })),
        };
      }
      const reqPath = req.path.startsWith('/') ? req.path : `/${req.path}`;
      if (!isSafePortHttpPath(reqPath)) {
        return {
          status: 400,
          statusText: 'Bad Request',
          headers: [['content-type', 'application/json']],
          body: textEncoder.encode(JSON.stringify({ error: 'Invalid backend request path' })),
        };
      }
      const bodyBytes =
        typeof req.body === 'string'
          ? textEncoder.encode(req.body)
          : req.body instanceof Uint8Array
            ? req.body
            : null;
      if (bodyBytes && bodyBytes.byteLength > MAX_PORT_HTTP_BODY_BYTES) {
        return {
          status: 413,
          statusText: 'Payload Too Large',
          headers: [['content-type', 'application/json']],
          body: textEncoder.encode(JSON.stringify({ error: 'Request body too large' })),
        };
      }
      const method = String(req.method || 'GET').toUpperCase();
      if (!ALLOWED_PORT_METHODS.has(method)) {
        return {
          status: 405,
          statusText: 'Method Not Allowed',
          headers: [['content-type', 'application/json']],
          body: textEncoder.encode(JSON.stringify({ error: 'Unsupported HTTP method' })),
        };
      }
      const query = typeof req.query === 'string' ? req.query : '';
      if (query.length > MAX_PORT_QUERY_BYTES || /[\r\n\0]/.test(query)) {
        return {
          status: 400,
          statusText: 'Bad Request',
          headers: [['content-type', 'application/json']],
          body: textEncoder.encode(JSON.stringify({ error: 'Invalid backend query string' })),
        };
      }
      const safeHeaders: Record<string, string> = {};
      let headerCount = 0;
      for (const [k, v] of Object.entries(req.headers ?? {})) {
        if (headerCount >= MAX_PORT_HEADERS) break;
        const lower = k.toLowerCase();
        if (
          !/^[a-z0-9-]+$/.test(lower) ||
          FORBIDDEN_PORT_HEADERS.has(lower) ||
          lower.startsWith('sec-') ||
          lower.startsWith('proxy-') ||
          lower.startsWith('x-formlogic')
        ) {
          continue;
        }
        if (typeof v !== 'string' || v.length > MAX_PORT_HEADER_VALUE_BYTES || /[\r\n\0]/.test(v)) {
          continue;
        }
        safeHeaders[lower] = v;
        headerCount++;
      }
      const jarCookies = cookieJar.headerFor(reqPath);
      if (jarCookies) {
        safeHeaders.cookie = jarCookies;
      }
      const envelope = await call('containerHttp', {
        method,
        path: reqPath,
        query,
        headers: safeHeaders,
        bodyBase64: bodyBytes && bodyBytes.byteLength > 0 ? encodeBase64(bodyBytes) : '',
      });
      if (!isRecord(envelope)) {
        return {
          status: 502,
          statusText: 'Bad Gateway',
          headers: [['content-type', 'application/json']],
          body: textEncoder.encode(JSON.stringify({ error: 'Invalid backend response' })),
        };
      }
      if (typeof envelope.error === 'string' && envelope.status === undefined && !isRecord(envelope.result)) {
        return {
          status: 502,
          statusText: 'Bad Gateway',
          headers: [['content-type', 'application/json']],
          body: textEncoder.encode(JSON.stringify({ error: envelope.error })),
        };
      }
      const raw = isRecord(envelope.result) ? envelope.result : envelope;
      if (typeof raw.error === 'string' && raw.status === undefined) {
        return {
          status: 502,
          statusText: 'Bad Gateway',
          headers: [['content-type', 'application/json']],
          body: textEncoder.encode(JSON.stringify({ error: raw.error })),
        };
      }
      const status = typeof raw.status === 'number' && Number.isFinite(raw.status) ? raw.status : 200;
      const statusText = typeof raw.statusText === 'string' ? raw.statusText : undefined;
      const headers: Array<[string, string]> = [];
      if (Array.isArray(raw.headers)) {
        for (const pair of raw.headers) {
          if (Array.isArray(pair) && pair.length >= 2) {
            headers.push([String(pair[0]).toLowerCase(), String(pair[1])]);
          }
        }
      } else if (isRecord(raw.headers)) {
        for (const [k, v] of Object.entries(raw.headers)) {
          const name = k.toLowerCase();
          if (typeof v === 'string') headers.push([name, v]);
          else if (Array.isArray(v)) {
            for (const item of v) headers.push([name, String(item)]);
          }
        }
      }
      cookieJar.ingest(headers);
      let body: Uint8Array;
      if (raw.body instanceof Uint8Array) {
        body = raw.body;
      } else if (typeof raw.bodyBase64 === 'string') {
        try {
          body = decodeBase64(raw.bodyBase64);
        } catch {
          return {
            status: 502,
            statusText: 'Bad Gateway',
            headers: [['content-type', 'application/json']],
            body: textEncoder.encode(JSON.stringify({ error: 'Malformed base64 response body' })),
          };
        }
      } else if (typeof raw.body === 'string') {
        body = textEncoder.encode(raw.body);
      } else {
        body = new Uint8Array(0);
      }
      return { status, ...(statusText ? { statusText } : {}), headers, body };
    },
    dispose(): void {
      disposed = true;
      cookieJar.clear();
    },
  };
}
