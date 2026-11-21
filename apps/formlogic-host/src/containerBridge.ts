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
    if (manifest.engine === 2 || manifest.container === true) return true;
    if (isRecord(manifest.backend)) return true;
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

/** Whether a path is safe to mount into the guest VFS (never traversal, never server/private files). */
export function isSafeClientPath(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\') || /^[A-Za-z]:/.test(name)) return false;
  if (!name.split('/').every((part) => part !== '' && part !== '.' && part !== '..')) return false;
  if (/^(?:__softn_generated__\/)?(?:server|backend|private)\/|\.sql$/i.test(name)) return false;
  return true;
}

/**
 * Combine `init.client` text files and `init.assets` (bytes or base64 strings) into the
 * VFS map `@softn/container` mounts from. Unsafe and server-only paths are dropped.
 */
export function buildContainerSource(
  files: ReadonlyMap<string, string>,
  assets: Record<string, unknown> | undefined
): Record<string, string | Uint8Array> {
  const out: Record<string, string | Uint8Array> = Object.create(null);

  for (const [path, text] of files.entries()) {
    if (isSafeClientPath(path) && typeof text === 'string') out[path] = text;
  }
  if (isRecord(assets)) {
    for (const [path, value] of Object.entries(assets)) {
      if (!isSafeClientPath(path)) continue;
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

/**
 * Bridge a v2 container's `/api/*` backend traffic across FormLogic's MessagePort
 * (`containerHttp` action) so authenticated multi-user backends run on the server
 * without opening direct network egress from the opaque-origin iframe.
 */
export function createPortBackendTransport(call: FrameBackendCall): ContainerBackendTransport {
  let disposed = false;
  return {
    kind: 'remote',
    ready: Promise.resolve(),
    async fetch(req: ContainerBackendRequest): Promise<ContainerBackendResponse> {
      if (disposed) {
        return {
          status: 503,
          statusText: 'Service Unavailable',
          headers: [['content-type', 'application/json']],
          body: new TextEncoder().encode(JSON.stringify({ error: 'Container backend disposed' })),
        };
      }
      const bodyBytes =
        typeof req.body === 'string'
          ? new TextEncoder().encode(req.body)
          : req.body instanceof Uint8Array
            ? req.body
            : null;
      const envelope = await call('containerHttp', {
        method: req.method,
        path: req.path,
        query: req.query ?? '',
        headers: req.headers ?? {},
        bodyBase64: bodyBytes && bodyBytes.byteLength > 0 ? encodeBase64(bodyBytes) : '',
      });
      if (!isRecord(envelope)) {
        return {
          status: 502,
          statusText: 'Bad Gateway',
          headers: [['content-type', 'application/json']],
          body: new TextEncoder().encode(JSON.stringify({ error: 'Invalid backend response' })),
        };
      }
      if (typeof envelope.error === 'string' && envelope.status === undefined && !isRecord(envelope.result)) {
        return {
          status: 502,
          statusText: 'Bad Gateway',
          headers: [['content-type', 'application/json']],
          body: new TextEncoder().encode(JSON.stringify({ error: envelope.error })),
        };
      }
      const raw = isRecord(envelope.result) ? envelope.result : envelope;
      if (typeof raw.error === 'string' && raw.status === undefined) {
        return {
          status: 502,
          statusText: 'Bad Gateway',
          headers: [['content-type', 'application/json']],
          body: new TextEncoder().encode(JSON.stringify({ error: raw.error })),
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
      let body: Uint8Array;
      if (raw.body instanceof Uint8Array) {
        body = raw.body;
      } else if (typeof raw.bodyBase64 === 'string') {
        body = decodeBase64(raw.bodyBase64);
      } else if (typeof raw.body === 'string') {
        body = new TextEncoder().encode(raw.body);
      } else {
        body = new Uint8Array(0);
      }
      return { status, ...(statusText ? { statusText } : {}), headers, body };
    },
    dispose(): void {
      disposed = true;
    },
  };
}
