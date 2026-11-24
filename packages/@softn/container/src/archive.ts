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
import { parseHtaccess, type ParsedHtaccess } from './htaccess';
import type {
  BackendConfig,
  BackendRuntimeKind,
  ContainerManifest,
  ContainerMode,
  ContainerPermissions,
  DatabaseConfig,
  VirtualDirEntry,
} from './types';

export const VIRTUAL_ORIGIN = 'https://app.softn.local';

/** The address of a blob the app's script made (`URL.createObjectURL`), and the id in it. */
export const RUNTIME_BLOB_URL = /^blob:https:\/\/app\.softn\.local\/([\w-]{1,64})$/;

/** The most blobs an app may have an address for at once, and the most bytes they may hold together. */
const MAX_RUNTIME_BLOBS = 512;
const MAX_RUNTIME_BLOB_BYTES = 64 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'mts', 'tsx', 'jsx', 'vue',
  'py', 'php', 'phtml', 'inc', 'tpl', 'rs', 'toml', 'sql', 'htaccess',
  'ini', 'env', 'yml', 'yaml', 'lock',
  'json', 'importmap', 'svg', 'txt', 'md', 'csv', 'xml', 'ui',
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
  const ext = extOf(path);
  return Object.hasOwn(MIME_TYPES, ext) ? MIME_TYPES[ext] : 'application/octet-stream';
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

const ARCHIVE_DECODER = new TextDecoder();
const ARCHIVE_ENCODER = new TextEncoder();
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

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
  for (const rawSeg of segments) {
    if (!rawSeg) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSeg);
    } catch {
      return null;
    }
    if (!decoded || decoded === '.') continue;
    // Reject decoded path separators or NUL bytes (`%2f`, `%5c`, `%00`) that could smuggle traversal.
    if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return null;
    if (decoded === '..') {
      if (resolved.length === 0) return null; // Escapes container root
      resolved.pop();
      continue;
    }
    resolved.push(decoded);
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

/** A piece of a blob as the app's side hands it over: base64, and (for a part of a file it picked) which of its bytes are the piece's. */
export interface BlobPiece {
  base64: string;
  skip?: number;
  take?: number;
}

/**
 * A blob's bytes from what the app's side hands over: one text of base64, or pieces of it
 * with the bytes of each to keep. (A part of a file the app picked is kept there as the text
 * the file came as, and made bytes here, where that is quick.) Null when it is neither.
 */
