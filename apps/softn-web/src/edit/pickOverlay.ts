/**
 * What the runtime draws over a running app while a person picks an element
 * of it to edit: a sheet over the app's box that takes the press, and the
 * outlines of what is under the pointer and of what is picked.
 *
 * All of it is the runtime's. The sheet is an element of the runtime's own,
 * laid over the app's box from outside it; the press is taken by the sheet
 * and never reaches the app, so the app is told nothing and does nothing;
 * and the outlines are the sheet's, so nothing of the app's is restyled.
 * Which element is under the pointer is asked of the browser
 * (`elementsFromPoint`), and what drew it of the renderer's notes.
 *
 * "Never reaches the app" is every part of a press, not its click alone. An
 * app's logic may listen on its window (a game listens there for
 * `pointerdown`), and the runtime hands such a listener every pointer event
 * that comes up to the window while the app is on screen (core's
 * window-bridge.ts). So while picking, everything of the pointer's that is
 * aimed at the sheet stops at the sheet: a press, its release, a move, a
 * touch, a wheel. The app does not fire, and cannot tell that a pick is
 * being made over it.
 */

/** Everything a pointer, a finger or a wheel sends to what is under it. */
const POINTER_FAMILY = [
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointercancel',
  'pointerover',
  'pointerout',
  'gotpointercapture',
  'lostpointercapture',
  'mousedown',
  'mouseup',
  'mousemove',
  'mouseover',
  'mouseout',
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
  'click',
  'dblclick',
  'contextmenu',
  'auxclick',
  'wheel',
  'dragstart',
  'dragover',
  'drop',
] as const;

export interface PickOverlayOptions {
  /** Where the sheet is put: an element of the runtime's, outside every app's box. */
  mount: HTMLElement;
  /** The app's box, as it is now; null while the app is not drawn. */
  box: () => HTMLElement | null;
  /** The elements that pressing on `target` would pick: what drew it drew these. Null for something that cannot be picked. */
  outlineFor: (target: Element) => Element[] | null;
  /** A press on `target`, an element of the app. */
  onPick: (target: Element) => void;
}

const OUTLINES = 24;

export class PickOverlay {
  private readonly sheet: HTMLDivElement;
  private readonly hover: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private readonly picked: HTMLDivElement[] = [];
  private picking = false;
  private selection: Element[] = [];
  private selectionLabel = '';
  private under: Element | null = null;
  private frame = 0;
  private gone = false;

  constructor(private readonly options: PickOverlayOptions) {
    const make = (name: string): HTMLDivElement => {
      const element = document.createElement('div');
      element.className = name;
      return element;
    };
    this.sheet = make('softn-edit-sheet');
    this.sheet.setAttribute('aria-hidden', 'true');
    // The runtime's own, said to core as well: what the sheet does not stop itself is still not the app's.
    this.sheet.setAttribute('data-softn-host', '');
    this.hover = make('softn-edit-outline softn-edit-outline--hover');
    this.label = make('softn-edit-outline-label');
    this.sheet.append(this.hover, this.label);
    this.sheet.addEventListener('pointermove', this.onMove);
    this.sheet.addEventListener('pointerleave', this.onLeave);
    this.sheet.addEventListener('click', this.onClick);
    this.sheet.addEventListener('wheel', this.onWheel, { passive: true });
    for (const type of POINTER_FAMILY) this.sheet.addEventListener(type, this.keep);
    options.mount.appendChild(this.sheet);
    this.frame = requestAnimationFrame(this.draw);
  }

  /** Whether a press on the app picks an element (and does not reach the app). */
  setPicking(on: boolean): void {
    this.picking = on;
    this.sheet.classList.toggle('softn-edit-sheet--picking', on);
    if (!on) this.under = null;
  }

  /** What is picked: outlined until this is called again. */
  setSelection(elements: Element[], label: string): void {
    this.selection = elements;
    this.selectionLabel = label;
  }

  destroy(): void {
    this.gone = true;
    cancelAnimationFrame(this.frame);
    this.sheet.remove();
  }

