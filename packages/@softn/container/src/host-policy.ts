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
import { isAllowedUiExtension } from './ui-extensions/registry';

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const MATH_NS = 'http://www.w3.org/1998/Math/MathML';

/**
 * Elements that run script, load a document, or reach outside the app's box, by their local
 * name in any namespace: an SVG `script` runs as an HTML one does.
 *
 * `portal` and `fencedframe` are documents like `iframe`. `softn-app` would mount a nested
 * container inside the embedding page's realm. (`link` and `style` are not here:
 * each has a rule of its own in the patcher, which reads their CSS before the page does.
 * `slot` has one below.)
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
  'softn-app',
]);

/**
 * Whether a browser assigns a root's slots by hand (`slotAssignment: 'manual'`), which the
 * container's own roots ask for where they can.
 *
 * A `<slot>` the app makes is the app's alone either way. Its page is in a root of its own,
 * on a box that has no children: a slot there has nothing of anyone's to show. In a shadow
 * tree the app attached, a slot is filled with the children of the app's own element, which
 * is what it is for. (The page was once in the root of the element the app is embedded in,
 * where a slot would have drawn the embedding page's children of that element, and slots
 * were given only to a browser that could be told to assign none.)
 */
export function slotsAreContained(): boolean {
  return typeof HTMLSlotElement !== 'undefined' && typeof (HTMLSlotElement.prototype as { assign?: unknown }).assign === 'function';
}

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
  const lower = local.toLowerCase();
  if (FORBIDDEN_ELEMENTS.has(lower)) return null;
  // Never let untrusted guest HTML instantiate a custom element already defined by the
  // embedding host page (e.g. host widgets or container elements), except allowlisted SoftN UI
  // extensions. Unregistered hyphenated tags remain inert guest custom elements.
  if (
    !ns &&
    lower.includes('-') &&
    typeof customElements !== 'undefined' &&
    customElements.get(lower) &&
    !isAllowedUiExtension(lower)
  ) {
    return null;
  }
  // SVG and MathML names are case-sensitive (`foreignObject`, `linearGradient`); HTML's are not.
  return ns ? local : lower;
}

/** The element `name` (from hostElementName) in its namespace. */
export function createHostElement(name: string, ns?: 'svg' | 'math'): Element {
  return ns === 'svg' ? document.createElementNS(SVG_NS, name) : ns === 'math' ? document.createElementNS(MATH_NS, name) : document.createElement(name);
}

export interface FontScopeContext {
  prefix: string;
  families: Set<string>;
}

export interface HostAttributeContext {
  entryPath: string;
  archive: ContainerArchive;
  permissions: ContainerPermissions;
  netGranted: boolean;
  /** The element's namespace, when it is not HTML's. */
  ns?: 'svg' | 'math';
  /** Per-mount font-family scoping context to prevent host-page @font-face hijacking. */
  fontScope?: FontScopeContext;
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
const DROPPED_ATTRIBUTES = new Set([
  'ping',
  'srcdoc',
  'http-equiv',
  'popover',
  'popovertarget',
  'popovertargetaction',
  'autofocus',
  'command',
  'commandfor',
  'interestfor',
  'interesttarget',
  'attributionsrc',
  'browsingtopics',
  'data-softn-readable',
]);

/** Safe CSS color syntax allowed for `<softn-chart color="...">` (no `url(...)` / `var(...)` / injection). */
const SAFE_CHART_COLOR_RE = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)|[a-z]{3,24})$/i;

/**
 * SVG presentation attributes whose value may be `url(…)`. As attributes they are CSS in all
 * but name: `mask="url(https://elsewhere/m.png)"` is fetched as the property is. Read by the
 * stylesheet's rule, which leaves a `url(#gradient)` in the same document as it is.
 */
const PAINT_ATTRIBUTES = new Set(['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cursor']);

/** The targets a link or form of the app's may name: a new tab, or itself. Never the page it is embedded in (`_top`, `_parent`) or a window by name. */
const TARGETS = new Set(['_blank', '_self']);

/** SVG attributes that an `<animate>` / `<set>` element must never retarget (addresses, styles, URL-bearing presentation refs). */
const FORBIDDEN_ANIMATION_TARGETS = new Set([
  'style',
  'target',
  'filter',
  'mask',
  'clip-path',
  'cursor',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
]);

