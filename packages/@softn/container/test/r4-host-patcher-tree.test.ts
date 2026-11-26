/**
 * Round 4: the app's tree as the page applies it, turn by turn.
 *
 * - `focus()` waits for the turn's tree to be in place (a field is focused once it is on the
 *   page); `blur()` did not, so `el.focus(); el.blur()` in one turn blurred first and focused
 *   after: the page left the field focused that the app's document had just blurred.
 * - The app's document tells the page of an element again when it moves (a keyed list
 *   reordered), and the page makes it again. The focused field of a row that moved lost the
 *   focus on the page while the app's document still had it there (so React, which puts the
 *   focus back after a commit when it has gone, saw nothing to do): what the person typed next
 *   went nowhere.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ContainerArchive } from '../src/archive';
import { HostDomPatcher } from '../src/dom-patcher';
import type { ShellOp } from '../src/types';

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
  return { made, page, viewportEl, archive };
}

/** A list of two rows, the first with a field: ids 10 (the list), 11 and 13 (rows), 12 (the field). */
const LIST: ShellOp[] = [
  ['e', 10, 'ul', {}],
  ['e', 11, 'li', {}],
  ['e', 12, 'input', { type: 'text' }],
  ['c', 11, [12]],
  ['e', 13, 'li', {}],
  ['e', 14, 'input', { type: 'text', id: 'other' }],
  ['c', 13, [14]],
  ['c', 10, [11, 13]],
  ['c', 1, [10]],
];

/** The first row told again at the end of the list, as the app's document tells a move. */
const MOVE_FIRST_ROW: ShellOp[] = [
  ['e', 11, 'li', {}],
  ['e', 12, 'input', { type: 'text' }],
  ['p', 12, 'value', 'hello world'],
  ['c', 11, [12]],
  ['c', 10, [13, 11]],
];

