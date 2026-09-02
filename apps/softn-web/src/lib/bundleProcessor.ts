/**
 * Bundle Processing — extracted from softn-loader/src/App.tsx
 *
 * Pure functions for reading .softn ZIP bundles, loading XDB data,
 * and resolving imports/logic into a single renderable source string.
 * No Tauri dependencies — uses only browser APIs.
 */

import {
  getXDB,
  readBundleEntries,
  classifyAsset,
  ASSET_CLASSIFICATIONS,
  parseXDBFile,
  seedXDBBundleData,
  composeBundleSource,
} from '@softn/core';
import type { PermissionConfig } from '@softn/core';

// ── Types ────────────────────────────────────────────────────────────

export interface BundleManifest {
  name: string;
  version: string;
  description?: string;
  main: string;
  icon?: string;
  files: {
    ui?: string[];
    logic?: string[];
    xdb?: string[];
    assets?: string[];
  };
  config?: {
    window?: {
      title?: string;
      width?: number;
      height?: number;
    };
    theme?: {
      primary?: string;
      mode?: 'light' | 'dark' | 'system';
    };
    /** Where the script runs: `AppConfig.execution` in @softn/core. */
    execution?: 'worker' | 'main';
    server?: {
      url?: string;
      token?: string;
      collections?: string[];
    };
  };
  permissions?: import('@softn/core').AppPermissions;
}

export interface ZipResult {
  textFiles: Map<string, string>;
  binaryFiles: Map<string, Uint8Array>;
}

// ── Helpers ──────────────────────────────────────────────────────────

function isBinaryFile(fileName: string): boolean {
  // The extension list lived here, in softn-loader, in core and in the demo
  // build script, and the four disagreed. @softn/core's registry is the only
  // copy now.
  return classifyAsset(fileName).binary;
}

// ── Core Functions ───────────────────────────────────────────────────

/** Read ZIP entries from Uint8Array using fflate */
export function readZip(data: Uint8Array): ZipResult {
  const textFiles = new Map<string, string>();
  const binaryFiles = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();

  // Validation lives in @softn/core so all three readers share it. This file
  // and softn-loader each carried their own copy — identical today, but two
  // copies of a security check are two chances to fix only one — and the
  // builder had none at all.
  for (const [normalizedPath, content] of readBundleEntries(data)) {
    if (isBinaryFile(normalizedPath)) {
      binaryFiles.set(normalizedPath, content);
    } else {
      textFiles.set(normalizedPath, decoder.decode(content));
    }
  }

  console.log('[SoftN Web] Loaded files:', Array.from(textFiles.keys()));

  return { textFiles, binaryFiles };
}

/** Load XDB data from bundle files into XDB (browser sync mode) */
export async function loadXDBData(
  textFiles: Map<string, string>,
  manifest: BundleManifest,
  appId?: string
): Promise<void> {
  const xdb = getXDB(appId);
  const xdbFiles = manifest.files.xdb || [];
  await xdb.isReady;

  for (const xdbFileName of xdbFiles) {
    const content = textFiles.get(xdbFileName);
    if (!content) continue;

    try {
      const xdbData = parseXDBFile(xdbFileName, content);
      const inserted = seedXDBBundleData(xdb, xdbData);
      console.log(
        `[SoftN Web] Loaded ${inserted}/${xdbData.records.length} records into ${xdbData.collection}`
      );
    } catch (err) {
      console.error(`[SoftN Web] Failed to load XDB file ${xdbFileName}:`, err);
    }
  }
}

/**
 * Process a bundle's main UI file: resolve `<logic src="..."/>` inlining
 * and `<import X from="..."/>` resolution into a single source string.
 * Logic imports stay runtime-resolved, but each fragment's relative paths are
 * canonicalized before the fragments become one parser-visible block.
 */
export function processBundle(
  textFiles: Map<string, string>,
  manifest: BundleManifest
): { source: string; logicBasePath?: string; preIncludedLogicPaths: string[] } {
  const result = composeBundleSource(textFiles, manifest.main, manifest.files.logic);
  console.log('[SoftN Web] Final source prepared with inlined components');
  return result;
}

/**
 * Create an import resolver that looks up paths in the bundle's textFiles map.
 * For URL imports (http/https), fetches with caching.
 */
export interface DisposableImportResolver {
  (path: string): Promise<string | null>;
  /** Abort work and make future resolutions inert. Safe to call repeatedly. */
  dispose(): void;
}

