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

import { ContainerArchive, addressOfName, readRunnableModule, RUNTIME_BLOB_URL, VIRTUAL_ORIGIN } from './archive';
import { closeOpenCss, collectFontFaceFamilies, extractFontFaces, namespaceContainerFonts, rewriteCss, transformContainerCss } from './css-policy';
import { MATH_NS, ROOT_ATTRIBUTE, SVG_NS, createHostElement, hostAttributeValue, hostElementName, isExternalHref, isLinkElement, type EmbedAllowance, type FontScopeContext } from './host-policy';
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

function parseIpv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    out.push(n);
  }
  return [out[0], out[1], out[2], out[3]];
}

function parseIpv6Groups(host: string): number[] | null {
  let inner = host;
  if (inner.startsWith('[') && inner.endsWith(']')) {
    inner = inner.slice(1, -1);
  }
  if (!inner.includes(':')) return null;
  const zoneIdx = inner.indexOf('%');
  if (zoneIdx >= 0) inner = inner.slice(0, zoneIdx);

  // Convert trailing dotted-quad IPv4 (e.g. ::ffff:127.0.0.1) into two 16-bit groups.
  const lastColon = inner.lastIndexOf(':');
  const tail = inner.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4Octets(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    inner = `${inner.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = inner.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const parsePart = (p: string): number => (/^[0-9a-f]{1,4}$/i.test(p) ? parseInt(p, 16) : -1);
  const leftNums = left.map(parsePart);
  const rightNums = right.map(parsePart);
  if (leftNums.some((n) => n < 0) || rightNums.some((n) => n < 0)) return null;

  if (halves.length === 1) {
    return leftNums.length === 8 ? leftNums : null;
  }
  const missing = 8 - (leftNums.length + rightNums.length);
  if (missing < 1) return null;
  return [...leftNums, ...new Array<number>(missing).fill(0), ...rightNums];
}

function embeddedIpv4FromIpv6(g: number[]): [number, number, number, number] | null {
  const isV4Mapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
  const isV4Translated = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0;
  const isV4Compat = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && (g[6] !== 0 || g[7] > 1);
  const isNat64WellKnown = g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  if (isV4Mapped || isV4Translated || isV4Compat || isNat64WellKnown) {
    return [(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff];
  }
  return null;
}

function isMetadataOrUnspecifiedIpv4(v4: [number, number, number, number]): boolean {
  const [a, b, c, d] = v4;
  return (
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 100 && b === 100 && c === 100 && d === 200) // Alibaba Cloud IMDS
  );
}

function isMetadataOrUnspecifiedHost(hostname: string): boolean {
  if (
    hostname === 'metadata.google.internal' ||
    hostname === 'metadata.goog' ||
    hostname === 'instance-data'
  ) {
    return true;
  }
  const v4 = parseIpv4Octets(hostname);
  if (v4) return isMetadataOrUnspecifiedIpv4(v4);
  const v6 = parseIpv6Groups(hostname);
  if (!v6) return false;
  if (v6.every((n) => n === 0)) return true; // ::
  if ((v6[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  // AWS IPv6 IMDS fd00:ec2::254
  if (v6[0] === 0xfd00 && v6[1] === 0x0ec2 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0 && v6[6] === 0 && v6[7] === 0x0254) {
    return true;
  }
  const embedded = embeddedIpv4FromIpv6(v6);
  return embedded ? isMetadataOrUnspecifiedIpv4(embedded) : false;
}

function isPrivateOrLocalIpv4(v4: [number, number, number, number]): boolean {
  const [a, b, c] = v4;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateOrLocalHost(hostname: string): boolean {
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa') ||
    hostname.endsWith('.localdomain') ||
    hostname.endsWith('.lan') ||
    hostname.endsWith('.home') ||
    hostname.endsWith('.corp') ||
    hostname.endsWith('.intranet') ||
    hostname.endsWith('.private')
  ) {
    return true;
  }
  // Single-label hostnames (`router`, `intranet`, `db`) resolve on local search domains, never public DNS.
  if (!hostname.includes('.') && !hostname.startsWith('[') && hostname !== '') {
    return true;
  }
  const v4 = parseIpv4Octets(hostname);
  if (v4) return isPrivateOrLocalIpv4(v4);
  if (hostname.startsWith('[') && hostname.includes('%')) return true;
  const v6 = parseIpv6Groups(hostname);
  if (!v6) return hostname.startsWith('['); // Fail closed on unparseable bracketed IPv6 literals
  if (v6.every((n) => n === 0)) return true; // ::
  if (v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0 && v6[6] === 0 && v6[7] === 1) {
    return true; // ::1
  }
  if ((v6[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((v6[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((v6[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((v6[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (v6[0] === 0x0100 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0) return true; // 100::/64 discard
  if (v6[0] === 0x0064 && v6[1] === 0xff9b && (v6[2] === 0 || v6[2] === 1)) return true; // NAT64 64:ff9b::/96 & 64:ff9b:1::/48
  if (v6[0] === 0x2001 && (v6[1] === 0x0000 || v6[1] === 0x0db8)) return true; // Teredo 2001::/32 & documentation
  if (v6[0] === 0x2001 && v6[1] === 0x0002 && v6[2] === 0) return true; // benchmarking 2001:2::/48
  if (v6[0] === 0x2001 && ((v6[1] & 0xfff0) === 0x0010 || (v6[1] & 0xfff0) === 0x0020)) return true; // ORCHID / ORCHIDv2
  if (v6[0] === 0x2002) return true; // 6to4 2002::/16 (can embed private IPv4)
  if (v6[0] === 0x5f00) return true; // SRv6 5f00::/16
  const embedded = embeddedIpv4FromIpv6(v6);
  return embedded ? isPrivateOrLocalIpv4(embedded) : false;
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '';
}

function isEmbeddingHostHostname(normalizedHost: string): boolean {
  try {
    const here = (globalThis as { location?: { origin?: string; href?: string } }).location;
    if (!here) return false;
    const rawOrigin = here.origin && here.origin !== 'null' ? here.origin : here.href ? new URL(here.href).origin : '';
    if (!rawOrigin || rawOrigin === 'null') return false;
    const emb = new URL(rawOrigin);
    if (emb.protocol !== 'https:' && emb.protocol !== 'http:') return false;
    const embHost = emb.hostname.toLowerCase().replace(/\.+$/, '');
    return embHost !== '' && normalizedHost === embHost;
  } catch {
    return false;
  }
}

function isEmbeddingHostOrigin(parsed: URL, normalizedHost: string): boolean {
  try {
    const here = (globalThis as { location?: { origin?: string; href?: string } }).location;
    if (!here) return false;
    const rawOrigin = here.origin && here.origin !== 'null' ? here.origin : here.href ? new URL(here.href).origin : '';
    if (!rawOrigin || rawOrigin === 'null') return false;
    const emb = new URL(rawOrigin);
    if (emb.protocol !== 'https:' && emb.protocol !== 'http:') return false;
    const embHost = emb.hostname.toLowerCase().replace(/\.+$/, '');
    return embHost !== '' && normalizedHost === embHost && parsed.protocol === emb.protocol && effectivePort(parsed) === effectivePort(emb);
  } catch {
    return false;
  }
}

function isLoopbackHostname(normalizedHost: string): boolean {
  if (normalizedHost === 'localhost' || normalizedHost.endsWith('.localhost')) return true;
  const v4 = parseIpv4Octets(normalizedHost);
  if (v4) return v4[0] === 127;
  const v6 = parseIpv6Groups(normalizedHost);
  if (v6) {
    if (v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0 && v6[6] === 0 && v6[7] === 1) {
      return true;
    }
    const embedded = embeddedIpv4FromIpv6(v6);
    return embedded ? embedded[0] === 127 : false;
  }
  return false;
}

/**
 * Check whether an external URL targets the embedding host.
 * Always blocks exact same-origin (even when explicitly allowlisted). For non-loopback
 * hosts, passive subresources also block other ports/schemes of the embedding hostname;
 * on loopback, distinct ports are separate local origins and still require explicit host
 * allowlisting and user consent.
 */
function targetsEmbeddingHost(rawUrl: string, originOnly = false): boolean {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    if (!hostname) return true;
    if (originOnly || isLoopbackHostname(hostname)) return isEmbeddingHostOrigin(parsed, hostname);
    return isEmbeddingHostHostname(hostname);
  } catch {
    return true;
  }
}

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
  // Reject URLs with embedded credentials (`https://allowed.com@evil.com`) to prevent host confusion.
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && netPerm.allow_http)) {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!hostname) return false;
  // Never permit cloud metadata, link-local, or unspecified addresses from a container.
  if (isMetadataOrUnspecifiedHost(hostname)) return false;

  const hosts = netPerm.allowed_hosts;
  const isPrivate = isPrivateOrLocalHost(hostname);
  const isEmbeddingHost = isEmbeddingHostOrigin(parsed, hostname) || isEmbeddingHostHostname(hostname);
  if (!hosts || hosts.length === 0) {
    // Broad `net` without an explicit host allowlist may reach public hosts, never private/loopback/LAN or the embedding host.
    return !isPrivate && !isEmbeddingHost;
  }
  return hosts.some((rule) => {
    const cleanRule = rule.trim().toLowerCase().replace(/\.+$/, '');
    if (!cleanRule) return false;
    if (cleanRule === '*') {
      return !isPrivate && !isEmbeddingHost;
    }
    if (cleanRule.startsWith('*.')) {
      if (isPrivate || isEmbeddingHost) return false;
      const suffix = cleanRule.slice(2);
      return hostname === suffix || hostname.endsWith(`.${suffix}`);
    }
    return cleanRule === hostname;
  });
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

