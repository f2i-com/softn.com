/**
 * The nodes the page keeps for an app, by the id the app's document knows each by.
 *
 * The document tells the page of a node when it joins the page and never says it has left.
 * Every node an app ever showed was kept, so an app that makes and drops nodes for as long
 * as it runs came to the most nodes a page may have (200,000) and drew nothing new after
 * that. The page now forgets the nodes that are no longer on it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ContainerArchive } from '../src/archive';
import { HostDomPatcher } from '../src/dom-patcher';
import type { ShellOp } from '../src/types';

async function patcher(sweepNodesEvery: number, warnings: string[] = []) {
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
    sweepNodesEvery,
    callbacks: { onEvent: () => undefined, onSync: () => undefined, onWarning: (text) => warnings.push(text) },
  });
  made.nodes.set(0, docRootEl);
  made.nodes.set(1, viewportEl);
  return { made, viewportEl, host, archive };
}

describe('the nodes the page keeps for an app', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('are let go once they are off the app’s page, so an app that makes and drops nodes for as long as it runs keeps drawing', async () => {
    const { made, viewportEl, archive } = await patcher(50);
    let next = 10;
    // A list of ten rows, made again from new nodes two hundred times over: 6,000 nodes in all.
    for (let round = 0; round < 200; round++) {
      const ops: ShellOp[] = [];
      const rows: number[] = [];
      for (let row = 0; row < 10; row++) {
        const li = next++;
        const text = next++;
        const span = next++;
        ops.push(['e', li, 'li', { class: 'row' }], ['e', span, 'span', {}], ['x', text, `row ${round}.${row}`], ['c', span, [text]], ['c', li, [span]]);
        rows.push(li);
      }
      ops.push(['c', 1, rows]);
      made.applyOps(ops);
    }
    // What is on the page is the last ten rows, as told.
    expect(viewportEl.querySelectorAll('li').length).toBe(10);
    expect(viewportEl.querySelector('li')?.textContent).toBe('row 199.0');
    // And the page holds a few rounds' nodes, not all 6,000.
    expect(made.nodes.size).toBeLessThan(400);
    // A node still on the page is still known: its text can be changed.
    made.applyOps([['x', next - 2, 'changed']]);
    expect(viewportEl.querySelectorAll('li')[9].textContent).toBe('changed');
    made.dispose();
    archive.dispose();
  });

  it('keeps what is off the page on purpose or only for now: a stylesheet’s text, and a node told in one batch and placed in the next', async () => {
    const { made, viewportEl, archive } = await patcher(4);
    // A stylesheet's text is never put on the page as a node: the page writes the sheet itself.
    made.applyOps([['e', 10, 'style', {}], ['x', 11, 'p { color: rgb(1, 2, 3) }'], ['c', 10, [11]], ['e', 12, 'p', {}], ['c', 1, [10, 12]]]);
    // A node told now and placed two batches on, with other nodes coming and going between.
    made.applyOps([['e', 20, 'div', { id: 'late' }], ['e', 21, 'i', {}], ['e', 22, 'i', {}], ['e', 23, 'i', {}], ['e', 24, 'i', {}]]);
    made.applyOps([['e', 30, 'b', {}], ['e', 31, 'b', {}], ['e', 32, 'b', {}], ['e', 33, 'b', {}], ['c', 1, [10, 12, 20]]]);
    expect(viewportEl.querySelector('#late')).not.toBeNull();
    for (let id = 40; id < 80; id += 4) made.applyOps([['e', id, 'u', {}], ['e', id + 1, 'u', {}], ['e', id + 2, 'u', {}], ['e', id + 3, 'u', {}]]);
    // The sheet's text is still the sheet's: changed, the sheet is written again.
    made.applyOps([['x', 11, 'p { color: rgb(4, 5, 6) }']]);
    expect(viewportEl.querySelector('style')?.textContent).toContain('rgb(4, 5, 6)');
    // What was never placed is gone; what is on the page is not.
    expect(made.nodes.has(21)).toBe(false);
    expect(made.nodes.has(20)).toBe(true);
    expect(made.nodes.has(12)).toBe(true);
    made.dispose();
    archive.dispose();
  });

  it('keeps a canvas and an image off the page that the app still draws with', async () => {
    // A buffer canvas the app draws on and copies from each frame, and a sprite sheet it
    // draws from, neither on the page: the sweep let them go, and the page drew nothing.
    const { made, viewportEl, archive } = await patcher(20);
    made.applyOps([['e', 5000, 'canvas', { width: '8', height: '8' }], ['e', 5001, 'img', {}], ['e', 10, 'canvas', {}], ['c', 1, [10]]]);
    let next = 100;
    for (let frame = 0; frame < 60; frame++) {
      const ops: ShellOp[] = [
        ['k2d', 5000, 8, 8, [['fillRect', 0, 0, 8, 8]]],
        ['k2d', 10, 300, 150, [['drawImage', 'node:5000', 0, 0], ['drawImage', 'node:5001', 0, 0]]],
      ];
      // And the churn that sets the sweep going.
      for (let i = 0; i < 10; i++) ops.push(['e', next++, 'p', {}]);
      made.applyOps(ops);
    }
    expect(made.nodes.has(5000)).toBe(true);
    expect(made.nodes.has(5001)).toBe(true);
    expect(viewportEl.querySelector('canvas')).not.toBeNull();
    // What the app made and never placed or drew with is gone, as before.
    expect(made.nodes.has(100)).toBe(false);
    made.dispose();
    archive.dispose();
  });

  it('has a canvas of its own for one of the app’s on no page, and keeps a canvas’s element when it is told again', async () => {
    // The app's document tells the page of a node when it joins the page: a buffer canvas
    // never does, and the page drew nothing on it and nothing from it. And an element told
    // again (it moved) was made again: a canvas came back blank.
    const { made, viewportEl, archive } = await patcher(1000);
    made.applyOps([['e', 10, 'canvas', { id: 'shown', width: '4', height: '4' }], ['c', 1, [10]]]);
    made.applyOps([['k2d', 20, 4, 4, [['fillRect', 0, 0, 4, 4]]], ['k2d', 10, 4, 4, [['drawImage', 'node:20', 0, 0]]]]);
    const buffer = made.nodes.get(20);
    expect(buffer).toBeInstanceOf(HTMLCanvasElement);
    expect((buffer as HTMLCanvasElement).isConnected).toBe(false);
    // Put on the page later: the canvas drawn on is the one shown.
    made.applyOps([['e', 20, 'canvas', { width: '4', height: '4', class: 'layer' }], ['c', 1, [10, 20]]]);
    expect(made.nodes.get(20)).toBe(buffer);
    expect(viewportEl.querySelector('.layer')).toBe(buffer);
    // Moved: told again with what it has now, it is the same canvas, and keeps nothing it no longer has.
    const shown = made.nodes.get(10);
    made.applyOps([['e', 10, 'canvas', { width: '4', height: '4' }], ['e', 30, 'div', { id: 'box' }], ['c', 30, [10]], ['c', 1, [30, 20]]]);
    expect(made.nodes.get(10)).toBe(shown);
    expect(viewportEl.querySelector('#box canvas')).toBe(shown);
    expect((shown as HTMLCanvasElement).hasAttribute('id')).toBe(false);
    expect((shown as HTMLCanvasElement).getAttribute('data-softn-id')).toBe('10');
    made.dispose();
    archive.dispose();
  });

  it('does not clear a canvas drawn on off the page when it is put on the page at the default size', async () => {
    // At 300 by 150 the page never wrote its size; put on the page with width="300", it was
    // given that attribute, and setting a canvas's size clears it.
    const { made, archive } = await patcher(1000);
    made.applyOps([['k2d', 40, 300, 150, [['fillRect', 0, 0, 1, 1]]]]);
    const canvas = made.nodes.get(40) as HTMLCanvasElement;
    const sizesSet: string[] = [];
    const plain = canvas.setAttribute.bind(canvas);
    canvas.setAttribute = (name: string, value: string) => {
      if (name === 'width' || name === 'height') sizesSet.push(`${name}=${value}`);
      plain(name, value);
    };
    made.applyOps([['e', 40, 'canvas', { width: '300', height: '150', id: 'adopted' }], ['c', 1, [40]]]);
    expect(made.nodes.get(40)).toBe(canvas);
    expect(sizesSet).toEqual([]);
    expect(canvas.id).toBe('adopted');
    // A size it does not have is set.
    made.applyOps([['e', 40, 'canvas', { width: '600', height: '150' }]]);
    expect(sizesSet).toEqual(['width=600']);
    made.dispose();
    archive.dispose();
  });

  it('lets go of a canvas on no page when the app lets go of it, and keeps those it has within a budget', async () => {
    const warnings: string[] = [];
    const { made, archive } = await patcher(100_000, warnings);
    made.applyOps([['e', 10, 'canvas', {}], ['c', 1, [10]], ['k2d', 20, 4, 4, [['fillRect', 0, 0, 1, 1]]]]);
    expect(made.nodes.get(20)).toBeInstanceOf(HTMLCanvasElement);
    // The app's side says when it can no longer reach one: on no page, it is let go of.
    made.applyOps([['k2dgone', 20], ['k2dgone', 10]]);
    expect(made.nodes.has(20)).toBe(false);
    // One on the page is the page's to keep.
    expect(made.nodes.has(10)).toBe(true);
    // Past the budget (64 million pixels: four of these), the least lately drawn on goes first, said once.
    const side = 4096;
    for (let id = 30; id < 35; id++) made.applyOps([['k2d', id, side, side, [['fillRect', 0, 0, 1, 1]]]]);
    expect([30, 31, 32, 33, 34].map((id) => made.nodes.has(id))).toEqual([false, true, true, true, true]);
    // Drawn on again, it is made again (blank), and the one least lately drawn on now goes.
    made.applyOps([['k2d', 30, side, side, [['fillRect', 0, 0, 1, 1]]]]);
    expect([30, 31, 32, 33, 34].map((id) => made.nodes.has(id))).toEqual([true, false, true, true, true]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('let go of a canvas the app had not drawn on lately');
    made.dispose();
    archive.dispose();
  });

  it('forgets nothing while the app’s page is itself on no page', async () => {
    const { made, host, archive } = await patcher(4);
    host.remove();
    for (let id = 10; id < 60; id += 5) made.applyOps([['e', id, 'p', {}], ['e', id + 1, 'p', {}], ['e', id + 2, 'p', {}], ['e', id + 3, 'p', {}], ['e', id + 4, 'p', {}]]);
    // Fifty of the app's, and the page's own three: its scroller, its body and its head.
    expect(made.nodes.size).toBe(53);
    made.dispose();
    archive.dispose();
  });
});
