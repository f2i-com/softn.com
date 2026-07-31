/**
 * PanView: the window onto content bigger than the space for it.
 *
 * The behaviour worth pinning is the arithmetic, because it is the part that
 * looks fine on screen until it doesn't: a drag that moves the content the
 * wrong way, or a zoom that throws away the spot the user was looking at.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { PanView } from '../src/animation/PanView';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const mount = (node: React.ReactElement) => act(() => root.render(node));

/** jsdom lays nothing out, so the viewport's own size has to be declared. */
function sizeViewport(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
}

const viewport = (): HTMLElement => container.firstElementChild as HTMLElement;

/** jsdom has no pointer capture; PanView calls it on every drag. */
function stubPointerCapture(el: HTMLElement): void {
  const captured = new Set<number>();
  Object.assign(el, {
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    hasPointerCapture: (id: number) => captured.has(id),
  });
}

function pointer(el: HTMLElement, type: string, init: PointerEventInit): void {
  const e = new MouseEvent(type, { bubbles: true, ...init });
  Object.assign(e, { pointerId: init.pointerId ?? 1, pointerType: (init as { pointerType?: string }).pointerType ?? 'mouse' });
  act(() => { el.dispatchEvent(e); });
}

describe('PanView sizing', () => {
  it('reserves the scaled footprint so the scrollbars can reach the far edge', () => {
    mount(<PanView contentWidth={800} contentHeight={600} scale={1.5} centered={false} />);
    const sizer = viewport().firstElementChild as HTMLElement;
    expect(sizer.style.width).toBe('1200px');
    expect(sizer.style.height).toBe('900px');
  });

  it('leaves children in unscaled coordinates and scales the world around them', () => {
    // The point of the transform is that the app keeps positioning things in
    // map pixels; if the world were sized to the scaled footprint instead,
    // every character coordinate in every app using this would need the zoom
    // multiplied through it by hand.
    mount(<PanView contentWidth={800} contentHeight={600} scale={2} centered={false} />);
    const world = viewport().firstElementChild?.firstElementChild as HTMLElement;
    expect(world.style.width).toBe('800px');
    expect(world.style.transform).toBe('scale(2)');
    expect(world.style.transformOrigin).toBe('top left');
  });

  it('falls back to 1 rather than collapsing on a nonsense scale', () => {
    mount(<PanView contentWidth={800} contentHeight={600} scale={0} centered={false} />);
    const sizer = viewport().firstElementChild as HTMLElement;
    expect(sizer.style.width).toBe('800px');
  });

  it('does not put NaN in the DOM when the content size is still being computed', () => {
    // A host that computes its size from a script gives NaN on the first
    // render, before the script has loaded.
    mount(<PanView contentWidth={NaN} contentHeight={NaN} centered={false} />);
    const sizer = viewport().firstElementChild as HTMLElement;
    const world = sizer.firstElementChild as HTMLElement;
    expect(sizer.style.width).toBe('0px');
    expect(world.style.width).toBe('0px');
  });
});

describe('PanView centring', () => {
  it('opens on the middle of the content', () => {
    mount(<PanView contentWidth={800} contentHeight={600} />);
    const el = viewport();
    sizeViewport(el, 400, 300);
    // Re-render so the layout effect runs again now the view has a size.
    mount(<PanView contentWidth={800} contentHeight={600} />);
    expect(el.scrollLeft).toBe(200);
    expect(el.scrollTop).toBe(150);
  });

  it('waits for the content size instead of centring on nothing', () => {
    // This is the bug that shipped: the content size arrives one render late,
    // the first pass centred on NaN, and centring is once-only — so the map
    // opened wedged against its own corner and stayed there.
    const el = () => viewport();
    mount(<PanView contentWidth={NaN} contentHeight={NaN} />);
    sizeViewport(el(), 400, 300);
    mount(<PanView contentWidth={NaN} contentHeight={NaN} />);
    expect(el().scrollLeft).toBe(0);

    mount(<PanView contentWidth={800} contentHeight={600} />);
    expect(el().scrollLeft).toBe(200);
    expect(el().scrollTop).toBe(150);
  });

  it('does not centre on a viewport that has not been laid out yet', () => {
    // A tab that mounts hidden reports zero, and centring on that scrolls to
    // the top-left corner and then calls itself done.
    mount(<PanView contentWidth={800} contentHeight={600} />);
    const el = viewport();
    expect(el.scrollLeft).toBe(0);
    sizeViewport(el, 400, 300);
    mount(<PanView contentWidth={800} contentHeight={600} />);
    expect(el.scrollLeft).toBe(200);
  });
});