export function createImportResolver(
  textFiles: Map<string, string>,
  permissionConfig: PermissionConfig | null = null
): DisposableImportResolver {
  const urlCache = new Map<string, string>();
  const controllers = new Set<AbortController>();
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let disposed = false;

  const remoteUrl = (value: string): URL | null => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }

    const permissions = permissionConfig?.permissions;
    const net = permissions && typeof permissions === 'object' ? permissions.net : undefined;

    // Remote imports are network access just as surely as fetch() in app logic.
    // Missing permission.json is therefore deny-by-default too: only an
    // explicit net.enabled grant reaches the network.
    if (!net || typeof net !== 'object' || !net.enabled) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && net?.allow_http)) return null;
    if (
      Array.isArray(net?.allowed_hosts) &&
      net.allowed_hosts.length > 0 &&
      !net.allowed_hosts.includes(url.hostname)
    ) {
      return null;
    }
    return url;
  };

  const MAX_REMOTE_IMPORT_BYTES = 1024 * 1024;
  const REMOTE_IMPORT_TIMEOUT_MS = 10_000;

  const cancelBody = async (response: Response): Promise<void> => {
    try {
      await response.body?.cancel();
    } catch {
      // It may already be locked by a reader or aborted by disposal.
    }
  };

  const readBoundedText = async (response: Response): Promise<string | null> => {
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > MAX_REMOTE_IMPORT_BYTES) {
      await cancelBody(response);
      return null;
    }

    if (!response.body) {
      const bytes = await response.arrayBuffer();
      if (disposed || bytes.byteLength > MAX_REMOTE_IMPORT_BYTES) return null;
      return new TextDecoder().decode(bytes);
    }

    const reader = response.body.getReader();
    readers.add(reader);
    try {
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (disposed || received > MAX_REMOTE_IMPORT_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return disposed ? null : chunks.join('');
    } finally {
      readers.delete(reader);
      reader.releaseLock();
    }
  };

  const resolve = (async (path: string): Promise<string | null> => {
    if (disposed) return null;
    // URL imports — fetch with caching
    if (path.startsWith('http://') || path.startsWith('https://')) {
      const requestedUrl = remoteUrl(path);
      if (!requestedUrl) return null;
      if (urlCache.has(requestedUrl.href)) return urlCache.get(requestedUrl.href)!;

      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), REMOTE_IMPORT_TIMEOUT_MS);
      try {
        const response = await fetch(requestedUrl.href, { signal: controller.signal });
        if (disposed) {
          controller.abort();
          await cancelBody(response);
          return null;
        }
        if (!response.ok) {
          await cancelBody(response);
          return null;
        }

        // Fetch follows redirects. Re-check the destination so an allowed host
        // cannot bounce the import to a host the user did not approve.
        if (response.url && !remoteUrl(response.url)) {
          await cancelBody(response);
          return null;
        }

        const text = await readBoundedText(response);
        if (text === null) return null;
        urlCache.set(requestedUrl.href, text);
        return text;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
      }
    }
    // Bundle path lookup
    return textFiles.get(path) ?? null;
  }) as DisposableImportResolver;

  resolve.dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const controller of controllers) controller.abort();
    for (const reader of readers) void reader.cancel().catch(() => undefined);
    controllers.clear();
    readers.clear();
    urlCache.clear();
  };

  return resolve;
}

/**
 * Extract permission config from the bundle.
 * Checks for a dedicated permission.json first, then falls back to manifest.permissions.
 */
export function extractPermissions(
  textFiles: Map<string, string>,
  manifest: BundleManifest
): PermissionConfig | null {
  // Check for permission.json in textFiles
  const permJson = textFiles.get('permission.json');
  if (permJson) {
    try {
      return JSON.parse(permJson) as PermissionConfig;
    } catch (e) {
      // A malformed permission.json must not be treated as an absent one.
      // `checkPermission` allows everything when the config is null (documented
      // backward compatibility for bundles predating the file), so falling
      // through here meant a bundle whose permission.json had a trailing comma
      // got strictly *more* privilege than the same bundle with valid JSON
      // declaring nothing at all. An empty config denies every capability,
      // which is the safe reading of "the author meant to declare something".
      console.error('[SoftN] Invalid permission.json — denying all capabilities:', e);
      return { permissions: {} } as PermissionConfig;
    }
  }
  // Fall back to manifest.permissions (backward compat)
  if (manifest?.permissions) {
    return {
      permissions: {
        net: manifest.permissions.network ? { enabled: true } : undefined,
        files: manifest.permissions.filesystem ? { enabled: true } : undefined,
      },
    };
  }
  return null;
}

/**
 * The same bundle, with everything it declared withheld.
 *
 * This is what the runtime is handed while the consent bar is up, so the app
 * renders and runs but every softn.* capability fails closed. Two details are
 * load-bearing:
 *
 * `permissions` is an empty object, never null. Both sync gates now refuse a
 * null config outright — that hole was closed in the same change that added
 * this — but an empty object is still what the state means, and it selects the
 * right refusal: a null config makes the runtime say "this bundle ships no
 * permission.json", which is false here and is advice for an author rather
 * than for the person looking at the bar.
 *
 * `consentPending` only changes what a refusal says: "you have not allowed this
 * yet" rather than an instruction to edit a file the author already wrote.
 */
