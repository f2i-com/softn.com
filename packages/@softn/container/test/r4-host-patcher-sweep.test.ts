/**
 * Round 4: the shadow trees the page lets go of.
 *
 * Every 256 new shadow trees, the page lets go of those whose element is off its page. It did
 * so the first time it found one there, and took the element out of its table with it, while
 * the nodes' own sweep waits for the second time (a batch can end between a node's being
 * told and its being placed: a turn of more operations than one message carries comes in
 * several). Elements with shadow trees told in one batch and placed in the next were never
 * placed. And the element let go of was not let go of everywhere: the page's ResizeObserver
 * kept observing it, and its measurements were kept.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContainerArchive } from '../src/archive';
import { HostDomPatcher } from '../src/dom-patcher';
import type { ShellOp } from '../src/types';

/** What the page's ResizeObserver observes now. */
const observed = new Set<Element>();
class RecordingResizeObserver {
  observe(el: Element) {
    observed.add(el);
  }
  unobserve(el: Element) {
    observed.delete(el);
  }
  disconnect() {
    observed.clear();
  }
}

async function patcher() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const page = host.attachShadow({ mode: 'open' });
  const docRootEl = document.createElement('div');
  const headEl = document.createElement('div');
  const viewportEl = document.createElement('div');
  docRootEl.append(headEl, viewportEl);
  page.appendChild(docRootEl);
  const archive = await ContainerArchive.open({ 'index.html': '<!doctype html><p>x</p>' });
  const made = new HostDomPatcher({
    viewportEl,
    docRootEl,
    headEl,
    archive,
    entryPath: 'index.html',
    permissions: {},
    netGranted: false,
    callbacks: { onEvent: () => undefined, onSync: () => undefined },
  });
  made.nodes.set(0, docRootEl);
  made.nodes.set(1, viewportEl);
  return { made, viewportEl, archive };
}

/** `count` elements, each with a shadow tree holding a text: element ids from `first` (step 3). */
function components(first: number, count: number): { ops: ShellOp[]; ids: number[] } {
  const ops: ShellOp[] = [];
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const id = first + i * 3;
    ops.push(['e', id, 'x-card', {}], ['sr', id, id + 1], ['x', id + 2, `card ${i}`], ['c', id + 1, [id + 2]]);
    ids.push(id);
  }
  return { ops, ids };
}

describe('the shadow trees the page lets go of (round 4)', () => {
  const realResizeObserver = globalThis.ResizeObserver;
  beforeEach(() => {
    observed.clear();
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = RecordingResizeObserver;
  });
  afterEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realResizeObserver;
    document.body.innerHTML = '';
  });

  it('keeps an element with a shadow tree that is told in one batch and placed in the next', async () => {
    const { made, viewportEl, archive } = await patcher();
    const { ops, ids } = components(1000, 300);
    // The first part of a long turn: the elements and their trees, and the children of one
    // element placed already (the tree changed), but not yet the list that holds them.
    made.applyOps([['e', 10, 'ul', {}], ...ops, ['c', 1, [10]]]);
    made.applyOps([['c', 10, ids]]);
    const cards = viewportEl.querySelectorAll('x-card');
    expect(cards.length).toBe(300);
    expect(cards[299].shadowRoot?.textContent).toBe('card 299');
    made.dispose();
    archive.dispose();
  });

  it('keeps loading pictures on no page past 2048 of them, letting go of the one least lately asked for', async () => {
    // `new Image()` for each tile of a map, each sprite of a game: the page kept every one it
    // had loaded, and past 2048 it loaded none at all (each was said to have failed).
    const host = document.createElement('div');
    document.body.appendChild(host);
    const docRootEl = document.createElement('div');
    const viewportEl = document.createElement('div');
    docRootEl.append(viewportEl);
    host.attachShadow({ mode: 'open' }).appendChild(docRootEl);
    const archive = await ContainerArchive.open({ 'index.html': '<!doctype html><p>x</p>' });
    const answered: string[] = [];
    const made = new HostDomPatcher({
      viewportEl,
      docRootEl,
      archive,
      entryPath: 'index.html',
      permissions: {},
      netGranted: false,
      callbacks: {
        onEvent: (_id, type, props) => {
          if (type === 'softn:image') answered.push(String(props.token));
        },
        onSync: () => undefined,
      },
    });
    // Loaded, every one of them (jsdom loads no picture).
    const complete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete')!;
    Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });
    try {
      const src = (i: number) => `data:image/png;base64,${btoa(`picture ${i}`)}`;
      for (let i = 0; i < 2048; i++) made.applyOps([['img', `t${i}`, src(i)]]);
      expect(answered).toEqual([]);
      // Asked for again: the one kept, answered at once.
      made.applyOps([['img', 'again0', src(0)]]);
      expect(answered).toEqual(['again0']);
      // One more: loaded (not refused at once), in the place of the one least lately asked for (1).
      made.applyOps([['img', 'new', src(2048)]]);
      expect(answered).toEqual(['again0']);
      made.applyOps([['img', 'again1', src(1)], ['img', 'again0b', src(0)]]);
      expect(answered).toEqual(['again0', 'again0b']);
    } finally {
      Object.defineProperty(HTMLImageElement.prototype, 'complete', complete);
      made.dispose();
      archive.dispose();
    }
  });

  it('lets go of an element off the page with its shadow tree everywhere, its observation too', async () => {
    const { made, viewportEl, archive } = await patcher();
    // A measured element with a shadow tree, on the page and then off it for good.
    made.applyOps([['e', 10, 'x-panel', {}], ['sr', 10, 11], ['c', 1, [10]], ['p', 10, 'measure', true]]);
    const panel = viewportEl.querySelector('x-panel')!;
    expect(observed.has(panel)).toBe(true);
    made.applyOps([['c', 1, []]]);
    // Enough new shadow trees, twice over, for the sweep to come round to it.
    for (let round = 0; round < 3; round++) {
      const { ops, ids } = components(10_000 + round * 1000, 260);
      made.applyOps([['e', 20 + round, 'div', {}], ...ops, ['c', 20 + round, ids], ['c', 1, [20 + round]]]);
    }
    expect(made.nodes.has(10)).toBe(false);
    expect(observed.has(panel)).toBe(false);
    made.dispose();
    archive.dispose();
  });
});
