/**
 * Direct Surgical Host DOM Patcher + Canvas 2D Replayer + Delegated Event Bridge.
 *
 * Replaces SoftN v1's `DocumentShell -> ElementNode AST -> React VDOM -> ReactDOM`
 * pipeline with direct `O(1)` operations against a `Map<number, Node>` inside
 * `<softn-app>`'s closed `ShadowRoot`.
 */

import { ContainerArchive, bytesToBase64, piecesToBytes } from './archive';
import { blobWithin } from './capped-body';
import { replayCanvasCommands } from './canvas-replay';
import {
  MATH_NS,
  MAX_EVENT_TYPES,
  MAX_HOST_NODES,
  SVG_NS,
  canvasSide,
  createHostElement,
  hostAttributeValue,
  hostElementName,
  hostTitle,
  isDeclaredElementProperty,
  isExternalHref,
  isLinkElement,
} from './host-policy';
import { NODE_ID_ATTR, READABLE_ATTR, extractSanitizedFontFaces, sanitizeContainerCss, sanitizeHostAssetUrl } from './sanitize';
import type {
  Canvas2DCmd,
  ContainerPermissions,
  MeasuredBoxTuple,
  ShellOp,
  ThreeSceneOp,
} from './types';

/**
 * Attributes of the two elements the app does not create — the document's root (id 0) and
 * its `body`, the viewport (id 1) — that the app may set. Not `style` on the root, which is
 * the box the app is kept in.
 */
const ROOT_ATTRIBUTE = /^(?:class|lang|dir|role|title|data-[\w.-]+|aria-[\w-]+)$/;

/**
 * The ids the app's document gives its own `<html>` and `<head>` (core's shell-source.ts,
 * `init`). Its `<body>` is 1: the viewport.
 */
const GUEST_HTML_ID = -2;
const GUEST_HEAD_ID = -3;

/**
 * Properties whose effect depends on the element's place in the page or on its children:
 * applied after the tree a turn built (see applyOps).
 */
const TREE_PROPERTIES = new Set(['selectedIndex', 'chosen', 'focus', 'scrollIntoView', 'scrollTop', 'scrollLeft']);

/** The most images an app has the page load for it that are not on the page (`new Image()`). */
const MAX_PRELOADED_IMAGES = 2048;

/** The largest picture of a canvas handed back to the app as a file. */
const MAX_CANVAS_FILE_BYTES = 32 * 1024 * 1024;

/** How long after a click or a key of the person's the app may ask to save a file. */
const ACTIVATION_MS = 5000;
/** The largest picture from another site the page fetches for the app to read back, and the most all it keeps of them take. */
const MAX_READABLE_PICTURE_BYTES = 32 * 1024 * 1024;
const MAX_READABLE_TOTAL_BYTES = 128 * 1024 * 1024;

/** How long after the person's click in the app an element around it that the click left the focus on is the app's to move on from. */
const CLICK_FOCUS_MS = 1500;

/** How long after a save was asked for nothing counts as a new word of the person's: what is left of the same press. */
const SAME_PRESS_MS = 500;

/** The most shadow trees an app has at once, and how many more there must be before those no longer on the page are looked for. */
const MAX_SHADOW_ROOTS = 8192;
const SWEEP_ROOTS_EVERY = 256;

/** How many more nodes there must be before those no longer on the app's page are looked for. */
const SWEEP_NODES_EVERY = 10_000;

/**
 * The most canvases and images kept from the sweep because the app lately drew on them or
 * from them: one off the page may be a buffer or a sprite sheet the app still draws with.
 */
const MAX_DRAWN_LATELY = 2000;

/**
 * The most pixels of the canvases the page keeps for the app off its page, in all (four bytes
 * each): past it, the least lately drawn on are let go of. The app's side says when it lets go
 * of a canvas itself; this is for an app that makes canvases faster than it lets go of them.
 */
const MAX_OFF_PAGE_PIXELS = 64 * 1024 * 1024;

/** The most pictures of canvases made for an app at once. */
const MAX_CANVAS_ENCODES = 4;

/**
 * Events that leave a shadow tree, by the web's own rule (every one a person's hand or keys
 * make): heard on the app's page wherever they happened, so a shadow root is not listened
 * on for them. What is not here (a form sent, a field's change, a picture's load) stays in
 * its tree, and every root is listened on for it.
 */
const COMPOSED_EVENTS = new Set([
  'click', 'dblclick', 'auxclick', 'contextmenu', 'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
  'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'pointercancel',
  'touchstart', 'touchend', 'touchmove', 'touchcancel', 'wheel', 'keydown', 'keyup', 'keypress', 'input', 'beforeinput',
  'focus', 'blur', 'focusin', 'focusout', 'compositionstart', 'compositionupdate', 'compositionend',
  'dragstart', 'drag', 'dragend', 'dragenter', 'dragleave', 'dragover', 'drop',
]);

/**
 * The most files of one file field handed to an app, and the most bytes of them together.
 *
 * Ten megabytes, which is what crosses to the app in one piece: the bytes go as text, and
 * the engine takes a text of sixteen megabytes at most. The app keeps a file as that text
 * and makes bytes of it only when something reads them, a part a turn (guest-web-apis.ts),
 * so a file is heard of at once whatever its size; an address for it, a data: URL of it and
 * a request that uploads it make no bytes at all. (Made bytes all at once, in the turn the
 * field's change was heard in, two megabytes arrived and two and a half never did.) A file
 * past the limit is left out and the app is told so.
 */
const MAX_PICKED_FILES = 32;
const MAX_PICKED_BYTES = 10 * 1024 * 1024;
const MAX_PICKED_FILE_BYTES = MAX_PICKED_BYTES;

/** The most measured elements the sweep let go of that are remembered, to be measured again if they are told again. */
const MAX_SWEPT_MEASURED = 20_000;

/** How long after the person's last scroll the app is told where its page and elements are, when no event has told it. */
const SCROLL_SETTLE_MS = 100;

/** The most animations an app runs at once, the most keyframes in one, and the longest any part of one lasts. */
const MAX_ANIMATIONS = 2048;
const MAX_KEYFRAMES = 512;
const MAX_ANIMATION_MS = 3_600_000;

/**
 * Events that do not bubble: heard on their way down to the element. `load` and `error` are an
 * image's (and a video's): listened for as they bubble, they were never heard, and an image's
 * `onload` never ran.
 */
const CAPTURE_ONLY_EVENTS = new Set([
  'load',
  'error',
  'focus',
  'blur',
  'scroll',
  'mouseenter',
  'mouseleave',
  'pointerenter',
  'pointerleave',
  'toggle',
  'invalid',
]);

const PASSIVE_EVENTS = new Set(['scroll', 'wheel', 'touchstart', 'touchmove']);

export interface DomPatcherCallbacks {
  /**
   * An event for the app's script. `answered`, when given, is called once the script has
   * heard it, with what it said: bit 1 when it cancelled the event (`preventDefault()`).
   */
  onEvent: (
    nodeId: number,
    eventType: string,
    props: Record<string, unknown>,
    syncChanges: unknown[],
    answered?: (eventBits: number) => void
  ) => void;
  onSync: (changes: unknown[]) => void;
  onTitleChange?: (title: string) => void;
  onNavigate?: (href: string) => void;
  onFormSubmit?: (req: { action: string; method: string; encoded: string }) => void;
  onExternalLink?: (href: string) => void;
  onCustomTag?: (tag: string) => void;
  onThreeOps?: (canvas: HTMLCanvasElement, canvasId: number, ops: ThreeSceneOp[]) => void;
  /** The app's script asks to save a file it made, just after a click or a key of the person's in the app. */
  onSaveRequest?: (file: { name: string; type: string; bytes: Uint8Array }) => void;
  /** Something the app is to be told in its console, as a warning: what the page could not do for it. */
  onWarning?: (text: string) => void;
  /** Sanitized `@font-face` rules extracted from a dynamic `<style>`/`<link>` sheet (empty string when cleared/removed). */
  onStyleFonts?: (sheet: Element, fontFacesCss: string) => void;
}

export class HostDomPatcher {
  readonly nodes = new Map<number, Node>();
  private readonly viewportEl: HTMLElement;
  private readonly docRootEl: HTMLElement;
  private readonly archive: ContainerArchive;
  private readonly entryPath: string;
  private permissions: ContainerPermissions;
  private netGranted: boolean;
  private filesGranted: boolean;
  /** When the person last clicked or pressed a key in the app: a file is saved only just after. */
  private lastActivation = Number.NEGATIVE_INFINITY;
  /**
   * The element around the app that held the focus just after the person's last click in it,
   * the element inside it (through its own open shadow trees) that did, and when. Forgotten
   * when the person presses or clicks anywhere outside the app.
   */
  private clickFocus: Element | null = null;
  private clickFocusDeep: Element | null = null;
  private clickFocusAt = Number.NEGATIVE_INFINITY;
  /** The files of a file field as last read for the app, by the list the page holds for it. */
  private readonly pickedFiles = new WeakMap<HTMLInputElement, { list: FileList | null; change: Promise<unknown[]> }>();
  private readonly callbacks: DomPatcherCallbacks;

  private readonly listenedEvents = new Set<string>();
  private readonly cleanupFns: Array<() => void> = [];
  /**
   * `<style>` elements the app made, each with the ids of the text nodes it was given. The
   * text never goes into the element as written: the page reads the sheet only after the
   * host has (sanitizeContainerCss), on every change to it.
   */
  private readonly styleSheets = new Map<Element, number[]>();
  /**
   * `<link>` elements the app made. Each is a `<style>` in the page: a stylesheet of the
   * app's is read from the archive and put there by the host's rule, and any other `rel`
   * (prefetch, preload, an icon) does nothing.
   */
  private readonly links = new Map<Element, { rel: string; href: string }>();
  /** Stylesheet links read (or not found) in the batch being applied, for the app's script to hear of. */
  private readonly linkNews = new Map<Element, 'load' | 'error'>();
  /** Structured values for a `<softn-*>` element whose class has not arrived yet. */
  private readonly pendingProperties = new Map<Element, Array<[string, unknown]>>();
  private readonly measuredIds = new Set<number>();
  /**
   * Measured elements let go of by the sweep, by id: the app's side asks for an element to be
   * measured once, so one put on the page again (a tab panel kept off it, Vue's KeepAlive) is
   * measured again when it is told again. Forgotten, it never was, and the app kept its old size.
   */
  private readonly sweptMeasured = new Set<number>();
  /** The app's elements (and its page) the person has scrolled since the app was last told where they are. */
  private readonly scrolledSince = new Set<Element>();
  private scrollSettle: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private measureScheduled = false;
  private readonly imageCache = new Map<string, HTMLImageElement>();
  /** The blob each image fetched for the app to read back is shown from (loadReadable), and what each holds. */
  private readonly readableUrls = new Map<HTMLImageElement, string>();
  private readonly readableSizes = new Map<string, number>();
  /** Bytes of such pictures being read now, held with those kept to their total. */
  private readableLoading = 0;
  /** An image of the page's being loaded as readable: the address it was asked for, and which asking is the last. */
  private readonly wantedSrc = new WeakMap<HTMLImageElement, string>();
  private readonly readableTokens = new WeakMap<HTMLImageElement, number>();
  /** Animations the app's script started (`element.animate`), by the key the script knows each by. */
  private readonly animations = new Map<string, { el: Element; animation: Animation }>();
  /**
   * The shadow roots the app's script attached to elements of its own. Each is a real one on
   * the page, so its stylesheets are its own and the browser fills its slots; and each is
   * listened on as the app's page is, because what does not leave a shadow tree (a form
   * sent, a field changed) is heard nowhere else.
   */
  private readonly shadowRoots = new Set<ShadowRoot>();
  /** What listens for the app's events: on its page, and on every shadow root attached in it. */
  private readonly listening: Array<{ type: string; fn: (e: Event) => void; capture: boolean }> = [];
  /** Stylesheets written in the batch being applied, read again at its end by where each then is. */
  private readonly writtenSheets = new Set<Element>();
  /** Stylesheets last written as a shadow tree's own: read again as the page's if one is ever found outside a tree. */
  private readonly shadowSheets = new Set<Element>();
  /** Each attached root's id, as the app's document knows it. */
  private readonly rootIds = new Map<ShadowRoot, number>();
  /** How many roots there were when those of elements no longer on the page were last let go. */
  private rootsAtSweep = 0;
  /** How many nodes were known when those no longer on the page were last looked for, and the ones found off it then. */
  private nodesAtSweep = 0;
  private offPage = new Set<number>();
  /** The canvases and images drawn on or from lately, the least lately first. */
  private readonly drawnLately = new Map<number, true>();
  /** The canvases the page made for the app's canvases that are on no page, by id. */
  private readonly offPage2d = new Map<number, HTMLCanvasElement>();
  private readonly bitmapContexts = new WeakMap<HTMLCanvasElement, ImageBitmapRenderingContext>();
  private warnedOffPage = false;
  private readonly sweepNodesEvery: number;
  /** Canvases with a picture from the network drawn into them, which are not the app's to read back. */
  private readonly unreadable = new WeakSet<HTMLCanvasElement>();
  /** Pictures of canvases being made for the app. */
  private encoding = 0;
  /** Until when no click or key is the person's word for a save: the rest of the press that asked for the last one. */
  private quietUntil = 0;
  /** Browser actions deferred until the guest has had a chance to cancel their event. */
  private readonly heldDefaults = new WeakMap<Event, () => void>();
  private disposed = false;

