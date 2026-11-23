/**
 * Native Browser `<template>` / `DOMParser` HTML & CSS Sanitizer + Seed Builder.
 *
 * Replaces SoftN v1's ~325 KB custom lexer/parser with 0 KB of custom grammar:
 * - Parses standard HTML5 via the browser's C++ `DOMParser`
 * - Extracts `<script>` tags (classic, `type="module"`, TypeScript, Python) so ZERO
 *   untrusted code ever enters the host page's JS realm
 * - Strips forbidden host elements (`<iframe>`, `<object>`, `<embed>`, `<base>`, `<meta http-equiv>`)
 * - Moves inline `on*` attributes (`onclick="..."`) off the host DOM and into `SeedNode.h`
 *   so they execute inside ZIPP
 * - Rewrites bundle-relative URLs (`src`, `href`, `srcset`, CSS `url(...)`) to scoped `blob:` URLs
 *   and enforces `net.allowed_hosts` egress policy on external URLs
 */

import { ContainerArchive, readRunnableModule, resolveVfsPath, RUNTIME_BLOB_URL, VIRTUAL_ORIGIN } from './archive';
import { extractFontFaces, rewriteCss, transformContainerCss } from './css-policy';
import { MATH_NS, SVG_NS, createHostElement, hostAttributeValue, hostElementName, isExternalHref, isLinkElement } from './host-policy';
import { findInlineScriptStartLines } from './source-map';
import { SOFTN_UI_CSS } from './ui-css';
import type {
  ContainerPermissions,
  ExtractedScript,
  PlacedScript,
  SeedNode,
  ShellSeed,
  ViewportTuple,
} from './types';

export const NODE_ID_ATTR = 'data-softn-id';

/** Check whether an external URL is allowed under `permission.json`'s `net` capability. */
export function isExternalUrlAllowed(
  rawUrl: string,
  netPerm: ContainerPermissions['permissions'] extends infer P
    ? P extends { net?: infer N }
      ? N
      : undefined
    : undefined,
  netGranted: boolean
): boolean {
  if (!netGranted || !netPerm?.enabled) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && netPerm.allow_http)) {
    return false;
  }
  const hosts = netPerm.allowed_hosts;
  if (!hosts || hosts.length === 0) return true;
  const hostname = parsed.hostname.toLowerCase();
  return hosts.some((h) => h.toLowerCase() === hostname);
}

/** A host written as an address of numbers. */
const NUMBERED_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

/**
 * Whether two hosts are one site, as near as can be told without the list of where
 * registered names begin: the same host, or hosts whose last two labels are the same
 * (`api.example.com` and `example.com`). That takes `a.co.uk` and `b.co.uk` for one site,
 * which they are not; where this is asked, too wide is the safe way to be wrong.
 */
export function sameSite(a: string, b: string): boolean {
  const one = a.toLowerCase().replace(/\.$/, '');
  const other = b.toLowerCase().replace(/\.$/, '');
  if (one === '' || other === '') return false;
  if (one === other) return true;
  if (NUMBERED_HOST.test(one) || NUMBERED_HOST.test(other)) return false;
  const tail = (host: string) => host.split('.').slice(-2).join('.');
  return one.includes('.') && other.includes('.') && tail(one) === tail(other);
}

/** Sanitize a single URL attribute value (`src`, `href`, etc.) for the host DOM. */
function stripAsciiControlAndSpace(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) > 0x20) out += input[i];
  }
  return out;
}

/** An SVG written into a `data:` address. */
const SVG_DATA = /^data:image\/svg\+xml[;,]/i;

/**
 * Whether `attr` of a `tag` element (its lower-cased local name) names a picture to draw: an
 * image, a picture's or an image set's candidate, a video's poster, an SVG `<image>`. Not a
 * link, a form's address, or an SVG `<use>`, which reads a document.
 */