/** The embedding page's own host, lower-cased, or '' where it has none (a file, an opaque origin, no page at all). */
function embeddingPageHost(): string {
  try {
    const here = (globalThis as { location?: { origin?: string; href?: string } }).location;
    if (!here) return '';
    const rawOrigin = here.origin && here.origin !== 'null' ? here.origin : here.href ? new URL(here.href).origin : '';
    if (!rawOrigin || rawOrigin === 'null') return '';
    const emb = new URL(rawOrigin);
    if (emb.protocol !== 'https:' && emb.protocol !== 'http:') return '';
    return emb.hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return '';
  }
}

/**
 * The address a frame of the app's (`<iframe src>`) may show, or null for one it may not.
 *
 * A frame is a document of another site's, drawn in the app's box with that site's own
 * script and the person's session there. So it is held to more than a picture is:
 *   - `https:` only, written whole (`//host/…` is read as https). Never a file of the app's,
 *     a `blob:`, a `data:` or `about:` address: each would be a document of the embedding
 *     page's own origin, or script of the app's run outside its VM.
 *   - a host the app declared and the person allowed (`net`, `allowed_hosts`), by the rule a
 *     `fetch` or a picture is held to, and never a private or local address even where one
 *     is listed: a frame is something the person clicks in.
 *   - never the embedding page's own site. Its pages, shown in a frame beside the app's own
 *     elements with the person signed in, are the embedding site's to be clicked through.
 */