  constructor(params: {
    viewportEl: HTMLElement;
    docRootEl: HTMLElement;
    /**
     * Where what the app's script puts in its `<head>` is kept: stylesheets apply from
     * there, and nothing in it is drawn. Without one the head's children go nowhere, as
     * they did: a `<style>` or a stylesheet `<link>` added to `document.head` (how every
     * library that styles from script adds its rules, and how a bundler adds the
     * stylesheet of a part of the app loaded later) never reached the page.
     */
    headEl?: HTMLElement;
    archive: ContainerArchive;
    entryPath: string;
    permissions: ContainerPermissions;
    netGranted: boolean;
    /** Whether the person allowed the app files: what they pick in a file field is then read for it. */
    filesGranted?: boolean;
    /** How many more nodes there must be before those no longer on the page are looked for (a test asks sooner). */
    sweepNodesEvery?: number;
    callbacks: DomPatcherCallbacks;
  }) {
    this.viewportEl = params.viewportEl;
    this.docRootEl = params.docRootEl;
    this.archive = params.archive;
    this.entryPath = params.entryPath;
    this.permissions = params.permissions;
    this.netGranted = params.netGranted;
    this.filesGranted = params.filesGranted === true;
    this.sweepNodesEvery = Math.max(1, params.sweepNodesEvery ?? SWEEP_NODES_EVERY);
    this.callbacks = params.callbacks;
    if (params.headEl) this.nodes.set(GUEST_HEAD_ID, params.headEl);

    this.installCoreInputSync();
    this.installResizeObserver();
  }

  updatePermissions(permissions: ContainerPermissions, netGranted: boolean, filesGranted = this.filesGranted): void {
    this.permissions = permissions;
    this.netGranted = netGranted;
    this.filesGranted = filesGranted;
  }

  /** Apply a batch of `ShellOp` operations produced by a Worker VM turn. */
  applyOps(ops: readonly ShellOp[]): void {
    if (this.disposed) return;

    // What is asked of an element that depends on where it is and what is in it, kept until
    // the turn's tree is in place. The app's document tells each parent's children at the end
    // of a turn, after every property set in it: applied as they came, a select was told
    // which option it shows before it had any (a framework that fills a select and chooses
    // in one turn showed the first), and a field was focused before it was on the page.
    const afterTree: Array<[number, string, unknown]> = [];
    let treeChanged = false;
    const started: Array<[string, number, unknown, unknown]> = [];
    const controlled: Array<[string, string]> = [];

    // A blob the script made an address for is kept before anything else in the turn is
    // read: the same turn that makes the address sets it on an image.
    for (const op of ops) {
      if (op[0] !== 'blob') continue;
      const [, id, type, given] = op;
      if (typeof id !== 'string') continue;
      try {
        const bytes = piecesToBytes(given);
        if (bytes) this.archive.putRuntimeBlob(id, typeof type === 'string' ? type : '', bytes);
      } catch {
        // Not base64: nothing is kept, and the address names nothing.
      }
    }

    for (const op of ops) {
      switch (op[0]) {
        case 'blob':
          break;

        case 'sr': {
          const [, hostId, rootId] = op;
          if (!Number.isInteger(hostId) || !Number.isInteger(rootId) || hostId <= 1 || rootId <= 1) break;
          // On an element the app made, never on the page's own (its root, its body).
          const hostEl = this.nodes.get(hostId);
          if (!(hostEl instanceof Element) || typeof hostEl.attachShadow !== 'function') break;
          let root = hostEl.shadowRoot && this.shadowRoots.has(hostEl.shadowRoot) ? hostEl.shadowRoot : null;
          if (!root) {
            // As many as a page has a use for, and counted with its nodes.
            if (this.shadowRoots.size >= MAX_SHADOW_ROOTS || (!this.nodes.has(rootId) && this.nodes.size >= MAX_HOST_NODES)) break;
            try {
              // Open, on the page: what is inside is the app's, and the page reads it as it
              // reads the rest of the app (to find the element an event happened on).
              root = hostEl.attachShadow({ mode: 'open' });
            } catch {
              // An element the browser attaches none to.
              break;
            }
            this.shadowRoots.add(root);
            // What does not leave a shadow tree is listened for inside it; what does is heard on the page.
            for (const { type, fn, capture } of this.listening) {
              if (!COMPOSED_EVENTS.has(type)) {
                root.addEventListener(type, fn, PASSIVE_EVENTS.has(type) ? { capture, passive: true } : capture);
              }
            }
          }
          this.rootIds.set(root, rootId);
          this.nodes.set(rootId, root);
          break;
        }

        case 'unblob':
          if (typeof op[1] === 'string') this.archive.dropRuntimeBlob(op[1]);
          break;

        case 'img':
          if (typeof op[1] === 'string' && typeof op[2] === 'string') this.preloadImage(op[1], op[2], op[3] === 'anonymous');
          break;

        case 'anim':
          // After the tree: the element it animates may have been made in this same turn.
          if (typeof op[1] === 'string' && typeof op[2] === 'number') started.push([op[1], op[2], op[3], op[4]]);
          break;

        case 'anim-ctl':
          if (typeof op[1] === 'string' && typeof op[2] === 'string') controlled.push([op[1], op[2]]);
          break;

        case 'canvas-blob': {
          const [, token, id, type, quality] = op;
          if (typeof token !== 'string') break;
          const answer = (bytes: Uint8Array | null, kind = '') => {
            if (!this.disposed) this.callbacks.onEvent(-1, 'softn:canvas', bytes ? { token, base64: bytesToBase64(bytes), kind } : { token }, []);
          };
          const canvas = this.nodes.get(id);
          // A picture of what the app drew from its own files and its own bytes. Not of a
          // canvas a picture from the network went into: the browser fetched that one with
          // the person's cookies for its site, and from the embedding page's own site it
          // would be read back whole (the browser's own rule stops only other sites'). And a
          // few at a time: each is a picture encoded on the page's thread.
          if (!(canvas instanceof HTMLCanvasElement) || typeof canvas.toBlob !== 'function' || this.unreadable.has(canvas) || this.encoding >= MAX_CANVAS_ENCODES) {
            answer(null);
            break;
          }
          const kind = type === 'image/jpeg' || type === 'image/webp' ? type : 'image/png';
          this.encoding++;
          let told = false;
          const tell = (bytes: Uint8Array | null, was = '') => {
            if (told) return;
            told = true;
            this.encoding--;
            answer(bytes, was);
          };
          try {
            canvas.toBlob(
              (blob) => {
                if (!blob || blob.size > MAX_CANVAS_FILE_BYTES) tell(null);
                else void readFile(blob as File).then((bytes) => tell(bytes, blob.type), () => tell(null));
              },
              kind,
              typeof quality === 'number' && quality >= 0 && quality <= 1 ? quality : undefined
            );
          } catch {
            // A canvas with a picture drawn into it that is not the app's to read back.
            tell(null);
          }
          break;
        }

        case 'save': {
          // Only just after a click or a key of the person's in the app, and one file for
          // each: an app saves nothing by itself, and not a stream of files for one click.
          if (typeof op[1] !== 'string' || performance.now() - this.lastActivation > ACTIVATION_MS) break;
          const blob = this.archive.getRuntimeBlob(op[1]);
          if (!blob) break;
          this.lastActivation = Number.NEGATIVE_INFINITY;
          // The press that asked is spent with it: its key going up, the click its pointer
          // going down ends in, are not a second word for a second file.
          this.quietUntil = performance.now() + SAME_PRESS_MS;
          this.callbacks.onSaveRequest?.({ name: typeof op[2] === 'string' ? op[2] : '', type: blob.type, bytes: blob.bytes });
          break;
        }

        case 'e': {
          const [, id, rawTag, attrs, rawNs] = op;
          if (!Number.isInteger(id) || id <= 1 || typeof rawTag !== 'string') break;
          // The page is the embedding page's to lay out and paint: past a size no app's page
          // has a use for, it is not grown.
          if (!this.nodes.has(id) && this.nodes.size >= MAX_HOST_NODES) break;
          const ns = rawNs === 'svg' || rawNs === 'math' ? rawNs : undefined;
          // The element's own name, by the host's rule (host-policy.ts): none for what the
          // page does not get, whatever prefix or case the operation spelled it with.
          const name = hostElementName(rawTag, ns);
          if (name === null) {
            this.nodes.set(id, document.createComment('blocked'));
            break;
          }
          const lower = name.toLowerCase();
          // A canvas told again (moved, or put on the page after it was drawn on off it) keeps
          // what is drawn on it, as a canvas that moves does: made again, it was blank.
          const told = this.nodes.get(id);
          if (!ns && lower === 'canvas' && told instanceof HTMLCanvasElement) {
            this.offPage2d.delete(id);
            const given = attrs && typeof attrs === 'object' ? (attrs as Record<string, unknown>) : {};
            for (const attr of Array.from(told.attributes)) {
              if (!attr.name.startsWith('data-softn-') && !(attr.name in given)) told.removeAttribute(attr.name);
            }
            for (const [k, v] of Object.entries(given)) {
              const value = typeof v === 'string' ? v : null;
              // Its size set again to what it is would clear it. Compared with the size it has:
              // at the default size (300 by 150) it has no such attribute.
              if ((k === 'width' || k === 'height') && value !== null && String(k === 'width' ? told.width : told.height) === value.trim()) continue;
              this.applySafeAttribute(told, lower, k, value);
            }
            if (!this.measuredIds.has(id)) {
              this.measuredIds.add(id);
              this.resizeObserver?.observe(told);
            }
            this.scheduleBoxMeasure();
            break;
          }
          // A `<link>` is a `<style>` here, filled by the host when it names a stylesheet of
          // the app's; the page never fetches what a link names.
          const isLink = !ns && lower === 'link';
          const el = isLink ? document.createElement('style') : createHostElement(name, ns);
          if (isLink) this.links.set(el, { rel: '', href: '' });
          else if (lower === 'style') this.styleSheets.set(el, []);
          if (!ns && lower.startsWith('softn-')) {
            this.callbacks.onCustomTag?.(lower);
          }
          if (attrs && typeof attrs === 'object') {
            for (const [k, v] of Object.entries(attrs)) {
              this.applySafeAttribute(el, lower, k, typeof v === 'string' ? v : null);
            }
          }
          el.setAttribute(NODE_ID_ATTR, String(id));
          // An element told again (it was moved) is made again: the one before, and the
          // shadow tree it had, are let go.
          const before = this.nodes.get(id);
          if (before instanceof Element && before.shadowRoot && this.shadowRoots.has(before.shadowRoot)) this.dropShadowRoot(before.shadowRoot);
          this.nodes.set(id, el);
          // Measured before: the element it is now is observed and measured (the one before was).
          if (el instanceof HTMLCanvasElement || this.measuredIds.has(id) || this.sweptMeasured.delete(id)) {
            if (before instanceof Element) this.resizeObserver?.unobserve(before);
            this.measuredIds.add(id);
            this.resizeObserver?.observe(el);
            this.scheduleBoxMeasure();
          }
          break;
        }

        case 'x': {
          const [, id, rawText] = op;
          if (!Number.isInteger(id) || id <= 1) break;
          const text = typeof rawText === 'string' ? rawText : String(rawText ?? '');
          const existing = this.nodes.get(id);
          if (existing && existing.nodeType === Node.TEXT_NODE) {
            existing.nodeValue = text;
            // A text node of a `<style>` is kept out of the page: its sheet is written again.
            const sheet = this.sheetOf(id);
            if (sheet) this.writeStyleSheet(sheet);
          } else if (existing || this.nodes.size < MAX_HOST_NODES) {
            const tn = document.createTextNode(text);
            if (existing?.parentNode) existing.parentNode.replaceChild(tn, existing);
            this.nodes.set(id, tn);
          }
          break;
        }

        case 'm': {
          const [, id] = op;
          if (Number.isInteger(id) && id > 1 && !this.nodes.has(id) && this.nodes.size < MAX_HOST_NODES) {
            this.nodes.set(id, document.createComment(''));
          }
          break;
        }

        case 'a': {
          const [, id, name, val] = op;
          if (typeof name !== 'string') break;
          const value = typeof val === 'string' ? val : null;
          // The head is the host's own element, kept out of sight: nothing of it is the app's to set.
          if (id === GUEST_HEAD_ID) break;
          if (id === 0 || id === GUEST_HTML_ID || id === 1) {
            // The document's root and its body are the host's own elements: the app names
            // their classes and the like, and the body's style, and nothing else of them.
            // (The root is told by the id the app's document gives its <html>. It was looked
            // for under 0, which nothing sends: a class or a data-theme the script set on
            // document.documentElement, as a dark mode does, never arrived.)
            const root = id === 1 ? this.viewportEl : this.docRootEl;
            const lowerName = name.toLowerCase();
            if (ROOT_ATTRIBUTE.test(lowerName)) {
              if (value === null) root.removeAttribute(lowerName);
              else root.setAttribute(lowerName, value);
            } else if (id === 1 && lowerName === 'style') {
              if (value === null) root.removeAttribute('style');
              else root.setAttribute('style', sanitizeContainerCss(value, this.entryPath, this.archive, this.permissions, this.netGranted, 'inline'));
            }
            break;
          }
          const target = this.nodes.get(id);
          if (target && target.nodeType === Node.ELEMENT_NODE) {
            const el = target as Element;
            this.applySafeAttribute(el, this.links.has(el) ? 'link' : el.localName.toLowerCase(), name, value);
          }
          break;
        }

        case 'c': {
          const [, parentId, childIds] = op;
          if (!Array.isArray(childIds)) break;
          // The children of the app's body, of its head, of an element or a shadow root it
          // made. Not of the page's scroller (the document's root, under either id it has
          // gone by): that holds the head and the body, and what was put beside them was
          // outside everything the app's page is held by.
          if (parentId === 0 || parentId === GUEST_HTML_ID) break;
          treeChanged = true;
          const parent = parentId === 1 ? this.viewportEl : this.nodes.get(parentId);
          if (!parent || (parent.nodeType !== Node.ELEMENT_NODE && parent.nodeType !== Node.DOCUMENT_FRAGMENT_NODE)) {
            break;
          }
          // A `<link>` has no children. A `<style>`'s are its text, which the host writes.
          if (this.links.has(parent as Element)) break;
          if (this.styleSheets.has(parent as Element)) {
            this.styleSheets.set(parent as Element, childIds.filter((cid) => Number.isInteger(cid)));
            this.writeStyleSheet(parent as Element);
            break;
          }
          this.reconcileChildren(parent as Element, childIds);
          break;
        }

        case 'p': {
          const [, id, prop, val] = op;
          if (TREE_PROPERTIES.has(prop)) afterTree.push([id, prop, val]);
          else this.applyProperty(id, prop, val);
          break;
        }

        case 'l': {
          const [, eventType] = op;
          this.ensureEventListener(eventType);
          break;
        }

        case 't': {
          // The app's word for itself, which a host may show in its own chrome or the
          // browser's tab: one line of text and no longer than a title is. It was passed on
          // as it came, whatever it was and however long.
          this.callbacks.onTitleChange?.(hostTitle(op[1]));
          break;
        }

        case 'n': {
          this.callbacks.onNavigate?.(op[1]);
          break;
        }

        case 'k2d': {
          const [, canvasId, width, height, cmds] = op;
          this.drawnWith(canvasId, cmds);
          const node = this.nodes.get(canvasId) ?? this.offPageCanvas(canvasId);
          if (node && node instanceof HTMLCanvasElement) {
            const area = node.width * node.height;
            this.replayCanvas2D(node, width, height, cmds);
            this.keepOffPage(canvasId, node, area);
          }
          break;
        }

        case 'k2dgone': {
          // The app let go of a canvas: one on no page is let go of here too.
          const node = this.nodes.get(op[1]);
          if (node instanceof HTMLCanvasElement && !node.isConnected) this.releaseCanvas(op[1], node);
          break;
        }

        case 'k2dreset': {
          // Set even when it is the size the canvas has: setting it is what clears a canvas.
          this.drawnWith(op[1], []);
          const node = this.nodes.get(op[1]) ?? this.offPageCanvas(op[1]);
          if (node && node instanceof HTMLCanvasElement) {
            const area = node.width * node.height;
            const w = canvasSide(op[2]);
            const h = canvasSide(op[3]);
            if (w > 0) node.width = w;
            if (h > 0) node.height = h;
            this.keepOffPage(op[1], node, area);
          }
          break;
        }

        case '3d': {
          const [, canvasId, threeOps] = op;
          const node = this.nodes.get(canvasId);
          if (node && node instanceof HTMLCanvasElement) {
            // A scene's textures are fetched where the scene is drawn: its picture is not read back.
            this.unreadable.add(node);
            this.callbacks.onThreeOps?.(node, canvasId, threeOps);
          }
          break;
        }
      }
    }

    // A stylesheet is written as its text arrives, which is before the turn's tree is in
    // place: one that ended up in a shadow tree is written again as that tree's own.
    if (this.writtenSheets.size > 0) {
      const written = [...this.writtenSheets];
      this.writtenSheets.clear();
      for (const sheet of written) {
        if (this.cssScope(sheet) !== 'shadow') continue;
        const link = this.links.get(sheet);
        if (link) this.writeLinkedSheet(sheet, link);
        else if (this.styleSheets.has(sheet)) this.writeStyleSheet(sheet);
      }
      this.writtenSheets.clear();
    }
    if (treeChanged) {
      // And the other way: a sheet written as a shadow tree's own that is no longer in one
      // (the app's document makes an element again when it moves; an operation written by
      // hand need not) is read again as the page's, where `:host` is not the app's.
      for (const sheet of [...this.shadowSheets]) {
        if (this.cssScope(sheet) === 'shadow') continue;
        this.shadowSheets.delete(sheet);
        const link = this.links.get(sheet);
        if (link) this.writeLinkedSheet(sheet, link);
        else if (this.styleSheets.has(sheet)) this.writeStyleSheet(sheet);
        else sheet.textContent = '';
      }
      this.writtenSheets.clear();
      if (this.shadowRoots.size >= this.rootsAtSweep + SWEEP_ROOTS_EVERY) this.sweepShadowRoots();
    }
    if (this.nodes.size >= this.nodesAtSweep + this.sweepNodesEvery) this.sweepNodes();
    this.limitOffPageCanvases();

    for (const [id, prop, val] of afterTree) this.applyProperty(id, prop, val);
    for (const [key, id, frames, timing] of started) this.startAnimation(key, id, frames, timing);
    for (const [key, action] of controlled) this.controlAnimation(key, action);

    // A stylesheet link whose sheet is in, or could not be read: the script that added it is
    // told, as a browser tells it. A bundler's loader waits for exactly this before it runs
    // the part of the app the stylesheet belongs to (Vite, for a chunk loaded on demand).
    if (this.linkNews.size > 0) {
      const news = [...this.linkNews];
      this.linkNews.clear();
      for (const [el, type] of news) {
        const id = Number(el.getAttribute(NODE_ID_ATTR));
        if (Number.isInteger(id) && id > 1 && this.nodes.get(id) === el) this.callbacks.onEvent(id, type, {}, []);
      }
    }

    if (this.measuredIds.size > 0) {
      this.scheduleBoxMeasure();
    }
  }

