// @vitest-environment jsdom
/**
 * The palette adds components from the keyboard, and every add is a step
 * Undo can take back. A double-click used to add without recording one, and
 * the items could not be reached without a mouse at all.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { ComponentPalette, insertFromPalette } from './ComponentPalette';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;

const canvas = () => useCanvasStore.getState();
const count = (type: string) => [...canvas().elements.values()].filter((el) => el.componentType === type).length;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  canvas().reset();
  useHistoryStore.getState().clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('adding from the palette', () => {
  it('adds, selects, and records one undoable step', () => {
    const id = insertFromPalette('Stack');
    expect(count('Stack')).toBe(1);
    expect(canvas().selectedIds).toEqual([id]);

    const entry = useHistoryStore.getState().undo({ elements: canvas().elements, rootId: canvas().rootId, timestamp: Date.now() });
    expect(entry).not.toBeNull();
    canvas().loadState(entry!.elements, entry!.rootId);
    expect(count('Stack')).toBe(0);
  });

  it('adds the focused item with Enter', () => {
    act(() => root.render(React.createElement(ComponentPalette)));
    const item = host.querySelector<HTMLElement>('[data-palette-item="Stack"]')!;
    expect(item.getAttribute('role')).toBe('button');
    expect(item.tabIndex).toBe(0);
    act(() => {
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(count('Stack')).toBe(1);
  });

  it('does not offer the page itself, which a page has one of', () => {
    act(() => root.render(React.createElement(ComponentPalette)));
    const offered = () => [...host.querySelectorAll<HTMLElement>('[data-palette-item]')].map((item) => item.dataset.paletteItem);
    expect(offered()).toContain('Stack');
    expect(offered()).not.toContain('App');

    // Nor when it is searched for by name.
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(search, 'App');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(offered()).not.toContain('App');

    // The number beside the title is the number of components that can be taken.
    act(() => {
      setValue.call(search, '');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    for (const header of host.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')) act(() => header.click());
    const counted = Number(host.querySelector('.bl-badge')!.textContent);
    expect(offered().filter((name) => !name!.startsWith('#'))).toHaveLength(counted);
  });

  it('draws an item the same after it has been dragged as before', () => {
    // The item set `border` and its dragged state set `borderStyle` and
    // `borderColor`. When the drag ended React took those two away by
    // clearing them, which clears that part of the shorthand: the item was
    // left with no border style, two pixels shorter, and an error in the
    // console at the end of every drag.
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      act(() => root.render(React.createElement(ComponentPalette)));
      const item = host.querySelector<HTMLElement>('[data-palette-item="Stack"]')!;
      const before = item.getAttribute('style');
      act(() => canvas().setDraggedType('Stack'));
      expect(item.getAttribute('style')).not.toBe(before);
      act(() => canvas().setDraggedType(null));
      expect(item.getAttribute('style')).toBe(before);
    } finally {
      console.error = original;
    }
    expect(errors.filter((message) => message.includes('shorthand'))).toEqual([]);
  });

  it('says when a search matches nothing', () => {
    act(() => root.render(React.createElement(ComponentPalette)));
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(search, 'zzzz');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Nothing matches');
  });
});