const SRCSET_DESCRIPTOR_RE = /^(?:[1-9]\d*w|(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?x)$/i;

function parseSrcsetCandidates(raw: string): Array<{ url: string; descriptor: string }> {
  const out: Array<{ url: string; descriptor: string }> = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    while (i < n && (raw[i] === ',' || /\s/.test(raw[i]))) i++;
    if (i >= n) break;
    const urlStart = i;
    while (i < n && !/\s/.test(raw[i])) {
      if (raw[i] === ',' && !/^data:/i.test(raw.slice(urlStart, i))) break;
      i++;
    }
    let url = raw.slice(urlStart, i);
    if (i < n && raw[i] === ',') {
      if (url) out.push({ url, descriptor: '' });
      i++;
      continue;
    }
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
      if (url) out.push({ url, descriptor: '' });
      continue;
    }
    while (i < n && /\s/.test(raw[i])) i++;
    const descStart = i;
    while (i < n && raw[i] !== ',') i++;
    const descriptor = raw.slice(descStart, i).trim();
    if (i < n && raw[i] === ',') i++;
    if (url) out.push({ url, descriptor });
  }
  return out;
}

/**
 * The value to set for attribute `name` of a `tag` element, or null to leave the attribute
 * off. `tag` is the element's lower-cased local name. Inline handlers (`on…`) are never set:
 * the first page's are moved into the app's VM before this is asked, and a later one is the
 * app's own script's business.
 */