  /** Set or remove an attribute the app asked for, by the host's rule (host-policy.ts). */
  private applySafeAttribute(el: Element, lowerTag: string, name: string, val: string | null): void {
    const lowerName = name.toLowerCase();
    if (lowerName === NODE_ID_ATTR) return;

    // A `<link>`: only what decides which sheet it is. The `<style>` standing in for it
    // takes `media` as a link does; nothing else of a link means anything here.
    const link = this.links.get(el);
    if (link) {
      if (lowerName === 'rel') link.rel = val ?? '';
      else if (lowerName === 'href') link.href = val ?? '';
      else if (lowerName === 'media' || lowerName === 'title' || lowerName === 'id' || lowerName === 'class' || lowerName.startsWith('data-')) {
        if (val === null) el.removeAttribute(lowerName);
        else el.setAttribute(lowerName, val);
        return;
      } else return;
      this.writeLinkedSheet(el, link);
      return;
    }

    if (val === null) {
      el.removeAttribute(name);
      if (isLinkElement(lowerTag)) this.holdLink(el);
      // An image no longer asked for with CORS (or with no address): loaded as any other.
      if (lowerTag === 'img' && el instanceof HTMLImageElement && (lowerName === 'crossorigin' || lowerName === 'src')) {
        const wanted = this.wantedSrc.get(el);
        this.cancelReadable(el);
        if (lowerName === 'crossorigin' && wanted) el.setAttribute('src', wanted);
      }
      return;
    }

    const clean = hostAttributeValue(lowerTag, name, val, {
      entryPath: this.entryPath,
      archive: this.archive,
      permissions: this.permissions,
      netGranted: this.netGranted,
      ns: el.namespaceURI === MATH_NS ? 'math' : el.namespaceURI === SVG_NS ? 'svg' : undefined,
    });
    // An image on the page asked for with CORS: fetched by the page and shown from a blob of
    // what came (loadReadable), so that a canvas it is drawn into is read back, toBlob too.
    // Shown from its own address, where a redirect took it was not the page's to know.
    if (lowerTag === 'img' && el instanceof HTMLImageElement && el.namespaceURI !== SVG_NS) {
      if (lowerName === 'src') {
        if (clean !== null && /^https?:/i.test(clean) && el.hasAttribute('crossorigin')) {
          this.readableImage(el, clean);
          return;
        }
        this.cancelReadable(el);
      } else if (lowerName === 'crossorigin' && clean !== null) {
        el.setAttribute('crossorigin', clean);
        const wanted = this.wantedSrc.get(el) ?? el.getAttribute('src');
        if (wanted && /^https?:/i.test(wanted)) this.readableImage(el, wanted);
        return;
      }
    }
    try {
      if (clean === null) el.removeAttribute(name);
      else el.setAttribute(name, clean);
    } catch {
      // Ignore invalid attribute names
    }
    if (isLinkElement(lowerTag)) this.holdLink(el);
  }

  /** An image of the page's loaded as one the app may read: fetched, and shown from a blob of what came; told `error` if it cannot be. */
  private readableImage(img: HTMLImageElement, address: string): void {
    const token = (this.readableTokens.get(img) ?? 0) + 1;
    this.readableTokens.set(img, token);
    this.wantedSrc.set(img, address);
    // Nothing loaded from its address meanwhile: what shows is what can be read.
    img.removeAttribute('src');
    this.loadReadable(img, address, () => this.readableTokens.get(img) === token);
  }

  /** The images of the app's first markup asked for with CORS (sanitize.ts marks them): each loaded as one the app may read. */
  adoptReadableImages(root: ParentNode): void {
    for (const img of Array.from(root.querySelectorAll(`img[${READABLE_ATTR}]`))) {
      const address = img.getAttribute(READABLE_ATTR);
      img.removeAttribute(READABLE_ATTR);
      if (img instanceof HTMLImageElement && address) this.readableImage(img, address);
    }
  }

  /** An image's readable load, if one is under way, is no longer wanted. */
  private cancelReadable(img: HTMLImageElement): void {
    if (!this.wantedSrc.has(img)) return;
    this.wantedSrc.delete(img);
    this.readableTokens.set(img, (this.readableTokens.get(img) ?? 0) + 1);
    this.letGoOfReadable(img);
  }

  /** A link out opens in a tab of its own with no handle on this page, whatever target the app gave it and in whatever order it set them. */
  private holdLink(el: Element): void {
    if (!isExternalHref(el.getAttribute('href') ?? '')) return;
    el.setAttribute('rel', 'noopener noreferrer');
    el.setAttribute('target', '_blank');
  }

  /** The `<style>` whose text node `id` is, if it is one's. */
  private sheetOf(id: number): Element | null {
    for (const [sheet, ids] of this.styleSheets) {
      if (ids.includes(id)) return sheet;
    }
    return null;
  }

