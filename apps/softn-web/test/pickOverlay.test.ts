/**
 * @vitest-environment jsdom
 *
 * The sheet the editor lays over a running app while a person picks an
 * element of it (src/edit/pickOverlay.ts).
 *
 * An app's logic may listen on its window, and the runtime hands such a
 * listener every pointer event that comes up to the window while the app is
 * on screen (core's window-bridge.ts). So "the press is taken by the sheet"
 * has to mean every part of a press: its start, its release, a touch, a
 * second click, the menu key. A game that listens for `pointerdown` must not
 * fire because an element of it was picked, and must not be able to tell
 * that one was.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PickOverlay } from '../src/edit/pickOverlay';

/** What a pointer, a finger or a mouse sends to what is under it. */
const PRESS = [
  'pointerdown',
  'mousedown',
  'pointermove',
  'mousemove',
  'pointerup',
  'mouseup',
  'pointercancel',
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
];

let mount: HTMLElement;
let box: HTMLElement;
let overlay: PickOverlay;
let picked: Element[];
const pointed = document as unknown as { elementsFromPoint?: (x: number, y: number) => Element[] };
const hadElementsFromPoint = pointed.elementsFromPoint;

beforeEach(() => {
  mount = document.createElement('aside');
  box = document.createElement('div');
  box.innerHTML = '<button class="fire">Fire</button>';
  document.body.append(box, mount);
  picked = [];
  // jsdom lays nothing out: the press is aimed at the app's button, as the browser would say.
  pointed.elementsFromPoint = () => [box.querySelector('.fire')!, box];
  overlay = new PickOverlay({ mount, box: () => box, outlineFor: () => null, onPick: (target) => picked.push(target) });
});

afterEach(() => {
  overlay.destroy();
  box.remove();
  mount.remove();
  pointed.elementsFromPoint = hadElementsFromPoint;
});

/** Send each event to the sheet, and answer which of them came up to the window, where an app's listeners are. */
function pressOnSheet(types: string[]): { reached: string[]; events: Event[] } {
  const sheet = mount.querySelector('.softn-edit-sheet')!;
  const reached: string[] = [];
  const note = (event: Event): void => {
    reached.push(event.type);
  };
  for (const type of types) window.addEventListener(type, note);
  const events = types.map((type) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  for (const event of events) sheet.dispatchEvent(event);
  for (const type of types) window.removeEventListener(type, note);
  return { reached, events };
}

describe('the sheet over an app while an element is picked', () => {
  it('keeps every part of a press to itself, and the press still picks', () => {
    overlay.setPicking(true);
    const { reached } = pressOnSheet(PRESS);
    expect(picked.map((element) => element.className)).toEqual(['fire']);
    expect(reached).toEqual([]);
  });

  it('takes nothing from the app by the start of a press: the field the app had the keyboard in keeps it', () => {
    overlay.setPicking(true);
    const { events } = pressOnSheet(PRESS);
    const prevented = events.filter((event) => event.defaultPrevented).map((event) => event.type);
    // What would move the focus, select text or open the browser's menu is not done.
    expect(prevented).toEqual(expect.arrayContaining(['pointerdown', 'mousedown', 'contextmenu']));
    // A touch is left to become the click that picks.
    expect(prevented).not.toContain('touchstart');
    expect(prevented).not.toContain('touchend');
  });

  it('is not in the way when nothing is being picked', () => {
    const { reached } = pressOnSheet(PRESS);
    expect(reached).toEqual(PRESS);
    expect(picked).toEqual([]);
    // And again once picking has ended.
    overlay.setPicking(true);
    overlay.setPicking(false);
    expect(pressOnSheet(['pointerdown', 'click']).reached).toEqual(['pointerdown', 'click']);
    expect(picked).toEqual([]);
  });
});
