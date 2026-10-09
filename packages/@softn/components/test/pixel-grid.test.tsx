/**
 * PixelGrid in less room than it asks for.
 *
 * The board is `cols * cellSize` wide and used to stay that wide whatever
 * held it, so a narrow parent cut it off: Blockfall's ten-column well showed
 * about seven columns on a phone, with most of "PRESS START". It is now
 * drawn at the width it is given, whole, and at its own size wherever that
 * fits.
 *
 * jsdom lays nothing out, so the width the board "was given" is played in
 * through the ResizeObserver the component listens to.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from './dom';
import { PixelGrid } from '../src/utility/PixelGrid';

type Notify = (width: number) => void;
let observed: Array<{ element: Element; notify: Notify }> = [];
let disconnected = 0;

beforeEach(() => {
  document.body.innerHTML = '';
  observed = [];
  disconnected = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: (entries: Array<{ contentRect: { width: number } }>) => void) {}
      observe(element: Element) {
        observed.push({ element, notify: (width) => this.callback([{ contentRect: { width } }]) });
      }
      unobserve() {}
      disconnect() {
        disconnected++;
      }
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const px = (value: string) => Number(value.replace('px', ''));

function board(container: HTMLElement) {
  const root = container.firstElementChild as HTMLElement;
  const cells = Array.from(root.children).filter((child) => (child as HTMLElement).style.backgroundColor !== 'rgba(0, 0, 0, 0.6)') as HTMLElement[];
  const overlay = Array.from(root.children).find((child) => (child as HTMLElement).style.backgroundColor === 'rgba(0, 0, 0, 0.6)') as HTMLElement | undefined;
  return { root, cells, overlay };
}

describe('PixelGrid', () => {
  const well = (
    <PixelGrid rows={20} cols={10} cellSize={24} overlay="Press start" items={[{ x: 0, y: 0, color: 'red' }, { x: 9, y: 19, color: 'blue' }]} />
  );

  it('is its own size where there is room, and can be made narrower by what holds it', () => {
    const { container } = mount(well);
    const { root, cells, overlay } = board(container);
    expect([root.style.width, root.style.height, root.style.maxWidth]).toEqual(['240px', '480px', '100%']);
    expect([cells[1].style.left, cells[1].style.top, cells[1].style.width, cells[1].style.height]).toEqual(['216px', '456px', '24px', '24px']);
    expect(overlay?.style.fontSize).toBe('28px');
    expect(root.style.backgroundImage).toContain('23px');
    expect(observed.map((o) => o.element)).toEqual([root]);
  });

  it('is drawn whole at the width it is given, every cell smaller by the same amount', () => {
    const { container } = mount(well);
    const { root } = board(container);
    // A phone gives the ten columns 156 pixels of the 240 they ask for.
    act(() => observed[0].notify(156));
    const { cells, overlay } = board(container);
    // The width is still the layout's to decide; the rest follows it.
    expect(root.style.width).toBe('240px');
    expect(px(root.style.height)).toBeCloseTo(312, 5);
    const last = cells[1];
    expect(px(last.style.width)).toBeCloseTo(15.6, 5);
    // The last column ends where the board does: nothing is past the edge.
    expect(px(last.style.left) + px(last.style.width)).toBeCloseTo(156, 5);
    expect(px(last.style.top) + px(last.style.height)).toBeCloseTo(312, 5);
    expect(px(overlay!.style.fontSize)).toBeCloseTo(18.2, 5);
    expect(root.style.backgroundImage).toContain('15.6px');

    // Given its room back, it is its own size again, to the pixel.
    act(() => observed[0].notify(240));
    const again = board(container);
    expect(root.style.height).toBe('480px');
    expect(again.cells[1].style.left).toBe('216px');
    expect(again.overlay?.style.fontSize).toBe('28px');
    // A width it was never laid out at (hidden, not yet in the page) is no width.
    act(() => observed[0].notify(0));
    expect(root.style.height).toBe('480px');
  });

  it('never shrinks its words out of reading size, and stops listening when it goes', () => {
    const { container, unmount } = mount(well);
    act(() => observed[0].notify(48));
    expect(board(container).overlay?.style.fontSize).toBe('10px');
    unmount();
    expect(disconnected).toBe(1);
  });

  it('is its own size where nothing can be measured', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { container } = mount(well);
    const { root, cells } = board(container);
    expect([root.style.width, root.style.height]).toEqual(['240px', '480px']);
    expect(cells[1].style.left).toBe('216px');
  });
});
