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
import { sanitizeContainerCss, sanitizeFrameUrl, sanitizeHostAssetUrl } from './sanitize';
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
 *
 * Two of these a mount may let an app have, each by a rule of its own and never as the app
 * wrote it ([`EmbedAllowance`]): an `iframe` of a site the person allowed the app, and a
 * `softn-app` of an archive the app carries. Asked without an allowance, both are refused
 * as they always were.
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
export function hostElementName(rawTag: string, ns?: 'svg' | 'math', embeds?: EmbedAllowance): string | null {
  const local = String(rawTag).slice(String(rawTag).lastIndexOf(':') + 1);
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(local)) return null;
  const lower = local.toLowerCase();
  // The two documents a mount may let the page hold, as HTML elements only: each is made by
  // createHostElement, which decides what it is, and its attributes by hostAttributeValue.
  if (!ns && embeds && ((lower === 'iframe' && embeds.frames === true) || (lower === NESTED_APP_TAG && embeds.apps === true))) return lower;
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
  if (ns === 'svg') return document.createElementNS(SVG_NS, name);
  if (ns === 'math') return document.createElementNS(MATH_NS, name);
  if (name === 'iframe') return createFrameElement();
  const el = document.createElement(name);
  if (name === NESTED_APP_TAG) nestedAppElements.add(el);
  return el;
}

// ---------------------------------------------------------------------------------------------
// Another document in the app's page: a frame of a site, and an app of the app's own
// ---------------------------------------------------------------------------------------------

/**
 * What of another document a mount lets its app put in the page. Both are off unless the
 * mount turns them on: a rule asked without one answers as it did before either existed.
 */
export interface EmbedAllowance {
  /** `<iframe>` of an `https:` site the app declared (`net`) and the person allowed. */
  frames?: boolean;
  /** `<softn-app src="…">` of an archive the app carries among its own files. */
  apps?: boolean;
}

/** The element an app nests another app in. */
export const NESTED_APP_TAG = 'softn-app';

/** The most frames one app's page holds at once. Each is a whole document of another site's. */
export const MAX_HOST_FRAMES = 12;

/** The most apps one app's page nests at once. Each is a Worker and a VM of its own. */
export const MAX_NESTED_APPS = 8;

/** How deep apps nest: an app at this depth nests none. The page's own app is at depth 0. */
export const MAX_NESTING_DEPTH = 3;

/**
 * The most apps nested under one app the person opened, at every depth together. The bounds
 * above are each page's own, and multiply down the levels: eight in each of eight in each of
 * eight is five hundred Workers from one archive, and twelve frames in each is seven thousand
 * documents.
 */
export const MAX_TREE_NESTED_APPS = 16;

/** How many nested apps are started under one app in NESTED_START_WINDOW_MS: a box that names another archive on every tick starts one each time. */
export const MAX_NESTED_STARTS = 24;
export const NESTED_START_WINDOW_MS = 10_000;

/**
 * What the pages of one app the person opened hold between them: its own page, and that of
 * every app nested in it at any depth. Made by the mount of the app the person opened and
 * handed down, so that the bounds are on what one archive brings to the embedding page.
 */
export interface EmbedBudget {
  /** Frames the pages hold (MAX_HOST_FRAMES between them). */
  frames: number;
  /** Nested apps started and not yet ended, a start still under way among them. */
  apps: number;
  /** When each of the latest nested apps was started, the oldest first. */
  starts: number[];
}

export function newEmbedBudget(): EmbedBudget {
  return { frames: 0, apps: 0, starts: [] };
}

/**
 * What a frame's document may do, whatever the app asked for. It runs its own script and
 * keeps its own origin (a video player has neither without them), sends its own forms, opens
 * a tab of its own when the person follows a link in it, and goes full screen. It is not let
 * take the embedding page somewhere else (`allow-top-navigation`), put a dialog of the
 * browser's over it (`allow-modals`), save a file (`allow-downloads`) or hold the pointer.
 *
 * `allow-same-origin` beside `allow-scripts` is safe only for a document of another origin
 * than the embedding page's, which is what sanitizeFrameUrl lets a frame be asked for, and
 * what guardFrame looks for again each time the frame has loaded.
 */
