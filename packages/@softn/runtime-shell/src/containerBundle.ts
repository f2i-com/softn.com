/**
 * Lightweight, zero-dependency detection & single-folder unwrapping for SoftN v2 Web Containers.
 *
 * Kept separate from `@softn/container`'s runtime entry so hosts (`softn-web`, `single-shell`)
 * can classify an archive synchronously in <1 KB of code and load `@softn/container` via
 * dynamic `import()` only when a tab actually mounts a v2 Web Container.
 */

import { declaresContainer, zeroConfigEntry } from '@softn/bundle-format/engine';
import type { BundleBinaryStore, BundleManifest } from './bundleProcessor';

export const WEB_CONTAINER_SOURCE_SENTINEL = '<!--softn:v2-web-container-->';

function inferTitleFromHtml(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 64);
}

function discoverHtmlIcon(
  html: string,
  hasEntry: (path: string) => boolean
): string | undefined {
  const linkMatch = /<link\b[^>]*rel\s*=\s*["'](?:shortcut\s+)?icon["'][^>]*>/i.exec(html);
  if (linkMatch) {
    const hrefMatch = /\bhref\s*=\s*["']([^"']+)["']/i.exec(linkMatch[0]);
    const clean = hrefMatch?.[1]?.replace(/^\.?\/+/, '').split(/[?#]/)[0];
    if (clean && hasEntry(clean)) return clean;
  }
  for (const candidate of ['favicon.svg', 'favicon.png', 'assets/icon.svg', 'assets/icon.png', 'icon.svg', 'icon.png', 'favicon.ico']) {
    if (hasEntry(candidate)) return candidate;
  }
  return undefined;
}

/**
 * An archive's text files with a wrapper folder's name taken off each: a Map to whoever holds
 * it, that decodes an entry when it is first read and not before.
 *
 * The archive's own map does that (a text entry is inflated and decoded on `get`), and for
 * the reason this one must: an archive of nine 50 MB JSON files of spaces is 451 KB. The
 * unwrap used to copy every entry into a plain Map, which read them all: such an archive,
 * zipped as its folder, held 445 MB of text before the app had started or the person had
 * been asked anything, where the same files at the archive's root held none.
 */
class UnwrappedTexts extends Map<string, string> {
  readonly #inner: Map<string, string>;
  readonly #prefix: string;
  /** The names this view has, without the prefix. */
  readonly #names = new Set<string>();
  /** What was put into the view itself, which the archive does not hold. */
  readonly #own = new Map<string, string>();

  constructor(inner: Map<string, string>, prefix: string) {
    super();
    this.#inner = inner;
    this.#prefix = prefix;
    for (const key of inner.keys()) {
      if (key.startsWith(prefix) && key.length > prefix.length) this.#names.add(key.slice(prefix.length));
    }
  }

  override get size(): number {
    return this.#names.size;
  }
  override has(key: string): boolean {
    return this.#names.has(key);
  }
  override get(key: string): string | undefined {
    if (!this.#names.has(key)) return undefined;
    return this.#own.has(key) ? this.#own.get(key) : this.#inner.get(this.#prefix + key);
  }
  override set(key: string, value: string): this {
    this.#names.add(key);
    this.#own.set(key, value);
    return this;
  }
  override delete(key: string): boolean {
    this.#own.delete(key);
    return this.#names.delete(key);
  }
  override clear(): void {
    this.#own.clear();
    this.#names.clear();
  }
  override keys(): MapIterator<string> {
    return this.#names.values();
  }
  override *entries(): MapIterator<[string, string]> {
    for (const key of this.#names) yield [key, this.get(key) as string];
  }
  override *values(): MapIterator<string> {
    for (const key of this.#names) yield this.get(key) as string;
  }
  override forEach(callback: (value: string, key: string, map: Map<string, string>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
  override [Symbol.iterator](): MapIterator<[string, string]> {
    return this.entries();
  }
}

/**
 * Unwraps a single top-level wrapper folder (e.g. `dist/index.html` -> `index.html`)
 * when root has neither `manifest.json` nor `index.html` / `app.html`.
 *
 * Nor `ui/main.ui`: that is a SoftN bundle's own layout, with `ui/` its folder of pages and
 * not a wrapper. The container reads it so (archive.ts), and this did not: an archive of
 * `ui/main.ui` and `ui/index.html` was a web container to the host that opened it and a
 * SoftN bundle to the container it was then handed to.
 */
export function unwrapContainerZipEntries(
  textFiles: Map<string, string>,
  binaryFiles: BundleBinaryStore
): { textFiles: Map<string, string>; binaryFiles: BundleBinaryStore; unwrappedPrefix: string | null } {
  if (textFiles.has('manifest.json') || textFiles.has('index.html') || textFiles.has('app.html') || textFiles.has('ui/main.ui')) {
    return { textFiles, binaryFiles, unwrappedPrefix: null };
  }
  const allKeys = [...textFiles.keys(), ...binaryFiles.keys()].filter((k) => !k.endsWith('/'));
  if (allKeys.length === 0) {
    return { textFiles, binaryFiles, unwrappedPrefix: null };
  }
  const slashIdx = allKeys[0].indexOf('/');
  if (slashIdx <= 0) {
    return { textFiles, binaryFiles, unwrappedPrefix: null };
  }
  const prefix = allKeys[0].slice(0, slashIdx + 1);
  if (!allKeys.every((k) => k.startsWith(prefix) && k.length > prefix.length)) {
    return { textFiles, binaryFiles, unwrappedPrefix: null };
  }
  if (
    !textFiles.has(`${prefix}manifest.json`) &&
    !textFiles.has(`${prefix}index.html`) &&
    !textFiles.has(`${prefix}app.html`)
  ) {
    return { textFiles, binaryFiles, unwrappedPrefix: null };
  }

  // Views that take `prefix` off each name and read an entry only when it is asked for, as
  // the archive's own stores do.
  const strippedTexts = new UnwrappedTexts(textFiles, prefix);

  const binKeys = [...binaryFiles.keys()]
    .filter((k) => k.startsWith(prefix) && k.length > prefix.length)
    .map((k) => k.slice(prefix.length));
  const binSet = new Set(binKeys);

  const strippedBinaries: BundleBinaryStore = {
    get: (p) => (binSet.has(p) ? binaryFiles.get(prefix + p) : undefined),
    has: (p) => binSet.has(p),
    keys: () => binSet.values(),
    get size() {
      return binSet.size;
    },
    declaredSize: (p) => (binSet.has(p) ? binaryFiles.declaredSize(prefix + p) : undefined),
    isRead: (p) => binSet.has(p) && binaryFiles.isRead(prefix + p),
    release: () => binaryFiles.release(),
    *entries() {
      for (const p of binSet) {
        const b = binaryFiles.get(prefix + p);
        if (b) yield [p, b];
      }
    },
    forEach(cb) {
      for (const [p, b] of strippedBinaries.entries()) cb(b, p, strippedBinaries);
    },
    [Symbol.iterator]() {
      return strippedBinaries.entries();
    },
  };

  return { textFiles: strippedTexts, binaryFiles: strippedBinaries, unwrappedPrefix: prefix };
}

export interface WebContainerDetection {
  isWebContainer: boolean;
  /** Present when `manifest.json` was absent and synthesized from `index.html`. */
  inferredManifest?: BundleManifest;
}

/**
 * Determine whether an unpacked bundle should run on `@softn/container` (`isWebContainer: true`)
 * vs legacy `@softn/core` (`isWebContainer: false`).
 */
export function detectWebContainer(
  textFiles: ReadonlyMap<string, string>,
  hasBinary?: (path: string) => boolean,
  fallbackName?: string
): WebContainerDetection {
  const hasAny = (p: string) => textFiles.has(p) || Boolean(hasBinary?.(p));

  if (!textFiles.has('manifest.json')) {
    // No manifest: a zipped folder of a web app, opened at its page (the one rule for which
    // page is @softn/bundle-format's zeroConfigEntry).
    const htmlEntry = zeroConfigEntry(textFiles.keys());
    if (!htmlEntry) {
      return { isWebContainer: false };
    }
    const html = textFiles.get(htmlEntry) ?? '';
    const cleanFallback = fallbackName?.replace(/\.(?:softn|zip)$/i, '').trim() || 'Web App';
    const title = inferTitleFromHtml(html) || cleanFallback;
    const icon = discoverHtmlIcon(html, hasAny);
    return {
      isWebContainer: true,
      inferredManifest: {
        name: title,
        version: '1.0.0',
        main: htmlEntry,
        ...(icon ? { icon } : {}),
        config: { execution: 'worker' },
      },
    };
  }

  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(textFiles.get('manifest.json')!) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { isWebContainer: false };
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return { isWebContainer: false };
  }

  const main = typeof raw.main === 'string' ? raw.main : '';
  if (!main || !/\.html?$/i.test(main) || !textFiles.has(main)) {
    return { isWebContainer: false };
  }

  // A bundle with a manifest says which engine runs it (@softn/bundle-format's engine.ts):
  // `"engine": 2`, or it is a SoftN bundle. Not a guess from its page: a SoftN HTML page has
  // a `<script type="module">` too, and a bundle of one with no `files.ui` listed was run in
  // the container, where `{count}` is text and `<Button>` is an unknown element.
  return { isWebContainer: declaresContainer(raw) };
}