describe('PanView zooming', () => {
  it('does not slide a freshly centred view to the edge when the scale arrives with it', () => {
    // The office does exactly this: content size and zoom both come from the
    // script, so the render that first centres the view is also the render
    // where the scale goes 1 -> 1.25. Treating that as a user zoom multiplied
    // the just-set offset and pinned the map against its right-hand wall.
    mount(<PanView contentWidth={896} contentHeight={640} />);
    const el = viewport();
    sizeViewport(el, 940, 842);

    mount(<PanView contentWidth={896} contentHeight={640} scale={1.25} />);

    expect(el.scrollLeft).toBe((896 * 1.25 - 940) / 2);
  });

  it('keeps what is in the middle of the view in the middle of the view', () => {
    mount(<PanView contentWidth={800} contentHeight={600} centered={false} />);
    const el = viewport();
    sizeViewport(el, 400, 300);
    el.scrollLeft = 200; // looking at content x 200..600, centred on 400
    el.scrollTop = 150;

    mount(<PanView contentWidth={800} contentHeight={600} scale={2} centered={false} />);

    // That same content point is now at 800, so it should sit at 800 - 200.
    expect(el.scrollLeft).toBe(600);
    expect(el.scrollTop).toBe(450);
  });
});

describe('PanView dragging', () => {
  it('moves the content with the pointer', () => {
    mount(<PanView contentWidth={800} contentHeight={600} centered={false} />);
    const el = viewport();
    stubPointerCapture(el);
    el.scrollLeft = 100;
    el.scrollTop = 100;

    pointer(el, 'pointerdown', { clientX: 300, clientY: 300, button: 0 });
    pointer(el, 'pointermove', { clientX: 260, clientY: 275 });

    // Dragging left by 40 has to reveal content to the right of what was shown.
    expect(el.scrollLeft).toBe(140);
    expect(el.scrollTop).toBe(125);
  });

  it('stops following the pointer once it is released', () => {
    mount(<PanView contentWidth={800} contentHeight={600} centered={false} />);
    const el = viewport();
    stubPointerCapture(el);

    pointer(el, 'pointerdown', { clientX: 300, clientY: 300, button: 0 });
    pointer(el, 'pointerup', { clientX: 300, clientY: 300 });
    pointer(el, 'pointermove', { clientX: 100, clientY: 100 });

    expect(el.scrollLeft).toBe(0);
    expect(el.style.cursor).toBe('grab');
  });

  it('leaves touch alone so the native flick still works', () => {
    mount(<PanView contentWidth={800} contentHeight={600} centered={false} />);
    const el = viewport();
    stubPointerCapture(el);

    pointer(el, 'pointerdown', { clientX: 300, clientY: 300, button: 0, pointerType: 'touch' });
    pointer(el, 'pointermove', { clientX: 200, clientY: 200, pointerType: 'touch' });

    expect(el.scrollLeft).toBe(0);
  });

  it('ignores the right mouse button', () => {
    mount(<PanView contentWidth={800} contentHeight={600} centered={false} />);
    const el = viewport();
    stubPointerCapture(el);

    pointer(el, 'pointerdown', { clientX: 300, clientY: 300, button: 2 });
    pointer(el, 'pointermove', { clientX: 200, clientY: 200 });

    expect(el.scrollLeft).toBe(0);
  });

  it('does not offer a grab cursor when dragging is off', () => {
    mount(<PanView contentWidth={800} contentHeight={600} centered={false} draggable={false} />);
    const el = viewport();
    stubPointerCapture(el);
    expect(el.style.cursor).toBe('');

    pointer(el, 'pointerdown', { clientX: 300, clientY: 300, button: 0 });
    pointer(el, 'pointermove', { clientX: 200, clientY: 200 });
    expect(el.scrollLeft).toBe(0);
  });
});

describe('PanView keyboard and assistive access', () => {
  it('is focusable and named, so arrow keys can scroll it', () => {
    mount(<PanView contentWidth={800} contentHeight={600} label="Office floor" />);
    const el = viewport();
    expect(el.tabIndex).toBe(0);
    expect(el.getAttribute('role')).toBe('region');
    expect(el.getAttribute('aria-label')).toBe('Office floor');
  });
});
