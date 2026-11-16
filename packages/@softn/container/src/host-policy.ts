/**
 * What an app may put into the page that embeds it: which elements, and which attributes with
 * which values. One rule for the page as the archive wrote it (sanitize.ts) and for every
 * change the app's script asks for afterwards (dom-patcher.ts).
 *
 * The script runs in a Worker, in a VM, and cannot touch the page; but it decides the
 * arguments of every DOM call it makes, and those arrive here as operations. So everything in
 * an operation is the app's word, and nothing in it is taken as already checked: v0.0.43 kept
 * two lists (one for the first page, one for later changes), each missing what the other had,
 * and trusted the tag of an operation as written.
 */
import type { ContainerArchive } from './archive';
import type { ContainerPermissions } from './types';
import { sanitizeContainerCss, sanitizeHostAssetUrl } from './sanitize';

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const MATH_NS = 'http://www.w3.org/1998/Math/MathML';

/**
 * Elements that run script, load a document, or reach outside the app's box, by their local
 * name in any namespace: an SVG `script` runs as an HTML one does.
 *
 * `slot` would draw the embedding page's own children of the element inside the app; `portal`
 * and `fencedframe` are documents like `iframe`. (`link` and `style` are not here: each has a
 * rule of its own in the patcher, which reads their CSS before the page does.)
 */
const FORBIDDEN_ELEMENTS = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'noscript',
  'portal',
  'fencedframe',
  'slot',
]);

/**
 * The name to create an element by, or null for one the page does not get.
 *
 * A name with a prefix is read by what follows it: `createElementNS(svg, 'svg:script')` makes
 * an SVG `script` (prefix `svg`, local name `script`), which runs; v0.0.43 looked the whole of
 * `svg:script` up in its list, found nothing, and created it. The prefix is dropped, so the
 * element made is the one that was checked.
 */
export function hostElementName(rawTag: string, ns?: 'svg' | 'math'): string | null {
  const local = String(rawTag).slice(String(rawTag).lastIndexOf(':') + 1);
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(local)) return null;
  if (FORBIDDEN_ELEMENTS.has(local.toLowerCase())) return null;
  // SVG and MathML names are case-sensitive (`foreignObject`, `linearGradient`); HTML's are not.
  return ns ? local : local.toLowerCase();
}

/** The element `name` (from hostElementName) in its namespace. */
export function createHostElement(name: string, ns?: 'svg' | 'math'): Element {
  return ns === 'svg' ? document.createElementNS(SVG_NS, name) : ns === 'math' ? document.createElementNS(MATH_NS, name) : document.createElement(name);
}

export interface HostAttributeContext {
  entryPath: string;
  archive: ContainerArchive;
  permissions: ContainerPermissions;
  netGranted: boolean;
}

/** Attributes whose value is one address. */
const URL_ATTRIBUTES = new Set(['src', 'href', 'poster', 'action', 'formaction', 'xlink:href', 'background', 'data', 'manifest']);

/** Attributes whose value is a list of addresses with descriptors (`a.png 1x, b.png 2x`). */
const SRCSET_ATTRIBUTES = new Set(['srcset', 'imagesrcset']);

/**
 * Attributes the page never gets:
 *   - `ping` posts to its address when the link is clicked, whatever the app was granted;
 *   - `srcdoc` and `http-equiv` are a document and a navigation;
 *   - `popover`, `popovertarget` and `popovertargetaction` put an element in the browser's top
 *     layer, over the whole page and over whatever asks the person for consent;
 *   - `autofocus` takes the focus as the element is drawn, from wherever in the embedding
 *     page the person was typing (the app's script asks for the focus through the patcher,
 *     which gives it only where that takes it from nobody).
 */
const DROPPED_ATTRIBUTES = new Set(['ping', 'srcdoc', 'http-equiv', 'popover', 'popovertarget', 'popovertargetaction', 'autofocus']);

/**
 * SVG presentation attributes whose value may be `url(…)`. As attributes they are CSS in all
 * but name: `mask="url(https://elsewhere/m.png)"` is fetched as the property is. Read by the
 * stylesheet's rule, which leaves a `url(#gradient)` in the same document as it is.
 */
const PAINT_ATTRIBUTES = new Set(['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cursor']);

/** The targets a link or form of the app's may name: a new tab, or itself. Never the page it is embedded in (`_top`, `_parent`) or a window by name. */
const TARGETS = new Set(['_blank', '_self']);

/**
 * The value to set for attribute `name` of a `tag` element, or null to leave the attribute
 * off. `tag` is the element's lower-cased local name. Inline handlers (`on…`) are never set:
 * the first page's are moved into the app's VM before this is asked, and a later one is the
 * app's own script's business.
 */
