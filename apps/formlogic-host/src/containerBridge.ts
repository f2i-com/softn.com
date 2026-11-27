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
    /\.(?:sql|php|phtml|php5|php7|php8|pht|phps|phar|inc|tpl|rs|py|logic|db|sqlite|sqlite3|db-wal|db-shm|db-journal|htpasswd|htaccess|ini|bak|sh|log)$/i.test(lower) ||
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
        const topDir = slash > 0 ? entry.slice(0, slash) : '';
        const feRoots = new Set(['public', 'static', 'dist', 'frontend', 'assets', 'css', 'js']);
        if (slash > 0 && !feRoots.has(topDir) && lower.startsWith(`${topDir}/`)) return false;
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
 * A file's bytes from base64 text, read by the browser's own decoder as media.ts's `bytesOf` reads
 * one (it passes over spaces and line breaks, takes text whose `=` padding is left off, and refuses
 * anything else), or null for text that is not base64.
 */
function base64Bytes(text: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Combine `init.client` text files and `init.assets` into the VFS map `@softn/container` mounts
 * from, each file under its own path: what web.ts gives the container. That is the app's pages
 * and code, its media, and the `.softn` archives its page nests: `<softn-app
 * src="assets/widgets/clock.softn">` is read from the archive by exactly that name (FormLogic
 * keeps one with the app's media, under `assets/`). An asset is taken as the bytes it came as (a
 * Uint8Array, as FormLogic sends them to a frame that says `mediaBytes: 1`, or an ArrayBuffer) or
 * from base64 text; text that is not base64 is no file and is left out. Unsafe and server-only
 * paths are dropped unless `options.allowLocalBackend` is enabled for a local-sandbox container.
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
        const bytes = base64Bytes(value);
        if (bytes) out[path] = bytes;
      }
    }
  }
  return out;
}

/**
 * What of another document the frame's container lets an app's page hold (`@softn/container`'s
 * `frames` and `nestedApps`).
 *
 * No frame of another site: this document's policy names no `frame-src` (framePolicy.ts), and it
 * runs in the parent's sandbox with no origin of its own, which a frame in it would inherit (a
 * video player keeps nothing there and does not play).
 *
 * An app of the app's own (`<softn-app src>`) needs neither, and is nested as anywhere: an
 * archive among the files the parent sent (buildContainerSource), run in a Worker and a VM of its
 * own, allowed no more than the app around it (here, what `init.permissions` grants), keeping
 * nothing between visits and none of this frame's storage, and with no backend call of its own:
 * none of the parent's calls is the nested app's to make (the full engine, where it needs one, is
 * fetched for it as for the app). A file it offers to save is asked about in the app's own bar.
 * Said here rather than left to the container's default: FormLogic keeps a hosted app's `.softn`
 * files so that its page can nest them.
 */
export const FRAME_EMBEDS = Object.freeze({ frames: 'deny', nestedApps: 'allow', dynamicPreviews: 'allow' } as const);

/** Maximum `.softn` binary bundle offer size accepted across the FormLogic host bridge (64 MiB binary -> ~86 MiB base64). */
export const MAX_BINARY_APP_OFFER_BYTES = 64 * 1024 * 1024;
const MAX_BINARY_APP_OFFER_B64 = Math.ceil((MAX_BINARY_APP_OFFER_BYTES * 4) / 3) + 1024;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