  /** Write a `<style>` the app made: its text nodes' text, read by the host first. */
  private writeStyleSheet(sheet: Element): void {
    let css = '';
    for (const id of this.styleSheets.get(sheet) ?? []) {
      const node = this.nodes.get(id);
      if (node && node.nodeType === Node.TEXT_NODE) css += node.nodeValue ?? '';
    }
    const scope = this.cssScope(sheet);
    const sanitized = sanitizeContainerCss(css, this.entryPath, this.archive, this.permissions, this.netGranted, scope);
    sheet.textContent = sanitized;
    this.callbacks.onStyleFonts?.(sheet, extractSanitizedFontFaces(sanitized));
    this.writtenSheets.add(sheet);
    if (scope === 'shadow') this.shadowSheets.add(sheet);
    else this.shadowSheets.delete(sheet);
  }

  /** Let go of a shadow tree: emptied, and no longer one of the app's. */
  private dropShadowRoot(root: ShadowRoot): void {
    this.shadowRoots.delete(root);
    this.rootIds.delete(root);
    root.replaceChildren();
  }

  /**
   * Let go of the shadow trees of elements that are no longer on the app's page. Asked at
   * the end of a batch, when every element the app's document has on its page is on this
   * one. Each is emptied, and forgotten under the ids it and its element went by, so
   * nothing can put it back as it was, unlistened to.
   */
  private sweepShadowRoots(): void {
    for (const root of [...this.shadowRoots]) {
      if (this.owns(root.host)) continue;
      const hostId = Number(root.host.getAttribute(NODE_ID_ATTR));
      if (this.nodes.get(hostId) === root.host) this.nodes.delete(hostId);
      const rootId = this.rootIds.get(root);
      if (rootId !== undefined && this.nodes.get(rootId) === root) this.nodes.delete(rootId);
      this.dropShadowRoot(root);
    }
    this.rootsAtSweep = this.shadowRoots.size;
  }