  /** The app's element at a point of the window, under the sheet. */
  private appElementAt(x: number, y: number): Element | null {
    const box = this.options.box();
    if (!box) return null;
    for (const element of document.elementsFromPoint(x, y)) {
      if (element !== box && box.contains(element)) return element;
    }
    return null;
  }

  /**
   * While picking, what the pointer sends the sheet goes no further: not up
   * to the window, where an app's own listeners are. The start of a press
   * also takes nothing by default: the app's focused field keeps the focus,
   * and is told of no blur. The click that follows a press still comes, and
   * is the pick.
   */
  private keep = (event: Event): void => {
    if (!this.picking) return;
    event.stopPropagation();
    if (event.type === 'pointerdown' || event.type === 'mousedown' || event.type === 'contextmenu' || event.type === 'dragstart') event.preventDefault();
  };

  private onMove = (event: PointerEvent): void => {
    if (this.picking) this.under = this.appElementAt(event.clientX, event.clientY);
  };

  private onLeave = (): void => {
    this.under = null;
  };

  private onClick = (event: MouseEvent): void => {
    if (!this.picking) return;
    event.preventDefault();
    event.stopPropagation();
    const target = this.appElementAt(event.clientX, event.clientY);
    if (target) this.options.onPick(target);
  };

  /** The sheet is over the app, so the wheel is handed on to what would have scrolled. */
  private onWheel = (event: WheelEvent): void => {
    const box = this.options.box();
    for (let element = this.appElementAt(event.clientX, event.clientY); element && box?.contains(element); element = element.parentElement) {
      const style = getComputedStyle(element);
      const scrolls = /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
      if (scrolls) {
        element.scrollBy(event.deltaX, event.deltaY);
        return;
      }
    }
  };

  private place(outline: HTMLElement, rect: DOMRect | null, within: DOMRect): void {
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      outline.style.display = 'none';
      return;
    }
    const left = Math.max(rect.left, within.left);
    const top = Math.max(rect.top, within.top);
    const right = Math.min(rect.right, within.right);
    const bottom = Math.min(rect.bottom, within.bottom);
    if (right <= left || bottom <= top) {
      outline.style.display = 'none';
      return;
    }
    outline.style.display = 'block';
    outline.style.left = `${left - within.left}px`;
    outline.style.top = `${top - within.top}px`;
    outline.style.width = `${right - left}px`;
    outline.style.height = `${bottom - top}px`;
  }

  private draw = (): void => {
    if (this.gone) return;
    this.frame = requestAnimationFrame(this.draw);
    const box = this.options.box();
    const within = box?.getBoundingClientRect();
    if (!box || !within || within.width === 0 || (!this.picking && this.selection.length === 0)) {
      this.sheet.style.display = 'none';
      return;
    }
    this.sheet.style.display = 'block';
    this.sheet.style.left = `${within.left}px`;
    this.sheet.style.top = `${within.top}px`;
    this.sheet.style.width = `${within.width}px`;
    this.sheet.style.height = `${within.height}px`;

    const hovered = this.picking && this.under?.isConnected ? this.options.outlineFor(this.under) : null;
    this.place(this.hover, hovered && hovered.length > 0 ? union(hovered) : null, within);

    const shown = this.selection.filter((element) => element.isConnected).slice(0, OUTLINES);
    while (this.picked.length < shown.length) {
      const outline = document.createElement('div');
      outline.className = 'softn-edit-outline softn-edit-outline--picked';
      this.sheet.insertBefore(outline, this.label);
      this.picked.push(outline);
    }
    this.picked.forEach((outline, index) => this.place(outline, shown[index]?.getBoundingClientRect() ?? null, within));

    const first = shown[0]?.getBoundingClientRect();
    if (first && this.selectionLabel && first.bottom > within.top && first.top < within.bottom) {
      this.label.textContent = this.selectionLabel;
      this.label.style.display = 'block';
      this.label.style.left = `${Math.max(0, Math.min(first.left - within.left, within.width - 80))}px`;
      this.label.style.top = `${Math.max(0, first.top - within.top - 20)}px`;
    } else {
      this.label.style.display = 'none';
    }
  };
}

/** The one rectangle around several elements. */
function union(elements: Element[]): DOMRect | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  return right > left && bottom > top ? new DOMRect(left, top, right - left, bottom - top) : null;
}