export const FRAME_SANDBOX: readonly string[] = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-presentation',
];

/**
 * What of the embedding page's own permissions a frame may be handed (`allow`): what a
 * player needs. Never the camera, the microphone, where the person is, their screen or a
 * payment: those are the person's answer to the embedding site, and the app's own to ask
 * for through the container (`permission.json`), not a third site's by the app's say-so.
 * Nor the clipboard, the share sheet or the device's motion, which a player's own embed code
 * asks for and plays without: what the person allowed the app was a site to be shown.
 */
const FRAME_FEATURES = new Set(['autoplay', 'encrypted-media', 'picture-in-picture', 'fullscreen']);

/**
 * How much of the embedding page's address a frame's site is told. Its origin by default,
 * which a player asks for before it plays (and a browser tells a frame its ancestors'
 * origins whatever is written here). Never the whole address: the path and query of the
 * embedding page are the person's, and may name what they are looking at.
 */
const FRAME_REFERRER = new Set(['no-referrer', 'origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin']);
export const FRAME_REFERRER_DEFAULT = 'strict-origin-when-cross-origin';

/** The attribute the host puts on every frame, and the app neither sets nor takes off (createHostElement). */
export const FRAME_CREDENTIALLESS = 'credentialless';

/** The attributes that are a frame's own, each read by frameAttributeValue. */
const FRAME_ATTRIBUTES = new Set(['src', 'sandbox', 'allow', 'allowfullscreen', 'referrerpolicy', 'loading', 'width', 'height', 'frameborder', 'scrolling']);

/**
 * Attributes of the two elements the app does not create, the document's root and its body
 * (the viewport), that the app may give them: the rule the patcher holds the app's script to
 * (dom-patcher.ts `ROOT_ATTRIBUTE`), for the page as the archive wrote it too. The first page
 * had a list of its own, and an app's `<body dir="rtl" lang="ar">` was drawn left to right.
 */
export const ROOT_ATTRIBUTE = /^(?:class|lang|dir|role|title|data-[\w.-]+|aria-[\w-]+)$/;

/** The attributes any element has that say nothing but how it looks and what it is called. */
function isPlainAttribute(lower: string): boolean {
  return (
    lower === 'class' || lower === 'id' || lower === 'style' || lower === 'title' || lower === 'hidden' || lower === 'role' ||
    lower === 'tabindex' || lower === 'lang' || lower === 'dir' || lower === 'slot' ||
    ((lower.startsWith('data-') || lower.startsWith('aria-')) && !lower.startsWith('data-softn-'))
  );
}

/** The sandbox a frame is given: the host's, less whatever the app itself asked to go without. */
export function frameSandbox(asked?: string | null): string {
  if (asked === undefined || asked === null) return FRAME_SANDBOX.join(' ');
  const wanted = new Set(asked.toLowerCase().split(/\s+/).filter(Boolean));
  return FRAME_SANDBOX.filter((token) => wanted.has(token)).join(' ');
}

/** A frame's own attribute by the host's rule, or null to leave it off. */
function frameAttributeValue(lower: string, value: string, context: HostAttributeContext): string | null {
  const text = value.trim();
  switch (lower) {
    case 'src':
      return sanitizeFrameUrl(value, context.permissions, context.netGranted);
    case 'sandbox':
      // Only ever narrower than the host's: a token the host does not give is not one the app can add.
      return frameSandbox(value);
    case 'allow': {
      const kept: string[] = [];
      for (const part of text.split(';')) {
        const feature = part.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
        if (FRAME_FEATURES.has(feature) && !kept.includes(feature)) kept.push(feature);
      }
      return kept.length > 0 ? kept.join('; ') : null;
    }
    case 'allowfullscreen':
      return '';
    case 'referrerpolicy':
      return FRAME_REFERRER.has(text.toLowerCase()) ? text.toLowerCase() : FRAME_REFERRER_DEFAULT;
    case 'loading':
      return text.toLowerCase() === 'lazy' || text.toLowerCase() === 'eager' ? text.toLowerCase() : null;
    case 'width':
    case 'height':
      return /^\d{1,5}(?:\.\d{1,3})?%?$/.test(text) ? text : null;
    case 'frameborder':
      return text === '0' || text === '1' ? text : null;
    case 'scrolling':
      return /^(?:yes|no|auto)$/i.test(text) ? text.toLowerCase() : null;
    default:
      return null;
  }
}

