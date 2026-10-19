/**
 * The host's side of the document a page's code is given (see
 * shell-source.ts): the seed it starts from, a mirror of what the code has
 * made of it, and the browser's events and typing sent back in.
 *
 * The seed is the page's own markup as the document's tree: each plain HTML
 * element (`<ul>`, `<li>`, `<form>`) and each piece of plain text is a node
 * the code may change; anything SoftN draws for itself (a component, a
 * `{value}`, `#if`, `#each`, an element drawn conditionally or once per
 * item, an `<svg>`) is an island, which the code can find, move and remove,
 * and which SoftN goes on drawing.
 *
 * The mirror is drawn by the renderer one element at a time (ShellElement
 * in render.tsx): an element nothing has touched is drawn from its markup,
 * as it always was; one the code changed is drawn from markup with the
 * code's changes over it, as if it had been written that way; one the code
 * made is drawn as markup with plain attributes would be. All of it goes
 * through the renderer's one path for elements, so what the code writes is
 * checked exactly as what an author writes: no `<script>`, no `<iframe>`,
 * no `javascript:` address, no handler in an attribute.
 */
import type { ElementNode, PropNode, TemplateNode, TextNode } from '../parser/ast';
import type { SourceLocation } from '../parser/token';

/** One node of the seed: an element, text, or an island. */
export interface SeedNode {
  /** Its id. */
  i: number;
  /** An element's tag, or an island element's name. */
  t?: string;
  /** An element's attributes, as written. */
  a?: Record<string, string>;
  /** An element's children. */
  c?: SeedNode[];
  /** Text. */
  x?: string;
  /** An island: SoftN draws it. */
  o?: 1;
}

export interface ShellSeed {
  next: number;
  body: SeedNode[];
  title?: string;
  /** Where the page is, for `location`. */
  url?: string;
}

/** What the shell tells the host after a turn of the engine. */
export type ShellOp =
  | ['e', number, string, Record<string, string>]
  | ['x', number, string]
  | ['m', number]
  | ['a', number, string, string | null]
  | ['c', number, number[]]
  | ['p', number, string, unknown]
  | ['l', string]
  | ['t', string]
  | ['n', string];

type MirrorNode =
  | {
      kind: 'element';
      id: number;
      tag: string;
      attrs: Map<string, string>;
      /** Set when it is the markup's own element. */
      ast?: ElementNode;
      /** Attributes the code set or removed, which win over the markup's. */
      touched: Set<string>;
      /** Whether the code changed what is in it, and it is drawn from here. */
      childrenTouched: boolean;
      children: number[];
      parent: number;
    }
  | { kind: 'text'; id: number; text: string; ast?: TextNode; drawn?: TextNode; parent: number }
  | { kind: 'island'; id: number; ast: TemplateNode; parent: number }
  | { kind: 'comment'; id: number; parent: number };

/** What a ShellElement needs from the shell. */
export interface DocumentShellView {
  /** The id of the page's body. */
  readonly bodyId: number;
  /** The id of an element the shell draws, or undefined for any other node. */
  idOf(node: TemplateNode): number | undefined;
  subscribe(id: number, onChange: () => void): () => void;
  version(id: number): number;
  /** The element to draw for this id now. */
  elementFor(id: number): ElementNode;
  /** What the page's body holds now, given what its markup holds. */
  bodyFor(template: TemplateNode[]): TemplateNode[];
  /** Do to the drawn element what the code asked of it (a value, focus). */
  settle(id: number): void;
}

/** The attribute every element the shell draws carries, naming it to the host. */
export const SHELL_NODE_ATTRIBUTE = 'data-softn-node';

const BODY = 1;
let shells = 0;

/** A place in no source, for a node the code made: unique, so a key made from it is too. */
function nowhere(id: number, column: number): SourceLocation {
  return { line: -id, column, start: -1, end: -1 };
}

/** A tag the shell takes as plain HTML the code may change. */
export type OwnsTag = (tag: string) => boolean;

