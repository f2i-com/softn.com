import type { PermissionConfig } from '@softn/core';

const DEFAULT_MAX_REMOTE_IMPORT_BYTES = 1024 * 1024;
const DEFAULT_REMOTE_IMPORT_TIMEOUT_MS = 10_000;

interface ImportResolverOptions {
  permissionConfig: PermissionConfig | null;
  isActive?: () => boolean;
  trackController?: (controller: AbortController) => () => void;
  fetchImpl?: typeof fetch;
  maxRemoteBytes?: number;
  timeoutMs?: number;
}

function permittedRemoteUrl(value: string, config: PermissionConfig | null): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const permissions = config?.permissions;
  const net = permissions && typeof permissions === 'object' ? permissions.net : undefined;
  if (!net || typeof net !== 'object' || !net.enabled) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && net.allow_http)) return null;
  if (
    Array.isArray(net.allowed_hosts) &&
    net.allowed_hosts.length > 0 &&
    !net.allowed_hosts.includes(url.hostname)
  ) {
    return null;
  }
  return url;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be locked/aborted; cancellation is best effort.
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  isActive: () => boolean
): Promise<string | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    await cancelBody(response);
    return null;
  }

  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (!isActive() || bytes.byteLength > maxBytes) return null;
    return new TextDecoder().decode(bytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (!isActive() || received > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return isActive() ? chunks.join('') : null;
}

/**
 * Resolve bundle-local imports and tightly gate remote ones.
 *
 * Remote source is executable input. It therefore requires an explicit
 * permission.json net.enabled grant, follows its transport/host restrictions,
 * revalidates redirects, and is read through a byte cap rather than text().
 */
export function createBundleImportResolver(
  textFiles: Map<string, string>,
  {
    permissionConfig,
    isActive = () => true,
    trackController = () => () => {},
    fetchImpl = fetch,
    maxRemoteBytes = DEFAULT_MAX_REMOTE_IMPORT_BYTES,
    timeoutMs = DEFAULT_REMOTE_IMPORT_TIMEOUT_MS,
  }: ImportResolverOptions
): (path: string) => Promise<string | null> {
  const urlCache = new Map<string, string>();

  return async (path: string): Promise<string | null> => {
    if (!isActive()) return null;
    if (!path.startsWith('http://') && !path.startsWith('https://')) {
      return textFiles.get(path) ?? null;
    }

    const requestedUrl = permittedRemoteUrl(path, permissionConfig);
    if (!requestedUrl) return null;
    if (urlCache.has(requestedUrl.href)) return urlCache.get(requestedUrl.href)!;

    const controller = new AbortController();
    const untrack = trackController(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(requestedUrl.href, { signal: controller.signal });
      if (!isActive()) {
        controller.abort();
        return null;
      }
      if (!response.ok) {
        await cancelBody(response);
        return null;
      }

      // fetch follows redirects, so the final response has to satisfy the same
      // policy as the URL the bundle originally named.
      if (response.url && !permittedRemoteUrl(response.url, permissionConfig)) {
        await cancelBody(response);
        return null;
      }

      const text = await readBoundedText(response, maxRemoteBytes, isActive);
      if (text === null) return null;
      urlCache.set(requestedUrl.href, text);
      return text;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      untrack();
    }
  };
}