  /**
   * Forget the nodes that are no longer on the app's page.
   *
   * The app's document tells the page of a node when it joins the page and never says it
   * has left: a node taken off is dropped from its parent's children, and one put back is
   * told afresh and made afresh. So every node an app ever showed was kept by its id, and
   * an app that makes and drops nodes for as long as it runs (a list that scrolls, a game's
   * sprites) came to the most nodes a page may have and drew nothing new after that.
   *
   * Asked at the end of a batch, when every node the document has on its page is on this
   * one. A node found off the page is let go the second time it is found there, in case a
   * batch ever ends between a node's being told and its being placed. The text of a
   * stylesheet is kept out of the page on purpose, and stays while its sheet does.
   */
  /**
   * A canvas of the app's that the page was not told of: one on no page (a buffer, a sprite
   * cache, a layer drawn once and copied every frame). The app's document tells the page of
   * a node when it joins the page, so the page had none, drew nothing on it, and drew
   * nothing from it. Made here when it is first drawn on, and the one used if it joins the
   * page later.
   */
  private offPageCanvas(id: unknown): HTMLCanvasElement | undefined {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 1 || this.nodes.size >= MAX_HOST_NODES) return undefined;
    const canvas = document.createElement('canvas');
    canvas.setAttribute(NODE_ID_ATTR, String(id));
    this.nodes.set(id, canvas);
    this.offPage2d.set(id, canvas);
    return canvas;
  }

  /** A canvas let go of: out of the page's table, and its pixels given back now. */
  private releaseCanvas(id: number, canvas: HTMLCanvasElement): void {
    this.nodes.delete(id);
    this.drawnLately.delete(id);
    this.offPage2d.delete(id);
    canvas.width = 0;
    canvas.height = 0;
  }

  /**
   * A canvas on no page that was drawn on (made so, or taken off the page and drawn on still):
   * counted with the others, and held to their budget at once when it is new or grew. Held to
   * it only when a batch was over, a batch that made a hundred large ones had them all at once;
   * and one taken off the page was never counted.
   */
  private keepOffPage(id: number, canvas: HTMLCanvasElement, areaBefore: number): void {
    if (canvas.isConnected) return;
    const known = this.offPage2d.has(id);
    if (!known) this.offPage2d.set(id, canvas);
    if (!known || canvas.width * canvas.height > areaBefore) this.limitOffPageCanvases();
  }

  /** Within what the page keeps of canvases on no page: the least lately drawn on are let go of. */
  private limitOffPageCanvases(): void {
    if (this.offPage2d.size === 0) return;
    let pixels = 0;
    for (const canvas of this.offPage2d.values()) pixels += canvas.width * canvas.height;
    if (pixels <= MAX_OFF_PAGE_PIXELS) return;
    // Least lately drawn first: drawnLately is in that order; one never drawn with is first of all.
    const rank = new Map<number, number>();
    let at = 0;
    for (const key of this.drawnLately.keys()) rank.set(key, at++);
    const order = [...this.offPage2d.keys()].sort((a, b) => (rank.get(a) ?? -1) - (rank.get(b) ?? -1));
    for (const id of order) {
      if (pixels <= MAX_OFF_PAGE_PIXELS) break;
      const canvas = this.offPage2d.get(id)!;
      if (canvas.isConnected) {
        this.offPage2d.delete(id);
        continue;
      }
      pixels -= canvas.width * canvas.height;
      this.releaseCanvas(id, canvas);
      if (!this.warnedOffPage) {
        this.warnedOffPage = true;
        this.callbacks.onWarning?.(
          `[SoftN] The page let go of a canvas the app had not drawn on lately, one on no page, to keep the canvases it keeps for the app off its page within ${MAX_OFF_PAGE_PIXELS} pixels: drawn from again, it is blank.`
        );
      }
    }
  }


  /** A canvas drawn on, and the canvases and images drawn from into it: kept from the sweep while the app draws with them. */
  private drawnWith(canvasId: number, cmds: readonly Canvas2DCmd[] | undefined): void {
    const touch = (id: number) => {
      if (!Number.isInteger(id)) return;
      this.drawnLately.delete(id);
      this.drawnLately.set(id, true);
      if (this.drawnLately.size > MAX_DRAWN_LATELY) {
        const oldest = this.drawnLately.keys().next().value;
        if (oldest !== undefined) this.drawnLately.delete(oldest);
      }
    };
    touch(canvasId);
    if (!Array.isArray(cmds)) return;
    for (const cmd of cmds) {
      if (Array.isArray(cmd) && cmd[0] === 'drawImage' && typeof cmd[1] === 'string' && cmd[1].startsWith('node:')) touch(Number(cmd[1].slice(5)));
    }
  }

  private sweepNodes(): void {
    // Nothing is on any page while the app's page is not on one: nothing to tell apart.
    if (!this.docRootEl.isConnected) return;
    const sheetText = new Set<number>();
    for (const [sheet, ids] of this.styleSheets) if (sheet.isConnected) for (const id of ids) sheetText.add(id);
    const found = new Set<number>();
    for (const [id, node] of this.nodes) {
      // The page's own (its scroller, its body, its head) are no one's to forget; nor is a
      // canvas or an image the app lately drew with, on the page or not.
      // A canvas drawn on while on no page is left to its own budget (and to the app's letting go of it).
      if (id <= 1 || node.isConnected || sheetText.has(id) || this.drawnLately.has(id) || this.offPage2d.has(id)) continue;
      if (!this.offPage.has(id)) {
        found.add(id);
        continue;
      }
      this.nodes.delete(id);
      if (this.measuredIds.delete(id)) {
        this.sweptMeasured.add(id);
        if (this.sweptMeasured.size > MAX_SWEPT_MEASURED) this.sweptMeasured.delete(this.sweptMeasured.values().next().value as number);
      }
      // The browser's observer holds what it observes: let go of here, let go of there too.
      if (node instanceof Element) this.resizeObserver?.unobserve(node);
      if (node instanceof HTMLImageElement) this.letGoOfReadable(node);
      if (node instanceof ShadowRoot) {
        if (this.shadowRoots.has(node)) this.dropShadowRoot(node);
      } else if (node instanceof Element) {
        if (this.styleSheets.delete(node) || this.links.delete(node)) this.callbacks.onStyleFonts?.(node, '');
        this.links.delete(node);
        this.linkNews.delete(node);
        this.pendingProperties.delete(node);
        this.shadowSheets.delete(node);
        if (node.shadowRoot && this.shadowRoots.has(node.shadowRoot)) this.dropShadowRoot(node.shadowRoot);
      }
    }
    this.offPage = found;
    this.nodesAtSweep = this.nodes.size;
  }

  /**
   * Whether a picture drawn into a canvas leaves it readable: the app's own bytes (a file of
   * its own, a blob it made, another canvas of such, or a picture from another site the app
   * asked for with CORS, which the page fetched for it and keeps as a blob: loadReadable).
   * An image of the page's with a network address is not, `crossorigin` or not: where a
   * redirect took it is not the page's to know.
   */
  private isOwnPicture(source: CanvasImageSource): boolean {
    if (source instanceof HTMLCanvasElement) return !this.unreadable.has(source);
    if (!(source instanceof HTMLImageElement)) return false;
    return /^(?:blob|data):/i.test(source.currentSrc || source.src);
  }

  /**
   * A picture from another site the app asked for with CORS, to draw from and read back: fetched
   * with CORS and without the person's cookies, read only if it came from a site the app may
   * read from (wherever a redirect took it) and never from the embedding page's own site, and
   * kept as a blob of what came, which is the app's to read. On failure, `img` is told so.
   */
  private loadReadable(img: HTMLImageElement, address: string, current: () => boolean = () => true): void {
    const readable = (url: string): boolean => {
      try {
        const parsed = new URL(url);
        if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin === location.origin) return false;
      } catch {
        return false;
      }
      return sanitizeHostAssetUrl('src', url, 'img', this.entryPath, this.archive, this.permissions, this.netGranted) !== null;
    };
    const failed = () => {
      if (!this.disposed && current()) img.dispatchEvent(new Event('error'));
    };
    if (!readable(address) || typeof fetch !== 'function') {
      queueMicrotask(failed);
      return;
    }
    // Never from the browser's copy: one the embedding page loaded with the person's cookies
    // (a site of its own it shares cookies with) would come back as if fetched without them.
    void fetch(address, { mode: 'cors', credentials: 'omit', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok || (response.redirected && !readable(response.url))) throw new Error('not readable');
        // Read a part at a time and held to its size as it comes, and with the others being
        // read to what all of them may keep: a size said first is not always there, nor true.
        let loading = 0;
        let blob: Blob;
        try {
          blob = await blobWithin(response, MAX_READABLE_PICTURE_BYTES, (bytes) => {
            loading += bytes;
            this.readableLoading += bytes;
            let kept = this.readableLoading;
            for (const size of this.readableSizes.values()) kept += size;
            return kept <= MAX_READABLE_TOTAL_BYTES;
          });
        } finally {
          this.readableLoading -= loading;
        }
        if (this.disposed) throw new Error('not kept');
        // Asked for another address since: this one is not shown.
        if (!current()) return;
        // One kept for each image, the one it shows, and all of them held to a total: an image
        // that changed its address every second kept every picture it had ever shown.
        this.letGoOfReadable(img);
        let total = blob.size;
        for (const kept of this.readableSizes.values()) total += kept;
        if (total > MAX_READABLE_TOTAL_BYTES) throw new Error('too much');
        const url = URL.createObjectURL(blob);
        this.readableUrls.set(img, url);
        this.readableSizes.set(url, blob.size);
        img.src = url;
      })
      .catch(failed);
  }

  /** The blob an image was shown from, given back. */
  private letGoOfReadable(img: HTMLImageElement): void {
    const url = this.readableUrls.get(img);
    if (url === undefined) return;
    this.readableUrls.delete(img);
    this.readableSizes.delete(url);
    URL.revokeObjectURL(url);
  }

  /**
   * The element an event happened on, as the app knows it: the innermost one on the
   * event's way that is in a tree of the app's own (its page, a shadow tree it attached).
   * Inside one of the page's own components (a grid's cells, a chart's marks) the element
   * is the component's, and the app hears of the component.
   */
  private originOf(e: Event): Element | null {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const page = this.docRootEl.getRootNode();
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      const root = node.getRootNode();
      if (root === page || (root instanceof ShadowRoot && this.shadowRoots.has(root))) return node;
    }
    return e.target instanceof Element ? e.target : null;
  }

  /** Where a stylesheet is: the app's page, or a shadow tree the app attached. */
  private cssScope(sheet: Element): 'page' | 'shadow' {
    const root = sheet.getRootNode();
    return root instanceof ShadowRoot && this.shadowRoots.has(root) ? 'shadow' : 'page';
  }

  /** Whether a node is the app's: in its page, or in a shadow tree attached in it. */
  private owns(node: Node | null): boolean {
    for (let cur = node; cur; cur = this.parentOf(cur)) if (cur === this.docRootEl) return true;
    return false;
  }

  /** A node's parent, out of a shadow tree of the app's to the element it is attached to. */
  private parentOf(node: Node): Node | null {
    const parent = node.parentNode;
    if (parent instanceof ShadowRoot) return this.shadowRoots.has(parent) ? parent.host : null;
    return parent;
  }

  /**
   * Listen on the app's page, and for what does not leave a shadow tree on every shadow
   * root attached in it, now and later. On the page's scroller, which holds the app's head
   * and its body and so everything the app has put anywhere.
   */
  private listen(type: string, fn: (e: Event) => void, capture: boolean): void {
    this.listening.push({ type, fn, capture });
    const opts = PASSIVE_EVENTS.has(type) ? { capture, passive: true } : capture;
    this.docRootEl.addEventListener(type, fn, opts);
    if (!COMPOSED_EVENTS.has(type)) for (const root of this.shadowRoots) root.addEventListener(type, fn, opts);
  }

  /** Fill the `<style>` standing in for a `<link>`: a stylesheet of the app's, by the host's rule, or nothing. */
  private writeLinkedSheet(el: Element, link: { rel: string; href: string }): void {
    let css = '';
    if (/(?:^|\s)stylesheet(?:\s|$)/i.test(link.rel) && link.href.trim()) {
      const path = this.archive.resolveExistingPath(link.href, this.entryPath);
      const text = path ? this.archive.readText(path) : null;
      const scope = this.cssScope(el);
      if (path && text !== null) css = sanitizeContainerCss(text, path, this.archive, this.permissions, this.netGranted, scope);
      this.writtenSheets.add(el);
      if (scope === 'shadow') this.shadowSheets.add(el);
      else this.shadowSheets.delete(el);
      // Only a stylesheet of the app's own is ever read: any other is said to have failed.
      this.linkNews.set(el, path && text !== null ? 'load' : 'error');
    } else {
      this.linkNews.delete(el);
    }
    el.textContent = css;
    this.callbacks.onStyleFonts?.(el, extractSanitizedFontFaces(css));
  }

  /** Reconcile `parent`'s DOM children to match `childIds` with minimal DOM moves. */
  private reconcileChildren(parent: Element, childIds: readonly number[]): void {
    const desiredNodes: Node[] = [];
    const desiredSet = new Set<Node>();
    for (const cid of childIds) {
      // A node the app made: not the page's own (its scroller, its head, its body), and not a shadow root, which is no one's child.
      if (!Number.isInteger(cid) || cid <= 1) continue;
      const child = this.nodes.get(cid);
      if (child && child.nodeType !== Node.DOCUMENT_FRAGMENT_NODE && !desiredSet.has(child)) {
        desiredNodes.push(child);
        desiredSet.add(child);
        if (child instanceof HTMLCanvasElement && parent instanceof Element) {
          const pid = Number(parent.getAttribute(NODE_ID_ATTR));
          if (Number.isInteger(pid) && pid > 1 && !this.measuredIds.has(pid)) {
            this.measuredIds.add(pid);
            this.resizeObserver?.observe(parent);
            this.scheduleBoxMeasure();
          }
        }
      }
    }

    // Remove nodes no longer in `desiredSet`
    let cur = parent.firstChild;
    while (cur) {
      const next = cur.nextSibling;
      if (!desiredSet.has(cur)) {
        parent.removeChild(cur);
      }
      cur = next;
    }

    // Insert/move into exact order
    let cursor: Node | null = parent.firstChild;
    for (const target of desiredNodes) {
      if (cursor === target) {
        cursor = cursor.nextSibling;
      } else {
        parent.insertBefore(target, cursor);
      }
    }
  }

  private applyProperty(id: number, prop: string, val: unknown): void {
    const node = id === 1 ? this.viewportEl : this.nodes.get(id);
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;

    switch (prop) {
      case 'value':
        if ('value' in el && (el as HTMLInputElement).value !== String(val ?? '')) {
          (el as HTMLInputElement).value = String(val ?? '');
        }
        break;
      case 'checked':
        if ('checked' in el) (el as HTMLInputElement).checked = Boolean(val);
        break;
      case 'indeterminate':
        if ('indeterminate' in el) (el as HTMLInputElement).indeterminate = Boolean(val);
        break;
      case 'selectedIndex':
        if ('selectedIndex' in el && typeof val === 'number') {
          (el as HTMLSelectElement).selectedIndex = val;
        }
        break;
      case 'chosen':
        // A select of several: the options chosen, by their place among its options.
        if (el instanceof HTMLSelectElement && Array.isArray(val)) {
          const chosen = new Set(val.filter((at) => Number.isInteger(at)));
          for (let at = 0; at < el.options.length; at++) el.options[at].selected = chosen.has(at);
        }
        break;
      case 'scrollIntoView':
        this.scrollIntoBox(el);
        break;
      // The page's own scroll (window.scrollTo, the body's scrollTop) is the app's box, which
      // is what scrolls; the viewport inside it grows with what it holds.
      case 'scrollTop':
        if (typeof val === 'number') (id === 1 ? this.docRootEl : el).scrollTop = val;
        break;
      case 'scrollLeft':
        if (typeof val === 'number') (id === 1 ? this.docRootEl : el).scrollLeft = val;
        break;
      case 'focus':
        // Only where it takes the focus from nobody: when it is already inside the app, or
        // nothing in the embedding page has it. An app that could focus its own field at
        // any time took the keys a person was typing into the page around it.
        if (!this.mayTakeFocus()) break;
        try {
          el.focus({ preventScroll: true });
        } catch {
          // Ignore focus errors in headless environments
        }
        break;
      case 'blur':
        try {
          el.blur();
        } catch {
          // Ignore
        }
        break;
      case 'showModal':
        // Open, but not as the browser's modal: a modal dialog is drawn in the top layer,
        // over the whole embedding page and over whatever there asks the person for
        // consent, and makes the rest of that page inert. Inside its box the app's dialog
        // is still a dialog: it has the `open` attribute, its `close()` works, and the
        // app's own backdrop is the app's to draw.
        el.setAttribute('open', '');
        break;
      case 'close':
        if (typeof (el as HTMLDialogElement).close === 'function') {
          try {
            if ((el as HTMLDialogElement).open) (el as HTMLDialogElement).close(typeof val === 'string' ? val : undefined);
          } catch {
            el.removeAttribute('open');
          }
        } else {
          el.removeAttribute('open');
        }
        break;
      case 'measure':
        this.measuredIds.add(id);
        this.resizeObserver?.observe(el);
        this.scheduleBoxMeasure();
        break;
      default:
        // A structured value (`data`, `options`, `rows`) for a `<softn-*>` element: only a
        // property the element's own class declares (host-policy.ts). Not whatever name the
        // operation carries: `innerHTML` is a property too, and its value would be parsed
        // in the embedding page.
        if (typeof prop === 'string' && el.localName.startsWith('softn-')) this.setElementProperty(el, prop, val);
        break;
    }
  }

  /**
   * Bring `el` into view inside the app's box, by scrolling what scrolls between it and the
   * box and nothing further out. The browser's own `scrollIntoView` scrolls every ancestor,
   * the embedding page among them: an app would move the page it is drawn in whenever it
   * liked. (A link to a place on the page, which the person followed, is scrolled to by the
   * browser; this is what the app's script asks for by itself.)
   */
  private scrollIntoBox(el: Element): void {
    if (!this.owns(el) || typeof el.getBoundingClientRect !== 'function') return;
    const boxOf = (node: Node): Element | null => {
      for (let up = this.parentOf(node); up; up = this.parentOf(up)) if (up instanceof Element) return up;
      return null;
    };
    for (let box = boxOf(el); box; box = boxOf(box)) {
      if (box.scrollHeight > box.clientHeight || box.scrollWidth > box.clientWidth) {
        const inner = el.getBoundingClientRect();
        const outer = box.getBoundingClientRect();
        // As little as shows it: nothing when it is in view already.
        if (inner.top < outer.top) box.scrollTop -= outer.top - inner.top;
        else if (inner.bottom > outer.bottom) box.scrollTop += Math.min(inner.bottom - outer.bottom, inner.top - outer.top);
        if (inner.left < outer.left) box.scrollLeft -= outer.left - inner.left;
        else if (inner.right > outer.right) box.scrollLeft += Math.min(inner.right - outer.right, inner.left - outer.left);
      }
      // The app's box is the last that scrolls for the app: past it is the embedding page.
      if (box === this.docRootEl) break;
    }
  }

  /**
   * Whether the app may be given the focus: it has it already, the element it is drawn in
   * has it, nothing in the embedding page has it, or the person's last click in the app left
   * it on an element around the app and nothing has moved it since. Never from a field of the
   * embedding page a person may be typing into, nor from a bar of the container's own.
   *
   * Asked out through each root the app's page is in, to the document: in each, the element
   * holding the focus is the one the app is inside, one around it, another, or none (asked of
   * the next root out). A browser that does not focus a button when it is clicked (Safari)
   * puts the focus on the nearest element around the click that takes it (the runtime's tab)
   * when the person clicks the app's own button: that element is the app's to move on from,
   * and only that one. (Any element around the app was: one whose own shadow tree held the
   * field a person was typing into gave its keys to the app.) The rule looked at one root
   * only, and the app's page has been in a root of its own since v0.0.45: in Safari, an app's
   * `focus()` after a click on its own button did nothing.
   */
  private mayTakeFocus(): boolean {
    let root = this.docRootEl.getRootNode() as ShadowRoot | Document;
    const inside = root.activeElement;
    if (inside && this.owns(inside)) return true;
    while (root instanceof ShadowRoot) {
      const host = root.host;
      const outer = host.getRootNode() as ShadowRoot | Document;
      const active = outer.activeElement;
      // The document's body or its root holding the focus is nobody holding it.
      const nobody = !active || (!(outer instanceof ShadowRoot) && (active === outer.body || active === outer.documentElement));
      if (!nobody && active) {
        if (active === host) return true;
        // The element around the app the person's click left the focus on, and still the very
        // one inside it (a move into a field of its own shadow tree leaves the document's the same).
        if (active !== this.clickFocus || performance.now() - this.clickFocusAt > CLICK_FOCUS_MS || !active.contains(host)) return false;
        const deep = deepestFocus(active);
        return deep === this.clickFocusDeep && !typedInto(deep);
      }
      // Nothing in this tree has it: out to the next.
      if (!(outer instanceof ShadowRoot)) return true;
      root = outer;
    }
    const active = root.activeElement;
    return !active || active === root.body || active === root.documentElement;
  }

  /** The element holding the focus around the app: the first a root out from the app's page has, or null. */
  private focusAround(): Element | null {
    let root = this.docRootEl.getRootNode() as ShadowRoot | Document;
    while (root instanceof ShadowRoot) {
      const outer = root.host.getRootNode() as ShadowRoot | Document;
      const active = outer.activeElement;
      if (!(outer instanceof ShadowRoot)) return active && active !== outer.body && active !== outer.documentElement ? active : null;
      if (active) return active;
      root = outer;
    }
    return null;
  }

  /** Hand `val` to a `<softn-*>` element's own property, now or when its class has arrived. */
  private setElementProperty(el: HTMLElement, prop: string, val: unknown): void {
    const defined = typeof customElements !== 'undefined' && customElements.get(el.localName);
    if (defined) {
      if (isDeclaredElementProperty(el, prop)) (el as unknown as Record<string, unknown>)[prop] = val;
      return;
    }
    // Its class is still loading: kept, and asked again by the same rule once it is defined.
    const waiting = this.pendingProperties.get(el);
    if (waiting) {
      waiting.push([prop, val]);
      return;
    }
    this.pendingProperties.set(el, [[prop, val]]);
    if (typeof customElements === 'undefined') return;
    void customElements.whenDefined(el.localName).then(() => {
      const kept = this.pendingProperties.get(el) ?? [];
      this.pendingProperties.delete(el);
      if (this.disposed) return;
      try {
        customElements.upgrade(el);
      } catch {
        // Not in a document yet: it upgrades when it is, and declares nothing until then.
      }
      for (const [name, value] of kept) {
        if (isDeclaredElementProperty(el, name)) (el as unknown as Record<string, unknown>)[name] = value;
      }
    });
  }

  /** Replay batched 2D `<canvas>` drawing commands onto the host `<canvas>`. */
  private replayCanvas2D(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    cmds: readonly Canvas2DCmd[]
  ): void {
    // The size the app asked for, held to what the page can hold: a canvas is the embedding
    // page's memory.
    const w = canvasSide(width);
    const h = canvasSide(height);
    if (w > 0 && canvas.width !== w) canvas.width = w;
    if (h > 0 && canvas.height !== h) canvas.height = h;
    if (!Array.isArray(cmds)) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      return;
    }
    if (!ctx) return;

    replayCanvasCommands(ctx, cmds, (ref) => {
      const source = this.resolveDrawableImage(ref);
      if (source && !this.isOwnPicture(source)) this.unreadable.add(canvas);
      return source;
    });
  }

  /**
   * Load an image that is on no page (`new Image()`, a game's sprites, a preloader), and tell
   * the app's script when it has loaded or cannot be. Its address is held to the rule an
   * `<img>` on the page is: a file of the app's, a blob it made, or a site it was granted.
   * Kept by the address as written, which is how a canvas then asks to draw it.
   */
  /** Present a zero-copy GPU `ImageBitmap` rendered on an OffscreenCanvas WebGL/WebGL2 context in the Worker. */
  presentWebGLFrame(canvasId: number, bitmap: ImageBitmap, width: number, height: number): void {
    const node = this.nodes.get(canvasId);
    if (!(node instanceof HTMLCanvasElement)) {
      try { bitmap.close(); } catch { /* ignore */ }
      return;
    }
    const w = canvasSide(width);
    const h = canvasSide(height);
    if (w > 0 && node.width !== w) node.width = w;
    if (h > 0 && node.height !== h) node.height = h;
    let br = this.bitmapContexts.get(node);
    if (!br && typeof node.getContext === 'function') {
      try {
        br = node.getContext('bitmaprenderer') ?? undefined;
        if (br) this.bitmapContexts.set(node, br);
      } catch {
        br = undefined;
      }
    }
    if (br) {
      try {
        br.transferFromImageBitmap(bitmap);
        return;
      } catch {
        // Fall through to 2D blit fallback
      }
    }
    try {
      const ctx2d = node.getContext('2d');
      if (ctx2d) {
        ctx2d.clearRect(0, 0, node.width, node.height);
        ctx2d.drawImage(bitmap, 0, 0, node.width, node.height);
      }
    } catch {
      // ignore
    }
    try { bitmap.close(); } catch { /* ignore */ }
  }

  private preloadImage(token: string, src: string, cors = false): void {
    const answer = (ok: boolean, width = 0, height = 0) => {
      if (!this.disposed) this.callbacks.onEvent(-1, 'softn:image', { token, src, ok, width, height }, []);
    };
    // Kept by the name a canvas draws it by: one asked for with CORS apart from one without.
    const name = cors ? `cors:${src}` : src;
    const kept = this.imageCache.get(name);
    if (kept) {
      if (kept.complete) answer(kept.naturalWidth > 0, kept.naturalWidth, kept.naturalHeight);
      else {
        kept.addEventListener('load', () => answer(true, kept.naturalWidth, kept.naturalHeight), { once: true });
        kept.addEventListener('error', () => answer(false), { once: true });
      }
      return;
    }
    const address = typeof Image === 'function' && this.imageCache.size < MAX_PRELOADED_IMAGES
      ? sanitizeHostAssetUrl('src', src, 'img', this.entryPath, this.archive, this.permissions, this.netGranted)
      : null;
    if (!address) {
      answer(false);
      return;
    }
    const img = new Image();
    img.addEventListener('load', () => answer(true, img.naturalWidth, img.naturalHeight), { once: true });
    img.addEventListener('error', () => answer(false), { once: true });
    this.imageCache.set(name, img);
    // From another site, fetched to be read back; the app's own file, a blob or data: address
    // is loaded as it is (and read back as it is: isOwnPicture). Every crossOrigin image was
    // fetched here, which takes only http(s): three.js sets it on every texture, and one from
    // the app's own files never loaded.
    if (cors && /^https?:/i.test(address)) this.loadReadable(img, address);
    else img.src = address;
  }

  /**
   * Run an animation the app's script asked for on one of its elements, and tell the script
   * when it ends. Its keyframes are CSS in all but name, so each value is read by the
   * stylesheet's rule (an address in one is the app's own file or a site it was granted, or
   * it is gone), and its timing is the few words a timing has.
   */
  private startAnimation(key: string, id: number, rawFrames: unknown, rawTiming: unknown): void {
    const ended = (state: 'finished' | 'cancelled') => {
      if (!this.disposed) this.callbacks.onEvent(-1, 'softn:animation', { id: key, state }, []);
    };
    // Those of elements that have left the page are let go.
    for (const [other, kept] of this.animations) if (!kept.el.isConnected) this.animations.delete(other);
    const node = id === 1 ? this.viewportEl : this.nodes.get(id);
    if (!(node instanceof Element) || typeof node.animate !== 'function' || this.animations.has(key) || this.animations.size >= MAX_ANIMATIONS) {
      // Nothing to run it on (or no more room): it ends at once, so whatever waits on it goes on.
      queueMicrotask(() => ended('finished'));
      return;
    }
    const css = (value: string) => sanitizeContainerCss(value.slice(0, 2000), this.entryPath, this.archive, this.permissions, this.netGranted, 'inline');
    const value = (raw: unknown): string | number | null => (typeof raw === 'number' && Number.isFinite(raw) ? raw : typeof raw === 'string' ? css(raw) : null);
    const frame = (raw: unknown): Keyframe | null => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const out: Keyframe = {};
      for (const [name, v] of Object.entries(raw as Record<string, unknown>).slice(0, 64)) {
        if (!/^[A-Za-z][A-Za-z-]{0,63}$/.test(name)) continue;
        if (name === 'offset') {
          if (typeof v === 'number' && v >= 0 && v <= 1) out.offset = v;
        } else if (name === 'easing' || name === 'composite') {
          if (typeof v === 'string' && v.length <= 128 && !/[(]\s*["']?\s*[a-z]+:|url|\\/i.test(v)) (out as Record<string, unknown>)[name] = v;
        } else {
          const clean = value(v);
          if (clean !== null) out[name] = clean;
        }
      }
      return out;
    };
    let frames: Keyframe[] | PropertyIndexedKeyframes;
    if (Array.isArray(rawFrames)) {
      frames = rawFrames.slice(0, MAX_KEYFRAMES).map(frame).filter((f): f is Keyframe => f !== null);
    } else if (rawFrames && typeof rawFrames === 'object') {
      // Each property with the list of its values.
      const byProperty: PropertyIndexedKeyframes = {};
      for (const [name, list] of Object.entries(rawFrames as Record<string, unknown>).slice(0, 64)) {
        if (!/^[A-Za-z][A-Za-z-]{0,63}$/.test(name) || name === 'easing' || name === 'composite' || name === 'offset') continue;
        const values = (Array.isArray(list) ? list : [list]).slice(0, MAX_KEYFRAMES).map(value).filter((v): v is string | number => v !== null);
        if (values.length > 0) (byProperty as Record<string, unknown>)[name] = values.map(String);
      }
      frames = byProperty;
    } else {
      frames = [];
    }
    const given = rawTiming && typeof rawTiming === 'object' ? (rawTiming as Record<string, unknown>) : {};
    const timing: KeyframeAnimationOptions = {};
    const time = (name: 'duration' | 'delay' | 'endDelay' | 'iterationStart') => {
      const v = given[name];
      if (typeof v === 'number' && Number.isFinite(v)) timing[name] = Math.max(name === 'delay' ? -MAX_ANIMATION_MS : 0, Math.min(MAX_ANIMATION_MS, v));
    };
    time('duration');
    time('delay');
    time('endDelay');
    time('iterationStart');
    if (given.iterations === 'infinite') timing.iterations = Infinity;
    else if (typeof given.iterations === 'number' && given.iterations >= 0) timing.iterations = given.iterations;
    if (typeof given.easing === 'string' && given.easing.length <= 128 && !/url|\\/i.test(given.easing)) timing.easing = given.easing;
    if (given.direction === 'normal' || given.direction === 'reverse' || given.direction === 'alternate' || given.direction === 'alternate-reverse') timing.direction = given.direction;
    if (given.fill === 'none' || given.fill === 'forwards' || given.fill === 'backwards' || given.fill === 'both' || given.fill === 'auto') timing.fill = given.fill;
    if (given.composite === 'replace' || given.composite === 'add' || given.composite === 'accumulate') timing.composite = given.composite;
    let animation: Animation;
    try {
      animation = node.animate(frames, timing);
    } catch {
      // Keyframes the page will not take: nothing runs, and whatever waits on it goes on.
      queueMicrotask(() => ended('finished'));
      return;
    }
    this.animations.set(key, { el: node, animation });
    animation.addEventListener('finish', () => ended('finished'));
    animation.addEventListener('cancel', () => {
      // Cancelled by the page (not asked for by the script, which is not told what it did itself).
      if (this.animations.delete(key)) ended('cancelled');
    });
  }

  /** What the app's script asks of an animation it started. */
  private controlAnimation(key: string, action: string): void {
    const kept = this.animations.get(key);
    if (!kept) return;
    try {
      if (action === 'cancel') {
        this.animations.delete(key);
        kept.animation.cancel();
      } else if (action === 'finish') kept.animation.finish();
      else if (action === 'pause') kept.animation.pause();
      else if (action === 'play') kept.animation.play();
      else if (action === 'reverse') kept.animation.reverse();
    } catch {
      // One that cannot be finished (it runs forever), or is already over.
    }
  }

  private resolveDrawableImage(ref: string): CanvasImageSource | null {
    if (ref.startsWith('node:')) {
      const id = Number(ref.slice(5));
      const n = this.nodes.get(id);
      if (n instanceof HTMLCanvasElement) return n;
      // A picture not loaded yet, or that could not be, draws nothing (drawn, a broken one throws).
      if (n instanceof HTMLImageElement) return n.complete && n.naturalWidth > 0 ? n : null;
      return null;
    }
    const cached = this.imageCache.get(ref);
    if (cached && cached.complete) return cached.naturalWidth > 0 ? cached : null;
    if (!cached && typeof Image === 'function' && this.imageCache.size < MAX_PRELOADED_IMAGES) {
      // Loaded by the rule an image on no page is (a file of the app's, a blob it made, data
      // in the address, a site it was granted), and drawn from the next time it is asked for.
      // Only a file of the app's was: a picture by any other address was never drawn. One
      // the app asked for with CORS ('cors:' and its address) is loaded with CORS.
      const cors = ref.startsWith('cors:');
      const address = sanitizeHostAssetUrl('src', cors ? ref.slice(5) : ref, 'img', this.entryPath, this.archive, this.permissions, this.netGranted);
      if (address) {
        const img = new Image();
        if (cors && /^https?:/i.test(address)) this.loadReadable(img, address);
        else img.src = address;
        this.imageCache.set(ref, img);
      }
    }
    return null;
  }

  private followClickedLink(href: string): void {
    if (isExternalHref(href)) this.callbacks.onExternalLink?.(href);
    else this.callbacks.onNavigate?.(href);
  }

  private afterGuestEvent(event: Event, action: () => void): void {
    if (this.listenedEvents.has(event.type)) this.heldDefaults.set(event, action);
    else action();
  }

  /** Emit the browser's submit event without requesting a navigation or posting the form. */
  private submitForm(form: HTMLFormElement, submitter: HTMLButtonElement | HTMLInputElement | null): void {
    if (!this.owns(form) || (submitter && (submitter.form !== form || submitter.matches(':disabled')))) return;
    if (!form.noValidate && !submitter?.formNoValidate && !HTMLFormElement.prototype.reportValidity.call(form)) return;
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }));
  }

  private submitOnEnter(event: Event): void {
    const key = event as KeyboardEvent;
    const field = this.originOf(event);
    if (key.key !== 'Enter' || key.isComposing || key.keyCode === 229 || key.defaultPrevented ||
        !(field instanceof HTMLInputElement) || !IMPLICIT_SUBMISSION_FIELDS.has(field.type) || !field.form) return;
    const form = field.form;
    if (!this.owns(form)) return;
    event.preventDefault();
    this.afterGuestEvent(event, () => {
      if (field.form !== form || !this.owns(field)) return;
      // form.elements omits image submit buttons. Search the form's own tree in document
      // order so that form-associated controls outside its children are included too.
      const root = form.getRootNode();
      const scope = root === this.docRootEl.getRootNode() ? this.docRootEl : root as ShadowRoot;
      let blockingFields = 0;
      for (const control of scope.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) {
        if (control.form !== form) continue;
        if (isSubmitButton(control)) {
          if (!control.matches(':disabled')) control.click();
          return;
        }
        if (control instanceof HTMLInputElement && IMPLICIT_SUBMISSION_FIELDS.has(control.type)) blockingFields++;
      }
      if (blockingFields === 1) this.submitForm(form, null);
    });
  }

  /** Always keep input/select/focus state synced and block native form page navigations. */
  private installCoreInputSync(): void {
    const onSubmitCapture = (e: Event) => {
      // Never allow a form inside `<softn-app>` to navigate the host browser window
      e.preventDefault();
      if (!this.callbacks.onFormSubmit) return;
      const target = this.originOf(e);
      const form = target instanceof HTMLFormElement ? target : target?.closest?.('form') ?? null;
      if (!form || !this.owns(form)) return;
      const action = (form.getAttribute('action') ?? '').trim();
      const method = (form.getAttribute('method') ?? 'GET').trim().toUpperCase() || 'GET';
      const params = new URLSearchParams();
      for (const el of Array.from(form.elements)) {
        if (el instanceof HTMLInputElement) {
          if (!el.name || el.disabled) continue;
          const t = (el.type || 'text').toLowerCase();
          if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image' || t === 'file') continue;
          if ((t === 'checkbox' || t === 'radio') && !el.checked) continue;
          params.append(el.name, el.value);
        } else if (el instanceof HTMLTextAreaElement) {
          if (!el.name || el.disabled) continue;
          params.append(el.name, el.value);
        } else if (el instanceof HTMLSelectElement) {
          if (!el.name || el.disabled) continue;
          for (const opt of Array.from(el.selectedOptions)) params.append(el.name, opt.value);
        }
      }
      const submitter = 'submitter' in e ? ((e as SubmitEvent).submitter as Element | null) : null;
      if ((submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) && submitter.name && !submitter.disabled) {
        params.append(submitter.name, submitter.value);
      }
      const req = { action, method, encoded: params.toString() };
      this.afterGuestEvent(e, () => this.callbacks.onFormSubmit?.(req));
    };
    // Every click on a link of the app's is the host's to carry out, never the browser's: the
    // link is an element of the embedding page, so followed natively it would move that
    // page (to the link's address, or to a fragment of its own address), and its `target`
    // is the app's word. A link out opens in a tab of its own with no handle on this page;
    // a fragment scrolls inside the app; a page of the app's is the container's to show;
    // anything else does nothing. v0.0.43 left links out to the browser, `target="_top"`
    // and all.
    const onClickCapture = (e: Event) => {
      const button = e.composedPath().find(isSubmitButton);
      if (button?.form && this.owns(button) && this.owns(button.form)) {
        if (e.defaultPrevented || (e as MouseEvent).button > 0 || button.matches(':disabled')) return;
        const form = button.form;
        // A sandboxed frame can suppress the native submit event altogether. Handle the
        // activation once in every frame, after the guest can cancel the originating click.
        e.preventDefault();
        this.afterGuestEvent(e, () => this.submitForm(form, button));
        return;
      }
      // The link the click is on: the nearest one on its way out, through any shadow tree
      // of the app's (a link inside one, or one around an element that has one).
      const anchor = linkOnPath(e);
      if (!anchor || !this.owns(anchor)) return;
      e.preventDefault();
      const href = (anchor.getAttribute('href') ?? '').trim();
      if (!href) return;
      if (href.startsWith('#')) {
        // A place in the tree the link is in: the app's page, or the shadow tree it is in.
        const root = anchor.getRootNode() as ShadowRoot | Document;
        let to: Element | null = null;
        try {
          to = href.length > 1 ? root.getElementById?.(decodeURIComponent(href.slice(1))) ?? null : this.viewportEl;
        } catch {
          to = null;
        }
        if (to && this.owns(to)) to.scrollIntoView({ block: 'start' });
        return;
      }
      if (isExternalHref(href) && !this.callbacks.onExternalLink) {
        if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      // A link inside the app. Where the app's script listens for clicks, the link is its to
      // cancel, as in a browser: a router's link is followed by the script (pushState, and
      // the page it draws), and the page it names is not one to load. The script is a
      // thread away, so the page waits for its answer (the listener below hands the click
      // over and follows the link if it was not cancelled). It was followed at once: the
      // "Home" link of a single-page app loaded the app again from the start.
      this.afterGuestEvent(e, () => this.followClickedLink(href));
    };
    const onInputOrChange = (e: Event) => {
      const changes = this.extractInputSync(this.originOf(e));
      if (this.listenedEvents.has(e.type)) return;
      const field = fileField(this.originOf(e));
      if (field) {
        // The files picked go with the field's change: read first, then told together.
        void this.filesOf(field).then((files) => {
          if (!this.disposed) this.callbacks.onSync([...changes, ...files]);
        });
        return;
      }
      if (changes.length > 0) this.callbacks.onSync(changes);
    };
    // A click or a key of the person's in the app: what a save is allowed just after.
    const onActivation = () => {
      const now = performance.now();
      if (now >= this.quietUntil) this.lastActivation = now;
    };

    // On the app's page and on each shadow root attached in it: a form sent or a field
    // changed inside a shadow tree does not leave it, and a form the page never heard of
    // would be sent by the browser, taking the embedding page with it. An event that does
    // leave (a click) passes more than one of these, and is handled at the first.
    this.listen('submit', oncePerEvent(onSubmitCapture), true);
    this.listen('click', oncePerEvent(onClickCapture), false);
    this.listen('keydown', oncePerEvent(e => this.submitOnEnter(e)), false);
    this.listen('input', oncePerEvent(onInputOrChange), true);
    this.listen('change', oncePerEvent(onInputOrChange), true);
    for (const type of ACTIVATIONS) this.listen(type, onActivation, true);
    // Where the person has scrolled the app's page and its elements to: told with the next
    // event the app hears, and once the scrolling stops, so that scrollTop reads it.
    this.listen(
      'scroll',
      (e: Event) => {
        const target = e.target;
        if (!(target instanceof Element) || !this.owns(target)) return;
        this.scrolledSince.add(target);
        if (this.scrollSettle !== null) clearTimeout(this.scrollSettle);
        this.scrollSettle = setTimeout(() => {
          this.scrollSettle = null;
          const changes = this.scrollChanges();
          if (changes.length > 0 && !this.disposed) this.callbacks.onSync(changes);
        }, SCROLL_SETTLE_MS);
      },
      true
    );
    // Where the person's click in the app left the focus, for an app's focus() just after it.
    this.listen(
      'click',
      () => {
        this.clickFocus = this.focusAround();
        this.clickFocusDeep = this.clickFocus ? deepestFocus(this.clickFocus) : null;
        this.clickFocusAt = performance.now();
      },
      true
    );
    // A press or a click anywhere outside the app ends it: the person has moved on. (Heard at
    // the document, an event inside the app's closed roots is seen as far as their hosts.)
    const outside = (e: Event) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (path.includes(this.docRootEl)) return;
      for (let root = this.docRootEl.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) if (path.includes(root.host)) return;
      this.clickFocus = this.clickFocusDeep = null;
    };
    if (typeof document !== 'undefined') {
      for (const type of ['pointerdown', 'mousedown', 'keydown']) document.addEventListener(type, outside, true);
      this.cleanupFns.push(() => {
        for (const type of ['pointerdown', 'mousedown', 'keydown']) document.removeEventListener(type, outside, true);
      });
    }

    this.cleanupFns.push(() => {
      for (const { type, fn, capture } of this.listening) {
        this.docRootEl.removeEventListener(type, fn, capture);
        for (const root of this.shadowRoots) root.removeEventListener(type, fn, capture);
      }
      this.listening.length = 0;
      this.shadowRoots.clear();
    });
  }

  private ensureEventListener(eventType: string): void {
    if (typeof eventType !== 'string' || !eventType || this.listenedEvents.has(eventType)) return;
    // Each kind is a listener on the embedding page's element: no app has a use for more
    // kinds than there are.
    if (this.listenedEvents.size >= MAX_EVENT_TYPES) return;
    if (eventType === 'softn:viewport') {
      this.listenedEvents.add(eventType);
      const onResize = () => {
        this.callbacks.onEvent(-1, 'softn:viewport', {
          v: [
            this.docRootEl.clientWidth || window.innerWidth || 1024,
            this.docRootEl.clientHeight || window.innerHeight || 768,
            window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 1 : 0,
            window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 1 : 0,
            window.devicePixelRatio || 1,
            window.matchMedia?.('(pointer: coarse)').matches ? 1 : 0,
          ],
        }, []);
      };
      window.addEventListener('resize', onResize);
      let viewportRo: ResizeObserver | null = null;
      if (typeof ResizeObserver === 'function') {
        viewportRo = new ResizeObserver(onResize);
        viewportRo.observe(this.docRootEl);
      }
      this.cleanupFns.push(() => {
        window.removeEventListener('resize', onResize);
        viewportRo?.disconnect();
      });

      return;
    }

    this.listenedEvents.add(eventType);
    const useCapture = CAPTURE_ONLY_EVENTS.has(eventType);

    const handler = (e: Event) => {
      // The element it happened on, inside whatever shadow tree of the app's: at the app's
      // page an event that left one reads as its host's. The app's page scrolled is its
      // document scrolled (window.addEventListener('scroll', …)).
      const targetEl = this.originOf(e);
      const nodeId = eventType === 'scroll' && targetEl === this.docRootEl ? -1 : this.findNearestNodeId(targetEl);
      const held = this.heldDefaults.get(e);
      this.heldDefaults.delete(e);
      if (nodeId === null) {
        held?.();
        return;
      }

      const syncChanges = [...this.scrollChanges(), ...this.extractInputSync(targetEl, eventType === 'click')];
      // The focused element inside the app's own root. (The document's is the embedding
      // page's `<softn-app>` element, which is none of the app's, so the app's script never
      // learned where the focus was.) Inside a shadow tree of the app's, the one in there.
      const root = this.viewportEl.getRootNode() as ShadowRoot | Document;
      let activeEl = root.activeElement;
      while (activeEl?.shadowRoot && this.shadowRoots.has(activeEl.shadowRoot) && activeEl.shadowRoot.activeElement) activeEl = activeEl.shadowRoot.activeElement;
      const activeId = activeEl instanceof Element && this.owns(activeEl) ? this.findNearestNodeId(activeEl) : null;
      if (activeId !== null) syncChanges.push(['f', activeId]);

      const props = serializeDomEvent(e, targetEl, this.findNearestNodeId.bind(this), this.origin());
      const answered =
        !held
          ? undefined
          : (eventBits: number) => {
              if (!this.disposed && !(eventBits & 1)) held();
            };
      // A file field that changed: its files are read (for an app allowed them) and told
      // with the event, so that input.files is true by the time the script hears of it.
      const field = eventType === 'change' || eventType === 'input' ? fileField(targetEl) : null;
      if (field) {
        void this.filesOf(field).then((files) => {
          if (!this.disposed) this.callbacks.onEvent(nodeId, eventType, props, [...syncChanges, ...files], answered);
        });
        return;
      }
      this.callbacks.onEvent(nodeId, eventType, props, syncChanges, answered);
    };

    this.listen(eventType, oncePerEvent(handler), useCapture);

    // An image of the first page may have loaded before the script asked to hear of it (its
    // script starts a thread away): each one that has is said now, once, so that
    // img.complete and the sizes the script reads are true from the start.
    if (eventType === 'load') {
      queueMicrotask(() => {
        if (this.disposed) return;
        for (const img of Array.from(this.viewportEl.querySelectorAll('img'))) {
          if (!img.complete || !img.getAttribute('src')) continue;
          const id = this.findNearestNodeId(img);
          if (id === null || id <= 1 || this.nodes.get(id) !== img) continue;
          const ok = img.naturalWidth > 0;
          this.callbacks.onEvent(id, ok ? 'load' : 'error', ok ? { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight } : {}, []);
        }
      });
    }
  }

  private findNearestNodeId(el: Element | null): number | null {
    // Out through a shadow tree of the app's, to the element it is attached to.
    for (let cur: Node | null = el; cur; cur = this.parentOf(cur)) {
      if (!(cur instanceof Element)) continue;
      const raw = cur.getAttribute(NODE_ID_ATTR);
      if (raw !== null) {
        const n = Number(raw);
        if (Number.isInteger(n)) return n;
      }
      if (cur === this.viewportEl) return 1;
    }
    return null;
  }

  /**
   * What the person did to the field an event is on, for the app's document to know before
   * the event is heard.
   *
   * `clicked`: a click is heard after the page has ticked the box, and the app's document
   * ticks its own when it hears the click (and unticks it when the code cancels). Told how
   * the box is now, it ticked a box already ticked back off: `event.target.checked` read
   * false in the click of a box just ticked, and a framework that asks on the click whether
   * the box changed (React) heard no change at all. So for a click the document is told how
   * the box was; a radio button, whose earlier state the page no longer has, is left as the
   * document has it.
   */
  private extractInputSync(target: EventTarget | null, clicked = false): unknown[] {
    const changes: unknown[] = [];
    if (!(target instanceof Element)) return changes;
    const id = this.findNearestNodeId(target);
    if (id === null || id <= 1) return changes;

    if (target instanceof HTMLInputElement) {
      if (target.type === 'checkbox' || target.type === 'radio') {
        if (!clicked) changes.push(['k', id, target.checked]);
        else if (target.type === 'checkbox') changes.push(['k', id, !target.checked]);
      } else if (target.type === 'file') {
        // What a file field says of itself is the name of what was picked: the app's to
        // know when it was allowed files, as the file is.
        changes.push(['v', id, this.filesGranted ? target.value : '']);
      } else {
        changes.push(['v', id, target.value]);
      }
    } else if (target instanceof HTMLTextAreaElement) {
      changes.push(['v', id, target.value]);
    } else if (target instanceof HTMLSelectElement) {
      if (target.multiple) {
        const indices: number[] = [];
        for (let i = 0; i < target.options.length; i++) {
          if (target.options[i].selected) indices.push(i);
        }
        changes.push(['S', id, indices]);
      } else {
        changes.push(['s', id, target.selectedIndex]);
      }
      changes.push(['v', id, target.value]);
    }
    return changes;
  }

  /**
   * Where the app's box is in the window, and how far it is scrolled. The box is the app's
   * window: its `position: fixed` elements are placed from the box's corner, and its page
   * scrolls inside it. So the pointer's place and an element's measured box are told from
   * that corner. They were told from the window's: a menu an app put at the pointer was
   * drawn as far off as the app was from the window's corner, and an app learned where in
   * the embedding page it had been put.
   */
  private origin(): AppOrigin {
    const box = typeof this.docRootEl.getBoundingClientRect === 'function' ? this.docRootEl.getBoundingClientRect() : null;
    return { left: box?.left ?? 0, top: box?.top ?? 0, scrollLeft: this.docRootEl.scrollLeft || 0, scrollTop: this.docRootEl.scrollTop || 0 };
  }

  /**
   * The files the person picked in a file field, as a change for the app's document: read
   * here, on the page, for an app the person allowed files; for any other the field's
   * files are none, and the app is told why. Read once for each choice (the field says
   * both `input` and `change` of it).
   */
  private filesOf(field: HTMLInputElement): Promise<unknown[]> {
    const id = this.findNearestNodeId(field);
    if (id === null || id <= 1) return Promise.resolve([]);
    const kept = this.pickedFiles.get(field);
    // A field says both `input` and `change` of one choice: the files go with the first, and the second says only that they are the same.
    if (kept && kept.list === field.files) return kept.change.then(() => [['F', id, { again: true }]]);
    const list = field.files;
    const chosen = list ? Array.from(list) : [];
    const change = (async (): Promise<unknown[]> => {
      if (!this.filesGranted) return [['F', id, { files: [], refused: chosen.length > 0 }]];
      const files: Array<{ name: string; type: string; lastModified: number; size: number; base64: string }> = [];
      let skipped = 0;
      let total = 0;
      for (const file of chosen) {
        if (files.length >= MAX_PICKED_FILES || file.size > MAX_PICKED_FILE_BYTES || total + file.size > MAX_PICKED_BYTES) {
          skipped++;
          continue;
        }
        try {
          const bytes = await readFile(file);
          total += bytes.byteLength;
          files.push({ name: file.name, type: file.type, lastModified: file.lastModified, size: bytes.byteLength, base64: bytesToBase64(bytes) });
        } catch {
          skipped++;
        }
      }
      return [['F', id, skipped > 0 ? { files, skipped } : { files }]];
    })();
    this.pickedFiles.set(field, { list, change });
    return change;
  }

  /** Where each element the person scrolled since the app was last told is now, by its id (the app's page is its body's, 1). */
  private scrollChanges(): unknown[] {
    if (this.scrolledSince.size === 0) return [];
    const changes: unknown[] = [];
    for (const el of this.scrolledSince) {
      if (!el.isConnected) continue;
      const id = el === this.docRootEl || el === this.viewportEl ? 1 : Number(el.getAttribute(NODE_ID_ATTR));
      if (Number.isInteger(id) && id >= 1) changes.push(['Y', id, el.scrollTop, el.scrollLeft]);
    }
    this.scrolledSince.clear();
    return changes;
  }

  private installResizeObserver(): void {
    if (typeof ResizeObserver !== 'function') return;
    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleBoxMeasure();
    });
  }

  private scheduleBoxMeasure(): void {
    if (this.measureScheduled || this.disposed) return;
    this.measureScheduled = true;
    const run = () => {
      this.measureScheduled = false;
      if (this.disposed || this.measuredIds.size === 0) return;
      const boxes: MeasuredBoxTuple[] = [];
      const origin = this.origin();
      // Also observe up to 2 ancestor wrappers of any measured <canvas> (e.g. R3F events.connected div)
      // so controllers reading element.clientWidth/clientHeight never observe 0 on first interaction.
      for (const id of [...this.measuredIds]) {
        const node = this.nodes.get(id);
        if (node instanceof HTMLCanvasElement && node.isConnected) {
          let anc = node.parentElement;
          for (let depth = 0; depth < 2 && anc; depth++, anc = anc.parentElement) {
            const aid = Number(anc.getAttribute(NODE_ID_ATTR));
            if (Number.isInteger(aid) && aid > 1 && !this.measuredIds.has(aid)) {
              this.measuredIds.add(aid);
              this.resizeObserver?.observe(anc);
            }
          }
        }
      }
      for (const id of this.measuredIds) {
        const node = this.nodes.get(id);
        if (node instanceof Element && node.isConnected) {
          const rect = node.getBoundingClientRect();
          // With how much it holds, for scrollHeight: a box and what scrolls inside it differ.
          const htmlEl = node as HTMLElement;
          boxes.push([
            id,
            rect.left - origin.left,
            rect.top - origin.top,
            rect.width,
            rect.height,
            node.scrollWidth,
            node.scrollHeight,
            typeof htmlEl.offsetLeft === 'number' ? htmlEl.offsetLeft : 0,
            typeof htmlEl.offsetTop === 'number' ? htmlEl.offsetTop : 0,
          ]);
        }
      }
      if (boxes.length > 0) {
        this.callbacks.onSync([['B', boxes]]);
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns.length = 0;
    if (this.scrollSettle !== null) clearTimeout(this.scrollSettle);
    this.scrollSettle = null;
    this.scrolledSince.clear();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.nodes.clear();
    this.shadowSheets.clear();
    this.rootIds.clear();
    this.imageCache.clear();
    for (const url of this.readableUrls.values()) URL.revokeObjectURL(url);
    this.readableUrls.clear();
    this.readableSizes.clear();
    this.animations.clear();
    this.styleSheets.clear();
    this.links.clear();
    this.pendingProperties.clear();
  }
}

/** The element holding the focus inside `el`, through its open shadow trees: `el` itself when none does. */
function deepestFocus(el: Element): Element {
  let deep = el;
  for (let depth = 0; depth < 32; depth++) {
    const inner = deep.shadowRoot?.activeElement;
    if (!inner) break;
    deep = inner;
  }
  return deep;
}

/** Whether a person types into an element: a field, or a region of the page that is edited in place. */
function typedInto(el: Element): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable === true || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '';
}