/**
 * A frame for the app's page: sandboxed before it has an address, so that no document is
 * ever in it without one, and watched each time it has loaded.
 */
function createFrameElement(): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', frameSandbox());
  frame.setAttribute('referrerpolicy', FRAME_REFERRER_DEFAULT);
  // Its site is shown as to someone it has never seen: none of the person's cookies or
  // storage for it are there, so what the app frames is the site, not the person's account
  // on it. And a page that is cross-origin isolated (softn.com sends
  // `Cross-Origin-Embedder-Policy: credentialless` with every page) is shown no frame at all
  // without this: a player that sends no such header of its own is refused by the browser.
  frame.setAttribute(FRAME_CREDENTIALLESS, '');
  frame.addEventListener('load', () => guardFrame(frame));
  return frame;
}

/**
 * A frame that has come to hold a document of the embedding page's own origin is emptied.
 *
 * The address the app asked for is another site's (sanitizeFrameUrl), but where a frame
 * goes after that is the framed site's to say: a redirect, or its script, can bring it to a
 * page of the embedding site, which the sandbox then runs as that site with the person
 * signed in, inside the app's box. Only a document of the page's own origin can be read
 * from here, so one that can be is one that must not be there.
 *
 * Answers whether it was. A frame found so stays empty for good (isTrippedFrame): the address
 * that brought it there would bring it there again, and each time the embedding site's page
 * is live in the app's box until this is asked.
 *
 * What this cannot see is a document of another origin of the embedding site's own (a
 * sibling name, another port): it is as unreadable from here as any site's. Where that
 * matters, the embedding site says of its own pages that they are not framed
 * (`frame-ancestors`), which no script of the framed site's can undo.
 */
export function guardFrame(frame: HTMLIFrameElement): boolean {
  let here: string | null = null;
  try {
    here = frame.contentWindow ? frame.contentWindow.location.href : null;
  } catch {
    return false; // Another origin's document: what the frame is for.
  }
  // An empty frame is the page's own `about:blank`, with nothing in it.
  if (here === null || here === 'about:blank') return false;
  trippedFrames.add(frame);
  emptyFrame(frame);
  return true;
}

/** The frames guardFrame found holding a document of the embedding page's own origin. */
const trippedFrames = new WeakSet<HTMLIFrameElement>();

/** Whether `frame` was found holding the embedding site's own page: it is shown nothing again. */
export function isTrippedFrame(frame: HTMLIFrameElement): boolean {
  return trippedFrames.has(frame);
}

/**
 * Take a frame's document away: its address off the element, and the document it holds
 * replaced by an empty one. (An address taken off an element leaves the document it loaded
 * where it is.)
 */
export function emptyFrame(frame: HTMLIFrameElement): void {
  frame.removeAttribute('src');
  try {
    frame.contentWindow?.location.replace('about:blank');
  } catch {
    // No document to replace (the frame is on no page), or none that can be.
  }
}

/** The `<softn-app>` elements made for an app to nest another in: not ones the app's page has by any other way. */
const nestedAppElements = new WeakSet<Element>();

/** Whether `el` is a box an app nests another app in (made by createHostElement for the app's `<softn-app>`). */
export function isNestedAppElement(el: unknown): el is HTMLElement {
  return typeof el === 'object' && el !== null && nestedAppElements.has(el as Element);
}

/**
 * The archive an app's `<softn-app src>` names: a `.softn` or `.zip` among the app's own
 * front-end files, by its path in the archive, or null. Never an address: an app nests what
 * it carries, which the person was given with it, and nothing it could fetch later.
 */