export class DocumentShell implements DocumentShellView {
  /** Distinguishes this shell's elements from another app's on the same page. */
  readonly key = 's' + ++shells;
  readonly bodyId = BODY;
  readonly seed: ShellSeed;
  private readonly nodes = new Map<number, MirrorNode>();
  private readonly ids = new WeakMap<object, number>();
  /** The node each element id is drawn by: the markup's, or a stand-in for one the code made. */
  private readonly drawnBy = new Map<number, ElementNode>();
  private readonly listeners = new Map<number, Set<() => void>>();
  private readonly versions = new Map<number, number>();
  private readonly pendingProps = new Map<number, Array<[string, unknown]>>();
  private readonly listened = new Set<string>();
  /** Attributes of the markup's elements SoftN draws from a `{value}`, by element. */
  private readonly drawnFromValues = new Map<number, string[]>();
  /** What the shell was last told each of them is, by `id:name`. */
  private readonly toldValues = new Map<string, string | null>();
  private pendingSync: unknown[] = [];
  private dispatcher: ((id: number, type: string, props: Record<string, unknown>, path: SeenElement[]) => number) | null = null;
  private readyHook: (() => void) | null = null;
  private container: HTMLElement | null = null;
  private readonly unhook: Array<() => void> = [];
  /** Set once the page's code was found to use the document. */
  active = false;
  onTitle: ((title: string) => void) | null = null;
  /** The page's code asked to go to an address (`location.href = …`). */
  onNavigate: ((href: string) => void) | null = null;

  constructor(template: TemplateNode[], owns: OwnsTag, title?: string, url?: string) {
    let next = BODY + 1;
    const nodes = this.nodes;
    const seedOf = (node: TemplateNode, parent: number): SeedNode | null => {
      const id = next++;
      if (node.type === 'Text') {
        nodes.set(id, { kind: 'text', id, text: node.content, ast: node, parent });
        return { i: id, x: node.content };
      }
      if (node.type === 'Element' && owns(node.tag) && !node.conditionalIf && !node.inlineEach) {
        const attrs = writtenAttributes(node);
        const children: number[] = [];
        const element: MirrorNode = {
          kind: 'element',
          id,
          tag: node.tag,
          attrs: new Map(Object.entries(attrs)),
          ast: node,
          touched: new Set(),
          childrenTouched: false,
          children,
          parent,
        };
        nodes.set(id, element);
        this.ids.set(node, id);
        this.drawnBy.set(id, node);
        const drawn = drawnAttributes(node);
        if (drawn.length > 0) this.drawnFromValues.set(id, drawn);
        const c: SeedNode[] = [];
        for (const child of node.children) {
          const seeded = seedOf(child, id);
          if (seeded) {
            c.push(seeded);
            children.push(seeded.i);
          }
        }
        return { i: id, t: node.tag, a: attrs, c };
      }
      if (node.type === 'TemplateSlot') return null;
      nodes.set(id, { kind: 'island', id, ast: node, parent });
      if (node.type === 'Element') return { i: id, o: 1, t: node.tag, a: writtenAttributes(node) };
      return { i: id, o: 1 };
    };
    const body: SeedNode[] = [];
    const bodyChildren: number[] = [];
    nodes.set(BODY, {
      kind: 'element',
      id: BODY,
      tag: 'body',
      attrs: new Map(),
      touched: new Set(),
      childrenTouched: false,
      children: bodyChildren,
      parent: 0,
    });
    for (const node of template) {
      const seeded = seedOf(node, BODY);
      if (seeded) {
        body.push(seeded);
        bodyChildren.push(seeded.i);
      }
    }
    this.seed = { next, body, ...(title ? { title } : {}), ...(url ? { url } : {}) };
  }

  /** The seed as the source the shell is started with. */
  seedJson(): string {
    return JSON.stringify(this.seed).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }

  // ------------------------------------------------------------------ drawing

  idOf(node: TemplateNode): number | undefined {
    return this.ids.get(node);
  }

