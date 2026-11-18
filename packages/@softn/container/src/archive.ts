/**
 * Zero-Config `.softn` Container Archive & Virtual File System (`https://app.softn.local/`).
 *
 * Supports:
 * 1. Standard `.softn` ZIP archives (with or without `manifest.json` / `permission.json`)
 * 2. Zipped `dist/` folders where all files share a single top-level directory prefix (`dist/index.html` -> `index.html`)
 * 3. Unpacked file maps (`Record<string, string | Uint8Array>`)
 * 4. Automatic detection of legacy v1 `.ui` bundles (`mode: 'legacy-ui'`) vs standard HTML web apps (`mode: 'web'`)
 */

import { openBundleArchive, sha256Hex, type BundleArchive } from '@softn/bundle-format';
import { readWebImportMap } from '@softn/bundle-format/web-imports';
import { checkSourceModules, compiledSourcePath, GENERATED_SOURCE_HEADER } from '@softn/bundle-format/source-modules';
import { inspectDeclaration, type Capability } from '@softn/bundle-format/capabilities';
import type { ContainerManifest, ContainerMode, ContainerPermissions } from './types';

export const VIRTUAL_ORIGIN = 'https://app.softn.local';

/** The address of a blob the app's script made (`URL.createObjectURL`), and the id in it. */
export const RUNTIME_BLOB_URL = /^blob:https:\/\/app\.softn\.local\/([\w-]{1,64})$/;

/** The most blobs an app may have an address for at once, and the most bytes they may hold together. */
const MAX_RUNTIME_BLOBS = 512;
const MAX_RUNTIME_BLOB_BYTES = 64 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'mts', 'tsx', 'jsx', 'vue',
  'py', 'json', 'importmap', 'svg', 'txt', 'md', 'csv', 'xml', 'ui',
  'logic', 'xdb', 'wgsl', 'glsl', 'vert', 'frag', 'obj', 'mtl', 'gltf',
]);

const MIME_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  ts: 'text/typescript; charset=utf-8',
  tsx: 'text/tsx; charset=utf-8',
  jsx: 'text/jsx; charset=utf-8',
  vue: 'text/plain; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  wasm: 'application/wasm',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
};

function extOf(path: string): string {
  const clean = path.split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
}

export function mimeTypeFor(path: string): string {
  return MIME_TYPES[extOf(path)] ?? 'application/octet-stream';
}

export function isTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.has(extOf(path));
}

/** Only script loading substitutes compiled JavaScript. Reading the file as data returns its authored source. */
export function readRunnableModule(path: string, read: (file: string) => string | null | undefined): string | null {
  const original = read(path);
  if (original == null) return null;
  const sidecar = compiledSourcePath(path);
  const generated = sidecar && read(sidecar);
  return generated?.startsWith(GENERATED_SOURCE_HEADER) ? generated : original;
}

/** Normalize a relative or virtual-origin URL to a clean VFS path (`assets/app.js`), or `null` if external/escaped. */
export function resolveVfsPath(input: string, basePath = 'index.html'): string | null {
  const raw = String(input ?? '').trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('javascript:')) {
    return null;
  }

  let pathname = raw;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith('//')) {
    try {
      const parsed = new URL(raw, VIRTUAL_ORIGIN + '/');
      if (parsed.origin !== VIRTUAL_ORIGIN) return null;
      pathname = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    pathname = raw.split(/[?#]/)[0].replace(/\\/g, '/');
  }

  let combined: string;
  if (pathname.startsWith('/')) {
    combined = pathname.slice(1);
  } else {
    const cleanBase = basePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const slash = cleanBase.lastIndexOf('/');
    const dir = slash >= 0 ? cleanBase.slice(0, slash + 1) : '';
    combined = dir + pathname;
  }

  const segments = combined.split('/');
  const resolved: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (resolved.length === 0) return null; // Escapes container root
      resolved.pop();
      continue;
    }
    try {
      resolved.push(decodeURIComponent(seg));
    } catch {
      resolved.push(seg);
    }
  }
  return resolved.length > 0 ? resolved.join('/') : null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Detect when all archive entries sit inside a single top-level wrapper folder
 * (e.g. `zip -r app.softn dist/`) with no root-level `manifest.json` or `index.html`.
 */
function detectSingleRootPrefix(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.includes('manifest.json') || names.includes('index.html') || names.includes('ui/main.ui')) {
    return '';
  }
  let candidate: string | null = null;
  for (const name of names) {
    const slash = name.indexOf('/');
    if (slash <= 0) return ''; // Root-level file exists -> don't strip
    const prefix = name.slice(0, slash + 1);
    if (candidate === null) candidate = prefix;
    else if (candidate !== prefix) return '';
  }
  return candidate && !isServerFile(candidate) ? candidate : '';
}