export function withheldPermissions(declared: PermissionConfig): PermissionConfig {
  return Object.freeze({
    app: declared.app,
    permissions: Object.freeze({}),
    consentPending: true,
  }) as PermissionConfig;
}

/**
 * Every capability a permission config asks for.
 *
 * One list, read by the consent check, the grant record and the bar's wording,
 * so none of the three can disagree about what was approved. Exported for the
 * last of those: PermissionBar keys its phrasing off `Capability`, so adding a
 * name here without giving it words fails the build instead of shipping a bar
 * that says "a capability called \"webusb\"".
 */
export const CAPABILITIES = ['net', 'camera', 'mic', 'files', 'qr', 'ai', 'gpu', 'sync', 'storage'] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function requestedCapabilities(config: PermissionConfig): string[] {
  const perms = (config.permissions ?? {}) as Record<string, { enabled?: boolean } | undefined>;
  return CAPABILITIES.filter((name) => perms[name]?.enabled);
}

/** Extract icon as a data URL from bundle binary files */
/**
 * Resolve `asset("images/x.png")` to something the browser can load.
 *
 * A bundle's images are inside the archive, so a template referencing one has to
 * be handed a URL rather than a path. Studio's preview has always provided this
 * function; the runtime provided no functions at all, so every `asset()` call in
 * a shipped app evaluated to undefined. The Office demo makes eight of them and
 * carries thirty-five images: every one of them was missing, and the console
 * filled with "Function asset not found" instead of anything saying why the page
 * had no pictures on it.
 *
 * Object URLs, made once per asset and cached, so a list rendering the same
 * image fifty times allocates it once. They live as long as the tab does.
 */
export interface AssetResolver {
  (assetPath: string): string;
  dispose(): void;
}

export function createAssetResolver(
  binaryFiles: Map<string, Uint8Array>,
  textFiles: Map<string, string>
): AssetResolver {
  const urls = new Map<string, string>();
  let disposed = false;

  const resolve = ((assetPath: string): string => {
    if (disposed) return '';
    if (typeof assetPath !== 'string' || !assetPath) return '';
    // Same refusal as the icon path: nothing that climbs out of the bundle.
    if (assetPath.includes('..') || assetPath.startsWith('/') || /^[a-zA-Z]:/.test(assetPath))
      return '';

    const path = assetPath.replace(/^\.\//, '');
    const cached = urls.get(path);
    if (cached) return cached;

    // A MIME miss used to return '' here, so a .glb whose bytes were sitting
    // in the bundle resolved to an empty URL with nothing logged. An unknown
    // format is served as opaque bytes instead, and says so once.
    const { mime } = classifyAsset(path);
    warnUnknownAssetExtension(path);

    const binary = binaryFiles.get(path);
    // An SVG may have been read as text rather than as bytes, depending on how
    // the bundle was written; both are the same picture.
    const text = binary ? undefined : textFiles.get(path);
    if (!binary && text === undefined) return '';

    try {
      const blob = binary
        ? new Blob([binary as BlobPart], { type: mime })
        : new Blob([text as string], { type: mime });
      const url = URL.createObjectURL(blob);
      urls.set(path, url);
      return url;
    } catch {
      return '';
    }
  }) as AssetResolver;

  resolve.dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
  };

  return resolve;
}

/** Extensions already warned about, so a folder of fifty unknowns logs once. */
const warnedAssetExtensions = new Set<string>();

function warnUnknownAssetExtension(path: string): void {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext in ASSET_CLASSIFICATIONS || warnedAssetExtensions.has(ext)) return;
  warnedAssetExtensions.add(ext);
  console.warn(
    `[SoftN Web] No MIME type registered for .${ext}; serving as application/octet-stream`
  );
}

export function extractIconDataUrl(
  binaryFiles: Map<string, Uint8Array>,
  manifest: BundleManifest
): string | undefined {
  if (!manifest.icon) return undefined;

  // Reject paths with traversal or absolute references
  if (
    manifest.icon.includes('..') ||
    manifest.icon.startsWith('/') ||
    /^[a-zA-Z]:/.test(manifest.icon)
  ) {
    return undefined;
  }

  const iconData = binaryFiles.get(manifest.icon);
  if (!iconData) return undefined;

  const ext = manifest.icon.split('.').pop()?.toLowerCase() || 'png';
  // Allow safe image formats. SVG is safe here because icons are always
  // rendered via <img> tags, which never execute embedded scripts.
  const safeMimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
  };
  const mime = safeMimeTypes[ext];
  if (!mime) return undefined;

  // Convert Uint8Array to base64
  let binary = '';
  for (let i = 0; i < iconData.length; i++) {
    binary += String.fromCharCode(iconData[i]);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