export function sanitizeFrameUrl(rawValue: string, permissions: ContainerPermissions, netGranted: boolean): string | null {
  // eslint-disable-next-line no-control-regex -- as a browser reads an address: the controls in it dropped
  const cleaned = String(rawValue ?? '').replace(/[\u0000-\u001f\u007f]+/g, '').trim();
  if (!cleaned) return null;
  const absolute = cleaned.startsWith('//') ? `https:${cleaned}` : cleaned;
  if (!/^https:\/\//i.test(absolute)) return null;
  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!hostname || isPrivateOrLocalHost(hostname) || isMetadataOrUnspecifiedHost(hostname)) return null;
  const embedding = embeddingPageHost();
  if (targetsEmbeddingHost(parsed.href) || (embedding !== '' && sameSite(hostname, embedding))) return null;
  if (!isExternalUrlAllowed(parsed.href, permissions.permissions?.net, netGranted)) return null;
  return parsed.href;
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

/**
 * The fragment of an address of a file of the app's (`#t=0.5`, `#icon-home`), for the address
 * the page is handed for that file: what part of it to show (a video's first frame, one view
 * of a sprite), which is never fetched and was lost, so a video started at its beginning and
 * a sprite showed every icon at once.
 */
function fragmentOf(address: string, basePath: string): string {
  if (!address.includes('#')) return '';
  try {
    return new URL(address, `${VIRTUAL_ORIGIN}/${basePath.replace(/^\/+/, '')}`).hash;
  } catch {
    return '';
  }
}

export function sanitizeHostAssetUrl(
  attrName: string,
  rawValue: string,
  tagName: string,
  basePath: string,
  archive: ContainerArchive,
  permissions: ContainerPermissions,
  netGranted: boolean,
  /** True only for cookie-free CORS `fetch(..., { credentials: 'omit' })` image reads (still blocks exact same-origin). */
  allowDistinctPortSameHost = false
): string | null {
  const trimmed = stripAsciiControlAndSpace(rawValue);
  const originalTrimmed = rawValue.trim();
  if (!originalTrimmed) return '';

  // Same-page hash anchors (`<a href="#top">`, SVG `<use href="#icon">`) are always safe
  if (originalTrimmed.startsWith('#')) return originalTrimmed;

  // SVG `<use>` loads another document (external SVG or host-origin blob); only same-document `#id` refs are allowed.
  if (tagName === 'use') return null;

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
    if (/^data:(?:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon)|audio\/(?:wav|mpeg|ogg)|font\/)/i.test(trimmed)) {
      return originalTrimmed;
    }
    // A drawing written into the address, where the page draws it as a picture. A bundler
    // writes every small SVG an app imports this way (Vite's default, under 4 KB), and the
    // container hands an SVG file of the app's to the page in this same form (archive.ts).
    // As a picture it runs no script and loads nothing; anywhere else it is refused.
    if (SVG_DATA.test(trimmed) && drawsAPicture(tagName, attrName)) return originalTrimmed;
    return null;
  }

  // A link out (`<a href="https://...">`, SVG `<a xlink:href="https://...">`, an image map's `<area>`)
  // fetches nothing until the person follows it, and then the patcher opens it in a tab of its own.
  const isLink = (tagName === 'a' || tagName === 'area') && (attrName === 'href' || attrName === 'xlink:href');
  const isFormAction =
    (tagName === 'form' && attrName === 'action') ||
    ((tagName === 'button' || tagName === 'input') && attrName === 'formaction');
  if (isLink && /^https?:\/\//i.test(trimmed)) {
    // eslint-disable-next-line no-control-regex -- strip embedded ASCII controls before WHATWG URL parsing
    const cleaned = originalTrimmed.replace(/[\u0000-\u001f\u007f]+/g, '');
    try {
      const parsed = new URL(cleaned);
      if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
        return null;
      }
      return parsed.href;
    } catch {
      return null;
    }
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
        if (resolvedUrl.pathname.startsWith('//')) return null;
        return `${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}`;
      }
    } catch {
      return null;
    }
  }

  // Virtual-origin or relative path -> resolve strictly from frontend VFS (never backend/private files)
  let vfsPath = archive.resolveFrontendExistingPath(originalTrimmed, basePath);
  if (!vfsPath && isLink && !/^https?:|^\/\//i.test(trimmed)) {
    try {
      const baseUrl = `${VIRTUAL_ORIGIN}/${basePath.replace(/^\/+/, '')}`;
      const parsed = new URL(originalTrimmed, baseUrl);
      if (parsed.origin === VIRTUAL_ORIGIN) {
        const cleanPath = parsed.pathname.replace(/\/+$/, '');
        const lastSeg = cleanPath.slice(cleanPath.lastIndexOf('/') + 1);
        if (cleanPath && lastSeg && !lastSeg.includes('.')) {
          vfsPath =
            archive.resolveFrontendExistingPath(`${cleanPath}.html`, basePath) ??
            archive.resolveFrontendExistingPath(`${cleanPath}.htm`, basePath);
        }
      }
    } catch {
      // Ignore unparseable URL
    }
  }
  if (vfsPath) {
    // A link to a file of the app's keeps the file's path: the patcher follows it inside the
    // container (a page) or does nothing (anything else). It is never given a `blob:`
    // address: one made by this page is this page's origin, and a link the person opens in
    // a new tab would show the app's file there as a document of the embedding site.
    if (isLink) {
      // As an address that reads back as the file (`100%.html` is `100%25.html`).
      const feLinkPath = addressOfName(archive.toFrontendVfsPath(vfsPath));
      try {
        const baseUrl = `${VIRTUAL_ORIGIN}/${basePath.replace(/^\/+/, '')}`;
        const parsed = new URL(originalTrimmed, baseUrl);
        if (parsed.search || parsed.hash) {
          return `${feLinkPath}${parsed.search}${parsed.hash}`;
        }
      } catch {
        // Fallback to plain resolved path
      }
      return feLinkPath;
    }
    const minted = archive.getBlobUrl(vfsPath);
    return minted ? minted + fragmentOf(originalTrimmed, basePath) : '';
  }

  // External network resource (`<img src="https://...">`) -> enforce `net` permission.
  // Never allow passive DOM subresource fetches to target the embedding host itself: browsers
  // attach ambient host cookies to `<img>`/`<video>`/`<audio>` requests even if `allowed_hosts`
  // explicitly listed the host's domain.
  if (/^https?:|^\/\//i.test(trimmed)) {
    const normalized = trimmed.startsWith('//') ? `https:${originalTrimmed}` : originalTrimmed;
    if (targetsEmbeddingHost(normalized, allowDistinctPortSameHost)) return null;
    if (isExternalUrlAllowed(normalized, permissions.permissions?.net, netGranted)) {
      return normalized;
    }
    return null;
  }

  return null;
}

