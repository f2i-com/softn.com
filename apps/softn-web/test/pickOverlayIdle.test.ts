/**
 * @vitest-environment jsdom
 *
 * The sheet the editor lays over a running app draws on every frame while the
 * editor is open (src/edit/pickOverlay.ts). With nothing being picked and
 * nothing picked it has nothing to draw, and it looked for the app's box in
 * the page and measured it on every one of those frames all the same, while
 * the person typed: a walk of the whole page and a layout, sixty times a
 * second. It does neither then, and draws as it did once there is something
 * to draw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PickOverlay } from '../src/edit/pickOverlay';

let frames: FrameRequestCallback[] = [];
const frame = (): void => {
  const due = frames;
  frames = [];
  for (const run of due) run(0);
};

let mount: HTMLElement;
let box: HTMLElement;
let overlay: PickOverlay;

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => frames.push(run));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  mount = document.createElement('aside');
  box = document.createElement('div');
  box.innerHTML = '<button class="fire">Fire</button>';
  document.body.append(box, mount);
});

afterEach(() => {
  overlay.destroy();
  box.remove();
  mount.remove();
  vi.unstubAllGlobals();
});

describe('the pick sheet, frame by frame', () => {
  it('looks for nothing and measures nothing while there is nothing to draw', () => {
    const found = vi.fn(() => box);
    const measured = vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
    overlay = new PickOverlay({ mount, box: found, outlineFor: () => null, onPick: () => {} });
    for (let i = 0; i < 10; i++) frame();
    expect(found).not.toHaveBeenCalled();
    expect(measured).not.toHaveBeenCalled();
    const sheet = mount.querySelector<HTMLElement>('.softn-edit-sheet')!;
    expect(sheet.style.display).toBe('none');

    // Picking: laid over the app's box, as it was.
    overlay.setPicking(true);
    frame();
    expect(found).toHaveBeenCalledTimes(1);
    expect(sheet.style.display).toBe('block');
    expect(sheet.style.width).toBe('300px');

    // Put away again: hidden, and idle again.
    overlay.setPicking(false);
    frame();
    frame();
    expect(found).toHaveBeenCalledTimes(1);
    expect(sheet.style.display).toBe('none');

    // Something picked is outlined, frame by frame.
    overlay.setSelection([box.querySelector('.fire')!], '<button>');
    frame();
    expect(found).toHaveBeenCalledTimes(2);
    expect(sheet.style.display).toBe('block');
  });
});