export function piecesToBytes(given: unknown): Uint8Array | null {
  if (typeof given === 'string') return base64ToBytes(given);
  if (!Array.isArray(given)) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  for (const piece of given as unknown[]) {
    if (!piece || typeof piece !== 'object' || typeof (piece as BlobPiece).base64 !== 'string') return null;
    const { base64, skip, take } = piece as BlobPiece;
    const from = typeof skip === 'number' && Number.isFinite(skip) && skip > 0 ? Math.floor(skip) : 0;
    const hasTake = typeof take === 'number' && Number.isFinite(take) && take >= 0;
    const wantedLen = hasTake ? Math.floor(take) : -1;
    if (wantedLen === 0) continue;
    // When slicing a clean standard base64 string without whitespace, decode only the 4-char
    // aligned window covering `[from, from + wantedLen)` instead of allocating the full file.
    if ((from > 0 || wantedLen >= 0) && base64.length > 0 && base64.length % 4 === 0 && !/\s/.test(base64)) {
      const startQuad = Math.floor(from / 3);
      const startChar = startQuad * 4;
      if (startChar >= base64.length) continue;
      const offsetInWindow = from - startQuad * 3;
      const endByte = wantedLen >= 0 ? from + wantedLen : Math.ceil((base64.length * 3) / 4);
      const endChar = Math.min(base64.length, Math.ceil(endByte / 3) * 4);
      const bytes = base64ToBytes(base64.slice(startChar, endChar));
      const sliceEnd = wantedLen >= 0 ? Math.min(bytes.length, offsetInWindow + wantedLen) : bytes.length;
      const part = bytes.subarray(offsetInWindow, Math.max(offsetInWindow, sliceEnd));
      parts.push(part);
      size += part.length;
    } else {
      const bytes = base64ToBytes(base64);
      const length = wantedLen >= 0 ? wantedLen : bytes.length - from;
      const part = bytes.subarray(from, from + Math.max(0, length));
      parts.push(part);
      size += part.length;
    }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** How many bytes the base64 of what `piecesToBytes` is handed comes to at most, without decoding it. */
export function piecesSize(given: unknown): number {
  if (typeof given === 'string') return Math.ceil((given.length * 3) / 4);
  if (!Array.isArray(given)) return 0;
  let size = 0;
  for (const piece of given as unknown[]) if (piece && typeof (piece as BlobPiece).base64 === 'string') size += Math.ceil(((piece as BlobPiece).base64.length * 3) / 4);
  return size;
}

/**
 * Detect when all archive entries sit inside a single top-level wrapper folder
 * (e.g. `zip -r app.softn dist/`) with no root-level `manifest.json` or `index.html`.
 */
function detectSingleRootPrefix(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (
    names.includes('manifest.json') ||
    names.includes('index.html') ||
    names.includes('index.php') ||
    names.includes('Cargo.toml') ||
    names.includes('ui/main.ui')
  ) {
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

/** Backend sources and SQLite migrations belong to the owner project, outside the guest VFS
 *  unless the archive declares an embedded v2 container backend (`manifest.backend`, `databases`,
 *  or zero-config PHP/Rust entry) that runs inside the sandboxed backend worker. */
function isServerFile(path: string, keepContainerBackend = false): boolean {
  if (/^(?:__softn_generated__\/)?private\//i.test(path)) return true;
  if (keepContainerBackend) return false;
  return /^(?:__softn_generated__\/)?(?:server|backend)\//i.test(path) || /\.sql$/i.test(path);
}

function hasEmbeddedContainerBackend(manifestText: string | null | undefined, names: readonly string[]): boolean {
  let declaresFormLogicServer = false;
  if (manifestText) {
    try {
      const parsed = JSON.parse(manifestText.replace(/^\uFEFF/, '')) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        if (parsed.backend && typeof parsed.backend === 'object' && !Array.isArray(parsed.backend)) return true;
        if (Array.isArray(parsed.databases) && parsed.databases.length > 0) return true;
        if (parsed.server && typeof parsed.server === 'object') declaresFormLogicServer = true;
      }
    } catch {
      // Malformed manifest handled later by buildContainerMeta
    }
  }
  if (declaresFormLogicServer || names.some((n) => /^server\/.*\.logic$/i.test(n))) return false;
  return names.some((n) =>
    n === 'index.php' ||
    n === 'Cargo.toml' ||
    n === 'schema.sql' ||
    n === 'seed.sql' ||
    /^(?:server|backend)\/(?:Cargo\.toml|index\.(?:php|js|mjs|ts)|server\.(?:js|mjs|ts|py)|app\.py|main\.py|src\/main\.rs)$/i.test(n) ||
    /^(?:db|database|migrations)\/[^/]+\.(?:json|sql)$/i.test(n)
  );
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
      const normalizedList = rawNames.map((n) => (rawPrefix && n.startsWith(rawPrefix) ? n.slice(rawPrefix.length) : n)).filter(Boolean);
      const manifestRawName = rawNames.find((n) => (rawPrefix && n.startsWith(rawPrefix) ? n.slice(rawPrefix.length) : n) === 'manifest.json');
      const peekManifestBytes = manifestRawName ? zipArchive.read(manifestRawName) : null;
      const keepBackend = hasEmbeddedContainerBackend(peekManifestBytes ? new TextDecoder().decode(peekManifestBytes) : null, normalizedList);
      const normalizedNames = new Set<string>();
      const initialText = new Map<string, string>();
      const decoder = new TextDecoder();

      for (const rawName of rawNames) {
        const norm = rawPrefix && rawName.startsWith(rawPrefix) ? rawName.slice(rawPrefix.length) : rawName;
        if (!norm || isServerFile(norm, keepBackend)) continue;
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

    // Unpacked file map — apply the same path-safety checks as ZIP entries.
    const isUnsafeMapKey = (key: string): boolean => {
      if (!key || key.includes('\0') || /^[a-zA-Z]:/.test(key) || key.startsWith('/') || key.endsWith('/')) return true;
      const segs = key.split('/');
      for (const s of segs) {
        if (!s || s === '.' || s === '..' || UNSAFE_PATH_SEGMENTS.has(s)) return true;
      }
      return false;
    };
    const rawKeys = Object.keys(input)
      .map((k) => k.replace(/\\/g, '/').replace(/^\/+/, ''))
      .filter((k) => !isUnsafeMapKey(k));
    const rawPrefix = detectSingleRootPrefix(rawKeys);
    const normalizedList = rawKeys.map((k) => (rawPrefix && k.startsWith(rawPrefix) ? k.slice(rawPrefix.length) : k)).filter(Boolean);
    let peekManifestText: string | null = null;
    for (const [origKey, val] of Object.entries(input)) {
      const cleanKey = origKey.replace(/\\/g, '/').replace(/^\/+/, '');
      if (isUnsafeMapKey(cleanKey)) continue;
      const norm = rawPrefix && cleanKey.startsWith(rawPrefix) ? cleanKey.slice(rawPrefix.length) : cleanKey;
      if (norm === 'manifest.json') {
        peekManifestText = typeof val === 'string' ? val : ARCHIVE_DECODER.decode(val);
        break;
      }
    }
    const keepBackend = hasEmbeddedContainerBackend(peekManifestText, normalizedList);
    const normalizedNames = new Set<string>();
    const initialText = new Map<string, string>();
    const initialBinary = new Map<string, Uint8Array>();
    const hashParts: string[] = [];

    for (const [origKey, val] of Object.entries(input)) {
      const cleanKey = origKey.replace(/\\/g, '/').replace(/^\/+/, '');
      if (isUnsafeMapKey(cleanKey)) continue;
      const norm = rawPrefix && cleanKey.startsWith(rawPrefix) ? cleanKey.slice(rawPrefix.length) : cleanKey;
      if (!norm || normalizedNames.has(norm)) continue;
      // Preserve the identity used for storage when the author includes server files.
      hashParts.push(`${norm}:${typeof val === 'string' ? val.length : val.byteLength}`);
      if (isServerFile(norm, keepBackend)) continue;
      normalizedNames.add(norm);
      if (typeof val === 'string') {
        initialText.set(norm, val);
      } else {
        if (isTextPath(norm)) {
          initialText.set(norm, ARCHIVE_DECODER.decode(val));
        } else {
          initialBinary.set(norm, val);
        }
      }
    }

    const digest = await sha256Hex(ARCHIVE_ENCODER.encode(hashParts.sort().join('|')));
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

  /** Resolve a path in this archive, falling back to `manifest.frontendRoot`, `/` -> main, and directory `index.html`. */
  resolveExistingPath(path: string, basePath?: string): string | null {
    const feRoot = this.manifest.frontendRoot
      ? this.manifest.frontendRoot.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      : '';
    const checkCandidate = (candidate: string | null): string | null => {
      if (!candidate) return null;
      if (this.normalizedNames.has(candidate)) return candidate;
      if (this.normalizedNames.has(`${candidate}/index.html`)) return `${candidate}/index.html`;
      if (this.normalizedNames.has(`${candidate}/index.htm`)) return `${candidate}/index.htm`;
      if (feRoot && !candidate.startsWith(`${feRoot}/`)) {
        const prefixed = resolveVfsPath(`${feRoot}/${candidate}`);
        if (prefixed) {
          if (this.normalizedNames.has(prefixed)) return prefixed;
          if (this.normalizedNames.has(`${prefixed}/index.html`)) return `${prefixed}/index.html`;
          if (this.normalizedNames.has(`${prefixed}/index.htm`)) return `${prefixed}/index.htm`;
        }
      }
      return null;
    };

    const resolved = resolveVfsPath(path, basePath);
    const direct = checkCandidate(resolved);
    if (direct) return direct;

    // Handle root path `/` (or `https://app.softn.local/` / `./` at root) -> manifest.main / index.html
    const raw = String(path ?? '').trim();
    if (raw && !raw.startsWith('#') && !raw.startsWith('data:') && !raw.startsWith('blob:') && !raw.startsWith('javascript:')) {
      try {
        const base = `${VIRTUAL_ORIGIN}/${(basePath ?? 'index.html').replace(/\\/g, '/').replace(/^\/+/, '')}`;
        const parsed = new URL(raw, base);
        if (parsed.origin === VIRTUAL_ORIGIN && parsed.pathname === '/') {
          if (this.manifest?.main && this.normalizedNames.has(this.manifest.main)) return this.manifest.main;
          return checkCandidate('index.html') ?? checkCandidate('index.htm');
        }
      } catch {
        // Ignore unparseable URL
      }
    }
    return null;
  }

  /** Map a normalized archive path into the frontend worker's VFS namespace (stripping `frontendRoot`). */
  toFrontendVfsPath(archivePath: string): string {
    const feRoot = this.manifest.frontendRoot
      ? this.manifest.frontendRoot.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/'
      : '';
    if (feRoot && archivePath.startsWith(feRoot)) {
      return archivePath.slice(feRoot.length);
    }
    return archivePath;
  }

  /** Resolve an archive path only if it belongs to the untrusted frontend (never backend/private files). */
  resolveFrontendExistingPath(path: string, basePath?: string): string | null {
    const resolved = this.resolveExistingPath(path, basePath);
    if (!resolved || !this.isFrontendPath(resolved)) return null;
    return resolved;
  }

  /** Paths explicitly declared as backend entry or database files/seeds in `manifest.json`. */
  private isManifestPrivatePath(archivePath: string): boolean {
    const norm = archivePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    const entry = this.manifest.backend?.entry?.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    if (entry && norm === entry) return true;
    const dbs = this.manifest.databases;
    if (Array.isArray(dbs)) {
      for (const db of dbs) {
        const candidates = [db.file, db.seedSql, typeof db.seedJson === 'string' ? db.seedJson : undefined];
        for (const c of candidates) {
          if (typeof c === 'string' && c.length > 0 && !c.trimStart().startsWith('{') && !c.trimStart().startsWith('[')) {
            const cn = c.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
            if (cn && (norm === cn || norm === `${cn}-wal` || norm === `${cn}-shm` || norm === `${cn}-journal`)) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  /** Redact backend secrets (`backend.env`, inline database seeds) from `manifest.json` before exposing to frontend. */
  private redactManifestForFrontend(rawText: string): string {
    try {
      const parsed = JSON.parse(rawText) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rawText;
      let changed = false;
      if (parsed.backend && typeof parsed.backend === 'object' && !Array.isArray(parsed.backend)) {
        const safeBackend = { ...(parsed.backend as Record<string, unknown>) };
        if ('env' in safeBackend) {
          delete safeBackend.env;
          parsed.backend = safeBackend;
          changed = true;
        }
      }
      if (Array.isArray(parsed.databases)) {
        parsed.databases = parsed.databases.map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
          const safeDb = { ...(entry as Record<string, unknown>) };
          if ('seedSql' in safeDb) { delete safeDb.seedSql; changed = true; }
          if ('seedJson' in safeDb) { delete safeDb.seedJson; changed = true; }
          return safeDb;
        });
      }
      return changed ? JSON.stringify(parsed) : rawText;
    } catch {
      return rawText;
    }
  }

  /** Whether an archive path belongs to the untrusted frontend (excluding backend/private files). */
  isFrontendPath(archivePath: string): boolean {
    const hasBackend = Boolean(this.manifest.backend);
    const backendRoot = this.manifest.backend?.root
      ? this.manifest.backend.root.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/'
      : '';
    if (isBackendPrivatePath(archivePath, hasBackend, backendRoot) || this.isManifestPrivatePath(archivePath)) {
      return false;
    }
    const feRoot = this.manifest.frontendRoot
      ? this.manifest.frontendRoot.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/'
      : '';
    if (feRoot && !archivePath.startsWith(feRoot)) return false;
    return true;
  }

  has(path: string): boolean {
    return this.resolveExistingPath(path) !== null;
  }

  names(): string[] {
    return [...this.normalizedNames];
  }

  readText(path: string, basePath?: string): string | null {
    const resolved = this.resolveExistingPath(path, basePath);
    if (!resolved) return null;
    const cached = this.textCache.get(resolved);
    if (cached !== undefined) return cached;
    const bytes = this.readBytes(resolved);
    if (!bytes) return null;
    const decoded = ARCHIVE_DECODER.decode(bytes);
    this.textCache.set(resolved, decoded);
    return decoded;
  }

  readBytes(path: string, basePath?: string): Uint8Array | null {
    if (this.disposed) return null;
    const resolved = this.resolveExistingPath(path, basePath);
    if (!resolved) return null;
    const cachedBin = this.binaryCache.get(resolved);
    if (cachedBin) return cachedBin;
    const cachedText = this.textCache.get(resolved);
    if (cachedText !== undefined) return ARCHIVE_ENCODER.encode(cachedText);
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
    const resolved = this.resolveFrontendExistingPath(path, basePath);
    if (!resolved) return null;
    const existing = this.blobUrls.get(resolved);
    if (existing) return existing;
    let bytes: Uint8Array | null;
    if (resolved === 'manifest.json' && (this.manifest.backend || (this.manifest.databases?.length ?? 0) > 0)) {
      const text = this.readText(resolved);
      bytes = text !== null ? ARCHIVE_ENCODER.encode(this.redactManifestForFrontend(text)) : null;
    } else {
      bytes = this.readBytes(resolved);
    }
    if (!bytes) return null;
    const url = this.mintUrl(bytes, mimeTypeFor(resolved));
    this.blobUrls.set(resolved, url);
    return url;
  }

  /** Strict allowlist of non-executable MIME types safe to mint as host `blob:` URLs. */
  private static readonly INERT_BLOB_TYPES = new Set([
    'text/plain',
    'text/css',
    'text/csv',
    'application/json',
    'application/octet-stream',
    'application/wasm',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/avif',
    'image/x-icon',
    'image/bmp',
    'image/apng',
    'font/woff',
    'font/woff2',
    'font/ttf',
    'font/otf',
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
    'audio/webm',
    'audio/mp4',
    'audio/aac',
    'audio/flac',
    'video/mp4',
    'video/webm',
    'video/ogg',
    'model/gltf-binary',
    'model/gltf+json',
  ]);

  /** An address the page can load `bytes` from, by the rule above: never one a browser would open as a document. */
  private mintUrl(bytes: Uint8Array, type: string): string {
    const baseType = type.split(';')[0].trim().toLowerCase();
    // Always keep base64 non-empty so an empty SVG `data:` URL never ends with a trailing comma.
    if (baseType === 'image/svg+xml') {
      const encoded = bytes.byteLength > 0 ? bytesToBase64(bytes) : 'IA==';
      return `data:image/svg+xml;base64,${encoded}`;
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    let inert: string;
    if (
      baseType === 'text/html' ||
      baseType === 'application/xhtml+xml' ||
      baseType === 'application/xml' ||
      baseType === 'text/xml'
    ) {
      inert = 'text/plain; charset=utf-8';
    } else if (ContainerArchive.INERT_BLOB_TYPES.has(baseType)) {
      inert = baseType;
    } else {
      // Downgrade active document/XML/PDF/multipart types (e.g. MathML, XSLT, PDF, MHTML) to inert bytes.
      inert = 'application/octet-stream';
    }
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

  /** Revoke and drop all runtime blobs minted during the current page session (called on navigation). */
  clearRuntimeBlobs(): void {
    for (const id of [...this.runtimeBlobs.keys()]) {
      this.dropRuntimeBlob(id);
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
    return this.exportFrontendVfs();
  }

  /**
   * Partitioned VFS strictly for the untrusted Frontend Worker.
   *
   * Security invariant: when a container includes an embedded backend or SQLite database,
   * backend source files (`.php`, `.rs`, `Cargo.toml`, `.htaccess`, `server/`, `backend/`),
   * secrets (`.env`), and raw database/seed files (`.db`, `.sqlite`, `.sql`, `seed.json`)
   * are NEVER exposed to the frontend sandbox.
   *
   * If `manifest.frontendRoot` is set (e.g. `"app/dist"`), files under that prefix are
   * mounted at the frontend virtual root (`"index.html"`, `"assets/..."`).
   */
  exportFrontendVfs(): { textFiles: Record<string, string>; binaryFiles: Record<string, Uint8Array> } {
    const textFiles: Record<string, string> = Object.create(null);
    const binaryFiles: Record<string, Uint8Array> = Object.create(null);
    const feRoot = this.manifest.frontendRoot
      ? this.manifest.frontendRoot.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/'
      : '';
    const hasBackend = Boolean(this.manifest.backend);
    const backendRoot = this.manifest.backend?.root
      ? this.manifest.backend.root.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/'
      : '';

    for (const name of this.normalizedNames) {
      if (isBackendPrivatePath(name, hasBackend, backendRoot) || this.isManifestPrivatePath(name)) continue;
      if (feRoot) {
        if (!name.startsWith(feRoot)) continue;
        const mapped = name.slice(feRoot.length);
        if (!mapped) continue;
        if (this.textCache.has(name)) {
          textFiles[mapped] = this.textCache.get(name)!;
        } else {
          const bytes = this.readBytes(name);
          if (bytes) binaryFiles[mapped] = bytes;
        }
      } else {
        if (this.textCache.has(name)) {
          let text = this.textCache.get(name)!;
          if (name === 'manifest.json' && (hasBackend || (this.manifest.databases?.length ?? 0) > 0)) {
            text = this.redactManifestForFrontend(text);
          }
          textFiles[name] = text;
        } else {
          const bytes = this.readBytes(name);
          if (bytes) binaryFiles[name] = bytes;
        }
      }
    }
    return { textFiles, binaryFiles };
  }

  /**
   * Complete VFS for the isolated Backend Worker (includes backend source, `.htaccess`,
   * bundled `.db` / `.sql` / `seed.json`, and static assets for PHP/SSR serving).
   */
  exportBackendVfs(): { textFiles: Record<string, string>; binaryFiles: Record<string, Uint8Array> } {
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

  /** Parse all `.htaccess` files in this archive keyed by directory prefix (`""` for root). */
  getHtaccessFiles(): Map<string, ParsedHtaccess> {
    const out = new Map<string, ParsedHtaccess>();
    for (const name of this.normalizedNames) {
      if (name === '.htaccess' || name.endsWith('/.htaccess')) {
        const text = this.readText(name);
        if (text !== null) {
          const dirPrefix = name === '.htaccess' ? '' : name.slice(0, -'/.htaccess'.length);
          out.set(dirPrefix, parseHtaccess(text, dirPrefix));
        }
      }
    }
    return out;
  }

  /**
   * List a virtual directory inside the container `.zip` archive (for virtual folder navigation
   * of scripts, pages, and folders).
   */
  listVirtualDirectory(virtualPath = '/', options?: { includeHidden?: boolean; includePrivate?: boolean }): VirtualDirEntry[] {
    const cleanDir = virtualPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const prefix = cleanDir ? `${cleanDir}/` : '';
    const includeHidden = options?.includeHidden ?? false;
    const includePrivate = options?.includePrivate ?? true;
    const hasBackend = Boolean(this.manifest.backend);
    const backendRoot = this.manifest.backend?.root
      ? this.manifest.backend.root.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/'
      : '';

    const dirs = new Set<string>();
    const files: VirtualDirEntry[] = [];

    for (const name of this.normalizedNames) {
      if (prefix && !name.startsWith(prefix)) continue;
      const rest = prefix ? name.slice(prefix.length) : name;
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash >= 0) {
        const dirName = rest.slice(0, slash);
        if (!includeHidden && dirName.startsWith('.')) continue;
        dirs.add(dirName);
      } else {
        if (!includeHidden && rest.startsWith('.')) continue;
        if (!includePrivate && isBackendPrivatePath(name, hasBackend, backendRoot)) continue;
        const ext = extOf(rest);
        const navigable = ext === 'php' || ext === 'phtml' || ext === 'html' || ext === 'htm';
        const textVal = this.textCache.get(name);
        const binVal = this.binaryCache.get(name);
        files.push({
          name: rest,
          path: name,
          urlPath: `/${name}`,
          kind: 'file',
          navigable,
          ext: ext || undefined,
          size: textVal !== undefined ? textVal.length : binVal?.byteLength,
        });
      }
    }

    const dirEntries: VirtualDirEntry[] = [...dirs]
      .sort((a, b) => a.localeCompare(b))
      .map((dirName) => {
        const full = prefix ? `${prefix}${dirName}` : dirName;
        return {
          name: dirName,
          path: full,
          urlPath: `/${full}/`,
          kind: 'dir',
          navigable: true,
        };
      });

    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirEntries, ...files];
  }

  /** Resolve a frontend asset path (respecting `manifest.frontendRoot`, `/` -> main, and directory `index.html`). */
  resolveFrontendPath(path: string, basePath?: string): string | null {
    const existing = this.resolveFrontendExistingPath(path, basePath);
    if (existing) return existing;
    const feRoot = this.manifest.frontendRoot
      ? this.manifest.frontendRoot.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      : '';
    const direct = resolveVfsPath(path, basePath);
    if (feRoot) {
      const strippedBase = basePath && basePath.startsWith(`${feRoot}/`) ? basePath.slice(feRoot.length + 1) : basePath;
      const rel = resolveVfsPath(path, strippedBase);
      if (rel) {
        const underRoot = `${feRoot}/${rel}`;
        if (this.normalizedNames.has(underRoot) && this.isFrontendPath(underRoot)) return underRoot;
        if (this.normalizedNames.has(`${underRoot}/index.html`) && this.isFrontendPath(`${underRoot}/index.html`)) return `${underRoot}/index.html`;
        if (this.normalizedNames.has(`${underRoot}/index.htm`) && this.isFrontendPath(`${underRoot}/index.htm`)) return `${underRoot}/index.htm`;
      }
    }
    return direct && this.isFrontendPath(direct) ? direct : null;
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

const BACKEND_PRIVATE_EXTENSIONS = new Set([
  'php', 'phtml', 'phar', 'php5', 'php7', 'php8', 'pht', 'phps',
  'inc', 'tpl', 'rs', 'sql', 'db', 'sqlite', 'sqlite3',
  'htaccess', 'htpasswd', 'env', 'ini', 'bak', 'log', 'sh',
]);

export function isBackendPrivatePath(path: string, hasBackend: boolean, backendRootWithSlash: string): boolean {
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (
    base === '.htaccess' ||
    base === '.htpasswd' ||
    base === '.env' ||
    base.startsWith('.env.') ||
    base === 'cargo.toml' ||
    base === 'cargo.lock' ||
    base === 'database.seed.json' ||
    /\.(?:db|sqlite|sqlite3)-(?:wal|shm|journal)$/.test(base)
  ) {
    return true;
  }
  if (/^(?:__softn_generated__\/)?private\//.test(lower) || /(?:^|\/)\.git(?:\/|$)/.test(lower)) {
    return true;
  }
  const ext = extOf(lower);
  if (BACKEND_PRIVATE_EXTENSIONS.has(ext)) {
    return true;
  }
  if (hasBackend) {
    if (
      /^(?:__softn_generated__\/)?(?:server|backend|db|database|migrations)\//.test(lower) ||
      base === 'seed.json'
    ) {
      return true;
    }
    if (backendRootWithSlash && lower.startsWith(backendRootWithSlash.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function parseExplicitBackend(raw: unknown): BackendConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const rt = typeof obj.runtime === 'string' ? obj.runtime.toLowerCase() : '';
  if (!['rust', 'php', 'javascript', 'typescript', 'python'].includes(rt)) return undefined;
  const entry = typeof obj.entry === 'string' ? obj.entry.replace(/\\/g, '/').replace(/^\/+/, '') : '';
  if (!entry) return undefined;
  const mode = obj.mode === 'ssr' || obj.mode === 'api' ? obj.mode : undefined;
  const routes = Array.isArray(obj.routes)
    ? obj.routes.filter((r): r is string => typeof r === 'string')
    : undefined;
  const interceptOrigins = Array.isArray(obj.interceptOrigins)
    ? obj.interceptOrigins.filter((o): o is string => typeof o === 'string')
    : undefined;
  const env: Record<string, string> | undefined =
    obj.env && typeof obj.env === 'object' && !Array.isArray(obj.env)
      ? Object.fromEntries(
          Object.entries(obj.env as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])
        )
      : undefined;
  const root = typeof obj.root === 'string' ? obj.root.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : undefined;
  const phpMode = obj.phpMode === 'worker' || obj.phpMode === 'sapi' ? obj.phpMode : undefined;
  return {
    runtime: rt as BackendRuntimeKind,
    entry,
    root,
    mode,
    routes,
    interceptOrigins,
    env,
    phpMode,
  };
}

function parseExplicitDatabases(raw: unknown): DatabaseConfig[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DatabaseConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : '';
    if (!name) continue;
    out.push({
      name,
      engine: 'sqlite',
      file: typeof obj.file === 'string' ? obj.file.replace(/\\/g, '/').replace(/^\/+/, '') : undefined,
      seedSql: typeof obj.seedSql === 'string' ? obj.seedSql : undefined,
      seedJson:
        typeof obj.seedJson === 'string' || (obj.seedJson && typeof obj.seedJson === 'object' && !Array.isArray(obj.seedJson))
          ? (obj.seedJson as string | Record<string, unknown>)
          : undefined,
      persist: typeof obj.persist === 'boolean' ? obj.persist : true,
    });
  }
  return out.length > 0 ? out : undefined;
}

function isLikelyXdbSeedJson(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const obj = parsed as Record<string, unknown>;
    if (
      Array.isArray(obj.schema) ||
      Array.isArray(obj.statements) ||
      (obj.tables && typeof obj.tables === 'object' && !Array.isArray(obj.tables))
    ) {
      return true;
    }
    const entries = Object.entries(obj);
    return (
      entries.length > 0 &&
      entries.every(
        ([, v]) =>
          Array.isArray(v) &&
          v.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
      )
    );
  } catch {
    return false;
  }
}

function discoverDatabases(names: ReadonlySet<string>, texts: ReadonlyMap<string, string>): DatabaseConfig[] | undefined {
  const dbFiles = [...names].filter((n) => /\.(?:db|sqlite|sqlite3)$/i.test(n)).sort();
  const seedSql = ['db/schema.sql', 'database/schema.sql', 'schema.sql', 'db/seed.sql', 'seed.sql'].find((p) => names.has(p));
  const seedJson = ['db/seed.json', 'database/seed.json', 'database.seed.json', 'seed.json'].find(
    (p) => names.has(p) && isLikelyXdbSeedJson(texts.get(p))
  );

  if (dbFiles.length > 0) {
    return dbFiles.map((file, idx) => {
      const base = file.slice(file.lastIndexOf('/') + 1).replace(/\.(?:db|sqlite|sqlite3)$/i, '');
      return {
        name: base || `db${idx}`,
        engine: 'sqlite',
        file,
        seedSql: idx === 0 ? seedSql : undefined,
        seedJson: idx === 0 ? seedJson : undefined,
        persist: true,
      };
    });
  }
  if (seedSql || seedJson) {
    return [
      {
        name: 'app',
        engine: 'sqlite',
        file: 'app.db',
        seedSql,
        seedJson,
        persist: true,
      },
    ];
  }
  return undefined;
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

  // Parse explicit backend / frontendRoot / databases from manifest.json
  let backend = parseExplicitBackend(rawManifest?.backend);
  let frontendRoot =
    typeof rawManifest?.frontendRoot === 'string'
      ? rawManifest.frontendRoot.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      : typeof (rawManifest?.frontend as Record<string, unknown> | undefined)?.root === 'string'
        ? String((rawManifest?.frontend as Record<string, unknown>).root).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        : undefined;
  const databases = parseExplicitDatabases(rawManifest?.databases) ?? discoverDatabases(names, texts);

  // Zero-config backend discovery when manifest.json doesn't declare one
  if (!backend) {
    const rustEntry = ['server/src/main.rs', 'backend/src/main.rs', 'src/main.rs'].find((p) => names.has(p));
    const hasRootHtml = names.has('index.html') || names.has('app.html');
    const nestedFeIndex = [
      'app/dist/index.html',
      'frontend/dist/index.html',
      'client/dist/index.html',
      'web/dist/index.html',
      'dist/index.html',
      'app/index.html',
      'frontend/index.html',
      'client/index.html',
      'web/index.html',
      'public/index.html',
    ].find((p) => names.has(p));

    if (rustEntry) {
      const root = rustEntry.includes('/') ? rustEntry.slice(0, rustEntry.indexOf('/src/')) : '';
      const cleanRoot = rustEntry.startsWith('src/') ? '' : root;
      backend = {
        runtime: 'rust',
        entry: rustEntry,
        root: cleanRoot,
        mode: hasRootHtml || nestedFeIndex ? 'api' : 'ssr',
        routes: hasRootHtml || nestedFeIndex ? ['/api/', '/ws'] : ['/'],
        interceptOrigins: ['http://localhost:8080', 'http://127.0.0.1:8080'],
      };
      if (!frontendRoot && !hasRootHtml && nestedFeIndex) {
        frontendRoot = nestedFeIndex.slice(0, -'/index.html'.length);
      }
    } else if (!hasRootHtml && (names.has('index.php') || [...names].some((n) => !n.includes('/') && /\.php$/i.test(n)))) {
      const phpEntry = names.has('index.php')
        ? 'index.php'
        : [...names].filter((n) => !n.includes('/') && /\.php$/i.test(n)).sort()[0];
      backend = {
        runtime: 'php',
        entry: phpEntry,
        root: '',
        mode: 'ssr',
        routes: ['/'],
        phpMode: 'sapi',
      };
    } else {
      const phpBackendEntry = ['backend/index.php', 'server/index.php', 'api/index.php'].find((p) => names.has(p))
        ?? [...names].filter((n) => /^api\/[^/]+\.php$/i.test(n)).sort()[0];
      const jsBackendEntry = ['backend/server.js', 'backend/index.js', 'server/index.js', 'server/server.js'].find((p) => names.has(p));
      const tsBackendEntry = ['backend/server.ts', 'backend/index.ts', 'server/index.ts', 'server/server.ts'].find((p) => names.has(p));
      const pyBackendEntry = ['backend/app.py', 'backend/server.py', 'server/app.py'].find((p) => names.has(p));
      if (phpBackendEntry) {
        backend = {
          runtime: 'php',
          entry: phpBackendEntry,
          root: phpBackendEntry.includes('/') ? phpBackendEntry.slice(0, phpBackendEntry.indexOf('/')) : '',
          mode: 'api',
          routes: ['/api/'],
          phpMode: 'sapi',
        };
      } else if (tsBackendEntry) {
        backend = {
          runtime: 'typescript',
          entry: tsBackendEntry,
          root: tsBackendEntry.slice(0, tsBackendEntry.indexOf('/')),
          mode: 'api',
          routes: ['/api/'],
        };
      } else if (jsBackendEntry) {
        backend = {
          runtime: 'javascript',
          entry: jsBackendEntry,
          root: jsBackendEntry.slice(0, jsBackendEntry.indexOf('/')),
          mode: 'api',
          routes: ['/api/'],
        };
      } else if (pyBackendEntry) {
        backend = {
          runtime: 'python',
          entry: pyBackendEntry,
          root: pyBackendEntry.slice(0, pyBackendEntry.indexOf('/')),
          mode: 'api',
          routes: ['/api/'],
        };
      }
    }
  }

  // Entry file discovery (explicit manifest -> frontendRoot/index.html -> root index.html -> SSR backend -> sole root .html -> legacy .ui)
  let main = typeof rawManifest?.main === 'string' ? rawManifest.main.replace(/^\/+/, '') : '';
  let ssrEntry = false;
  if (!main || !names.has(main)) {
    if (frontendRoot && names.has(`${frontendRoot}/index.html`)) {
      main = `${frontendRoot}/index.html`;
    } else if (names.has('index.html')) {
      main = 'index.html';
    } else if (names.has('app.html')) {
      main = 'app.html';
    } else if (backend && (backend.mode === 'ssr' || backend.runtime === 'php')) {
      main = backend.entry;
      ssrEntry = true;
    } else {
      const rootHtml = [...names].filter((n) => !n.includes('/') && /\.html?$/i.test(n));
      if (rootHtml.length >= 1) main = rootHtml.sort()[0];
      else if (names.has('ui/main.ui')) main = 'ui/main.ui';
      else if (names.has('main.ui')) main = 'main.ui';
      else {
        const anyHtml = [...names].filter((n) => /\.html?$/i.test(n)).sort();
        if (anyHtml.length > 0) main = anyHtml[0];
        else if (backend) {
          main = backend.entry;
          ssrEntry = true;
        }
      }
    }
  } else if (backend && (/\.php$/i.test(main) || (backend.mode === 'ssr' && main === backend.entry))) {
    ssrEntry = true;
  }

  if (!main || !names.has(main)) {
    throw new Error('Container has no entry point (expected index.html, index.php, or manifest.json "main")');
  }

  const rawEntryText = ssrEntry ? '' : (texts.get(main) ?? '');
  const explicitV2 =
    rawManifest === null ||
    rawManifest.engine === 2 ||
    rawManifest.container === true ||
    Boolean(backend);
  const mode: ContainerMode = /\.ui$/i.test(main)
    ? 'legacy-ui'
    : !explicitV2 && isLegacySoftNMarkup(rawEntryText)
      ? 'legacy-ui'
      : 'web';
  const entryHtml = mode === 'web' && !ssrEntry ? rawEntryText : '';
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
    backend,
    frontendRoot,
    databases,
    ssrEntry: ssrEntry || undefined,
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