describe('the app’s tree, applied (round 4)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('blurs after it focuses when the app’s script did both in one turn', async () => {
    const { made, page, viewportEl, archive } = await patcher();
    made.applyOps(LIST);
    const field = viewportEl.querySelector('input')!;
    made.applyOps([['p', 12, 'focus', true], ['p', 12, 'blur', true]] as ShellOp[]);
    expect(page.activeElement).not.toBe(field);
    // And the other way round, it ends focused.
    made.applyOps([['p', 12, 'blur', true], ['p', 12, 'focus', true]] as ShellOp[]);
    expect(page.activeElement).toBe(field);
    made.dispose();
    archive.dispose();
  });

  it('keeps the focus, and where the caret was, on a focused field whose row moved', async () => {
    const { made, page, viewportEl, archive } = await patcher();
    made.applyOps(LIST);
    const field = viewportEl.querySelector('input')!;
    field.focus();
    field.value = 'hello world';
    field.setSelectionRange(2, 5);
    expect(page.activeElement).toBe(field);
    made.applyOps(MOVE_FIRST_ROW);
    const moved = viewportEl.querySelector('li:last-child input') as HTMLInputElement;
    // Made again, as an element told again is, and where the app put it.
    expect(moved).not.toBe(field);
    expect(moved.value).toBe('hello world');
    expect(page.activeElement).toBe(moved);
    expect([moved.selectionStart, moved.selectionEnd]).toEqual([2, 5]);
    made.dispose();
    archive.dispose();
  });

  it('puts the focus back once the moved field is on the page, when the move comes in two batches', async () => {
    const { made, page, viewportEl, archive } = await patcher();
    made.applyOps(LIST);
    const field = viewportEl.querySelector('input')!;
    field.focus();
    // The elements told in one batch, placed in the next (a turn's operations sent in parts).
    made.applyOps(MOVE_FIRST_ROW.slice(0, 3));
    expect(page.activeElement).toBe(field);
    made.applyOps(MOVE_FIRST_ROW.slice(3));
    const moved = viewportEl.querySelector('li:last-child input') as HTMLInputElement;
    expect(moved).not.toBe(field);
    expect(page.activeElement).toBe(moved);
    made.dispose();
    archive.dispose();
  });

  it('mutes a video or an audio element made with the `muted` attribute, as one the page’s parser makes is', async () => {
    // Set on an element made by script, the attribute sets only `defaultMuted`: a background
    // `<video autoplay muted loop>` was not muted, and a browser does not start one with sound.
    const { made, viewportEl, archive } = await patcher();
    made.applyOps([['e', 10, 'video', { autoplay: '', muted: '', loop: '' }], ['e', 11, 'audio', {}], ['c', 1, [10, 11]]] as ShellOp[]);
    const video = viewportEl.querySelector('video')!;
    expect(video.muted).toBe(true);
    expect(viewportEl.querySelector('audio')!.muted).toBe(false);
    made.dispose();
    archive.dispose();
  });

  it('writes a stylesheet of a shadow tree once a batch, and again only when the app declared a font it may name', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const docRootEl = document.createElement('div');
    const viewportEl = document.createElement('div');
    docRootEl.append(viewportEl);
    host.attachShadow({ mode: 'open' }).appendChild(docRootEl);
    const archive = await ContainerArchive.open({ 'index.html': '<!doctype html><p>x</p>' });
    const writes = new Map<Element, number>();
    const made = new HostDomPatcher({
      viewportEl,
      docRootEl,
      archive,
      entryPath: 'index.html',
      permissions: {},
      netGranted: false,
      fontScope: { prefix: 'app1-', families: new Set<string>() },
      callbacks: { onEvent: () => undefined, onSync: () => undefined, onStyleFonts: (sheet) => writes.set(sheet, (writes.get(sheet) ?? 0) + 1) },
    });
    made.nodes.set(0, docRootEl);
    made.nodes.set(1, viewportEl);
    // Two components, the first naming a font the second's sheet declares.
    made.applyOps([
      ['e', 10, 'x-a', {}], ['sr', 10, 11], ['e', 12, 'style', {}], ['x', 13, ':host { display: block } .t { font-family: Brand, sans-serif }'], ['c', 12, [13]], ['c', 11, [12]],
      ['e', 20, 'x-b', {}], ['sr', 20, 21], ['e', 22, 'style', {}], ['x', 23, '@font-face { font-family: Brand; src: url(data:font/woff2;base64,AAAA) }'], ['c', 22, [23]], ['c', 21, [22]],
      ['c', 1, [10, 20]],
    ] as ShellOp[]);
    const first = viewportEl.querySelector('x-a')!.shadowRoot!.querySelector('style')!;
    const second = viewportEl.querySelector('x-b')!.shadowRoot!.querySelector('style')!;
    // A shadow tree's own: `:host` kept; and the font it names is the app's, by its scoped name.
    expect(first.textContent).toContain(':host');
    expect(first.textContent).toContain('app1-Brand');
    // The first read again for the font the second declared; the second once.
    expect(writes.get(first)).toBe(2);
    expect(writes.get(second)).toBe(1);
    // Changed again, with nothing new declared: written once.
    made.applyOps([['x', 13, ':host { display: flex } .t { font-family: Brand }']] as ShellOp[]);
    expect(writes.get(first)).toBe(3);
    expect(first.textContent).toContain('flex');
    made.dispose();
    archive.dispose();
  });

  it('gives the focus to what the app’s script focused, or to nothing it blurred, in the turn a focused field moved', async () => {
    const { made, page, viewportEl, archive } = await patcher();
    made.applyOps(LIST);
    viewportEl.querySelector('input')!.focus();
    made.applyOps([...MOVE_FIRST_ROW, ['p', 14, 'focus', true]] as ShellOp[]);
    expect(page.activeElement).toBe(viewportEl.querySelector('#other'));
    // The other row's field moves in the turn the app blurs it: nothing has the focus.
    made.applyOps([['e', 13, 'li', {}], ['e', 14, 'input', { type: 'text', id: 'other' }], ['c', 13, [14]], ['c', 10, [13, 11]], ['p', 14, 'blur', true]] as ShellOp[]);
    expect(page.activeElement).toBeNull();
    // A field that did not have the focus is not given it for moving.
    made.applyOps([['e', 13, 'li', {}], ['e', 14, 'input', { type: 'text', id: 'other' }], ['c', 13, [14]], ['c', 10, [11, 13]]] as ShellOp[]);
    expect(page.activeElement).toBeNull();
    made.dispose();
    archive.dispose();
  });
});
