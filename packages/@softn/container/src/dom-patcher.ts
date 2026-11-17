/**
 * Direct Surgical Host DOM Patcher + Canvas 2D Replayer + Delegated Event Bridge.
 *
 * Replaces SoftN v1's `DocumentShell -> ElementNode AST -> React VDOM -> ReactDOM`
 * pipeline with direct `O(1)` operations against a `Map<number, Node>` inside
 * `<softn-app>`'s closed `ShadowRoot`.
 */

import { ContainerArchive, base64ToBytes, resolveVfsPath } from './archive';
import {
  MAX_EVENT_TYPES,
  MAX_HOST_NODES,
  canvasPropertyAllowed,
  canvasSide,
  createHostElement,
  hostAttributeValue,
  hostElementName,
  hostTitle,
  isDeclaredElementProperty,
  isExternalHref,
  isLinkElement,
} from './host-policy';
import { NODE_ID_ATTR, sanitizeContainerCss, sanitizeHostAssetUrl } from './sanitize';
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
  onCustomTag?: (tag: string) => void;
  onThreeOps?: (canvas: HTMLCanvasElement, canvasId: number, ops: ThreeSceneOp[]) => void;
}

export class HostDomPatcher {
  readonly nodes = new Map<number, Node>();
  private readonly viewportEl: HTMLElement;
  private readonly docRootEl: HTMLElement;
  private readonly archive: ContainerArchive;
  private readonly entryPath: string;
  private permissions: ContainerPermissions;
  private netGranted: boolean;
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
  private resizeObserver: ResizeObserver | null = null;
  private measureScheduled = false;
  private readonly imageCache = new Map<string, HTMLImageElement>();
  /** A link to a page of the app's that was clicked, held until the app's script has heard the click. */
  private heldLink: { event: Event; href: string } | null = null;
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
    callbacks: DomPatcherCallbacks;
  }) {
    this.viewportEl = params.viewportEl;
    this.docRootEl = params.docRootEl;
    this.archive = params.archive;
    this.entryPath = params.entryPath;
    this.permissions = params.permissions;
    this.netGranted = params.netGranted;
    this.callbacks = params.callbacks;
    if (params.headEl) this.nodes.set(GUEST_HEAD_ID, params.headEl);

    this.installCoreInputSync();
    this.installResizeObserver();
  }

  updatePermissions(permissions: ContainerPermissions, netGranted: boolean): void {
    this.permissions = permissions;
    this.netGranted = netGranted;
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

    // A blob the script made an address for is kept before anything else in the turn is
    // read: the same turn that makes the address sets it on an image.
    for (const op of ops) {
      if (op[0] !== 'blob') continue;
      const [, id, type, base64] = op;
      if (typeof id !== 'string' || typeof base64 !== 'string') continue;
      try {
        this.archive.putRuntimeBlob(id, typeof type === 'string' ? type : '', base64ToBytes(base64));
      } catch {
        // Not base64: nothing is kept, and the address names nothing.
      }
    }

    for (const op of ops) {
      switch (op[0]) {
        case 'blob':
          break;

        case 'unblob':
          if (typeof op[1] === 'string') this.archive.dropRuntimeBlob(op[1]);
          break;

        case 'img':
          if (typeof op[1] === 'string' && typeof op[2] === 'string') this.preloadImage(op[1], op[2]);
          break;

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
          this.nodes.set(id, el);
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
              else root.setAttribute('style', sanitizeContainerCss(value, this.entryPath, this.archive, this.permissions, this.netGranted));
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
          const node = this.nodes.get(canvasId);
          if (node && node instanceof HTMLCanvasElement) {
            this.replayCanvas2D(node, width, height, cmds);
          }
          break;
        }

        case '3d': {
          const [, canvasId, threeOps] = op;
          const node = this.nodes.get(canvasId);
          if (node && node instanceof HTMLCanvasElement) {
            this.callbacks.onThreeOps?.(node, canvasId, threeOps);
          }
          break;
        }
      }
    }

    for (const [id, prop, val] of afterTree) this.applyProperty(id, prop, val);

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
      return;
    }

    const clean = hostAttributeValue(lowerTag, name, val, {
      entryPath: this.entryPath,
      archive: this.archive,
      permissions: this.permissions,
      netGranted: this.netGranted,
    });
    try {
      if (clean === null) el.removeAttribute(name);
      else el.setAttribute(name, clean);
    } catch {
      // Ignore invalid attribute names
    }
    if (isLinkElement(lowerTag)) this.holdLink(el);
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
    sheet.textContent = sanitizeContainerCss(css, this.entryPath, this.archive, this.permissions, this.netGranted);
  }

  /** Fill the `<style>` standing in for a `<link>`: a stylesheet of the app's, by the host's rule, or nothing. */
  private writeLinkedSheet(el: Element, link: { rel: string; href: string }): void {
    let css = '';
    if (/(?:^|\s)stylesheet(?:\s|$)/i.test(link.rel) && link.href.trim()) {
      const path = resolveVfsPath(link.href, this.entryPath);
      const text = path ? this.archive.readText(path) : null;
      if (path && text !== null) css = sanitizeContainerCss(text, path, this.archive, this.permissions, this.netGranted);
      // Only a stylesheet of the app's own is ever read: any other is said to have failed.
      this.linkNews.set(el, path && text !== null ? 'load' : 'error');
    } else {
      this.linkNews.delete(el);
    }
    el.textContent = css;
  }

  /** Reconcile `parent`'s DOM children to match `childIds` with minimal DOM moves. */
  private reconcileChildren(parent: Element, childIds: readonly number[]): void {
    const desiredNodes: Node[] = [];
    const desiredSet = new Set<Node>();
    for (const cid of childIds) {
      const child = this.nodes.get(cid);
      if (child && !desiredSet.has(child)) {
        desiredNodes.push(child);
        desiredSet.add(child);
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
    if (!this.viewportEl.contains(el) || typeof el.getBoundingClientRect !== 'function') return;
    for (let box: Element | null = el.parentElement; box; box = box.parentElement) {
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

  /** Whether the app may be given the focus: it has it already, or nothing in the embedding page does. */
  private mayTakeFocus(): boolean {
    const root = this.viewportEl.getRootNode() as ShadowRoot | Document;
    const inside = root.activeElement;
    if (inside && this.viewportEl.contains(inside)) return true;
    const doc = this.viewportEl.ownerDocument;
    const active = doc?.activeElement ?? null;
    if (!active || active === doc.body || active === doc.documentElement) return true;
    // The element the app is drawn in holding the focus is the app holding it.
    return 'host' in root && active === (root as ShadowRoot).host;
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

    for (const cmd of cmds) {
      switch (cmd[0]) {
        case 'prop':
          // A drawing property of the context, by name (host-policy.ts): not any name, and
          // not a filter that names an address.
          if (canvasPropertyAllowed(cmd[1], cmd[2])) (ctx as unknown as Record<string, unknown>)[cmd[1]] = cmd[2];
          break;
        case 'clearRect':
          ctx.clearRect(cmd[1], cmd[2], cmd[3], cmd[4]);
          break;
        case 'fillRect':
          ctx.fillRect(cmd[1], cmd[2], cmd[3], cmd[4]);
          break;
        case 'strokeRect':
          ctx.strokeRect(cmd[1], cmd[2], cmd[3], cmd[4]);
          break;
        case 'beginPath':
          ctx.beginPath();
          break;
        case 'closePath':
          ctx.closePath();
          break;
        case 'moveTo':
          ctx.moveTo(cmd[1], cmd[2]);
          break;
        case 'lineTo':
          ctx.lineTo(cmd[1], cmd[2]);
          break;
        case 'arc':
          ctx.arc(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6]);
          break;
        case 'ellipse':
          ctx.ellipse(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6], cmd[7], cmd[8]);
          break;
        case 'rect':
          ctx.rect(cmd[1], cmd[2], cmd[3], cmd[4]);
          break;
        case 'roundRect':
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5]);
          } else {
            ctx.rect(cmd[1], cmd[2], cmd[3], cmd[4]);
          }
          break;
        case 'quadraticCurveTo':
          ctx.quadraticCurveTo(cmd[1], cmd[2], cmd[3], cmd[4]);
          break;
        case 'bezierCurveTo':
          ctx.bezierCurveTo(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6]);
          break;
        case 'fill':
          if (cmd[1]) ctx.fill(cmd[1] as CanvasFillRule);
          else ctx.fill();
          break;
        case 'stroke':
          ctx.stroke();
          break;
        case 'clip':
          if (cmd[1]) ctx.clip(cmd[1] as CanvasFillRule);
          else ctx.clip();
          break;
        case 'save':
          ctx.save();
          break;
        case 'restore':
          ctx.restore();
          break;
        case 'scale':
          ctx.scale(cmd[1], cmd[2]);
          break;
        case 'rotate':
          ctx.rotate(cmd[1]);
          break;
        case 'translate':
          ctx.translate(cmd[1], cmd[2]);
          break;
        case 'transform':
          ctx.transform(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6]);
          break;
        case 'setTransform':
          ctx.setTransform(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6]);
          break;
        case 'resetTransform':
          ctx.resetTransform();
          break;
        case 'setLineDash':
          ctx.setLineDash(cmd[1]);
          break;
        case 'fillText':
          if (cmd[4] !== undefined) ctx.fillText(cmd[1], cmd[2], cmd[3], cmd[4]);
          else ctx.fillText(cmd[1], cmd[2], cmd[3]);
          break;
        case 'strokeText':
          if (cmd[4] !== undefined) ctx.strokeText(cmd[1], cmd[2], cmd[3], cmd[4]);
          else ctx.strokeText(cmd[1], cmd[2], cmd[3]);
          break;
        case 'putImageData': {
          const raw = base64ToBytes(cmd[1]);
          const w = cmd[2];
          const h = cmd[3];
          if (typeof ImageData === 'function' && raw.byteLength === w * h * 4) {
            const imgData = new ImageData(new Uint8ClampedArray(raw), w, h);
            ctx.putImageData(imgData, cmd[4], cmd[5]);
          }
          break;
        }
        case 'drawImage': {
          const srcRef = cmd[1];
          const source = this.resolveDrawableImage(srcRef);
          if (!source) break;
          if (cmd[7] !== undefined && cmd[8] !== undefined && cmd[9] !== undefined) {
            ctx.drawImage(source, cmd[2], cmd[3], cmd[4]!, cmd[5]!, cmd[6]!, cmd[7], cmd[8], cmd[9]);
          } else if (cmd[4] !== undefined && cmd[5] !== undefined) {
            ctx.drawImage(source, cmd[2], cmd[3], cmd[4], cmd[5]);
          } else {
            ctx.drawImage(source, cmd[2], cmd[3]);
          }
          break;
        }
      }
    }
  }

  /**
   * Load an image that is on no page (`new Image()`, a game's sprites, a preloader), and tell
   * the app's script when it has loaded or cannot be. Its address is held to the rule an
   * `<img>` on the page is: a file of the app's, a blob it made, or a site it was granted.
   * Kept by the address as written, which is how a canvas then asks to draw it.
   */
  private preloadImage(token: string, src: string): void {
    const answer = (ok: boolean, width = 0, height = 0) => {
      if (!this.disposed) this.callbacks.onEvent(-1, 'softn:image', { token, src, ok, width, height }, []);
    };
    const kept = this.imageCache.get(src);
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
    this.imageCache.set(src, img);
    img.src = address;
  }

  private resolveDrawableImage(ref: string): CanvasImageSource | null {
    if (ref.startsWith('node:')) {
      const id = Number(ref.slice(5));
      const n = this.nodes.get(id);
      if (n instanceof HTMLCanvasElement || n instanceof HTMLImageElement) return n;
      return null;
    }
    const cached = this.imageCache.get(ref);
    if (cached && cached.complete) return cached;
    if (!cached && typeof Image === 'function') {
      const blobUrl = this.archive.getBlobUrl(ref, this.entryPath);
      if (blobUrl) {
        const img = new Image();
        img.src = blobUrl;
        this.imageCache.set(ref, img);
      }
    }
    return null;
  }

  /** Always keep input/select/focus state synced and block native form page navigations. */
  private installCoreInputSync(): void {
    const onSubmitCapture = (e: Event) => {
      // Never allow a form inside `<softn-app>` to navigate the host browser window
      e.preventDefault();
    };
    // Every click on a link of the app's is the host's to carry out, never the browser's: the
    // link is an element of the embedding page, so followed natively it would move that
    // page (to the link's address, or to a fragment of its own address), and its `target`
    // is the app's word. A link out opens in a tab of its own with no handle on this page;
    // a fragment scrolls inside the app; a page of the app's is the container's to show;
    // anything else does nothing. v0.0.43 left links out to the browser, `target="_top"`
    // and all.
    const onClickCapture = (e: Event) => {
      const target = e.target instanceof Element ? e.target : null;
      const anchor = target?.closest('a[href], area[href]');
      if (!anchor || !this.viewportEl.contains(anchor)) return;
      e.preventDefault();
      const href = (anchor.getAttribute('href') ?? '').trim();
      if (!href) return;
      if (href.startsWith('#')) {
        const root = this.viewportEl.getRootNode() as ShadowRoot | Document;
        let to: Element | null = null;
        try {
          to = href.length > 1 ? root.getElementById?.(decodeURIComponent(href.slice(1))) ?? null : this.viewportEl;
        } catch {
          to = null;
        }
        if (to && this.viewportEl.contains(to)) to.scrollIntoView({ block: 'start' });
        return;
      }
      if (isExternalHref(href)) {
        if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      // A link inside the app. Where the app's script listens for clicks, the link is its to
      // cancel, as in a browser: a router's link is followed by the script (pushState, and
      // the page it draws), and the page it names is not one to load. The script is a
      // thread away, so the page waits for its answer (the listener below hands the click
      // over and follows the link if it was not cancelled). It was followed at once: the
      // "Home" link of a single-page app loaded the app again from the start.
      if (this.listenedEvents.has('click')) {
        this.heldLink = { event: e, href };
        return;
      }
      this.callbacks.onNavigate?.(href);
    };
    const onInputOrChange = (e: Event) => {
      const changes = this.extractInputSync(e.target);
      if (changes.length > 0 && !this.listenedEvents.has(e.type)) {
        this.callbacks.onSync(changes);
      }
    };

    this.viewportEl.addEventListener('submit', onSubmitCapture, true);
    this.viewportEl.addEventListener('click', onClickCapture, false);
    this.viewportEl.addEventListener('input', onInputOrChange, true);
    this.viewportEl.addEventListener('change', onInputOrChange, true);

    this.cleanupFns.push(() => {
      this.viewportEl.removeEventListener('submit', onSubmitCapture, true);
      this.viewportEl.removeEventListener('click', onClickCapture, false);
      this.viewportEl.removeEventListener('input', onInputOrChange, true);
      this.viewportEl.removeEventListener('change', onInputOrChange, true);
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
            window.innerWidth || 1024,
            window.innerHeight || 768,
            window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 1 : 0,
            window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 1 : 0,
            window.devicePixelRatio || 1,
            window.matchMedia?.('(pointer: coarse)').matches ? 1 : 0,
          ],
        }, []);
      };
      window.addEventListener('resize', onResize);
      this.cleanupFns.push(() => window.removeEventListener('resize', onResize));
      return;
    }

    this.listenedEvents.add(eventType);
    const useCapture = CAPTURE_ONLY_EVENTS.has(eventType);

    const handler = (e: Event) => {
      const targetEl = e.target instanceof Element ? e.target : null;
      const nodeId = this.findNearestNodeId(targetEl);
      // A link held for this click (above): followed once the script has heard the click
      // and not cancelled it, or now if the script is not going to hear it.
      const held = this.heldLink && this.heldLink.event === e ? this.heldLink.href : null;
      if (held !== null) this.heldLink = null;
      if (nodeId === null) {
        if (held !== null) this.callbacks.onNavigate?.(held);
        return;
      }

      const syncChanges = this.extractInputSync(e.target, eventType === 'click');
      // The focused element inside the app's own root. (The document's is the embedding
      // page's `<softn-app>` element, which is none of the app's, so the app's script never
      // learned where the focus was.)
      const root = this.viewportEl.getRootNode() as ShadowRoot | Document;
      const activeEl = root.activeElement;
      const activeId = activeEl instanceof Element && this.viewportEl.contains(activeEl) ? this.findNearestNodeId(activeEl) : null;
      if (activeId !== null) syncChanges.push(['f', activeId]);

      const props = serializeDomEvent(e, targetEl, this.findNearestNodeId.bind(this), this.origin());
      const answered =
        held === null
          ? undefined
          : (eventBits: number) => {
              if (!this.disposed && !(eventBits & 1)) this.callbacks.onNavigate?.(held);
            };
      this.callbacks.onEvent(nodeId, eventType, props, syncChanges, answered);
    };

    this.viewportEl.addEventListener(eventType, handler, useCapture);
    this.cleanupFns.push(() => this.viewportEl.removeEventListener(eventType, handler, useCapture));

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
    let cur: Element | null = el;
    while (cur) {
      const raw = cur.getAttribute(NODE_ID_ATTR);
      if (raw !== null) {
        const n = Number(raw);
        if (Number.isInteger(n)) return n;
      }
      if (cur === this.viewportEl) return 1;
      cur = cur.parentElement;
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
      for (const id of this.measuredIds) {
        const node = this.nodes.get(id);
        if (node instanceof Element && node.isConnected) {
          const rect = node.getBoundingClientRect();
          // With how much it holds, for scrollHeight: a box and what scrolls inside it differ.
          boxes.push([id, rect.left - origin.left, rect.top - origin.top, rect.width, rect.height, node.scrollWidth, node.scrollHeight]);
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
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.nodes.clear();
    this.imageCache.clear();
    this.styleSheets.clear();
    this.links.clear();
    this.pendingProperties.clear();
  }
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