export function hostAttributeValue(tag: string, name: string, value: string, context: HostAttributeContext): string | null {
  const lower = name.toLowerCase();
  if (lower.startsWith('on') || DROPPED_ATTRIBUTES.has(lower)) return null;
  // No part of a formula is a link. A browser that follows `href` on any MathML element
  // (Firefox does) follows it by itself: it is no `<a>`, so nothing here hears the click as
  // a link's, and the page the app is embedded in would go where the app said.
  if (context.ns === 'math' && (lower === 'href' || lower === 'xlink:href')) return null;

  if (lower === 'target') {
    const target = value.trim().toLowerCase();
    return TARGETS.has(target) ? target : null;
  }

  // A picture (or anything) asked for with CORS is asked for without the person's cookies:
  // `use-credentials` would have the page send them to the app's sites and hand the app what
  // came back, readable.
  if (lower === 'crossorigin') return 'anonymous';

  // SVG animation aimed at an address or URL-bearing presentation attribute:
  // `<set attributeName="href" to="javascript:…">` or `<set attributeName="filter" to="url(…)">`
  // would mutate the attribute after host checks. Block sensitive targets and sanitize URL/script keyframes.
  if (lower === 'attributename') {
    const targetAttr = value.trim().toLowerCase();
    const localAttr = targetAttr.slice(targetAttr.lastIndexOf(':') + 1);
    if (
      URL_ATTRIBUTES.has(targetAttr) ||
      URL_ATTRIBUTES.has(localAttr) ||
      SRCSET_ATTRIBUTES.has(localAttr) ||
      DROPPED_ATTRIBUTES.has(localAttr) ||
      FORBIDDEN_ANIMATION_TARGETS.has(localAttr) ||
      localAttr.startsWith('on')
    ) {
      return null;
    }
  }
  if (lower === 'to' || lower === 'from' || lower === 'by' || lower === 'values') {
    // As a browser reads an address: with the control characters and spaces in it dropped.
    // eslint-disable-next-line no-control-regex -- the C0 controls are what is being removed
    if (/(?:^|;)(?:java|vb)script:/i.test(value.replace(/[\u0000- ]+/g, ''))) return null;
    if (/\(|\\/.test(value)) {
      return sanitizeContainerCss(value, context.entryPath, context.archive, context.permissions, context.netGranted, 'inline');
    }
  }

  if (URL_ATTRIBUTES.has(lower)) {
    return sanitizeHostAssetUrl(lower, value, tag, context.entryPath, context.archive, context.permissions, context.netGranted);
  }

  if (SRCSET_ATTRIBUTES.has(lower)) {
    // Each candidate by the rule for a single address; descriptors must match HTML srcset syntax
    // so trailing commas or extra tokens can never smuggle an unverified second URL.
    const kept: string[] = [];
    for (const { url, descriptor } of parseSrcsetCandidates(value)) {
      if (descriptor && !SRCSET_DESCRIPTOR_RE.test(descriptor)) continue;
      const clean = sanitizeHostAssetUrl('src', url, tag, context.entryPath, context.archive, context.permissions, context.netGranted);
      if (!clean || /\s/.test(clean) || clean.endsWith(',')) continue;
      kept.push(descriptor ? `${clean} ${descriptor}` : clean);
    }
    return kept.length > 0 ? kept.join(', ') : null;
  }

  if (tag === 'softn-chart' && lower === 'color') {
    const trimmedColor = value.trim();
    return SAFE_CHART_COLOR_RE.test(trimmedColor) ? trimmedColor : null;
  }

  if (tag === 'canvas' && !context.ns && (lower === 'width' || lower === 'height')) {
    const parsed = Number.parseFloat(value.trim());
    return String(canvasSide(parsed));
  }

  if (lower === 'style' || (PAINT_ATTRIBUTES.has(lower) && /\(|\\/.test(value))) {
    return sanitizeContainerCss(value, context.entryPath, context.archive, context.permissions, context.netGranted, 'inline', context.fontScope);
  }

  return value;
}

/** The most nodes one app's page is given. Past it the page is not grown: the nodes are the embedding page's to lay out and paint. */
export const MAX_HOST_NODES = 200_000;

/** The most kinds of event one app is listened to for. */
export const MAX_EVENT_TYPES = 256;

/** A canvas's side in pixels: no more than a page can hold without stopping. */
export const MAX_CANVAS_SIDE = 8192;

/** The most characters of an app's title a host is handed. */
export const MAX_TITLE_LENGTH = 120;

/**
 * An app's title as a host is handed it: text, on one line (control characters, the marks
 * that turn the direction of the text after them, and runs of space become one space), and
 * no longer than a title is. A host shows it in its own chrome, beside words of its own.
 */
export function hostTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    // eslint-disable-next-line no-control-regex -- control characters are what is being taken out
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

/**
 * What is not seen and still takes a place in a line: the format characters (the marks that
 * turn text around among them), and the letters that are drawn as nothing. A hundred of
 * them between `report.pdf` and `.exe` put the name's real end where nobody looks.
 */
const UNSEEN = /[\p{Cc}\p{Cf}\u115f\u1160\u2800\u3164\uffa0]+/gu;

/** The most characters of an app's name in a bar of the container's own. */
export const MAX_LABEL_LENGTH = 60;

/**
 * An app's own name as the container shows it in a bar of its own, beside words of its own:
 * one line, nothing unseen in it, and short. The name is the app's word about itself; a mark
 * in it that turns text around would turn the words that follow it in the bar, the name of
 * the file the person is asked about among them.
 */
export function hostLabel(value: unknown): string {
  return hostTitle(value).replace(UNSEEN, '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LENGTH);
}

/** The most characters of a name a file is saved under. */
export const MAX_FILE_NAME_LENGTH = 120;

/**
 * The name a file an app made is saved under: the app's word for it, as a file's name and
 * nothing else. No folder (a name is not a path), nothing a file system refuses, no control
 * characters, and none of the marks that turn the direction of the text after them: with
 * one, `report‮fdp.exe` reads as `reportexe.pdf` in the bar that asks the person. A name
 * with nothing left in it is `download`. Nothing unseen either, and no quotation mark: the
 * bar shows the name between a pair, and a name with one in it closed the pair early.
 */
export function hostFileName(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  const clean = text
    .replace(UNSEEN, '')
    // What a file system refuses, and the quotation marks a bar puts a name between.
    .replace(/[<>:"/\\|?*\u201c-\u201f\u00ab\u00bb]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, MAX_FILE_NAME_LENGTH)
    .replace(/[. ]+$/, '');
  return clean || 'download';
}

/** A width or height the app asked a canvas for, held to what the page can hold. */
export function canvasSide(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(MAX_CANVAS_SIDE, Math.floor(value))) : 0;
}

/** Whether `tag` is a link the person can follow: `a` (HTML or SVG) or an image map's `area`. */
export const isLinkElement = (tag: string): boolean => tag === 'a' || tag === 'area';

/** Whether `href` leaves the app for the web. */
export const isExternalHref = (href: string): boolean => {
  // eslint-disable-next-line no-control-regex -- strip C0 controls/spaces identically to WHATWG URL parser
  return /^https?:/i.test(href.replace(/[\u0000-\u0020\u007f]+/g, ''));
};

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
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc) return typeof desc.set === 'function';
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}