export function nestedAppSource(value: string, context: Pick<HostAttributeContext, 'archive' | 'entryPath'>): string | null {
  const text = value.trim();
  if (!text || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(text)) return null;
  const resolved = context.archive.resolveFrontendExistingPath(text.split(/[?#]/)[0], context.entryPath);
  if (resolved === null || !/\.(?:softn|zip)$/i.test(resolved)) return null;
  // The name is the file's own, and reads as itself: the mount reads the archive by what
  // this answers, and a name that reads as another file's (`%73erver/x.zip`, which is
  // `server/x.zip` read once more) would be checked as one file and run as another.
  if (!isNestedAppFile(context.archive, resolved)) return null;
  return `/${resolved.replace(/^\/+/, '')}`;
}

/** Whether `name` is, exactly, a front-end file of the archive: what a nested app is read by. */
export function isNestedAppFile(archive: ContainerArchive, name: string): boolean {
  return archive.resolveExistingPath(name) === name && archive.isFrontendPath(name);
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

/** SVG/CSS attributes & properties that an `<animate>` / `<set>` element must never retarget (addresses, styles, URL-bearing presentation refs, top-layer/view-transition escapes). */
const FORBIDDEN_ANIMATION_TARGETS = new Set([
  'style',
  'target',
  'filter',
  'mask',
  'mask-image',
  'clip-path',
  'cursor',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
  'appearance',
  '-webkit-appearance',
  '-moz-appearance',
  'view-transition-name',
  'background',
  'background-image',
  'content',
  'border-image',
  'border-image-source',
  'list-style',
  'list-style-image',
  'fill',
  'stroke',
]);

const SRCSET_DESCRIPTOR_RE = /^(?:[1-9]\d*w|(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?x)$/i;

/**
 * The candidates of a `srcset`, read as HTML reads one: an address is everything up to the
 * space after it, commas and all, and commas at its end end the candidate. An address with a
 * comma in it is an image service's (`…/upload/c_scale,w_480/a.jpg 480w`), and was cut there:
 * the picture was asked for at `…/upload/c_scale`, which is no picture. What the page is given
 * is put together again from the candidates read here, each checked, so it reads the same.
 */
function parseSrcsetCandidates(raw: string): Array<{ url: string; descriptor: string }> {
  const out: Array<{ url: string; descriptor: string }> = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    while (i < n && (raw[i] === ',' || /\s/.test(raw[i]))) i++;
    if (i >= n) break;
    const urlStart = i;
    while (i < n && !/\s/.test(raw[i])) i++;
    let url = raw.slice(urlStart, i);
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

  // A frame and a nested app are each another document: of their own attributes only the
  // ones read here are set, and of any element's only those that say how it looks.
  if (!context.ns && tag === 'iframe') {
    if (FRAME_ATTRIBUTES.has(lower)) return frameAttributeValue(lower, value, context);
    if (!isPlainAttribute(lower)) return null;
  }
  if (!context.ns && tag === NESTED_APP_TAG) {
    if (lower === 'src') return nestedAppSource(value, context);
    // Where the nested app starts: a path of its own, which it reads by its own rule.
    if (lower === 'initial-path') return /^\/[^\s\\]{0,511}$/.test(value.trim()) && !value.trim().startsWith('//') ? value.trim() : null;
    if (!isPlainAttribute(lower)) return null;
  }

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

/** The longest end of a name, from its last `.`, kept when the name is shortened (`.xlsx`, `.gz`). */
const MAX_FILE_EXTENSION_LENGTH = 16;

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
  const whole = text
    .replace(UNSEEN, '')
    // What a file system refuses, and the quotation marks a bar puts a name between.
    .replace(/[<>:"/\\|?*\u201c-\u201f\u00ab\u00bb]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (whole.length <= MAX_FILE_NAME_LENGTH) return whole || 'download';
  // Shortened before its extension, which says what the file is: cut off with the end of a
  // long name, a report was saved as a file of no kind that nothing would open.
  const dot = whole.lastIndexOf('.');
  const extension = dot > 0 && whole.length - dot <= MAX_FILE_EXTENSION_LENGTH ? whole.slice(dot) : '';
  return `${whole.slice(0, MAX_FILE_NAME_LENGTH - extension.length).replace(/[. ]+$/, '')}${extension}` || 'download';
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
  return /^https?:\/\//i.test(href.replace(/[\u0000-\u0020\u007f]+/g, ''));
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