export function hostAttributeValue(tag: string, name: string, value: string, context: HostAttributeContext): string | null {
  const lower = name.toLowerCase();
  if (lower.startsWith('on') || DROPPED_ATTRIBUTES.has(lower)) return null;

  if (lower === 'target') {
    const target = value.trim().toLowerCase();
    return TARGETS.has(target) ? target : null;
  }

  // SVG animation aimed at an address: `<set attributeName="href" to="javascript:…">` writes
  // the link's address after every check here has passed. Neither half is set.
  if (lower === 'attributename' && /^(?:xlink:)?href$/i.test(value.trim())) return null;
  if (lower === 'to' || lower === 'from' || lower === 'by' || lower === 'values') {
    // As a browser reads an address: with the control characters and spaces in it dropped.
    // eslint-disable-next-line no-control-regex -- the C0 controls are what is being removed
    if (/(?:^|;)(?:java|vb)script:/i.test(value.replace(/[\u0000- ]+/g, ''))) return null;
  }

  if (URL_ATTRIBUTES.has(lower)) {
    return sanitizeHostAssetUrl(lower, value, tag, context.entryPath, context.archive, context.permissions, context.netGranted);
  }

  if (SRCSET_ATTRIBUTES.has(lower)) {
    // Each candidate by the rule for a single address; one the app may not load is left out.
    const kept: string[] = [];
    for (const candidate of value.split(',')) {
      const parts = candidate.trim().split(/\s+/);
      if (!parts[0]) continue;
      const clean = sanitizeHostAssetUrl('src', parts[0], tag, context.entryPath, context.archive, context.permissions, context.netGranted);
      if (clean) kept.push([clean, ...parts.slice(1)].join(' '));
    }
    return kept.length > 0 ? kept.join(', ') : null;
  }

  if (lower === 'style' || (PAINT_ATTRIBUTES.has(lower) && /\(|\\/.test(value))) {
    return sanitizeContainerCss(value, context.entryPath, context.archive, context.permissions, context.netGranted);
  }

  return value;
}

/** The most nodes one app's page is given. Past it the page is not grown: the nodes are the embedding page's to lay out and paint. */
export const MAX_HOST_NODES = 200_000;

/** The most kinds of event one app is listened to for. */
export const MAX_EVENT_TYPES = 256;

/** A canvas's side in pixels: no more than a page can hold without stopping. */
export const MAX_CANVAS_SIDE = 8192;

/** A width or height the app asked a canvas for, held to what the page can hold. */
export function canvasSide(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(MAX_CANVAS_SIDE, Math.floor(value))) : 0;
}

/** Whether `tag` is a link the person can follow: `a` (HTML or SVG) or an image map's `area`. */
export const isLinkElement = (tag: string): boolean => tag === 'a' || tag === 'area';

/** Whether `href` leaves the app for the web. */
export const isExternalHref = (href: string): boolean => /^https?:/i.test(href.trim());

/**
 * The properties of a 2D canvas context an app's drawing may set, each to a string, a number
 * or a boolean. Not `filter` with an address in it (`url(https://…#f)` is fetched), and not a
 * name the context does not have: v0.0.43 assigned whatever name it was given.
 */
const CANVAS_PROPERTIES = new Set([
  'fillStyle',
  'strokeStyle',
  'lineWidth',
  'lineCap',
  'lineJoin',
  'miterLimit',
  'lineDashOffset',
  'font',
  'textAlign',
  'textBaseline',
  'direction',
  'letterSpacing',
  'wordSpacing',
  'fontKerning',
  'fontStretch',
  'fontVariantCaps',
  'textRendering',
  'globalAlpha',
  'globalCompositeOperation',
  'shadowBlur',
  'shadowColor',
  'shadowOffsetX',
  'shadowOffsetY',
  'imageSmoothingEnabled',
  'imageSmoothingQuality',
  'filter',
]);

/** Whether a canvas `prop` command may be applied. */
export function canvasPropertyAllowed(name: unknown, value: unknown): boolean {
  if (typeof name !== 'string' || !CANVAS_PROPERTIES.has(name)) return false;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return false;
  return !(name === 'filter' && typeof value === 'string' && /url\s*\(|\\/i.test(value));
}

/**
 * Whether property `prop` of a `<softn-*>` element is one its own class declares (a setter
 * for `rows`, `data`, `options`), which is what a structured value is handed to it by.
 *
 * Not anything the element inherits from the page's own elements: v0.0.43 assigned any name,
 * so an app that asked for `innerHTML` had its markup parsed in the embedding page, handlers
 * and all, and its script ran there. An element whose class has not arrived yet declares
 * nothing, and is asked again when it has (see the patcher).
 */
export function isDeclaredElementProperty(el: Element, prop: string): boolean {
  if (!prop || prop === 'constructor' || prop.startsWith('__') || /^on/i.test(prop)) return false;
  const stop = typeof HTMLElement === 'function' ? HTMLElement.prototype : null;
  let proto: object | null = Object.getPrototypeOf(el);
  while (proto && proto !== stop && proto !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(proto, prop)) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}