/**
 * What a stylesheet may load written into its address: a picture or a font, which draws and
 * runs nothing (an SVG has a rule of its own). A font is written with the type of whichever
 * tool wrote it: `font/woff2`, and before that `application/font-woff`, `application/x-font-ttf`
 * (IcoMoon) and `application/octet-stream` (Fontello); a JPEG as often `image/jpg` as not. Only
 * the first two were kept, and an icon font of the others drew nothing.
 */
const CSS_DATA_TYPES =
  /^data:(?:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon)[;,]|font\/|application\/(?:x-)?font|application\/(?:x-woff|vnd\.ms-opentype|octet-stream)[;,])/i;

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
  scope: 'page' | 'shadow' | 'inline' = 'page',
  fontScope?: FontScopeContext
): string {
  const out = rewriteCss(css, (target) => {
    // An empty address is the page's own: the embedding page, fetched again as an image.
    if (!target) return null;
    // A fragment alone names something in this document (an SVG filter, clip or gradient).
    if (target.startsWith('#')) return target;
    if (CSS_DATA_TYPES.test(target)) return target;
    // A drawing in the address: a stylesheet draws it as a picture (a background, a mask, a
    // list's marker), where it runs nothing. The arrows and ticks of every CSS framework's
    // form controls are written this way.
    if (SVG_DATA.test(target)) return target;
    const runtimeBlob = RUNTIME_BLOB_URL.exec(target);
    if (runtimeBlob) return archive.getRuntimeBlobUrl(runtimeBlob[1]);
    const vfs = archive.resolveFrontendExistingPath(target, basePath);
    if (vfs) {
      const minted = archive.getBlobUrl(vfs);
      return minted ? minted + fragmentOf(target, basePath) : null;
    }
    if (/^https?:/i.test(target) && !targetsEmbeddingHost(target) && isExternalUrlAllowed(target, permissions.permissions?.net, netGranted)) return target;
    return null;
  }, { keepHost: scope === 'shadow' });

  const transformed = transformContainerCss(out, {
    scopeSelectors: scope === 'page',
    rewriteViewportUnits: true,
    inline: scope === 'inline',
  });
  const scoped = fontScope
    ? namespaceContainerFonts(transformed, fontScope.prefix, fontScope.families, scope === 'inline')
    : transformed;
  // A sheet ends here with nothing left open: the page's sheets share one `<style>` (closeOpenCss).
  return scope === 'inline' ? scoped : closeOpenCss(scoped);
}

