/**
 * Bundle Processing — extracted from softn-loader/src/App.tsx
 *
 * Pure functions for reading .softn ZIP bundles, loading XDB data,
 * and resolving imports/logic into a single renderable source string.
 * No Tauri dependencies — uses only browser APIs.
 */

import {
  getXDB,
  openBundleArchive,
  classifyAsset,
  ASSET_CLASSIFICATIONS,
  parseXDBFile,
  seedXDBBundleData,
  composeBundleSource,
  inspectDeclaration,
} from '@softn/core';
import type { BundleArchive, PermissionConfig } from '@softn/core';

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

/**
 * The bundle's binary entries, read from the archive when first asked for.
 *
 * Shaped like the `Map<string, Uint8Array>` it replaces so the callers that
 * only ever `get` one path — the asset resolver, the icon — need not change,
 * and so a plain Map still stands in for it in tests. The difference is when
 * the bytes exist: `get` inflates and verifies an entry on its first call and
 * returns the same bytes after; `keys`, `has`, `size` and `declaredSize` come
 * from the index and read nothing. Iterating — `entries`, `forEach`, the
 * iterator — reads every entry, which is what iterating a Map of bytes meant
 * too; it is here for compatibility, not for a first screen.
 */
export interface BundleBinaryStore {
  get(path: string): Uint8Array | undefined;
  has(path: string): boolean;
  keys(): IterableIterator<string>;
  readonly size: number;
  entries(): IterableIterator<[string, Uint8Array]>;
  forEach(callback: (bytes: Uint8Array, path: string, store: BundleBinaryStore) => void): void;
  [Symbol.iterator](): IterableIterator<[string, Uint8Array]>;
  /** What `get(path)` will hold, from the central directory, without reading it. */
  declaredSize(path: string): number | undefined;
  /** Whether `get(path)` would return without inflating. */
  isRead(path: string): boolean;
  /** Drop every byte read so far and the archive they came from; see BundleArchive. */
  release(): void;
}

/** What a reader of single binary entries needs: a store, or a Map in a test. */
export type BundleBinaryReader = Pick<BundleBinaryStore, 'get'> &
  Partial<Pick<BundleBinaryStore, 'release'>>;

export interface ZipResult {
  textFiles: Map<string, string>;
  binaryFiles: BundleBinaryStore;
  /** The index both maps read through; `binaryFiles.release()` releases it. */
  archive: BundleArchive;
}

// ── Helpers ──────────────────────────────────────────────────────────

function isBinaryFile(fileName: string): boolean {
  // The extension list lived here, in softn-loader, in core and in the demo
  // build script, and the four disagreed. @softn/core's registry is the only
  // copy now.
  return classifyAsset(fileName).binary;
}

/**
 * Phase boundaries for scripts/bench/measure.mjs, which pairs each
 * `softn:<phase>:start` with its `:end` and sums a phase that runs more than
 * once. Guarded because the runtime is also rendered where the User Timing
 * API is absent or stubbed.
 */
function mark(name: string): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark(name);
  }
}

function createBinaryStore(archive: BundleArchive, names: string[]): BundleBinaryStore {
  const index = new Set(names);
  const read = (path: string): Uint8Array | undefined => {
    if (!index.has(path)) return undefined;
    if (archive.isRead(path)) return archive.read(path);
    // Only a read that inflates is a phase; a memo hit is a lookup.
    mark('softn:asset-extract:start');
    try {
      return archive.read(path);
    } finally {
      mark('softn:asset-extract:end');
    }
  };
  const store: BundleBinaryStore = {
    get: read,
    has: (path) => index.has(path),
    keys: () => index.values(),
    get size() {
      return index.size;
    },
    declaredSize: (path) => (index.has(path) ? archive.declaredSize(path) : undefined),
    isRead: (path) => index.has(path) && archive.isRead(path),
    release: () => archive.release(),
    *entries() {
      for (const path of index) yield [path, read(path) as Uint8Array];
    },
    forEach(callback) {
      for (const [path, bytes] of store.entries()) callback(bytes, path, store);
    },
    [Symbol.iterator]() {
      return store.entries();
    },
  };
  return store;
}

// ── Core Functions ───────────────────────────────────────────────────