/** Backend sources and SQLite migrations belong to the owner project, outside the guest VFS. */
function isServerFile(path: string): boolean {
  return /^(?:__softn_generated__\/)?(?:server|backend|private)\//i.test(path) || /\.sql$/i.test(path);
}

function extractHtmlHeadMeta(html: string): { title?: string; icon?: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : undefined;

  const iconMatch = /<link\b[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*href=["']([^"']+)["'][^>]*>/i.exec(html)
    ?? /<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*>/i.exec(html);
  const icon = iconMatch ? iconMatch[1].trim() : undefined;

  return { title, icon };
}

export class ContainerArchive {
  readonly digest: string;
  readonly manifest: ContainerManifest;
  readonly permissions: ContainerPermissions;
  readonly requestedCapabilities: Capability[];

  private readonly zipArchive: BundleArchive | null;
  private readonly rawPrefix: string;
  private readonly normalizedNames: Set<string>;
  private readonly textCache = new Map<string, string>();
  private readonly binaryCache = new Map<string, Uint8Array>();
  private readonly blobUrls = new Map<string, string>();
  /** Blobs the app's script made an address for (`URL.createObjectURL`), by the address's id. */
  private readonly runtimeBlobs = new Map<string, { bytes: Uint8Array; type: string; url: string | null }>();
  private runtimeBlobBytes = 0;
  private disposed = false;

  private constructor(params: {
    digest: string;
    manifest: ContainerManifest;
    permissions: ContainerPermissions;
    requestedCapabilities: Capability[];
    zipArchive: BundleArchive | null;
    rawPrefix: string;
    normalizedNames: Set<string>;
    initialText: Map<string, string>;
    initialBinary: Map<string, Uint8Array>;
  }) {
    this.digest = params.digest;
    this.manifest = params.manifest;
    this.permissions = params.permissions;
    this.requestedCapabilities = params.requestedCapabilities;
    this.zipArchive = params.zipArchive;
    this.rawPrefix = params.rawPrefix;
    this.normalizedNames = params.normalizedNames;
    for (const [k, v] of params.initialText) this.textCache.set(k, v);
    for (const [k, v] of params.initialBinary) this.binaryCache.set(k, v);
  }

  /** Open a `.softn` container from ZIP bytes or an unpacked file map. */
  static async open(
    input: Uint8Array | ArrayBuffer | Record<string, string | Uint8Array>,
    fallbackName = 'SoftN App'
  ): Promise<ContainerArchive> {
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      const digest = await sha256Hex(bytes);
      const zipArchive = openBundleArchive(bytes);
      const rawNames = zipArchive.names();
      const rawPrefix = detectSingleRootPrefix(rawNames);
      const normalizedNames = new Set<string>();
      const initialText = new Map<string, string>();
      const decoder = new TextDecoder();

      for (const rawName of rawNames) {
        const norm = rawPrefix && rawName.startsWith(rawPrefix) ? rawName.slice(rawPrefix.length) : rawName;
        if (!norm || isServerFile(norm)) continue;
        normalizedNames.add(norm);
        if (isTextPath(norm)) {
          const entryBytes = zipArchive.read(rawName);
          if (entryBytes) {
            initialText.set(norm, decoder.decode(entryBytes));
            zipArchive.forget(rawName);
          }
        }
      }

      await checkSourceModules(initialText);
      const { manifest, permissions, requestedCapabilities } = buildContainerMeta(
        normalizedNames,
        initialText,
        digest,
        fallbackName
      );

      return new ContainerArchive({
        digest,
        manifest,
        permissions,
        requestedCapabilities,
        zipArchive,
        rawPrefix,
        normalizedNames,
        initialText,
        initialBinary: new Map(),
      });
    }

    // Unpacked file map
    const rawKeys = Object.keys(input).map((k) => k.replace(/\\/g, '/').replace(/^\/+/, ''));
    const rawPrefix = detectSingleRootPrefix(rawKeys);
    const normalizedNames = new Set<string>();
    const initialText = new Map<string, string>();
    const initialBinary = new Map<string, Uint8Array>();
    const hashParts: string[] = [];
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    for (const [origKey, val] of Object.entries(input)) {
      const cleanKey = origKey.replace(/\\/g, '/').replace(/^\/+/, '');
      const norm = rawPrefix && cleanKey.startsWith(rawPrefix) ? cleanKey.slice(rawPrefix.length) : cleanKey;
      if (!norm) continue;
      // Preserve the identity used for storage when the author includes server files.
      hashParts.push(`${norm}:${typeof val === 'string' ? val.length : val.byteLength}`);
      if (isServerFile(norm)) continue;
      normalizedNames.add(norm);
      if (typeof val === 'string') {
        initialText.set(norm, val);
      } else {
        if (isTextPath(norm)) {
          initialText.set(norm, decoder.decode(val));
        } else {
          initialBinary.set(norm, val);
        }
      }
    }

    const digest = await sha256Hex(encoder.encode(hashParts.sort().join('|')));
    await checkSourceModules(initialText);
    const { manifest, permissions, requestedCapabilities } = buildContainerMeta(
      normalizedNames,
      initialText,
      digest,
      fallbackName
    );

    return new ContainerArchive({
      digest,
      manifest,
      permissions,
      requestedCapabilities,
      zipArchive: null,
      rawPrefix,
      normalizedNames,
      initialText,
      initialBinary,
    });
  }

  has(path: string): boolean {
    const resolved = resolveVfsPath(path);
    return resolved !== null && this.normalizedNames.has(resolved);
  }

  names(): string[] {
    return [...this.normalizedNames];
  }

  readText(path: string, basePath?: string): string | null {
    const resolved = resolveVfsPath(path, basePath);
    if (!resolved || !this.normalizedNames.has(resolved)) return null;
    const cached = this.textCache.get(resolved);
    if (cached !== undefined) return cached;
    const bytes = this.readBytes(resolved);
    if (!bytes) return null;
    const decoded = new TextDecoder().decode(bytes);
    this.textCache.set(resolved, decoded);
    return decoded;
  }

  readBytes(path: string, basePath?: string): Uint8Array | null {
    if (this.disposed) return null;
    const resolved = resolveVfsPath(path, basePath);
    if (!resolved || !this.normalizedNames.has(resolved)) return null;
    const cachedBin = this.binaryCache.get(resolved);
    if (cachedBin) return cachedBin;
    const cachedText = this.textCache.get(resolved);
    if (cachedText !== undefined) return new TextEncoder().encode(cachedText);
    if (!this.zipArchive) return null;
    const rawName = this.rawPrefix + resolved;
    const inflated = this.zipArchive.read(rawName);
    if (!inflated) return null;
    this.binaryCache.set(resolved, inflated);
    return inflated;
  }

  /**
   * An address the page can load a file of the app's from: a `blob:` URL, minted once.
   *
   * A `blob:` URL made here belongs to the embedding page's origin, and a browser opens one
   * as a document when the person asks it to ("Open image in new tab", a link opened in a
   * tab). So a file that a browser would run as a document is never given one in that form:
   *
   *   - an SVG is a `data:` URL: it still draws as an image, where its scripts never run,
   *     and a browser will not open a `data:` address as a page;
   *   - HTML and XML are plain text. Nothing loads the app's pages from an address (the
   *     container reads them from the archive), so this only answers an app that points an
   *     image or a media element at one.
   *
   * v0.0.43 gave each its own type, and an app's `picture.svg` opened in a new tab ran its
   * script as the embedding site.
   */
  getBlobUrl(path: string, basePath?: string): string | null {
    if (this.disposed || typeof URL.createObjectURL !== 'function') return null;
    const resolved = resolveVfsPath(path, basePath);
    if (!resolved || !this.normalizedNames.has(resolved)) return null;
    const existing = this.blobUrls.get(resolved);
    if (existing) return existing;
    const bytes = this.readBytes(resolved);
    if (!bytes) return null;
    const url = this.mintUrl(bytes, mimeTypeFor(resolved));
    this.blobUrls.set(resolved, url);
    return url;
  }

  /** An address the page can load `bytes` from, by the rule above: never one a browser would open as a document. */
  private mintUrl(bytes: Uint8Array, type: string): string {
    if (/^image\/svg\+xml/i.test(type)) return `data:image/svg+xml;base64,${bytesToBase64(bytes)}`;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const inert = /^(?:text\/html|application\/xhtml\+xml|application\/xml|text\/xml)/i.test(type) ? 'text/plain; charset=utf-8' : type;
    return URL.createObjectURL(new Blob([copy], { type: inert }));
  }

  /**
   * Keep a blob the app's script made an address for. It is the page's memory, so there is
   * a most of them and a most of their bytes together; past either the blob is not kept, and
   * its address names nothing.
   */
  putRuntimeBlob(id: string, type: string, bytes: Uint8Array): boolean {
    if (this.disposed || !/^[\w-]{1,64}$/.test(id) || this.runtimeBlobs.has(id)) return false;
    if (this.runtimeBlobs.size >= MAX_RUNTIME_BLOBS || this.runtimeBlobBytes + bytes.byteLength > MAX_RUNTIME_BLOB_BYTES) return false;
    // Its type as a type and nothing else: it ends up in an address.
    const clean = /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type.toLowerCase() : 'application/octet-stream';
    this.runtimeBlobs.set(id, { bytes, type: clean, url: null });
    this.runtimeBlobBytes += bytes.byteLength;
    return true;
  }

  /** The address the page loads a kept blob from, minted when first asked for; null for one that is not kept. */
  getRuntimeBlobUrl(id: string): string | null {
    const kept = this.runtimeBlobs.get(id);
    if (!kept || this.disposed || typeof URL.createObjectURL !== 'function') return null;
    if (kept.url === null) kept.url = this.mintUrl(kept.bytes, kept.type);
    return kept.url;
  }

  /** A kept blob's bytes and type, for the host to save at the person's word; null for one that is not kept. */
  getRuntimeBlob(id: string): { bytes: Uint8Array; type: string } | null {
    const kept = this.runtimeBlobs.get(id);
    return kept && !this.disposed ? { bytes: kept.bytes, type: kept.type } : null;
  }

  /** Let a kept blob go (`URL.revokeObjectURL`). */
  dropRuntimeBlob(id: string): void {
    const kept = this.runtimeBlobs.get(id);
    if (!kept) return;
    this.runtimeBlobs.delete(id);
    this.runtimeBlobBytes -= kept.bytes.byteLength;
    if (kept.url && kept.url.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') {
      try {
        URL.revokeObjectURL(kept.url);
      } catch {
        // Ignore revoke errors
      }
    }
  }

  /**
   * The app's files as the Worker holds them: text as text, everything else as its bytes.
   *
   * The bytes are the archive's own, not copies: a Worker is sent copies by `postMessage`,
   * and a session in the page reads them where they are. They used to be written out as
   * base64 here, on the page's thread and again for every page the app showed: an app with
   * 20 MB of pictures cost the embedding page 27 MB of text each time, for files its script
   * almost never reads (a picture is drawn from the archive by the page). The Worker now
   * makes the text when a script asks for a file.
   */
  exportWorkerVfs(): { textFiles: Record<string, string>; binaryFiles: Record<string, Uint8Array> } {
    // No prototype: a file may be called `constructor` or `__proto__`.
    const textFiles: Record<string, string> = Object.create(null);
    const binaryFiles: Record<string, Uint8Array> = Object.create(null);
    for (const name of this.normalizedNames) {
      if (this.textCache.has(name)) {
        textFiles[name] = this.textCache.get(name)!;
      } else {
        const bytes = this.readBytes(name);
        if (bytes) binaryFiles[name] = bytes;
      }
    }
    return { textFiles, binaryFiles };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof URL.revokeObjectURL === 'function') {
      for (const url of this.blobUrls.values()) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // Ignore revoke errors
        }
      }
    }
    this.blobUrls.clear();
    for (const id of [...this.runtimeBlobs.keys()]) this.dropRuntimeBlob(id);
    this.binaryCache.clear();
    this.zipArchive?.release();
  }
}