  subscribe(id: number, onChange: () => void): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(onChange);
    return () => set!.delete(onChange);
  }

  version(id: number): number {
    return this.versions.get(id) ?? 0;
  }

  private changed(id: number): void {
    this.versions.set(id, this.version(id) + 1);
    for (const notify of [...(this.listeners.get(id) ?? [])]) notify();
  }

  elementFor(id: number): ElementNode {
    const node = this.nodes.get(id);
    if (!node || node.kind !== 'element') throw new Error(`The page has no element ${id}`);
    const marker: PropNode = staticProp(SHELL_NODE_ATTRIBUTE, `${this.key}:${id}`, node.ast?.loc ?? nowhere(id, 0));
    if (node.ast) {
      const ast = node.ast;
      const props = ast.props.filter((prop) => !node.touched.has(attributeName(prop.name)));
      for (const name of node.touched) {
        const value = node.attrs.get(name);
        if (value !== undefined) props.push(staticProp(name, value, ast.loc));
      }
      return {
        ...ast,
        props: [...props, marker],
        bindings: ast.bindings.filter((binding) => !node.touched.has(attributeName(binding.name))),
        children: node.childrenTouched ? this.childrenOf(node.children) : ast.children,
      };
    }
    const props: PropNode[] = [];
    for (const [name, value] of node.attrs) props.push(staticProp(name, value, nowhere(id, 0)));
    props.push(marker);
    return {
      type: 'Element',
      tag: node.tag,
      props,
      events: [],
      bindings: [],
      children: this.childrenOf(node.children),
      selfClosing: false,
      loc: nowhere(id, 0),
    };
  }

  bodyFor(template: TemplateNode[]): TemplateNode[] {
    const body = this.nodes.get(BODY);
    return body && body.kind === 'element' && body.childrenTouched ? this.childrenOf(body.children) : template;
  }

  private childrenOf(ids: number[]): TemplateNode[] {
    const out: TemplateNode[] = [];
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (!node) continue;
      if (node.kind === 'element') out.push(this.drawnBy.get(id)!);
      else if (node.kind === 'island') out.push(node.ast);
      else if (node.kind === 'text') {
        if (node.ast && node.ast.content === node.text) out.push(node.ast);
        else {
          if (!node.drawn || node.drawn.content !== node.text) {
            node.drawn = { type: 'Text', content: node.text, loc: nowhere(id, 1) };
          }
          out.push(node.drawn);
        }
      }
    }
    return out;
  }

  /** The stand-in a new element of the code's is drawn by, found by its id. */
  private standIn(id: number, tag: string): ElementNode {
    const node: ElementNode = {
      type: 'Element',
      tag,
      props: [],
      events: [],
      bindings: [],
      children: [],
      selfClosing: false,
      loc: nowhere(id, 0),
    };
    this.ids.set(node, id);
    this.drawnBy.set(id, node);
    return node;
  }

  settle(id: number): void {
    const props = this.pendingProps.get(id);
    if (!props || !this.container) return;
    this.pendingProps.delete(id);
    const element = this.elementById(id);
    if (!element) return;
    for (const [name, value] of props) {
      const field = element as HTMLInputElement & HTMLSelectElement;
      if (name === 'value' && 'value' in field) field.value = String(value);
      else if (name === 'checked' && 'checked' in field) field.checked = Boolean(value);
      else if (name === 'selectedIndex' && 'selectedIndex' in field) field.selectedIndex = Number(value);
      else if (name === 'focus') (element as HTMLElement).focus?.();
      else if (name === 'blur') (element as HTMLElement).blur?.();
      else if (name === 'scrollIntoView') element.scrollIntoView?.({ block: 'nearest' });
    }
  }

  private elementById(id: number): Element | null {
    if (!this.container) return null;
    return this.container.querySelector(`[${SHELL_NODE_ATTRIBUTE}="${this.key}:${id}"]`);
  }

  // ------------------------------------------------------------------ the engine's side

  /** What the page's code changed, from the shell. */
  apply(ops: readonly ShellOp[] | null | undefined): void {
    if (!ops || ops.length === 0) return;
    const touched = new Set<number>();
    const navigations: string[] = [];
    const dropped: number[] = [];
    for (const op of ops) {
      switch (op[0]) {
        case 'e': {
          const [, id, tag, attrs] = op;
          const existing = this.nodes.get(id);
          if (existing && existing.kind === 'element') {
            // Joined again, as it is now: what differs is what the code did.
            const names = new Set([...existing.attrs.keys(), ...Object.keys(attrs)]);
            for (const name of names) {
              const value = Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : undefined;
              if (existing.attrs.get(name) === value) continue;
              if (value === undefined) existing.attrs.delete(name);
              else existing.attrs.set(name, value);
              existing.touched.add(name);
            }
          } else {
            this.nodes.set(id, {
              kind: 'element',
              id,
              tag,
              attrs: new Map(Object.entries(attrs)),
              touched: new Set(Object.keys(attrs)),
              childrenTouched: true,
              children: [],
              parent: 0,
            });
            this.standIn(id, tag);
          }
          touched.add(id);
          break;
        }
        case 'x': {
          const [, id, text] = op;
          const existing = this.nodes.get(id);
          if (existing && existing.kind === 'text') {
            if (existing.text !== text) {
              existing.text = text;
              this.childrenChangedIn(existing.parent, touched);
            }
          } else {
            this.nodes.set(id, { kind: 'text', id, text, parent: 0 });
          }
          break;
        }
        case 'm':
          if (!this.nodes.has(op[1])) this.nodes.set(op[1], { kind: 'comment', id: op[1], parent: 0 });
          break;
        case 'a': {
          const [, id, name, value] = op;
          const node = this.nodes.get(id);
          if (!node || node.kind !== 'element') break;
          if (value === null) node.attrs.delete(name);
          else node.attrs.set(name, value);
          node.touched.add(name);
          touched.add(id);
          break;
        }
        case 'c': {
          const [, id, children] = op;
          const node = this.nodes.get(id);
          if (!node || node.kind !== 'element') break;
          for (const old of node.children) if (!children.includes(old)) dropped.push(old);
          node.children = children.slice();
          node.childrenTouched = true;
          for (const child of children) {
            const c = this.nodes.get(child);
            if (c) c.parent = id;
          }
          touched.add(id);
          break;
        }
        case 'p': {
          const [, id, name, value] = op;
          let list = this.pendingProps.get(id);
          if (!list) this.pendingProps.set(id, (list = []));
          list.push([name, value]);
          touched.add(id);
          break;
        }
        case 'l':
          this.listen(op[1]);
          break;
        case 't':
          this.onTitle?.(op[1]);
          break;
        case 'n':
          navigations.push(op[1]);
          break;
      }
    }
    for (const id of dropped) if (!this.isOnPage(id)) this.letGo(id);
    for (const id of touched) this.changed(id);
    // After what the code drew: the last place it asked to go is where it goes.
    if (navigations.length > 0) this.onNavigate?.(navigations[navigations.length - 1]);
  }

  /** Whether a node is in its parent's children: on the page, or in a part of it taken off whole. */
  private isOnPage(id: number): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    const parent = this.nodes.get(node.parent);
    return !!parent && parent.kind === 'element' && parent.children.includes(id);
  }

  /**
   * Forget a node the code took off the page, and what is in it: the code
   * tells the host about it again, whole, if it puts it back. The markup's
   * own nodes are kept, since putting one back must find the markup it
   * stands for, and there are only as many of them as the page has.
   */
  private letGo(id: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if ((node.kind === 'element' || node.kind === 'text') && node.ast) return;
    if (node.kind === 'island') return;
    if (node.kind === 'element') for (const child of node.children) this.letGo(child);
    this.nodes.delete(id);
    this.drawnBy.delete(id);
    this.versions.delete(id);
    this.listeners.delete(id);
    this.pendingProps.delete(id);
  }

  /** A text node changed: its element is drawn from the mirror from now on. */
  private childrenChangedIn(parentId: number, touched: Set<number>): void {
    const parent = this.nodes.get(parentId);
    if (!parent || parent.kind !== 'element') return;
    parent.childrenTouched = true;
    touched.add(parentId);
  }

  /**
   * What the person did to the page since the engine last ran: values typed,
   * boxes ticked, choices made, and which element has focus. Null when
   * nothing.
   */
  takeSync(): unknown[] | null {
    this.readDrawnValues();
    if (this.pendingSync.length === 0) return null;
    const out = this.pendingSync;
    this.pendingSync = [];
    return out;
  }

  /**
   * The attributes SoftN draws from a `{value}` (`class={cls}`), as the page
   * shows them now, for those the code has not taken over: the shell's seed
   * could not know them, and `classList.add` on one added to nothing.
   */
  private readDrawnValues(): void {
    if (!this.container) return;
    for (const [id, names] of this.drawnFromValues) {
      const node = this.nodes.get(id);
      if (!node || node.kind !== 'element') continue;
      const element = this.elementById(id);
      if (!element) continue;
      for (const name of names) {
        if (node.touched.has(name)) continue;
        const value = element.getAttribute(name);
        const key = `${id}:${name}`;
        if (this.toldValues.get(key) === value) continue;
        this.toldValues.set(key, value);
        this.pendingSync.push(['A', id, name, value]);
      }
    }
  }

  // ------------------------------------------------------------------ the browser's side

  /** The engine's ways in, given by the runtime once the code is found to use the document. */
  attach(
    dispatch: (id: number, type: string, props: Record<string, unknown>, path: SeenElement[]) => number,
    ready: () => void
  ): void {
    this.dispatcher = dispatch;
    this.readyHook = ready;
    this.active = true;
  }

  /** Listen on the page the app is drawn in, inside `container`. */
  connect(container: HTMLElement): void {
    if (this.container === container) return;
    this.disconnect();
    this.container = container;
    const doc = container.ownerDocument;
    const field = (event: Event) => {
      const id = this.idIn(event.target);
      if (id === null) return;
      const element = event.target as HTMLInputElement;
      if (element.tagName === 'SELECT') this.pendingSync.push(['s', id, (element as unknown as HTMLSelectElement).selectedIndex]);
      else if (element.type === 'checkbox' || element.type === 'radio') {
        this.pendingSync.push(['k', id, element.checked]);
        // A radio chosen takes its group's other choices with it.
        if (element.type === 'radio' && element.name) {
          const group = container.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(element.name)}"]`);
          for (const other of group) {
            const otherId = this.idIn(other);
            if (other !== element && otherId !== null) this.pendingSync.push(['k', otherId, other.checked]);
          }
        }
      } else if ('value' in element) this.pendingSync.push(['v', id, element.value]);
    };
    const focus = (event: Event) => {
      const id = this.idIn(event.target);
      this.pendingSync.push(['f', id ?? 0]);
    };
    doc.addEventListener('input', field, true);
    doc.addEventListener('change', field, true);
    doc.addEventListener('focusin', focus, true);
    this.unhook.push(() => {
      doc.removeEventListener('input', field, true);
      doc.removeEventListener('change', field, true);
      doc.removeEventListener('focusin', focus, true);
    });
    for (const type of this.listened) this.hear(type);
    // Values and settings the code asked for before the page was drawn.
    for (const id of [...this.pendingProps.keys()]) this.settle(id);
  }

  disconnect(): void {
    for (const off of this.unhook.splice(0)) off();
    this.container = null;
  }

  /** The page has been drawn: DOMContentLoaded and load. */
  ready(): void {
    this.readyHook?.();
  }

  private listen(type: string): void {
    if (this.listened.has(type)) return;
    this.listened.add(type);
    if (this.container) this.hear(type);
  }

  /**
   * Hear one kind of event for the page's code. On the app it is heard on
   * the app's container on the way down, before SoftN's own handlers (which
   * React runs on the way up): the code's `preventDefault()` on a link then
   * keeps the link from being followed, as it does in a browser. A stop the
   * code made on the way down stops the event there; one made on the way up
   * cannot reach back past what already ran.
   *
   * On the page around the app (the body, with nothing focused) it is heard
   * on the document and given to the code's body, but what the code does
   * with it stays its own: an app cannot cancel the page's keys.
   */
  private hear(type: string): void {
    if (type === 'DOMContentLoaded' || type === 'load') return;
    const container = this.container!;
    const doc = container.ownerDocument;
    const onApp = (event: Event) => {
      if (!this.dispatcher) return;
      const target = event.target as Node | null;
      const id = this.idIn(target) ?? BODY;
      const flags = this.dispatcher(id, type, eventData(event), this.seenPath(target, id));
      if (flags & 1) event.preventDefault();
      if (flags & 4) event.stopPropagation();
    };
    const aroundApp = (event: Event) => {
      if (!this.dispatcher) return;
      const target = event.target as Node | null;
      if (target !== doc && target !== doc.body && target !== doc.documentElement) return;
      this.dispatcher(BODY, type, eventData(event), []);
    };
    container.addEventListener(type, onApp, true);
    doc.addEventListener(type, aroundApp, !BUBBLES.has(type));
    this.unhook.push(() => {
      container.removeEventListener(type, onApp, true);
      doc.removeEventListener(type, aroundApp, !BUBBLES.has(type));
    });
  }

  /**
   * The elements SoftN drew between `target` and the document's element with
   * this id (or the app's edge, for the body), innermost first, as the page
   * shows them: what `event.target` and its ancestors are when the event
   * happened inside an island.
   */
  private seenPath(target: Node | null, id: number): SeenElement[] {
    const path: SeenElement[] = [];
    let node: Node | null = target && target.nodeType !== 1 ? target.parentNode : target;
    const stop = id === BODY ? this.container : this.elementById(id);
    while (node && node.nodeType === 1 && node !== stop && this.container?.contains(node) && path.length < MAX_SEEN) {
      path.push(seenElement(node as Element));
      node = node.parentNode;
    }
    return path;
  }

  /** The id of the shell's element `target` is in, or null. */
  private idIn(target: EventTarget | null): number | null {
    let node = target as Node | null;
    if (node && node.nodeType !== 1) node = node.parentNode;
    const element = node as Element | null;
    if (!element || typeof element.closest !== 'function' || !this.container?.contains(element)) return null;
    const found = element.closest(`[${SHELL_NODE_ATTRIBUTE}^="${this.key}:"]`);
    if (!found) return null;
    const id = Number(found.getAttribute(SHELL_NODE_ATTRIBUTE)!.slice(this.key.length + 1));
    return Number.isFinite(id) ? id : null;
  }
}