export { extractFontFaces as extractSanitizedFontFaces };

/** The attribute an image asked for with CORS in the app's first markup carries its address in, for the patcher to load (dom-patcher.ts `adoptReadableImages`). */
export const READABLE_ATTR = 'data-softn-readable';
/** On a frame of the first page's markup, until the patcher takes it: the address the app wrote for it. */
export const FRAME_WANTED_ATTR = 'data-softn-frame';

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

/**
 * The media a stylesheet of the page's (`<link media>`, `<style media>`) applies to, or '' for
 * all of them. A print sheet (`media="print"`, which so often hides all but the article) and a
 * sheet for small screens were applied to every screen, as if written for it.
 *
 * Two things keep a sheet for all media, as before. A list with anything in it a media query
 * is not written with: it is put into the sheet, and no more than a query is let in. And a
 * sheet with an `onload`, which is the page's own to turn on: `media="print"
 * onload="this.media='all'"` loads a sheet without holding the page up, and no script of the
 * page's runs on a stylesheet here.
 */
function stylesheetMedia(el: Element): string {
  const media = (el.getAttribute('media') ?? '').trim();
  if (!media || /^all$/i.test(media) || el.hasAttribute('onload')) return '';
  return /^[\w\s(),:./<>=+-]+$/.test(media) ? media : '';
}