function drawsAPicture(tag: string, attr: string): boolean {
  if (attr === 'poster') return tag === 'video';
  if (attr === 'src') return tag === 'img' || tag === 'source' || tag === 'input' || tag === 'image';
  return (attr === 'href' || attr === 'xlink:href') && (tag === 'image' || tag === 'feimage');
}

export function sanitizeHostAssetUrl(
  attrName: string,
  rawValue: string,
  tagName: string,
  basePath: string,
  archive: ContainerArchive,
  permissions: ContainerPermissions,
  netGranted: boolean
): string | null {
  const trimmed = stripAsciiControlAndSpace(rawValue);
  const originalTrimmed = rawValue.trim();
  if (!originalTrimmed) return '';

  // Same-page hash anchors (`<a href="#top">`, SVG `<use href="#icon">`) are always safe
  if (originalTrimmed.startsWith('#')) return originalTrimmed;

  // Block dangerous executable schemes unconditionally
  if (/^(?:javascript|vbscript|file):/i.test(trimmed)) return null;

  // A blob the app's script made an address for: the page loads it from an address the host
  // mints, by the rule for the app's own files. Not in a link: followed, a blob is a
  // document, or a file saved to the person's disk, and neither is done here.
  const runtimeBlob = RUNTIME_BLOB_URL.exec(trimmed);
  if (runtimeBlob) {
    if (tagName === 'a' || tagName === 'area' || attrName === 'action' || attrName === 'formaction') return null;
    return archive.getRuntimeBlobUrl(runtimeBlob[1]);
  }

  // Safe inline data: images/audio/svg-free media
  if (/^data:/i.test(trimmed)) {
    if (/^data:(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon)|audio\/(?:wav|mpeg|ogg)|font\/)/i.test(trimmed)) {
      return originalTrimmed;
    }
    // A drawing written into the address, where the page draws it as a picture. A bundler
    // writes every small SVG an app imports this way (Vite's default, under 4 KB), and the
    // container hands an SVG file of the app's to the page in this same form (archive.ts).
    // As a picture it runs no script and loads nothing; anywhere else it is refused.
    if (SVG_DATA.test(trimmed) && drawsAPicture(tagName, attrName)) return originalTrimmed;
    return null;
  }

  // A link out (`<a href="https://...">`, an image map's `<area>`) fetches nothing until the
  // person follows it, and then the patcher opens it in a tab of its own.
  const isLink = (tagName === 'a' || tagName === 'area') && attrName === 'href';
  const isFormAction =
    (tagName === 'form' && attrName === 'action') ||
    ((tagName === 'button' || tagName === 'input') && attrName === 'formaction');
  if (isLink && /^https?:/i.test(trimmed)) {
    return originalTrimmed;
  }

  // When an embedded backend is active, allow same-virtual-origin links & form actions
  // (including `.htaccess` rewrite routes like `/signin`, `/posts/42`, and query strings
  // like `modules/sign.php?do=in`). `new URL(..., VIRTUAL_ORIGIN)` rejects all external
  // hosts and dangerous schemes (`javascript:`, `data:`, `file:`, `//evil.com`).
  if (archive.manifest.backend && (isLink || isFormAction) && !/^https?:|^\/\//i.test(trimmed)) {
    try {
      const baseUrl = `${VIRTUAL_ORIGIN}/${basePath.replace(/^\/+/, '')}`;
      const resolvedUrl = new URL(originalTrimmed, baseUrl);
      if (resolvedUrl.origin === VIRTUAL_ORIGIN) {
        return `${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}`;
      }
    } catch {
      return null;
    }
  }

  // Virtual-origin or relative path -> resolve from `.softn` archive VFS
  const vfsPath = archive.resolveExistingPath(originalTrimmed, basePath);
  if (vfsPath) {
    // A link to a file of the app's keeps the file's path: the patcher follows it inside the
    // container (a page) or does nothing (anything else). It is never given a `blob:`
    // address: one made by this page is this page's origin, and a link the person opens in
    // a new tab would show the app's file there as a document of the embedding site.
    if (isLink) {
      try {
        const baseUrl = `${VIRTUAL_ORIGIN}/${basePath.replace(/^\/+/, '')}`;
        const parsed = new URL(originalTrimmed, baseUrl);
        if (parsed.search || parsed.hash) {
          return `${vfsPath}${parsed.search}${parsed.hash}`;
        }
      } catch {
        // Fallback to plain resolved path
      }
      return vfsPath;
    }
    return archive.getBlobUrl(vfsPath) ?? '';
  }

  // External network resource (`<img src="https://...">`) -> enforce `net` permission
  if (/^https?:|^\/\//i.test(trimmed)) {
    const normalized = trimmed.startsWith('//') ? `https:${originalTrimmed}` : originalTrimmed;
    if (isExternalUrlAllowed(normalized, permissions.permissions?.net, netGranted)) {
      return normalized;
    }
    return null;
  }

  return null;
}