/** An element SoftN drew, as an event's target or one of its ancestors: tag, attributes, text, a field's state. */
export interface SeenElement {
  t: string;
  a: Record<string, string>;
  x: string;
  v?: string;
  k?: boolean;
}

/** How far up from an event's target an island's elements are seen. */
const MAX_SEEN = 32;
/** How much of an element's text, and of an attribute's value, is seen. */
const MAX_SEEN_TEXT = 2000;

function seenElement(element: Element): SeenElement {
  const a: Record<string, string> = {};
  for (let i = 0; i < element.attributes.length && i < 40; i++) {
    const attribute = element.attributes[i];
    if (attribute.name === SHELL_NODE_ATTRIBUTE || attribute.name === 'style') continue;
    a[attribute.name] = attribute.value.slice(0, MAX_SEEN_TEXT);
  }
  const seen: SeenElement = { t: element.tagName.toLowerCase(), a, x: (element.textContent ?? '').slice(0, MAX_SEEN_TEXT) };
  const field = element as HTMLInputElement;
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') seen.v = field.value;
  if (element.tagName === 'INPUT' && (field.type === 'checkbox' || field.type === 'radio')) seen.k = field.checked;
  return seen;
}

/** Event types that bubble; the rest are heard on their way down. */
const BUBBLES = new Set([
  'click', 'dblclick', 'contextmenu', 'input', 'change', 'submit', 'reset', 'keydown', 'keyup', 'keypress',
  'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'pointerdown', 'pointerup', 'pointermove',
  'pointerover', 'pointerout', 'wheel', 'focusin', 'focusout', 'touchstart', 'touchend', 'touchmove',
  'dragstart', 'dragover', 'drop', 'dragend', 'copy', 'paste', 'cut', 'beforeinput',
]);