const IMPLICIT_SUBMISSION_FIELDS = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number']);

function isSubmitButton(node: EventTarget): node is (HTMLButtonElement | HTMLInputElement) & { type: 'submit' | 'image' } {
  return (node instanceof HTMLButtonElement && node.type === 'submit') ||
    (node instanceof HTMLInputElement && (node.type === 'submit' || node.type === 'image'));
}

/** The nearest link on an event's way out, through any shadow tree. */
function linkOnPath(e: Event): Element | null {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  for (const node of path) if (node instanceof Element && node.matches('a[href], area[href]')) return node;
  const target = e.target instanceof Element ? e.target : null;
  return target?.closest('a[href], area[href]') ?? null;
}

/** `fn`, run once for an event however many of the app's roots it passes. */
function oncePerEvent(fn: (e: Event) => void): (e: Event) => void {
  const seen = new WeakSet<Event>();
  return (e) => {
    if (seen.has(e)) return;
    seen.add(e);
    fn(e);
  };
}

/** What a person does that an app may save a file just after. */
const ACTIVATIONS = ['keydown', 'click'] as const;

/** The file field an event is on, if it is one. */
function fileField(target: EventTarget | null): HTMLInputElement | null {
  return target instanceof HTMLInputElement && target.type === 'file' ? target : null;
}