/**
 * Open a bundle: validate its directory, read its text, index its binaries.
 *
 * Validation lives in @softn/core so all three readers share it. This file
 * and softn-loader each carried their own copy — identical today, but two
 * copies of a security check are two chances to fix only one — and the
 * builder had none at all.
 *
 * Text entries are read here because the composer needs all of them before
 * anything renders, and they are small. Binary entries are only indexed:
 * an image or a model is inflated — and checksummed — on the first `get`
 * that asks for it, which for most of a large bundle is never. A corrupt
 * binary entry therefore no longer fails the open; it fails the read that
 * touches it, and the asset resolves to nothing. The bytes are never handed
 * on unverified either way.
 */
export function readZip(data: Uint8Array): ZipResult {
  const archive = openBundleArchive(data);
  const textFiles = new Map<string, string>();
  const binaryNames: string[] = [];
  const decoder = new TextDecoder();

  for (const name of archive.names()) {
    if (isBinaryFile(name)) {
      binaryNames.push(name);
    } else {
      textFiles.set(name, decoder.decode(archive.read(name)));
      // The string is what everything downstream reads; the bytes it was
      // decoded from would be a second copy held for nothing, and for the
      // text-classified formats that are not small — a .obj or a .gltf of
      // tens of megabytes — the bytes plus a UTF-16 string is three times
      // the file. Nothing reads text through the archive after this.
      archive.forget(name);
    }
  }

  console.log('[SoftN Web] Loaded files:', Array.from(textFiles.keys()));

  return { textFiles, binaryFiles: createBinaryStore(archive, binaryNames), archive };
}

/**
 * Paths named by `asset("…")` calls with a string literal, in source order.
 *
 * A deliberately narrow scan over the composed .ui/.logic text: only a call
 * whose sole argument is one quoted string, so `asset(path)`, `asset(base +
 * name)` and `asset(list[i])` contribute nothing. Those are read on demand
 * when the app evaluates them; guessing at them here would inflate branches
 * the first screen never takes.
 */
