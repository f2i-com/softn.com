/**
 * Round 4: what the page tells the app's script of an event the person made.
 *
 * - A touch event's points (`touches`, `targetTouches`, `changedTouches`) were never told:
 *   a touch event has no `clientX` of its own, so the app's handler got none of them and
 *   `e.touches[0].clientX` threw in every touch handler.
 * - `movementX`/`movementY` (a drag's or a pointer-locked look's deltas) and a key's
 *   `keyCode`/`which`/`charCode`/`location` were never told either: code that reads them got
 *   `undefined`.
 * - A radio button the person picked told the app's document only that it was now checked: the
 *   one of its group that had been checked stayed checked there, so `:checked`, the group's
 *   value and a FormData of the form read both.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ContainerArchive } from '../src/archive';
import { HostDomPatcher } from '../src/dom-patcher';
import type { ShellOp } from '../src/types';

interface Heard {
  nodeId: number;
  type: string;
  props: Record<string, unknown>;
  sync: unknown[];
  answered?: (eventBits: number) => void;
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
  const heard: Heard[] = [];
  const synced: unknown[][] = [];
  const made = new HostDomPatcher({
    viewportEl,
    docRootEl,
    headEl,
    archive,
    entryPath: 'index.html',
    permissions: {},
    netGranted: false,
    callbacks: {
      onEvent: (nodeId, type, props, sync, answered) => heard.push({ nodeId, type, props, sync, answered }),
      onSync: (changes) => synced.push(changes),
    },
  });
  made.nodes.set(0, docRootEl);
  made.nodes.set(1, viewportEl);
  return { made, viewportEl, docRootEl, archive, heard, synced };
}

/** A touch point as a browser's Touch reads. */
function point(identifier: number, clientX: number, clientY: number, target: EventTarget) {
  return { identifier, clientX, clientY, pageX: clientX, pageY: clientY, screenX: clientX + 500, screenY: clientY + 300, radiusX: 4, radiusY: 5, rotationAngle: 0, force: 0.5, target };
}

/** A list of touch points, as a TouchList reads: by index, `length` and `item()`. */
function touchList(points: ReturnType<typeof point>[]) {
  const list: Record<string, unknown> = { length: points.length, item: (i: number) => points[i] ?? null };
  points.forEach((p, i) => (list[i] = p));
  return list;
}