/** A picked file's bytes. Through a FileReader: every page that has file fields has one. */
function readFile(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read'));
    reader.readAsArrayBuffer(file);
  });
}

/** The corner of the app's box in the window, and how far the box is scrolled. */
interface AppOrigin {
  left: number;
  top: number;
  scrollLeft: number;
  scrollTop: number;
}

function serializeDomEvent(
  e: Event,
  targetEl: Element | null,
  findId: (el: Element | null) => number | null,
  origin: AppOrigin
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ('key' in e) {
    const ke = e as KeyboardEvent;
    out.key = ke.key;
    out.code = ke.code;
    out.ctrlKey = ke.ctrlKey;
    out.shiftKey = ke.shiftKey;
    out.altKey = ke.altKey;
    out.metaKey = ke.metaKey;
    out.repeat = ke.repeat;
    out.isComposing = ke.isComposing;
  }
  if ('clientX' in e) {
    const me = e as MouseEvent;
    // From the corner of the app's box, and in the app's page from that page's corner (see origin()).
    out.clientX = me.clientX - origin.left;
    out.clientY = me.clientY - origin.top;
    out.pageX = me.clientX - origin.left + origin.scrollLeft;
    out.pageY = me.clientY - origin.top + origin.scrollTop;
    out.button = me.button;
    out.buttons = me.buttons;
    out.ctrlKey = me.ctrlKey;
    out.shiftKey = me.shiftKey;
    out.altKey = me.altKey;
    out.metaKey = me.metaKey;
    if (targetEl) {
      const rect = targetEl.getBoundingClientRect();
      out.offsetX = me.clientX - rect.left;
      out.offsetY = me.clientY - rect.top;
    }
  }
  // An image that loaded says how large its picture is.
  if (e.type === 'load' && targetEl instanceof HTMLImageElement) {
    out.naturalWidth = targetEl.naturalWidth;
    out.naturalHeight = targetEl.naturalHeight;
  }
  if ('pointerId' in e) {
    const pe = e as PointerEvent;
    out.pointerId = pe.pointerId;
    out.pointerType = pe.pointerType;
    out.pressure = pe.pressure;
    out.isPrimary = pe.isPrimary;
  }
  if ('deltaY' in e) {
    const we = e as WheelEvent;
    out.deltaX = we.deltaX;
    out.deltaY = we.deltaY;
    out.deltaZ = we.deltaZ;
    out.deltaMode = we.deltaMode;
  }
  if ('data' in e && typeof (e as InputEvent).data === 'string') {
    out.data = (e as InputEvent).data;
    out.inputType = (e as InputEvent).inputType;
  }
  if ('submitter' in e) {
    const sub = (e as SubmitEvent).submitter;
    const subId = sub ? findId(sub) : null;
    if (subId !== null) out.submitter = subId;
  }
  if ('detail' in e) {
    const detail = (e as CustomEvent).detail;
    if (detail !== undefined) {
      try {
        JSON.stringify(detail);
        out.detail = detail;
      } catch {
        // Drop non-serializable detail
      }
    }
  }
  return out;
}