/**
 * A stylesheet of the app's, or a `style` attribute's value, for the page: every address by
 * the host's rule, no `@import`, no `:host` (css-policy.ts reads it as CSS does), `html`/`:root`
 * scoped to `[data-softn-docroot]`, `body` scoped to `[data-softn-viewport]`, and viewport units
 * (`vh`/`dvh`/`vw`/`dvw`) bound to the container's live viewport variables.
 */
export function sanitizeContainerCss(
  css: string,
  basePath: string,
  archive: ContainerArchive,
  permissions: ContainerPermissions,
  netGranted: boolean,
  /** Where the sheet is: the app's page, a shadow tree the app attached, or an inline `style` value. */
  scope: 'page' | 'shadow' | 'inline' = 'page'
): string {
  const out = rewriteCss(css, (target) => {
    // An empty address is the page's own: the embedding page, fetched again as an image.
    if (!target) return null;
    // A fragment alone names something in this document (an SVG filter, clip or gradient).
    if (target.startsWith('#')) return target;
    if (/^data:(?:image\/(?:png|jpeg|gif|webp|avif)|font\/|application\/font)/i.test(target)) return target;
    // A drawing in the address: a stylesheet draws it as a picture (a background, a mask, a
    // list's marker), where it runs nothing. The arrows and ticks of every CSS framework's
    // form controls are written this way.
    if (SVG_DATA.test(target)) return target;
    const runtimeBlob = RUNTIME_BLOB_URL.exec(target);
    if (runtimeBlob) return archive.getRuntimeBlobUrl(runtimeBlob[1]);
    const vfs = archive.resolveExistingPath(target, basePath);
    if (vfs) return archive.getBlobUrl(vfs);
    if (/^https?:/i.test(target) && isExternalUrlAllowed(target, permissions.permissions?.net, netGranted)) return target;
    return null;
  }, { keepHost: scope === 'shadow' });

  return transformContainerCss(out, {
    scopeSelectors: scope === 'page',
    rewriteViewportUnits: true,
    inline: scope === 'inline',
  });
}

export { extractFontFaces as extractSanitizedFontFaces };

/** The attribute an image asked for with CORS in the app's first markup carries its address in, for the patcher to load (dom-patcher.ts `adoptReadableImages`). */
export const READABLE_ATTR = 'data-softn-readable';

/** The types a browser runs a script of (its "JavaScript MIME types"), and the container's own for TypeScript and Python. */
const JS_SCRIPT_TYPES = new Set([
  '', 'text/javascript', 'application/javascript', 'application/ecmascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4',
  'text/javascript1.5', 'text/jscript', 'text/livescript', 'text/x-ecmascript', 'text/x-javascript',
]);
const OWN_SCRIPT_TYPES = new Set([
  'module',
  'text/typescript',
  'module/ts',
  'text/tsx',
  'module/tsx',
  'text/jsx',
  'module/jsx',
  'text/python',
  'python',
]);

/**
 * What a `<script>` runs as, by its type as a browser reads it (a `language` attribute stands
 * for a missing type): none for a type that is not run. Every type but a few was run as
 * JavaScript, so a template (`text/x-template`), a shader (`x-shader/x-vertex`) or JSX for
 * Babel was run, and failed, where a browser leaves it for the app to read.
 */