/** What a script is told of an event, besides where it happened. */
function eventData(event: Event): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const e = event as Event & Partial<KeyboardEvent & MouseEvent & InputEvent & WheelEvent>;
  for (const key of [
    'key', 'code', 'repeat', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'clientX', 'clientY', 'pageX', 'pageY',
    'offsetX', 'offsetY', 'screenX', 'screenY', 'button', 'buttons', 'deltaX', 'deltaY', 'deltaMode', 'data',
    'inputType', 'detail',
  ] as const) {
    const value = e[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/** The attributes an element is written with, as the page's code reads them. */
function writtenAttributes(node: ElementNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const prop of node.props) {
    if (prop.name.includes(':') || prop.name.startsWith('@')) continue;
    const name = attributeName(prop.name);
    const value = prop.value;
    if (value.type === 'static') out[name] = value.value;
    else if (value.type === 'number') out[name] = String(value.value);
    else if (value.type === 'boolean' && value.value) out[name] = '';
  }
  return out;
}

/** The attributes of a markup element SoftN draws from a `{value}`, as HTML names them. */
function drawnAttributes(node: ElementNode): string[] {
  const names = new Set<string>();
  for (const prop of node.props) {
    if (prop.value.type !== 'expression' || prop.name.startsWith('@') || /^on/i.test(prop.name)) continue;
    names.add(attributeName(prop.name.startsWith('class:') ? 'class' : prop.name.startsWith('style:') ? 'style' : prop.name));
  }
  for (const binding of node.bindings) {
    if (binding.name === 'class' || binding.name === 'className' || binding.name === 'style') names.add(attributeName(binding.name));
  }
  return [...names];
}

/** An attribute's name as HTML has it: `className` is `class`, `htmlFor` is `for`. */
function attributeName(name: string): string {
  if (name === 'className') return 'class';
  if (name === 'htmlFor') return 'for';
  return name.toLowerCase();
}

function staticProp(name: string, value: string, loc: SourceLocation): PropNode {
  return { type: 'Prop', name, value: { type: 'static', value }, loc };
}