/** `css` applied only to `media` ('' for all media). */
function forMedia(css: string, media: string): string {
  return media ? `@media ${media}{\n${css}\n}` : css;
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
  /** Sanitized per-page SEO metadata extracted from `<head>` and `<html>`. */
  meta: {
    title?: string;
    description?: string;
    robots?: string;
    lang?: string;
  };
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
  netGranted: boolean,
  fontScope?: FontScopeContext,
  /** What of another document the page may hold (a frame, an app of its own): nothing, unless the mount says. */
  embeds?: EmbedAllowance
): PreparedDocument {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(htmlSource, 'text/html');
  // The app runs with scripting on, so its `<noscript>` holds nothing it gets, as in a browser
  // that runs scripts. DOMParser reads with scripting off and builds what a `<noscript>` holds:
  // its scripts were run and its stylesheets applied, and every later inline script was given
  // the start line of the one before (findInlineScriptStartLines passes a `<noscript>` over).
  for (const el of Array.from(parsed.querySelectorAll('noscript'))) el.remove();

  // Extract safe per-page SEO metadata before removing <head> elements.
  const pageMeta: PreparedDocument['meta'] = {};
  const rawTitle = (parsed.title || '').replace(/\s+/g, ' ').trim();
  if (rawTitle) pageMeta.title = rawTitle.slice(0, 160);
  const rawLang = (parsed.documentElement?.getAttribute('lang') ?? '').trim();
  if (/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/.test(rawLang)) {
    pageMeta.lang = rawLang;
  }
  const descEl =
    parsed.head?.querySelector('meta[name="description" i]') ??
    parsed.head?.querySelector('meta[property="og:description" i]');
  const rawDesc = (descEl?.getAttribute('content') ?? '').replace(/\s+/g, ' ').trim();
  if (rawDesc) pageMeta.description = rawDesc.slice(0, 320);
  const robotsEl = parsed.head?.querySelector('meta[name="robots" i]');
  const rawRobots = (robotsEl?.getAttribute('content') ?? '').trim().toLowerCase();
  if (rawRobots) {
    const allowed = rawRobots
      .split(/\s*,\s*/)
      .filter((t) =>
        ['index', 'noindex', 'follow', 'nofollow', 'noarchive', 'nosnippet', 'noimageindex', 'none', 'all'].includes(t) ||
        /^max-image-preview:(?:none|standard|large)$/.test(t) ||
        /^max-snippet:(?:-1|[0-9]{1,4})$/.test(t)
      );
    if (allowed.length > 0) pageMeta.robots = [...new Set(allowed)].join(',');
  }

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
      // `rel` is a list of words, as a browser reads it: `rel="stylesheet "` is a stylesheet,
      // and an alternate one is not applied until it is chosen.
      const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/[\t\n\f\r ]+/);
      const href = (el.getAttribute('href') ?? '').trim();
      afterRemoved.set(el, el.nextSibling);
      if (rel.includes('stylesheet') && !rel.includes('alternate') && href) {
        if (href === 'softn:ui.css' || href === '/runtime/ui.css') {
          usesSoftnUiCss = true;
          styles.push(SOFTN_UI_CSS);
        } else {
          const cssPath = archive.resolveFrontendExistingPath(href, entryPath);
          if (cssPath) {
            const cacheKey = `${cssPath}|${netGranted ? '1' : '0'}`;
            const cachedCss = archive.getCachedCss(cacheKey);
            if (cachedCss !== undefined) {
              styles.push(forMedia(cachedCss, stylesheetMedia(el)));
            } else {
              const cssText = archive.readText(cssPath);
              if (cssText !== null) {
                const sanitizedCss = sanitizeContainerCss(cssText, cssPath, archive, permissions, netGranted);
                archive.setCachedCss(cacheKey, sanitizedCss);
                styles.push(forMedia(sanitizedCss, stylesheetMedia(el)));
              }
            }
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
        styles.push(forMedia(sanitizeContainerCss(rawCss, entryPath, archive, permissions, netGranted), stylesheetMedia(el)));
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
          const resolvedSrc = archive.resolveFrontendExistingPath(srcAttr, entryPath);
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
    const resolvedName = hostElementName(el.localName, undefined, embeds);
    const resolvedLower = resolvedName?.toLowerCase();
    // Namespace-prefixed `<x:style>` / `<x:link>` are missed by `querySelectorAll('link, style, script')`
    // above, yet `hostElementName` strips the prefix to `'style'`/`'link'`. Drop them unconditionally
    // so raw unsanitized stylesheets or links can never enter `pageRoot`.
    if (resolvedName === null || resolvedLower === 'style' || resolvedLower === 'link') {
      afterRemoved.set(el, el.nextSibling);
      el.remove();
      continue;
    }
    if (el.localName.toLowerCase() === 'meta' && el.hasAttribute('http-equiv')) {
      el.remove();
    }
  }

  // Namespace all static @font-face families across stylesheets so guest fonts cannot hijack host page fonts.
  if (fontScope && styles.length > 0) {
    for (const s of styles) {
      for (const fam of collectFontFaceFamilies(s)) {
        fontScope.families.add(fam);
      }
    }
    for (let idx = 0; idx < styles.length; idx++) {
      styles[idx] = namespaceContainerFonts(styles[idx], fontScope.prefix, fontScope.families, false);
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
        out.style = sanitizeContainerCss(attr.value, entryPath, archive, permissions, netGranted, 'inline', fontScope);
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
    const tag = hostElementName(el.localName, ns, embeds);
    if (tag === null) return { seed: null, bp: null };
    const lowerTag = tag.toLowerCase();
    // All legitimate initial `<style>` and `<link>` elements were already extracted and sanitized
    // above; reject any remaining (including namespace-prefixed `<x:style>`/`<svg:style>`/`<x:link>`).
    if (lowerTag === 'style' || lowerTag === 'link') return { seed: null, bp: null };

    const id = nextId++;
    seedIds.set(domNode, id);
    const seedAttrs: Record<string, string> = {};
    const hostAttrs: Record<string, string> = {};
    const inlineHandlers: Record<string, string> = {};
    const context = { entryPath, archive, permissions, netGranted, ns, fontScope };

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

    // A frame: the address the app wrote goes to the patcher beside the element (adoptEmbeds),
    // which shows it when the app may have it. Read here alone, a frame of a site the person
    // had not yet allowed stayed empty after they did.
    if (lowerTag === 'iframe' && !ns) {
      const wanted = Object.entries(seedAttrs).find(([name]) => name.toLowerCase() === 'src')?.[1];
      if (typeof wanted === 'string' && wanted.trim()) hostAttrs[FRAME_WANTED_ATTR] = wanted;
    }

    // An image asked for with CORS from a site the app may reach: loaded by the patcher, which
    // fetches it cookie-free (`credentials: 'omit'`) and shows it from a blob of what came
    // (a canvas it is drawn into is read back). Distinct ports on the same host are allowed
    // here when explicitly listed in `allowed_hosts`, while exact same-origin stays blocked.
    if (lowerTag === 'img' && !ns && hostAttrs.crossorigin !== undefined) {
      const readableSrc =
        hostAttrs.src && /^https?:/i.test(hostAttrs.src)
          ? hostAttrs.src
          : typeof seedAttrs.src === 'string' && /^https?:|^\/\//i.test(seedAttrs.src.trim())
            ? sanitizeHostAssetUrl('src', seedAttrs.src, 'img', entryPath, archive, permissions, netGranted, true)
            : null;
      if (readableSrc && /^https?:/i.test(readableSrc)) {
        hostAttrs[READABLE_ATTR] = readableSrc;
        delete hostAttrs.src;
      }
    }

    // Every link gets `noopener noreferrer`; an external link opens in a new tab of its own.
    if (isLinkElement(lowerTag)) {
      const linkHref = hostAttrs.href ?? hostAttrs['xlink:href'] ?? '';
      if (linkHref) {
        hostAttrs.rel = 'noopener noreferrer';
        if (isExternalHref(linkHref)) {
          hostAttrs.target = '_blank';
        }
      }
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

    // By the rule the app's script is held to for these two (ROOT_ATTRIBUTE), and `style` on
    // the body, which is the viewport's own.
    for (const [k, v] of Object.entries(htmlAttrs)) {
      const lowerK = k.toLowerCase();
      if (lowerK.startsWith('data-softn-')) continue;
      if (lowerK === 'class') docRootEl.classList.add(...v.split(/\s+/).filter(Boolean));
      else if (ROOT_ATTRIBUTE.test(lowerK)) docRootEl.setAttribute(lowerK, v);
    }
    for (const [k, v] of Object.entries(bodyAttrs)) {
      const lowerK = k.toLowerCase();
      if (lowerK.startsWith('data-softn-')) continue;
      if (lowerK === 'class') viewportEl.classList.add(...v.split(/\s+/).filter(Boolean));
      else if (lowerK === 'style') viewportEl.setAttribute('style', v);
      else if (ROOT_ATTRIBUTE.test(lowerK)) viewportEl.setAttribute(lowerK, v);
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
      // A media element the parser makes is muted by its `muted`; one made by script and given
      // the attribute is not (the attribute is only its default), and a browser plays no
      // unmuted video of itself: `<video autoplay muted loop>` stood still.
      if (!bp.ns && (bp.tag === 'video' || bp.tag === 'audio') && el.hasAttribute('muted')) (el as HTMLMediaElement).muted = true;
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
    meta: pageMeta,
    mountInitialDom,
  };
}