function classifyScriptLanguage(typeAttr: string | null, srcPath?: string, languageAttr?: string | null): {
  kind: 'classic' | 'module' | 'python';
  language: 'javascript' | 'typescript' | 'python';
  jsx?: boolean;
} | null {
  const written = typeAttr !== null ? typeAttr : languageAttr ? `text/${languageAttr}` : '';
  const t = written.split(';')[0].trim().toLowerCase();
  if (!JS_SCRIPT_TYPES.has(t) && !OWN_SCRIPT_TYPES.has(t)) return null;
  if (t === 'text/python' || t === 'python' || (srcPath && /\.py$/i.test(srcPath))) {
    return { kind: 'python', language: 'python' };
  }
  const isJsx =
    t === 'text/tsx' ||
    t === 'module/tsx' ||
    t === 'text/jsx' ||
    t === 'module/jsx' ||
    (srcPath ? /\.(?:tsx|jsx)$/i.test(srcPath) : false);
  const isTs =
    t === 'text/typescript' ||
    t === 'module/ts' ||
    t === 'text/tsx' ||
    t === 'module/tsx' ||
    (srcPath ? /\.(?:ts|tsx|mts)$/i.test(srcPath) : false);
  const isModule =
    t === 'module' ||
    t === 'module/ts' ||
    t === 'text/tsx' ||
    t === 'module/tsx' ||
    t === 'text/jsx' ||
    t === 'module/jsx' ||
    (srcPath ? /\.(?:mjs|mts|tsx|jsx)$/i.test(srcPath) : false);
  return {
    kind: isModule ? 'module' : 'classic',
    language: isTs ? 'typescript' : 'javascript',
    ...(isJsx ? { jsx: true } : {}),
  };
}

function currentViewport(): ViewportTuple {
  if (typeof window === 'undefined') return [1024, 768, 0, 0, 1, 0];
  const mq = (q: string) => (typeof window.matchMedia === 'function' ? window.matchMedia(q).matches : false);
  return [
    window.innerWidth || 1024,
    window.innerHeight || 768,
    mq('(prefers-color-scheme: dark)') ? 1 : 0,
    mq('(prefers-reduced-motion: reduce)') ? 1 : 0,
    window.devicePixelRatio || 1,
    mq('(pointer: coarse)') ? 1 : 0,
  ];
}

/** The most of the page's scripts placed in the app's document, and the most text one of them carries (a template, JSON). */
const MAX_PLACED_SCRIPTS = 512;
const MAX_PLACED_SCRIPT_TEXT = 2 * 1024 * 1024;

function randomCryptoSeed(): number[] {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)));
  }
  return Array.from({ length: 32 }, (_, i) => (i * 37 + 13) & 0xff);
}

export interface PreparedDocument {
  seed: ShellSeed;
  scripts: ExtractedScript[];
  /** Every `<script>` of the page, for the app's document (each where it was). */
  placed: PlacedScript[];
  styles: string[];
  usesSoftnUiCss: boolean;
  /** Populate `viewportEl` and fill `nodeMap` (`id -> Node`) with sanitized initial DOM nodes. */
  mountInitialDom: (viewportEl: HTMLElement, nodeMap: Map<number, Node>, docRootEl: HTMLElement) => string[];
}

/**
 * Parse an entry HTML file from `archive`, extracting styles, scripts, sanitized initial DOM,
 * and the `ShellSeed` tree for the Worker's guest DOM.
 */