/**
 * Returns `true` when an `.html` file actually contains legacy v1 SoftN template
 * DSL (`<logic>`, `<import Foo from="...">`, `<data><collection>`, `#if`/`#each`,
 * or a bare `<App>` component tree without `<!DOCTYPE html>`).
 */
export function isLegacySoftNMarkup(source: string): boolean {
  if (!source) return false;
  if (/<logic[\s>]|<import\s+[A-Z]\w*\s+from\s*=|<data>\s*<collection\b|^\s*#(?:if|each)\b/m.test(source)) {
    return true;
  }
  if (!/<!doctype\s+html/i.test(source) && !/<html[\s>]/i.test(source) && /<App[\s>]/.test(source)) {
    return true;
  }
  return false;
}

function buildContainerMeta(
  names: ReadonlySet<string>,
  texts: Map<string, string>,
  digest: string,
  fallbackName: string
): {
  manifest: ContainerManifest;
  permissions: ContainerPermissions;
  requestedCapabilities: Capability[];
} {
  let rawManifest: Record<string, unknown> | null = null;
  const manifestText = texts.get('manifest.json');
  if (manifestText) {
    try {
      const parsed = JSON.parse(manifestText) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rawManifest = parsed as Record<string, unknown>;
        if (Object.hasOwn(rawManifest, 'server')) {
          delete rawManifest.server;
          texts.set('manifest.json', JSON.stringify(rawManifest));
        }
      }
    } catch {
      throw new Error('Malformed manifest.json in .softn container');
    }
  }

  // Entry file discovery (explicit manifest -> root index.html -> sole root .html -> legacy .ui)
  let main = typeof rawManifest?.main === 'string' ? rawManifest.main.replace(/^\/+/, '') : '';
  if (!main || !names.has(main)) {
    if (names.has('index.html')) main = 'index.html';
    else if (names.has('app.html')) main = 'app.html';
    else {
      const rootHtml = [...names].filter((n) => !n.includes('/') && /\.html?$/i.test(n));
      if (rootHtml.length >= 1) main = rootHtml.sort()[0];
      else if (names.has('ui/main.ui')) main = 'ui/main.ui';
      else if (names.has('main.ui')) main = 'main.ui';
      else {
        const anyHtml = [...names].filter((n) => /\.html?$/i.test(n)).sort();
        if (anyHtml.length > 0) main = anyHtml[0];
      }
    }
  }

  if (!main || !names.has(main)) {
    throw new Error('Container has no entry point (expected index.html or manifest.json "main")');
  }

  const rawEntryText = texts.get(main) ?? '';
  const explicitV2 =
    rawManifest === null ||
    rawManifest.engine === 2 ||
    rawManifest.container === true;
  const mode: ContainerMode = /\.ui$/i.test(main)
    ? 'legacy-ui'
    : !explicitV2 && isLegacySoftNMarkup(rawEntryText)
      ? 'legacy-ui'
      : 'web';
  const entryHtml = mode === 'web' ? rawEntryText : '';
  const htmlMeta = entryHtml ? extractHtmlHeadMeta(entryHtml) : {};
  const manifestImports = readWebImportMap(entryHtml, rawManifest?.imports);

  const config =
    rawManifest?.config && typeof rawManifest.config === 'object'
      ? (rawManifest.config as Record<string, unknown>)
      : undefined;
  const pythonCfg =
    config?.python && typeof config.python === 'object'
      ? (config.python as { packages?: unknown })
      : undefined;
  const pythonPackages = Array.isArray(pythonCfg?.packages)
    ? pythonCfg.packages.filter((p): p is string => typeof p === 'string')
    : undefined;

  const themeObj =
    config?.theme && typeof config.theme === 'object'
      ? (config.theme as { mode?: unknown })
      : undefined;
  const themeMode =
    themeObj?.mode === 'dark' || themeObj?.mode === 'light'
      ? themeObj.mode
      : rawManifest?.theme === 'dark' || rawManifest?.theme === 'light'
        ? rawManifest.theme
        : undefined;

  const name =
    (typeof rawManifest?.name === 'string' && rawManifest.name.trim()) ||
    htmlMeta.title ||
    fallbackName;
  const id =
    (typeof rawManifest?.id === 'string' && rawManifest.id.trim()) ||
    `softn-${digest.slice(0, 16)}`;
  const version =
    typeof rawManifest?.version === 'string'
      ? rawManifest.version
      : typeof rawManifest?.version === 'number'
        ? String(rawManifest.version)
        : '1.0.0';
  const icon =
    (typeof rawManifest?.icon === 'string' && rawManifest.icon) ||
    htmlMeta.icon ||
    (names.has('favicon.svg') ? 'favicon.svg' : names.has('favicon.ico') ? 'favicon.ico' : undefined);

  const manifest: ContainerManifest = {
    id,
    name,
    version,
    main,
    icon,
    mode,
    inferred: rawManifest === null,
    importMap: manifestImports,
    pythonPackages,
    theme: themeMode,
    raw: rawManifest ?? undefined,
  };

  // Permissions (`permission.json` -> legacy `manifest.permissions` -> zero-egress default `{}`)
  let permissions: ContainerPermissions = { permissions: {} };
  const permText = texts.get('permission.json');
  if (permText && permText.trim()) {
    try {
      const parsed = JSON.parse(permText) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        permissions = parsed as ContainerPermissions;
      }
    } catch {
      permissions = { permissions: {} };
    }
  } else if (rawManifest?.permissions && typeof rawManifest.permissions === 'object') {
    const leg = rawManifest.permissions as Record<string, unknown>;
    permissions = {
      permissions: {
        ...(leg.network ? { net: { enabled: true } } : {}),
        ...(leg.filesystem ? { files: { enabled: true } } : {}),
      },
    };
  }

  const report = inspectDeclaration(permissions);
  return {
    manifest,
    permissions,
    requestedCapabilities: report.requested,
  };
}
