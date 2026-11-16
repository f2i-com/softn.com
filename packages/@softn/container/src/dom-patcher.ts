/**
 * Direct Surgical Host DOM Patcher + Canvas 2D Replayer + Delegated Event Bridge.
 *
 * Replaces SoftN v1's `DocumentShell -> ElementNode AST -> React VDOM -> ReactDOM`
 * pipeline with direct `O(1)` operations against a `Map<number, Node>` inside
 * `<softn-app>`'s closed `ShadowRoot`.
 */

import { ContainerArchive, base64ToBytes } from './archive';
import { NODE_ID_ATTR, sanitizeContainerCss, sanitizeHostAssetUrl } from './sanitize';
import type {
  Canvas2DCmd,
  ContainerPermissions,
  MeasuredBoxTuple,
  ShellOp,
  ThreeSceneOp,
} from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MATH_NS = 'http://www.w3.org/1998/Math/MathML';

const FORBIDDEN_DYNAMIC_TAGS = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
]);

const URL_ATTRS = new Set(['src', 'href', 'poster', 'action', 'formaction', 'xlink:href']);

const CAPTURE_ONLY_EVENTS = new Set([
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
  onEvent: (
    nodeId: number,
    eventType: string,
    props: Record<string, unknown>,
    syncChanges: unknown[]
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
  private readonly measuredIds = new Set<number>();
  private resizeObserver: ResizeObserver | null = null;
  private measureScheduled = false;
  private readonly imageCache = new Map<string, HTMLImageElement>();
  private disposed = false;

  constructor(params: {
    viewportEl: HTMLElement;
    docRootEl: HTMLElement;
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

    for (const op of ops) {
      switch (op[0]) {
        case 'e': {
          const [, id, rawTag, attrs, ns] = op;
          const lower = rawTag.toLowerCase();
          if (FORBIDDEN_DYNAMIC_TAGS.has(lower)) {
            const placeholder = document.createComment(`blocked:${lower}`);
            this.nodes.set(id, placeholder);
            break;
          }
          const el =
            ns === 'svg'
              ? document.createElementNS(SVG_NS, rawTag)
              : ns === 'math'
                ? document.createElementNS(MATH_NS, rawTag)
                : document.createElement(lower);
          if (lower.startsWith('softn-')) {
            this.callbacks.onCustomTag?.(lower);
          }
          for (const [k, v] of Object.entries(attrs)) {
            this.applySafeAttribute(el, lower, k, v);
          }
          el.setAttribute(NODE_ID_ATTR, String(id));
          this.nodes.set(id, el);
          break;
        }

        case 'x': {
          const [, id, text] = op;
          const existing = this.nodes.get(id);
          if (existing && existing.nodeType === Node.TEXT_NODE) {
            existing.nodeValue = text;
          } else {
            const tn = document.createTextNode(text);
            if (existing?.parentNode) existing.parentNode.replaceChild(tn, existing);
            this.nodes.set(id, tn);
          }
          break;
        }

        case 'm': {
          const [, id] = op;
          if (!this.nodes.has(id)) {
            this.nodes.set(id, document.createComment(''));
          }
          break;
        }

        case 'a': {
          const [, id, name, val] = op;
          const target = id === 0 ? this.docRootEl : id === 1 ? this.viewportEl : this.nodes.get(id);
          if (target && target.nodeType === Node.ELEMENT_NODE) {
            const el = target as Element;
            this.applySafeAttribute(el, el.tagName.toLowerCase(), name, val);
          }
          break;
        }

        case 'c': {
          const [, parentId, childIds] = op;
          const parent = parentId === 1 ? this.viewportEl : this.nodes.get(parentId);
          if (!parent || (parent.nodeType !== Node.ELEMENT_NODE && parent.nodeType !== Node.DOCUMENT_FRAGMENT_NODE)) {
            break;
          }
          this.reconcileChildren(parent as Element, childIds);
          break;
        }

        case 'p': {
          const [, id, prop, val] = op;
          this.applyProperty(id, prop, val);
          break;
        }

        case 'l': {
          const [, eventType] = op;
          this.ensureEventListener(eventType);
          break;
        }

        case 't': {
          this.callbacks.onTitleChange?.(op[1]);
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

    if (this.measuredIds.size > 0) {
      this.scheduleBoxMeasure();
    }
  }

  private applySafeAttribute(el: Element, lowerTag: string, name: string, val: string | null): void {
    const lowerName = name.toLowerCase();
    if (lowerName === NODE_ID_ATTR || lowerName.startsWith('on')) return;

    if (val === null) {
      el.removeAttribute(name);
      return;
    }

    if (URL_ATTRS.has(lowerName)) {
      const clean = sanitizeHostAssetUrl(
        lowerName,
        val,
        lowerTag,
        this.entryPath,
        this.archive,
        this.permissions,
        this.netGranted
      );
      if (clean === null) {
        el.removeAttribute(name);
      } else {
        el.setAttribute(name, clean);
        if (lowerTag === 'a' && lowerName === 'href' && /^https?:/i.test(clean)) {
          el.setAttribute('rel', 'noopener noreferrer');
          if (!el.hasAttribute('target')) el.setAttribute('target', '_blank');
        }
      }
      return;
    }

    if (lowerName === 'style') {
      el.setAttribute(
        'style',
        sanitizeContainerCss(val, this.entryPath, this.archive, this.permissions, this.netGranted)
      );
      return;
    }

    try {
      el.setAttribute(name, val);
    } catch {
      // Ignore invalid attribute names
    }
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
      case 'scrollTop':
        if (typeof val === 'number') el.scrollTop = val;
        break;
      case 'scrollLeft':
        if (typeof val === 'number') el.scrollLeft = val;
        break;
      case 'focus':
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
        if (typeof (el as HTMLDialogElement).showModal === 'function') {
          try {
            if (!(el as HTMLDialogElement).open) (el as HTMLDialogElement).showModal();
          } catch {
            el.setAttribute('open', '');
          }
        } else {
          el.setAttribute('open', '');
        }
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
        // Allow structured data properties (`data`, `options`, `rows`, `config`) on `<softn-*>` custom elements
        if (el.tagName.toLowerCase().startsWith('softn-') && !prop.startsWith('__')) {
          (el as unknown as Record<string, unknown>)[prop] = val;
        }
        break;
    }
  }

  /** Replay batched 2D `<canvas>` drawing commands onto the host `<canvas>`. */
  private replayCanvas2D(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    cmds: readonly Canvas2DCmd[]
  ): void {
    if (width > 0 && canvas.width !== width) canvas.width = width;
    if (height > 0 && canvas.height !== height) canvas.height = height;
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
          (ctx as unknown as Record<string, unknown>)[cmd[1]] = cmd[2];
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
    const onClickCapture = (e: Event) => {
      const target = e.target instanceof Element ? e.target : null;
      const anchor = target?.closest('a[href]');
      if (anchor) {
        const href = anchor.getAttribute('href') ?? '';
        if (href && !href.startsWith('#') && !/^https?:/i.test(href)) {
          e.preventDefault();
          this.callbacks.onNavigate?.(href);
        }
      }
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
    if (this.listenedEvents.has(eventType)) return;
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
      if (nodeId === null) return;

      const syncChanges = this.extractInputSync(e.target);
      const activeEl = this.viewportEl.ownerDocument?.activeElement;
      const activeId = activeEl instanceof Element ? this.findNearestNodeId(activeEl) : null;
      if (activeId !== null) syncChanges.push(['f', activeId]);

      const props = serializeDomEvent(e, targetEl, this.findNearestNodeId.bind(this));
      this.callbacks.onEvent(nodeId, eventType, props, syncChanges);
    };

    this.viewportEl.addEventListener(eventType, handler, useCapture);
    this.cleanupFns.push(() => this.viewportEl.removeEventListener(eventType, handler, useCapture));
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

  private extractInputSync(target: EventTarget | null): unknown[] {
    const changes: unknown[] = [];
    if (!(target instanceof Element)) return changes;
    const id = this.findNearestNodeId(target);
    if (id === null || id <= 1) return changes;

    if (target instanceof HTMLInputElement) {
      if (target.type === 'checkbox' || target.type === 'radio') {
        changes.push(['k', id, target.checked]);
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
      for (const id of this.measuredIds) {
        const node = this.nodes.get(id);
        if (node instanceof Element && node.isConnected) {
          const rect = node.getBoundingClientRect();
          boxes.push([id, rect.left, rect.top, rect.width, rect.height]);
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
  }
}

function serializeDomEvent(
  e: Event,
  targetEl: Element | null,
  findId: (el: Element | null) => number | null
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
    out.clientX = me.clientX;
    out.clientY = me.clientY;
    out.pageX = me.pageX;
    out.pageY = me.pageY;
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