export function prepareHtmlDocument(
  htmlSource: string,
  entryPath: string,
  archive: ContainerArchive,
  permissions: ContainerPermissions,
  netGranted: boolean
): PreparedDocument {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(htmlSource, 'text/html');

  const styles: string[] = [];
  const scripts: ExtractedScript[] = [];
  const scriptStartLines = findInlineScriptStartLines(htmlSource);
  let scriptTagIndex = 0;
  const pageDisplayFile = archive.toFrontendVfsPath(entryPath);
  let usesSoftnUiCss = false;
  let scriptSeq = 1;
  /** Every `<script>` of the page, with where it was: placed in the app's document by its id (PlacedScript). */
  const placedScripts: Array<{ el: Element; attrs: Array<[string, string]>; text: string; parent: Element | null; next: Node | null; ran: number | null }> = [];
  let placedText = 0;
  /** What came after each element taken out (a stylesheet, a script, what the page does not get): where a script was is found past them. */
  const afterRemoved = new Map<Node, Node | null>();

  // Walk `<head>` and `<body>` in document order for `<link rel="stylesheet">`, `<style>`, and `<script>`
  const allElements = Array.from(parsed.querySelectorAll('link, style, script'));
  for (const el of allElements) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'link') {
      const rel = (el.getAttribute('rel') ?? '').toLowerCase();
      const href = (el.getAttribute('href') ?? '').trim();
      afterRemoved.set(el, el.nextSibling);
      if (rel === 'stylesheet' && href) {
        if (href === 'softn:ui.css' || href === '/runtime/ui.css') {
          usesSoftnUiCss = true;
          styles.push(SOFTN_UI_CSS);
        } else {
          const cssText = archive.readText(href, entryPath);
          if (cssText !== null) {
            const cssPath = archive.resolveExistingPath(href, entryPath) ?? resolveVfsPath(href, entryPath) ?? entryPath;
            styles.push(sanitizeContainerCss(cssText, cssPath, archive, permissions, netGranted));
          }
        }
      }
      el.remove();
      continue;
    }

    if (tag === 'style') {
      afterRemoved.set(el, el.nextSibling);
      const rawCss = el.textContent ?? '';
      if (rawCss.trim()) {
        styles.push(sanitizeContainerCss(rawCss, entryPath, archive, permissions, netGranted));
      }
      el.remove();
      continue;
    }

    if (tag === 'script') {
      const htmlLine = scriptStartLines[scriptTagIndex++] ?? 1;
      const srcAttr = el.getAttribute('src')?.trim();
      const classified = classifyScriptLanguage(el.getAttribute('type'), srcAttr, el.getAttribute('language'));
      // A browser that runs modules runs no nomodule script (a build's copy for old browsers).
      const runs = classified !== null && !(classified.kind === 'classic' && el.hasAttribute('nomodule'));
      let ran: number | null = null;
      // Run once the page's other scripts have run, as a browser runs it after the page is
      // read: a module (unless async), a classic script by its address with defer. A bundle in
      // the head with defer ran before the page's own scripts that set up what it reads.
      const deferred = classified !== null && !el.hasAttribute('async') && (classified.kind === 'module' || (!!srcAttr && el.hasAttribute('defer')));
      if (classified && runs) {
        if (srcAttr) {
          const resolvedSrc = archive.resolveExistingPath(srcAttr, entryPath);
          const code = resolvedSrc ? readRunnableModule(resolvedSrc, (path) => archive.readText(path)) : null;
          if (code !== null && resolvedSrc) {
            const vfsFile = archive.toFrontendVfsPath(resolvedSrc);
            ran = scriptSeq;
            scripts.push({
              id: scriptSeq++,
              kind: classified.kind,
              language: classified.language,
              src: srcAttr,
              code,
              originPath: vfsFile,
              displayFile: vfsFile,
              startLine: 1,
              ...(deferred ? { defer: true } : {}),
            });
          }
        } else {
          const inlineCode = el.textContent ?? '';
          if (inlineCode.trim()) {
            const ext = classified.jsx
              ? classified.language === 'typescript'
                ? 'tsx'
                : 'jsx'
              : classified.language === 'typescript'
                ? 'ts'
                : classified.language === 'python'
                  ? 'py'
                  : 'js';
            ran = scriptSeq;
            scripts.push({
              id: scriptSeq,
              kind: classified.kind,
              language: classified.language,
              code: inlineCode,
              originPath: `${pageDisplayFile}.inline-${scriptSeq}.${ext}`,
              displayFile: pageDisplayFile,
              startLine: htmlLine,
              ...(deferred ? { defer: true } : {}),
            });
            scriptSeq++;
          }
        }
      }
      // In the app's document all the same, where it was, already run or never to be: what
      // reads the page's scripts finds it (document.currentScript, a snippet that puts its own
      // script beside the first, a template or JSON read by its id). Its text goes with it
      // only when it is not run (a run script's code is the script itself).
      if (placedScripts.length < MAX_PLACED_SCRIPTS) {
        const attrs: Array<[string, string]> = [];
        for (const attr of Array.from(el.attributes)) {
          const lower = attr.name.toLowerCase();
          if (lower.startsWith('on') || lower === NODE_ID_ATTR) continue;
          attrs.push([attr.name, attr.value]);
        }
        let text = ran === null && !srcAttr ? (el.textContent ?? '') : '';
        if (text.length > MAX_PLACED_SCRIPT_TEXT || placedText + text.length > MAX_PLACED_SCRIPT_TEXT * 2) text = '';
        placedText += text.length;
        placedScripts.push({ el, attrs, text, parent: el.parentElement, next: el.nextSibling, ran });
      }
      afterRemoved.set(el, el.nextSibling);
      el.remove();
    }
  }

  // Remove what the page does not get (`<iframe>`, `<object>`, an SVG `script`, ...), by the
  // element's own name whatever prefix it was written with (host-policy.ts), and a
  // `<meta http-equiv>`, which is a navigation.
  for (const el of Array.from(parsed.body.querySelectorAll('*'))) {
    if (hostElementName(el.localName, undefined) === null) {
      afterRemoved.set(el, el.nextSibling);
      el.remove();
      continue;
    }
    if (el.localName.toLowerCase() === 'meta' && el.hasAttribute('http-equiv')) {
      el.remove();
    }
  }

  // Extract `<html>` and `<body>` safe attributes
  const extractSafeRootAttrs = (el: Element | null): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!el) return out;
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) continue;
      if (name === 'style') {
        out.style = sanitizeContainerCss(attr.value, entryPath, archive, permissions, netGranted, 'inline');
      } else {
        out[attr.name] = attr.value;
      }
    }
    return out;
  };

  const htmlAttrs = extractSafeRootAttrs(parsed.documentElement);
  const bodyAttrs = extractSafeRootAttrs(parsed.body);

  let nextId = 2; // 0 = html, 1 = body

  // Build seed tree while recording exact sanitized blueprint for host DOM creation
  interface BlueprintNode {
    id: number;
    kind: 'element' | 'text' | 'comment' | 'template';
    tag?: string;
    ns?: 'svg' | 'math';
    hostAttrs?: Record<string, string>;
    text?: string;
    children?: BlueprintNode[];
  }

  /** The id each node with a seed was given: where a page's script was is said by these. */
  const seedIds = new Map<Node, number>();
  const buildNode = (domNode: Node): { seed: SeedNode | null; bp: BlueprintNode | null } => {
    if (domNode.nodeType === Node.TEXT_NODE) {
      const text = domNode.nodeValue ?? '';
      const id = nextId++;
      seedIds.set(domNode, id);
      return {
        seed: { i: id, x: text },
        bp: { id, kind: 'text', text },
      };
    }

    if (domNode.nodeType === Node.COMMENT_NODE) {
      const id = nextId++;
      return {
        seed: null,
        bp: { id, kind: 'comment', text: domNode.nodeValue ?? '' },
      };
    }

    if (domNode.nodeType !== Node.ELEMENT_NODE) {
      return { seed: null, bp: null };
    }

    const el = domNode as Element;
    // The namespace the parser gave the element, not its ancestor's: an element inside
    // `<foreignObject>` is HTML again, and is created as HTML.
    const ns: 'svg' | 'math' | undefined = el.namespaceURI === SVG_NS ? 'svg' : el.namespaceURI === MATH_NS ? 'math' : undefined;
    // The name the element is made by: its own, without a prefix, and none for what the page
    // does not get (host-policy.ts). `<svg:script>` inside `<svg>` was looked up whole, not
    // found, and created by that name, which makes an SVG `script`.
    const tag = hostElementName(el.localName, ns);
    if (tag === null) return { seed: null, bp: null };
    const lowerTag = tag.toLowerCase();

    const id = nextId++;
    seedIds.set(domNode, id);
    const seedAttrs: Record<string, string> = {};
    const hostAttrs: Record<string, string> = {};
    const inlineHandlers: Record<string, string> = {};
    const context = { entryPath, archive, permissions, netGranted, ns };

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name;
      const lower = name.toLowerCase();
      if (lower === NODE_ID_ATTR) continue;
      if (lower.startsWith('on') && lower.length > 2) {
        inlineHandlers[lower] = attr.value;
        continue;
      }
      // The app's script sees the attribute as written; the page gets it by the host's rule.
      seedAttrs[name] = attr.value;
      const clean = hostAttributeValue(lowerTag, name, attr.value, context);
      if (clean !== null) hostAttrs[name] = clean;
    }

    // An image asked for with CORS from a site the app may reach: loaded by the patcher, which
    // fetches it and shows it from a blob of what came (a canvas it is drawn into is read back).
    if (lowerTag === 'img' && !ns && hostAttrs.crossorigin !== undefined && hostAttrs.src && /^https?:/i.test(hostAttrs.src)) {
      hostAttrs[READABLE_ATTR] = hostAttrs.src;
      delete hostAttrs.src;
    }

    // A link out opens in a tab of its own, with no handle on this page, whatever the app
    // wrote for its target (the patcher's click rule says the same for a link made later).
    if (isLinkElement(lowerTag) && hostAttrs.href && isExternalHref(hostAttrs.href)) {
      hostAttrs.rel = 'noopener noreferrer';
      hostAttrs.target = '_blank';
    }

    // `<template>` holds inert template content for guest `.content.cloneNode(true)`
    if (lowerTag === 'template') {
      const tplEl = el as HTMLTemplateElement;
      const tplSeeds: SeedNode[] = [];
      for (const child of Array.from(tplEl.content.childNodes)) {
        const built = buildNode(child);
        if (built.seed) tplSeeds.push(built.seed);
      }
      return {
        seed: {
          i: id,
          o: 1,
          t: 'template',
          ...(Object.keys(seedAttrs).length ? { a: seedAttrs } : {}),
          tpl: tplSeeds,
        },
        bp: { id, kind: 'template', tag: 'template', hostAttrs },
      };
    }

    const seedChildren: SeedNode[] = [];
    const bpChildren: BlueprintNode[] = [];
    for (const child of Array.from(el.childNodes)) {
      const built = buildNode(child);
      if (built.seed) seedChildren.push(built.seed);
      if (built.bp) bpChildren.push(built.bp);
    }

    const seed: SeedNode = {
      i: id,
      t: tag,
      ...(ns ? { ns } : {}),
      ...(Object.keys(seedAttrs).length ? { a: seedAttrs } : {}),
      ...(Object.keys(inlineHandlers).length ? { h: inlineHandlers } : {}),
      ...(seedChildren.length ? { c: seedChildren } : {}),
    };

    const bp: BlueprintNode = {
      id,
      kind: 'element',
      tag,
      ns,
      hostAttrs,
      children: bpChildren,
    };

    return { seed, bp };
  };

  const bodySeeds: SeedNode[] = [];
  const bodyBlueprints: BlueprintNode[] = [];
  for (const child of Array.from(parsed.body.childNodes)) {
    const built = buildNode(child);
    if (built.seed) bodySeeds.push(built.seed);
    if (built.bp) bodyBlueprints.push(built.bp);
  }

  // Where each of the page's scripts was: in the head, or under its parent before the first
  // node after it that the app's document has (each by its id there).
  const placed: PlacedScript[] = placedScripts.map((script) => {
    const inHead = !script.parent || script.parent === parsed.head || script.parent === parsed.documentElement;
    let before: number | null = null;
    if (!inHead) {
      // Past the elements taken out beside it (a script straight after another was placed last).
      for (let node = script.next; node; node = afterRemoved.has(node) ? afterRemoved.get(node)! : node.nextSibling) {
        const id = seedIds.get(node);
        if (id !== undefined) {
          before = id;
          break;
        }
      }
    }
    const parentId = inHead ? 'head' : script.parent === parsed.body ? 1 : seedIds.get(script.parent!) ?? 1;
    return {
      a: script.attrs,
      ...(script.text ? { x: script.text } : {}),
      p: parentId,
      b: parentId === 'head' ? null : before,
      r: script.ran,
    };
  });

  const seed: ShellSeed = {
    next: nextId,
    body: bodySeeds,
    ...(Object.keys(htmlAttrs).length ? { htmlAttrs } : {}),
    ...(Object.keys(bodyAttrs).length ? { bodyAttrs } : {}),
    title: parsed.title || archive.manifest.name,
    // A folder's index page is at the folder's address, as every web server gives it: a
    // router matches location.pathname, and an app opened at "/index.html" started on its
    // "no such page" page. A page of any other name is at its own address.
    url: `${VIRTUAL_ORIGIN}/${archive.toFrontendVfsPath(entryPath).replace(/(^|\/)index\.html?$/i, '$1')}`,
    r: randomCryptoSeed(),
    v: currentViewport(),
    shadow: true,
  };

  const mountInitialDom = (
    viewportEl: HTMLElement,
    nodeMap: Map<number, Node>,
    docRootEl: HTMLElement
  ): string[] => {
    const customTagsSeen = new Set<string>();
    nodeMap.set(0, docRootEl);
    nodeMap.set(1, viewportEl);

    for (const [k, v] of Object.entries(htmlAttrs)) {
      if (k === 'class') docRootEl.classList.add(...v.split(/\s+/).filter(Boolean));
      else if (k.startsWith('data-') || k === 'lang' || k === 'dir') docRootEl.setAttribute(k, v);
    }
    for (const [k, v] of Object.entries(bodyAttrs)) {
      if (k === 'class') viewportEl.classList.add(...v.split(/\s+/).filter(Boolean));
      else if (k === 'style') viewportEl.setAttribute('style', v);
      else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role') viewportEl.setAttribute(k, v);
    }
    viewportEl.setAttribute(NODE_ID_ATTR, '1');

    const materialize = (bp: BlueprintNode): Node => {
      if (bp.kind === 'text') {
        const tn = document.createTextNode(bp.text ?? '');
        nodeMap.set(bp.id, tn);
        return tn;
      }
      if (bp.kind === 'comment') {
        const cn = document.createComment(bp.text ?? '');
        nodeMap.set(bp.id, cn);
        return cn;
      }
      const el = createHostElement(bp.tag!, bp.ns);
      if (bp.tag && bp.tag.startsWith('softn-')) customTagsSeen.add(bp.tag);
      if (bp.hostAttrs) {
        for (const [k, v] of Object.entries(bp.hostAttrs)) {
          try {
            if (bp.ns === 'svg' && k.toLowerCase() === 'xlink:href') {
              el.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', v);
            } else {
              el.setAttribute(k, v);
            }
          } catch {
            // Ignore invalid attribute names
          }
        }
      }
      el.setAttribute(NODE_ID_ATTR, String(bp.id));
      nodeMap.set(bp.id, el);
      if (bp.children) {
        for (const childBp of bp.children) {
          el.appendChild(materialize(childBp));
        }
      }
      return el;
    };

    for (const bp of bodyBlueprints) {
      viewportEl.appendChild(materialize(bp));
    }
    return [...customTagsSeen];
  };

  return {
    seed,
    scripts,
    placed,
    styles,
    usesSoftnUiCss,
    mountInitialDom,
  };
}
