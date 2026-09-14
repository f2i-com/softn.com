import { inspectDeclaration, type PermissionConfig } from '@softn/core';
/**
 * Where the app came from, when a directory served this shell for it: the
 * endpoints the runtime reports to and stores through. Both are the same-origin
 * routes the directory API answers for the app (`/api/apps/<slug>/...`), set by
 * the server that rendered the page and never by the bundle.
 */
export interface DirectoryConfig {
  /** `POST` here once the app is up, so the directory counts the run. */
  runs?: string;
  /** The app's own server-side database, `softn.storage.*` in its scripts. */
  storage?: string;
}
export interface SingleConfig {
  version: 1;
  id: string;
  title: string;
  bundle: string;
  permissions?: string;
  loadingText: string;
  theme: 'light' | 'dark';
  sha256?: string;
  permissionMode?: 'prompt' | 'preapproved';
  directory?: DirectoryConfig;
}
export function localUrl(value: unknown, base: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048)
    throw Error('Invalid file location');
  const url = new URL(value, base),
    origin = new URL(base);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== origin.origin ||
    url.username ||
    url.password ||
    url.hash
  )
    throw Error('Files must be on the same origin');
  return url.href;
}
function parseDirectory(value: unknown, base: string): DirectoryConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid directory configuration');
  const d = value as Record<string, unknown>;
  if (Object.keys(d).some((k) => k !== 'runs' && k !== 'storage'))
    throw Error('Invalid directory configuration');
  return {
    runs: d.runs === undefined ? undefined : localUrl(d.runs, base),
    storage: d.storage === undefined ? undefined : localUrl(d.storage, base),
  };
}
export function parseConfig(input: unknown, base: string): SingleConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('Invalid configuration');
  const c = input as Record<string, unknown>;
  const keys = [
    'version',
    'id',
    'title',
    'bundle',
    'permissions',
    'loadingText',
    'theme',
    'sha256',
    'permissionMode',
    'directory',
  ];
  if (
    Object.keys(c).some((k) => !keys.includes(k)) ||
    c.version !== 1 ||
    typeof c.id !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(c.id)
  )
    throw Error('Invalid configuration');
  if (typeof c.title !== 'string' || !c.title.trim() || c.title.length > 120)
    throw Error('Invalid application title');
  if (
    c.loadingText !== undefined &&
    (typeof c.loadingText !== 'string' || c.loadingText.length > 160)
  )
    throw Error('Invalid loading text');
  if (c.theme !== undefined && c.theme !== 'light' && c.theme !== 'dark')
    throw Error('Invalid theme');
  if (c.sha256 !== undefined && (typeof c.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(c.sha256)))
    throw Error('Invalid digest');
  if (c.permissionMode !== undefined && c.permissionMode !== 'prompt' && c.permissionMode !== 'preapproved')
    throw Error('Invalid permission mode');
  if (c.permissionMode === 'preapproved' && !c.sha256)
    throw Error('Preapproved deployments require a pinned bundle digest');
  return {
    version: 1,
    id: c.id,
    title: c.title,
    bundle: localUrl(c.bundle, base),
    permissions: c.permissions === undefined ? undefined : localUrl(c.permissions, base),
    loadingText: (c.loadingText as string) ?? 'Loading…',
    theme: (c.theme as 'light' | 'dark') ?? 'dark',
    sha256: c.sha256 as string | undefined,
    permissionMode: (c.permissionMode as SingleConfig['permissionMode']) ?? 'prompt',
    directory: parseDirectory(c.directory, base),
  };
}
export function parsePermissions(value: unknown): PermissionConfig {
  const report = inspectDeclaration(value);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('permissions' in value) ||
    !value.permissions ||
    typeof value.permissions !== 'object' ||
    Array.isArray(value.permissions) ||
    report.unknown.length ||
    report.malformed.length
  )
    throw Error('Invalid permission declaration');
  return value as PermissionConfig;
}
export async function fetchBytes(
  url: string,
  signal: AbortSignal,
  limit: number,
  // `no-store` for a file an operator may replace in place under the same
  // name. A directory hands out version-addressed bundles whose bytes never
  // change and whose digest the config pins, so those may use the browser's
  // cache: a second visit inside the server's max-age makes no request at all.
  cache: RequestCache = 'no-store'
): Promise<Uint8Array> {
  const response = await fetch(url, {
    signal,
    credentials: 'same-origin',
    cache,
    redirect: 'error',
  });
  if (!response.ok) throw Error('Required file could not be loaded');
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw Error('File exceeds size limit');
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw Error('File exceeds size limit');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) {
        await reader.cancel();
        throw Error('File exceeds size limit');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}
export async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, '0')).join('');
}
