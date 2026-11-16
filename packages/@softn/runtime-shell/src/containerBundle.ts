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
 * Unwraps a single top-level wrapper folder (e.g. `dist/index.html` -> `index.html`)
 * when root has neither `manifest.json` nor `index.html` / `app.html`.
 */
export function unwrapContainerZipEntries(
  textFiles: Map<string, string>,
  binaryFiles: BundleBinaryStore
): { textFiles: Map<string, string>; binaryFiles: BundleBinaryStore; unwrappedPrefix: string | null } {
  if (textFiles.has('manifest.json') || textFiles.has('index.html') || textFiles.has('app.html')) {
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

  // Lazy Map/Store views that strip `prefix` without eagerly decoding untouched entries
  const strippedTexts = new Map<string, string>();
  for (const key of textFiles.keys()) {
    if (key.startsWith(prefix) && key.length > prefix.length) {
      strippedTexts.set(key.slice(prefix.length), textFiles.get(key)!);
    }
  }

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