export function collectAssetLiterals(source: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(/\basset\(\s*(["'])([^"'\n]+)\1\s*\)/g)) {
    const path = match[2].replace(/^\.\//, '');
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * How much of a bundle the first-screen warm-up may inflate ahead of the app.
 *
 * Bounds, not targets. A warm-up reads what the composed source names by
 * literal, then the manifest's asset list, in that order, and stops at the
 * first path that would take it past either figure: 32 entries is more
 * images than a first screen shows, and 64 MB of decoded assets is more than
 * a first screen can upload to the GPU before the user has seen anything.
 * Whatever is past the bound is read when it is asked for, exactly as a
 * dynamic path is.
 */
export const FIRST_SCREEN_WARM_MAX_ENTRIES = 32;
export const FIRST_SCREEN_WARM_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The binary entries worth inflating before the app asks, cut at the
 * first-screen bounds: the literal `asset()` paths of the composed source
 * first, then whatever of `manifest.files.assets` fits, in the manifest's
 * order, skipping what the bundle lacks, has already read, or classes as
 * text.
 *
 * The literal scan alone covered almost nothing shipped: of the sixteen
 * `asset()` calls across the bundles in public/ and public/demos, six are
 * literals, all in one bundle; the rest build their paths — `asset(item.src)`,
 * `asset(base + name)` — so the bundles with the most to inflate (GFXX-Anika,
 * twelve binaries and 51 MB; PromptlyUnemployed, seventy-one) inflated every
 * asset synchronously on the main thread on first use, which is what the
 * worker exists to avoid. The manifest list is the author's, in the author's
 * order, so the first screen's assets can be listed first and the bounds do
 * the rest — and a manifest that lists only its icon, as PromptlyUnemployed's
 * does, gets exactly what it lists.
 *
 * The icon is not a candidate: both hosts extract it before they ask for this
 * list, so it is read already, or never will be (softn-single refuses one
 * over 256 KB by declared size and would have warmed it for nothing).
 */
export function firstScreenAssets(
  source: string,
  manifest: Pick<Partial<BundleManifest>, 'files'>,
  binaryFiles: Pick<BundleBinaryStore, 'has' | 'isRead' | 'declaredSize'>
): string[] {
  const candidates = collectAssetLiterals(source);
  for (const path of manifest.files?.assets ?? []) {
    if (typeof path === 'string') candidates.push(path.replace(/^\.\//, ''));
  }

  const chosen: string[] = [];
  const seen = new Set<string>();
  let declared = 0;
  for (const path of candidates) {
    if (seen.has(path) || !binaryFiles.has(path) || binaryFiles.isRead(path)) continue;
    const size = binaryFiles.declaredSize(path) ?? 0;
    if (chosen.length >= FIRST_SCREEN_WARM_MAX_ENTRIES) break;
    if (declared + size > FIRST_SCREEN_WARM_MAX_BYTES) break;
    seen.add(path);
    chosen.push(path);
    declared += size;
  }
  return chosen;
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
        // `redirect: 'error'` makes the browser reject the fetch at the first
        // redirect response, so the hop's target is never requested. Checking
        // the final URL afterwards, as this used to, only found out about a
        // forbidden host after the request had already reached it.
        const response = await fetch(requestedUrl.href, {
          signal: controller.signal,
          redirect: 'error',
        });
        if (disposed) {
          controller.abort();
          await cancelBody(response);
          return null;
        }
        if (!response.ok) {
          await cancelBody(response);
          return null;
        }

        // Kept beside `redirect: 'error'` as defence in depth: the option
        // refuses a redirect, but a fetch can report a final URL that differs
        // from the requested one without any redirect having happened (a
        // service worker answering for another origin), and a host that
        // ignores the option would otherwise hand the import to a host the
        // user did not approve.
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
 * The list itself is the schema in `@softn/core` — one list for the runtime's
 * enforcement, this launcher's consent, the directory's inspection and its
 * pages — re-exported here because the consent check, the grant record and
 * the bar's wording all read it from this module. PermissionBar keys its
 * phrasing off `Capability`, so a name added to the schema without words here
 * fails the build instead of shipping a bar that says "a capability called
 * \"webusb\"".
 */
export { CAPABILITIES } from '@softn/core';
export type { Capability } from '@softn/core';

export function requestedCapabilities(config: PermissionConfig): string[] {
  return inspectDeclaration(config).requested;
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
  /**
   * The bundle path an object URL was minted for; undefined for a URL this
   * resolver did not make, and for everything once disposed. A model loader
   * handed `blob:…` for a .gltf cannot find the buffers and images the file
   * names beside itself from that URL; this gives it back the archive
   * directory to resolve them against.
   */
  pathOf(url: string): string | undefined;
  dispose(): void;
}

export function createAssetResolver(
  binaryFiles: BundleBinaryReader,
  textFiles: Map<string, string>
): AssetResolver {
  const urls = new Map<string, string>();
  // The reverse of `urls`, so `pathOf` is a lookup rather than a scan of every
  // asset the app has touched.
  const paths = new Map<string, string>();
  // Entries the bundle holds but cannot produce — a checksum that does not
  // match — so a template asking for a broken image on every render neither
  // re-reads it nor logs it again.
  const unreadable = new Set<string>();
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
    if (unreadable.has(path)) return '';

    // A MIME miss used to return '' here, so a .glb whose bytes were sitting
    // in the bundle resolved to an empty URL with nothing logged. An unknown
    // format is served as opaque bytes instead, and says so once.
    const { mime } = classifyAsset(path);
    warnUnknownAssetExtension(path);

    // A demand read: the entry is inflated and checksummed here if this is
    // the first time anything asked for it. The read is synchronous because
    // this function is — templates call asset() and use the result in the
    // same expression — and it must stay so until host components can take
    // an asynchronous asset descriptor instead.
    let binary: Uint8Array | undefined;
    try {
      binary = binaryFiles.get(path);
    } catch (err) {
      unreadable.add(path);
      console.error(`[SoftN Web] Asset ${path} could not be read from the bundle:`, err);
      return '';
    }
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
      paths.set(url, path);
      return url;
    } catch {
      return '';
    }
  }) as AssetResolver;

  resolve.pathOf = (url: string) => paths.get(url);

  resolve.dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
    paths.clear();
    unreadable.clear();
    // The resolver is the last reader of the archive a tab holds, so its
    // disposal is when the archive's bytes — and every entry inflated from
    // them — can go. A warm-up still in flight sees the release at its next
    // step and stops.
    binaryFiles.release?.();
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
  binaryFiles: Pick<BundleBinaryStore, 'get'>,
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

  // One demand read. A corrupt icon is a missing icon, not a failed open.
  let iconData: Uint8Array | undefined;
  try {
    iconData = binaryFiles.get(manifest.icon);
  } catch (err) {
    console.error(`[SoftN Web] Icon ${manifest.icon} could not be read from the bundle:`, err);
    return undefined;
  }
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