export interface BinaryAppOfferInput {
  name: string;
  operation: 'create' | 'update';
  targetAppId?: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
  manifest: Record<string, unknown>;
  summary?: {
    frontend?: string;
    backend?: string | null;
    database?: string | null;
    fileCount: number;
    size?: number;
    tables?: number;
    records?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface BinaryAppOfferResponse {
  ok: boolean;
  status: 'accepted' | 'cancelled' | 'rejected' | 'unsupported';
  appId?: string;
  url?: string;
  message?: string;
}

/**
 * The calls FormLogic's own page answers for an app itself (HostedAppFrame, NativeAppView), beside
 * its backend and its uploads: `formlogicWallet` opens FormLogic's wallet over the app (an app
 * that takes payments, after a declined charge), `formlogicHost` says what else the page can do
 * for it, `formlogicDictate` has the page listen and hands the app the words, and
 * `formlogicAddApp` has it offer the person an app this one made. The page holds each to what the
 * app declared and its owner allowed: the wallet only for an app that takes payments (any other is
 * answered as for an action the page does not know), listening and offers only where the owner
 * turned them on (refused `off` otherwise). The web frame refused all four ("Use an app-relative API route under /api/."), so a web app that takes
 * payments had no way to the wallet after a declined charge, and one that listens or offers apps
 * was told the page could do neither. The classic frame passes every call on.
 */
export const PAGE_ACTIONS: ReadonlySet<string> = new Set(['formlogicWallet', 'formlogicHost', 'formlogicDictate', 'formlogicAddApp']);

/**
 * What answers an app's `softn.backend.call` in the web frame, given `call`, which sends an action
 * to the parent over the port: an upload to the app's file store (`formlogicUpload`, its shape
 * checked first), one of the page's own calls (PAGE_ACTIONS), or a request to one of the app's own
 * routes (`nativeRequest`, an app-relative path under `/api/`). Any other name is refused here and
 * never reaches the parent: the app's storage (`nativeStorage`), its container's HTTP
 * (`containerHttp`) and its engine (`containerEngine`) are this frame's own to send, in the shape
 * the parent takes them. An app nested in this one has no backend call at all (FRAME_EMBEDS).
 */
export function frameBackendCall(call: FrameBackendCall): FrameBackendCall {
  return (action, input) => {
    if (action === 'formlogicUpload') {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return Promise.resolve({ error: 'Invalid upload request.' });
      }
      const op = input.op === undefined ? 'upload' : input.op;
      if (op !== 'upload' && op !== 'list' && op !== 'delete') {
        return Promise.resolve({ error: 'Unsupported upload operation.' });
      }
      if (op === 'delete') {
        if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{4,64}$/.test(input.id.trim())) {
          return Promise.resolve({ error: 'Invalid upload id.' });
        }
      } else if (op === 'upload') {
        if (
          typeof input.contentBase64 !== 'string' ||
          input.contentBase64.length === 0 ||
          input.contentBase64.length > 34 * 1024 * 1024 ||
          (input.filename !== undefined && typeof input.filename !== 'string') ||
          (input.mimeType !== undefined && typeof input.mimeType !== 'string') ||
          (input.folder !== undefined && typeof input.folder !== 'string')
        ) {
          return Promise.resolve({ error: 'Invalid upload payload.' });
        }
      } else if (input.folder !== undefined && typeof input.folder !== 'string') {
        return Promise.resolve({ error: 'Invalid upload folder.' });
      }
      return call('formlogicUpload', input);
    }
    if (action === 'formlogicOfferBundle') {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return Promise.resolve({ error: 'Invalid binary app offer request.' });
      }
      const op = input.op === undefined ? 'offer' : input.op;
      if (op !== 'offer' && op !== 'status') {
        return Promise.resolve({ error: 'Unsupported binary app offer operation.' });
      }
      if (op === 'offer') {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        const operation = input.operation === 'update' ? 'update' : input.operation === 'create' ? 'create' : '';
        const bundleBase64 = typeof input.bundleBase64 === 'string' ? input.bundleBase64 : '';
        const sha256 = typeof input.sha256 === 'string' ? input.sha256 : '';
        const targetAppId = input.targetAppId;
        if (
          !name ||
          name.length > 120 ||
          !operation ||
          !bundleBase64 ||
          bundleBase64.length > MAX_BINARY_APP_OFFER_B64 ||
          !SHA256_HEX_RE.test(sha256) ||
          (targetAppId !== undefined && (typeof targetAppId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(targetAppId)))
        ) {
          return Promise.resolve({ error: 'Invalid binary app offer payload.' });
        }
      }
      return call('formlogicOfferBundle', input);
    }
    if (PAGE_ACTIONS.has(action)) return call(action, input);
    const pathOnly = typeof input.url === 'string' ? input.url.split('?')[0] : '';
    if (
      action !== 'nativeRequest' ||
      typeof input.url !== 'string' ||
      input.url.length > 2048 ||
      /[\r\n\0]/.test(input.url) ||
      !/^\/api\/[A-Za-z0-9_.%~/-]+(?:\?[^#]*)?$/.test(input.url) ||
      /(?:^|\/)\.\.(?:\/|$)/.test(pathOnly) ||
      /%(?:2e|2f|5c|00|25)/i.test(pathOnly)
    ) {
      return Promise.resolve({ error: 'Use an app-relative API route under /api/.' });
    }
    return call('nativeRequest', input);
  };
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

/**
 * Bridge `@softn/container`'s `onOfferApp` callback (`softn:apps` `offerToHost()`) onto
 * FormLogic's bounded `formlogicOfferBundle` host action without ever exposing FormLogic
 * auth tokens, workspace internals, or arbitrary admin APIs to the guest application.
 */
export function createBinaryAppOfferHandler(
  call: FrameBackendCall
): (offer: BinaryAppOfferInput) => Promise<BinaryAppOfferResponse> {
  return async (offer) => {
    if (!(offer.bytes instanceof Uint8Array) || offer.bytes.byteLength === 0) {
      return { ok: false, status: 'rejected', message: 'Empty application bundle.' };
    }
    if (offer.bytes.byteLength > MAX_BINARY_APP_OFFER_BYTES) {
      return {
        ok: false,
        status: 'rejected',
        message: `Application bundle exceeds FormLogic limit (${MAX_BINARY_APP_OFFER_BYTES} bytes).`,
      };
    }
    const name = String(offer.name || offer.manifest?.name || 'Generated App').trim().slice(0, 120);
    const operation = offer.operation === 'update' ? 'update' : 'create';
    const payload: Record<string, unknown> = {
      op: 'offer',
      name,
      operation,
      ...(offer.targetAppId ? { targetAppId: offer.targetAppId } : {}),
      size: offer.bytes.byteLength,
      sha256: offer.sha256,
      bundleBase64: encodeBase64(offer.bytes),
      manifest: offer.manifest,
      summary: offer.summary,
      ...(offer.metadata ? { metadata: offer.metadata } : {}),
    };
    const raw = await call('formlogicOfferBundle', payload);
    if (!isRecord(raw)) {
      return { ok: false, status: 'rejected', message: 'Unexpected host response.' };
    }
    const inner = isRecord(raw.result) ? raw.result : raw;
    if (typeof inner.error === 'string') {
      const unsupported = /unknown|unsupported|not implemented|off/i.test(inner.error);
      return {
        ok: false,
        status: unsupported ? 'unsupported' : 'rejected',
        message: inner.error,
      };
    }
    const status =
      inner.status === 'accepted' ||
      inner.status === 'cancelled' ||
      inner.status === 'rejected' ||
      inner.status === 'unsupported'
        ? inner.status
        : inner.ok === true
          ? 'accepted'
          : 'rejected';
    return {
      ok: status === 'accepted',
      status,
      ...(typeof inner.appId === 'string' ? { appId: inner.appId } : {}),
      ...(typeof inner.url === 'string' ? { url: inner.url } : {}),
      ...(typeof inner.message === 'string' ? { message: inner.message } : {}),
    };
  };
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
        if (aKey === 'path' && aVal.startsWith('/') && !/[\r\n\0]/.test(aVal) && !/(?:^|\/)\.\.(?:\/|$)/.test(aVal)) {
          const collapsed = aVal.replace(/\/{2,}/g, '/');
          // Normalize mount-prefixed `/.../api/...` cookie paths to container-relative `/api/...`
          const apiIdx = collapsed.indexOf('/api/');
          path = apiIdx > 0 ? collapsed.slice(apiIdx) : collapsed;
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
          lower.startsWith('x-forwarded-') ||
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
      // Never expose raw Set-Cookie headers (which may carry HttpOnly session tokens) to the untrusted guest JS.
      const guestHeaders = headers.filter(([name]) => name !== 'set-cookie' && name !== 'set-cookie2');
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
      return { status, ...(statusText ? { statusText } : {}), headers: guestHeaders, body };
    },
    dispose(): void {
      disposed = true;
      cookieJar.clear();
    },
  };
}
