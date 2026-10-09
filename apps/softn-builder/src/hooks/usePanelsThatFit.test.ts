// @vitest-environment jsdom
/**
 * The canvas is on the screen at every width the editor is shown in.
 *
 * Files, Components and Properties are each a fixed width and the canvas
 * has the rest. At 900 pixels wide, which is where the editor starts being
 * shown at all, the rest was nothing: Design was three panels and no
 * canvas. Seen in Chromium; what is held here is the arithmetic that now
 * leaves the canvas its room, and that a panel closed for want of room
 * comes back with the room while one a person closed stays closed.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANVAS_FLOOR, CANVAS_MIN, PANEL_WIDTHS, canvasWidthWith, panelsThatFit, useSidePanels } from './usePanelsThatFit';

let root: Root;
let host: HTMLDivElement;
let files: [boolean, (open: boolean) => void];
let components: [boolean, (open: boolean) => void];

function Harness() {
  const panels = useSidePanels();
  files = [panels.files, panels.setFiles];
  components = [panels.components, panels.setComponents];
  return null;
}

function resizeTo(width: number): void {
  act(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    window.dispatchEvent(new Event('resize'));
  });
}

function mountAt(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => root.render(React.createElement(Harness)));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** What is left for the canvas at `width`, with the panels that are open there. */
function canvasWidth(width: number): number {
  return canvasWidthWith(width, panelsThatFit(width));
}

describe('the room left for the canvas', () => {
  it('is never less than its least, from the narrowest window the editor is shown in', () => {
    for (let width = 900; width <= 2000; width += 1) {
      expect(canvasWidth(width), `at ${width}px`).toBeGreaterThanOrEqual(CANVAS_MIN);
    }
  });

  it('is made by closing Files first, then Components, and never Properties', () => {
    expect(panelsThatFit(1440)).toEqual({ files: true, components: true });
    expect(panelsThatFit(1100)).toEqual({ files: false, components: true });
    expect(panelsThatFit(900)).toEqual({ files: false, components: false });
  });
});

describe('a panel there is no room for', () => {
  it('starts closed in a narrow window', () => {
    mountAt(900);
    expect(files[0]).toBe(false);
    expect(components[0]).toBe(false);
  });

  it('closes when the window narrows and opens again when it widens', () => {
    mountAt(1440);
    expect(files[0]).toBe(true);
    resizeTo(1100);
    expect([files[0], components[0]]).toEqual([false, true]);
    resizeTo(1440);
    expect([files[0], components[0]]).toEqual([true, true]);
  });

  it('stays closed when the window widens, if a person closed it', () => {
    mountAt(1440);
    act(() => files[1](false));
    resizeTo(1100);
    resizeTo(1440);
    expect(files[0]).toBe(false);
  });

  it('stays open in a narrow window once a person opens it', () => {
    mountAt(900);
    act(() => components[1](true));
    expect(components[0]).toBe(true);
    resizeTo(950);
    expect(components[0]).toBe(true);
  });

  it('gives way when the other is opened and both would leave no canvas', () => {
    mountAt(900);
    act(() => components[1](true));
    act(() => files[1](true));
    // Both open at this width is no canvas again.
    expect(PANEL_WIDTHS.files + PANEL_WIDTHS.components).toBeGreaterThan(900 - PANEL_WIDTHS.properties - PANEL_WIDTHS.around - CANVAS_FLOOR);
    expect([files[0], components[0]]).toEqual([true, false]);
    expect(canvasWidthWith(900, { files: files[0], components: components[0] })).toBeGreaterThanOrEqual(CANVAS_FLOOR);
    act(() => components[1](true));
    expect([files[0], components[0]]).toEqual([false, true]);

    // Where there is room for both, both stay.
    resizeTo(1200);
    act(() => files[1](true));
    expect([files[0], components[0]]).toEqual([true, true]);
  });
});
