// @vitest-environment jsdom
/**
 * The canvas keeps the room a page needs at every width, and the panels
 * share what is over.
 *
 * Files, Components and Properties are each a fixed width and the canvas
 * has the rest. All three were open wherever that left the canvas 360
 * pixels: 540 of a 1440 pixel window, 370 of a 1024 one, between panels
 * twice as wide. Seen in Chromium; what is held here is the arithmetic that
 * now leaves the canvas its room, one panel open at a time where two crowd
 * it, and that a panel put away for want of room comes back with the room
 * while one a person closed stays closed.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANVAS_MIN, CANVAS_WIDE, SHEETS_BELOW, canvasWidthWith, layoutMode, panelsThatFit, useWorkspaceLayout, type WorkspaceLayout } from './usePanelsThatFit';

let root: Root;
let host: HTMLDivElement;
let layout: WorkspaceLayout;

function Harness() {
  layout = useWorkspaceLayout();
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

const open = () => (['files', 'components', 'properties'] as const).filter((panel) => layout.open[panel]);

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

describe('the room left for the canvas', () => {
  it('is the room a page needs, at every width the panels stand beside it', () => {
    for (let width = SHEETS_BELOW; width <= 2400; width += 1) {
      const least = layoutMode(width) === 'all' ? CANVAS_WIDE : layoutMode(width) === 'two' ? CANVAS_MIN : 470;
      expect(canvasWidthWith(width, panelsThatFit(width)), `at ${width}px`).toBeGreaterThanOrEqual(least);
    }
  });

  it('is more than half the window at the common widths', () => {
    for (const width of [1024, 1280, 1366, 1440, 1536, 1920]) {
      expect(canvasWidthWith(width, panelsThatFit(width)) / width, `at ${width}px`).toBeGreaterThan(0.48);
    }
  });

  it('is shared by fewer panels as the window narrows', () => {
    expect(layoutMode(1920)).toBe('all');
    expect(panelsThatFit(1920)).toEqual({ files: true, components: true, properties: true });
    expect(layoutMode(1440)).toBe('two');
    expect(panelsThatFit(1440)).toEqual({ files: false, components: true, properties: true });
    expect(layoutMode(1024)).toBe('one');
    expect(panelsThatFit(1024)).toEqual({ files: false, components: true, properties: false });
    expect(layoutMode(899)).toBe('sheets');
    expect(panelsThatFit(390)).toEqual({ files: false, components: false, properties: false });
  });
});

describe('one panel at a time, where two crowd the canvas', () => {
  it('puts the open panel away when another is opened at 1024', () => {
    mountAt(1024);
    expect(open()).toEqual(['components']);
    act(() => layout.setOpen('properties', true));
    expect(open()).toEqual(['properties']);
    act(() => layout.setOpen('files', true));
    expect(open()).toEqual(['files']);
  });

  it('keeps Properties, and one of Files and Components, at 1440', () => {
    mountAt(1440);
    expect(open()).toEqual(['components', 'properties']);
    act(() => layout.setOpen('files', true));
    expect(open()).toEqual(['files', 'properties']);
    act(() => layout.setOpen('components', true));
    expect(open()).toEqual(['components', 'properties']);
  });

  it('keeps all three at 1920', () => {
    mountAt(1920);
    expect(open()).toEqual(['files', 'components', 'properties']);
  });

  it('leaves the canvas the whole row when the one open panel is closed', () => {
    mountAt(1024);
    act(() => layout.setOpen('components', false));
    expect(open()).toEqual([]);
  });
});

describe('a panel there is no room for', () => {
  it('comes back when the window widens', () => {
    mountAt(1024);
    resizeTo(1440);
    expect(open()).toEqual(['components', 'properties']);
    resizeTo(1920);
    expect(open()).toEqual(['files', 'components', 'properties']);
    resizeTo(1024);
    expect(open()).toEqual(['components']);
  });

  it('stays closed when the window widens, if a person closed it', () => {
    mountAt(1920);
    act(() => layout.setOpen('files', false));
    resizeTo(1024);
    resizeTo(1920);
    expect(open()).toEqual(['components', 'properties']);
  });

  it('is the one opened longest ago, when the window narrows', () => {
    mountAt(1920);
    act(() => layout.setOpen('files', false));
    act(() => layout.setOpen('files', true));
    resizeTo(1440);
    expect(open()).toEqual(['files', 'properties']);
    resizeTo(1024);
    expect(open()).toEqual(['files']);
  });
});

describe('a phone or a narrow tablet', () => {
  it('has no panel beside the canvas, and finds them all again when it widens', () => {
    mountAt(390);
    expect(layout.mode).toBe('sheets');
    expect(open()).toEqual([]);
    resizeTo(1920);
    expect(layout.mode).toBe('all');
    expect(open()).toEqual(['files', 'components', 'properties']);
  });
});