function touchEvent(type: string, touches: ReturnType<typeof point>[], changed: ReturnType<typeof point>[]): Event {
  const e = new TouchEvent(type, { bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(e, 'touches', { value: touchList(touches) });
  Object.defineProperty(e, 'targetTouches', { value: touchList(touches) });
  Object.defineProperty(e, 'changedTouches', { value: touchList(changed) });
  return e;
}

describe('what the page tells the app of an event (round 4)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('tells a touch event’s points, from the corner of the app’s box', async () => {
    const { made, viewportEl, docRootEl, archive, heard } = await patcher();
    made.applyOps([['e', 10, 'div', { id: 'pad' }], ['c', 1, [10]], ['l', 'touchstart'], ['l', 'touchend']] as ShellOp[]);
    const pad = viewportEl.querySelector('#pad')!;
    // The app's box is 40 by 25 from the window's corner.
    docRootEl.getBoundingClientRect = () => ({ left: 40, top: 25, right: 440, bottom: 325, width: 400, height: 300, x: 40, y: 25, toJSON: () => ({}) });
    const first = point(7, 140, 125, pad);
    pad.dispatchEvent(touchEvent('touchstart', [first], [first]));
    const second = point(8, 60, 45, pad);
    pad.dispatchEvent(touchEvent('touchend', [first], [second]));
    expect(heard.map((h) => h.type)).toEqual(['touchstart', 'touchend']);
    const start = heard[0].props as { touches: Array<Record<string, number>>; changedTouches: Array<Record<string, number>>; targetTouches: unknown[] };
    expect(heard[0].nodeId).toBe(10);
    expect(start.touches).toHaveLength(1);
    expect(start.touches[0]).toMatchObject({ identifier: 7, clientX: 100, clientY: 100, pageX: 100, pageY: 100, radiusX: 4, radiusY: 5, force: 0.5 });
    // A swipe is read from screenX: told from the box's corner too, as clientX is (the box is
    // the app's screen; where the page is on the person's screen is not the app's to know).
    expect(start.touches[0].screenX).toBe(100);
    expect(start.changedTouches[0].identifier).toBe(7);
    expect(start.targetTouches).toHaveLength(1);
    const end = heard[1].props as { touches: unknown[]; changedTouches: Array<Record<string, number>> };
    expect(end.changedTouches[0]).toMatchObject({ identifier: 8, clientX: 20, clientY: 20 });
    // What crosses to the app's Worker is data, never the page's own elements.
    expect(() => structuredClone(heard.map((h) => h.props))).not.toThrow();
    made.dispose();
    archive.dispose();
  });

  it('tells a move’s movementX/movementY and a key’s keyCode, which, charCode and location', async () => {
    const { made, viewportEl, archive, heard } = await patcher();
    made.applyOps([['e', 10, 'div', { id: 'pad' }], ['c', 1, [10]], ['l', 'mousemove'], ['l', 'keydown']] as ShellOp[]);
    const pad = viewportEl.querySelector('#pad')!;
    const move = new MouseEvent('mousemove', { bubbles: true, composed: true, clientX: 5, clientY: 6 });
    Object.defineProperty(move, 'movementX', { value: 3 });
    Object.defineProperty(move, 'movementY', { value: -4 });
    pad.dispatchEvent(move);
    pad.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, which: 37, location: 0 } as KeyboardEventInit));
    expect(heard.map((h) => h.type)).toEqual(['mousemove', 'keydown']);
    expect(heard[0].props).toMatchObject({ movementX: 3, movementY: -4 });
    expect(heard[1].props).toMatchObject({ key: 'ArrowLeft', keyCode: 37, which: 37, charCode: 0, location: 0 });
    made.dispose();
    archive.dispose();
  });

  it('tells offsetX/offsetY from the target’s padding edge, as a browser does, on a move and on a click', async () => {
    // A drawing on a canvas with a border: the point drawn was the border's width off the pointer.
    const { made, viewportEl, archive, heard } = await patcher();
    made.applyOps([['e', 10, 'canvas', { width: '100', height: '100' }], ['c', 1, [10]], ['l', 'mousemove'], ['l', 'mousedown']] as ShellOp[]);
    const canvas = viewportEl.querySelector('canvas')!;
    // 3px of border; the canvas's box at 40 by 30 from the window's corner.
    Object.defineProperty(canvas, 'clientLeft', { configurable: true, value: 3 });
    Object.defineProperty(canvas, 'clientTop', { configurable: true, value: 3 });
    canvas.getBoundingClientRect = () => ({ left: 40, top: 30, right: 146, bottom: 136, width: 106, height: 106, x: 40, y: 30, toJSON: () => ({}) });
    for (const type of ['mousemove', 'mousedown']) {
      const e = new MouseEvent(type, { bubbles: true, composed: true, clientX: 50, clientY: 45 });
      // What a browser says: from the padding edge, inside the border.
      Object.defineProperty(e, 'offsetX', { value: 7 });
      Object.defineProperty(e, 'offsetY', { value: 12 });
      canvas.dispatchEvent(e);
    }
    expect(heard.map((h) => [h.type, h.props.offsetX, h.props.offsetY])).toEqual([
      ['mousemove', 7, 12],
      ['mousedown', 7, 12],
    ]);
    made.dispose();
    archive.dispose();
  });

  it('scrolls to the place a link names only once the app’s script has not cancelled its click', async () => {
    // `<a href="#">` is how much code makes a button (`onclick` cancels it): each click on one
    // scrolled the app's page to its top before its script had heard of the click.
    const { made, viewportEl, docRootEl, archive, heard } = await patcher();
    made.applyOps([['e', 10, 'a', { href: '#' }], ['x', 11, 'Load more'], ['c', 10, [11]], ['c', 1, [10]], ['l', 'click']] as ShellOp[]);
    let top = 500;
    Object.defineProperty(docRootEl, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = v) });
    Object.defineProperty(docRootEl, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(docRootEl, 'clientHeight', { configurable: true, value: 500 });
    const box = (y: number, h: number) => ({ left: 0, top: y, right: 400, bottom: y + h, width: 400, height: h, x: 0, y, toJSON: () => ({}) });
    docRootEl.getBoundingClientRect = () => box(0, 500);
    viewportEl.getBoundingClientRect = () => box(-top, 2000);
    const link = viewportEl.querySelector('a')!;
    const click = () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    expect(click()).toBe(false);
    // Not before the script has answered, nor when it cancelled the click.
    expect(top).toBe(500);
    expect(heard).toHaveLength(1);
    heard[0].answered?.(1);
    expect(top).toBe(500);
    // Not cancelled: to the top of the page, as a browser goes.
    click();
    heard[1].answered?.(0);
    expect(top).toBe(0);
    made.dispose();
    archive.dispose();
  });

  it('tells the app’s document a <details> the person opened or closed, with the toggle and without it', async () => {
    // The page opens a <details> by itself when its summary is clicked, and its document never
    // heard: `details.open` read false in the toggle the click made, and a React
    // `<details open={open} onToggle={(e) => setOpen(e.target.open)}>` closed it at once.
    const { made, viewportEl, archive, heard, synced } = await patcher();
    made.applyOps([['e', 10, 'details', {}], ['e', 11, 'summary', {}], ['x', 12, 'More'], ['c', 11, [12]], ['c', 10, [11]], ['c', 1, [10]]] as ShellOp[]);
    const details = viewportEl.querySelector('details')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    expect(synced.flat()).toContainEqual(['A', 10, 'open', '']);
    made.applyOps([['l', 'toggle']] as ShellOp[]);
    details.open = false;
    const toggle = new Event('toggle');
    Object.defineProperty(toggle, 'newState', { value: 'closed' });
    Object.defineProperty(toggle, 'oldState', { value: 'open' });
    details.dispatchEvent(toggle);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ nodeId: 10, type: 'toggle', props: { newState: 'closed', oldState: 'open' } });
    expect(heard[0].sync).toContainEqual(['A', 10, 'open', null]);
    made.dispose();
    archive.dispose();
  });

  it('tells the app’s document the fields a form’s reset put back', async () => {
    // A reset button puts a form's fields back as its markup has them, and says nothing of
    // them: the app's document kept what the person had typed and ticked.
    const { made, viewportEl, archive, synced } = await patcher();
    made.applyOps([
      ['e', 10, 'form', {}],
      ['e', 11, 'input', { type: 'text', value: 'start' }],
      ['e', 12, 'input', { type: 'checkbox' }],
      ['e', 13, 'button', { type: 'reset' }],
      ['c', 10, [11, 12, 13]],
      ['c', 1, [10]],
    ] as ShellOp[]);
    const form = viewportEl.querySelector('form')!;
    const [text, box] = Array.from(form.querySelectorAll('input'));
    text.value = 'typed';
    box.checked = true;
    form.reset();
    expect(text.value).toBe('start');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const told = synced.flat();
    expect(told).toContainEqual(['v', 11, 'start']);
    expect(told).toContainEqual(['k', 12, false]);
    made.dispose();
    archive.dispose();
  });

  it('sends a field’s text with what can change it, not with every move of the pointer over it', async () => {
    // A move, a wheel or a scroll changes no field: the text of a large textarea under the
    // pointer was read and sent to the app's Worker with each one.
    const { made, viewportEl, archive, heard } = await patcher();
    made.applyOps([['e', 10, 'textarea', {}], ['c', 1, [10]], ['l', 'mousemove'], ['l', 'pointermove'], ['l', 'wheel'], ['l', 'keydown']] as ShellOp[]);
    const area = viewportEl.querySelector('textarea')!;
    area.value = 'x'.repeat(1_000_000);
    area.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true }));
    area.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, composed: true }));
    area.dispatchEvent(new WheelEvent('wheel', { bubbles: true, composed: true, deltaY: 5 }));
    area.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, key: 'a' }));
    expect(heard.map((h) => h.type)).toEqual(['mousemove', 'pointermove', 'wheel', 'keydown']);
    const sent = heard.map((h) => JSON.stringify(h.sync).length);
    expect(sent[0]).toBeLessThan(100);
    expect(sent[1]).toBeLessThan(100);
    expect(sent[2]).toBeLessThan(100);
    // A key may change it: what it holds goes with the key, as before.
    expect(heard[3].sync).toContainEqual(['v', 10, area.value]);
    made.dispose();
    archive.dispose();
  });

  it('tells the app’s document that the radio a picked one took over from is no longer checked', async () => {
    const { made, viewportEl, archive, heard, synced } = await patcher();
    made.applyOps([
      ['e', 10, 'form', {}],
      ['e', 11, 'input', { type: 'radio', name: 'size', value: 's', checked: '' }],
      ['e', 12, 'input', { type: 'radio', name: 'size', value: 'm' }],
      ['e', 13, 'input', { type: 'radio', name: 'size', value: 'l' }],
      // Another group, and a radio of the same name outside the form: neither is the group's.
      ['e', 14, 'input', { type: 'radio', name: 'colour', value: 'red', checked: '' }],
      ['e', 15, 'input', { type: 'radio', name: 'size', value: 'xl', checked: '' }],
      ['c', 10, [11, 12, 13, 14]],
      ['c', 1, [10, 15]],
    ] as ShellOp[]);
    const radios = Array.from(viewportEl.querySelectorAll('input')) as HTMLInputElement[];
    // The person picks "m": the page ticks it and unticks "s", and says change.
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event('change', { bubbles: true }));
    expect(radios[0].checked).toBe(false);
    // No script listens for change: the field's state goes as a sync of its own.
    const told = synced.flat() as Array<[string, number, unknown]>;
    expect(told).toContainEqual(['k', 12, true]);
    expect(told).toContainEqual(['k', 11, false]);
    // Only the radios of its own group: not another group's, nor one of the same name outside its form.
    expect(told.some((c) => c[1] === 14 || c[1] === 15)).toBe(false);

    // With a script listening for change, the same goes with the event.
    made.applyOps([['l', 'change']] as ShellOp[]);
    radios[2].checked = true;
    radios[2].dispatchEvent(new Event('change', { bubbles: true }));
    const change = heard.find((h) => h.type === 'change')!;
    expect(change.nodeId).toBe(13);
    expect(change.sync).toContainEqual(['k', 13, true]);
    expect(change.sync).toContainEqual(['k', 12, false]);
    expect(change.sync).toContainEqual(['k', 11, false]);
    made.dispose();
    archive.dispose();
  });
});
