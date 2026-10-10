// @vitest-environment jsdom
/**
 * What is added from the palette can be taken back, moved and deleted from
 * the keyboard straight away.
 *
 * Delete is heard on the canvas, and Ctrl+Z and Alt+Shift with an arrow
 * everywhere but in a field being typed in. After a search and a
 * double-click the focus was still in the search field, so each of those
 * keys edited the search text while the element just added sat selected on
 * the canvas; and after Enter on a row the focus was on the row, where
 * Delete was heard by nothing.
 *
 * A double-click is a pointer's: the focus goes to the new element on the
 * canvas, where every key of the canvas is heard, and the search text
 * stays. Enter is a keyboard's, and a page is built by pressing it on one
 * row after another, so the focus stays on the row, and Delete there
 * deletes what is selected, as it does on the canvas.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { useHistoryStore } from '../../stores/historyStore';
import { undoCanvas } from '../../utils/canvasHistory';
import { Canvas } from '../canvas/Canvas';
import { ComponentPalette } from './ComponentPalette';
import { useWorkspaceShortcuts } from '../../hooks/useWorkspaceShortcuts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;

const canvas = () => useCanvasStore.getState();
const count = (type: string) => [...canvas().elements.values()].filter((el) => el.componentType === type).length;
const search = () => host.querySelector<HTMLInputElement>('input[type="search"]')!;
const row = (name: string) => host.querySelector<HTMLElement>(`[data-palette-item="${name}"]`)!;
const key = (target: Element, name: string) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
/** The frame after which the new element is on the canvas to be focused. */
/** The workspace's own keys, heard at the window as in the app: Ctrl+Z, and Alt+Shift with an arrow. */
function Workspace(): null {
  const nothing = () => undefined;
  useWorkspaceShortcuts({ blocked: false, narrow: false, canvas: true, save: nothing, open: nothing, create: nothing, export: nothing, shortcuts: nothing, changeView: nothing });
  return null;
}
const order = () => canvas().elements.get(canvas().rootId!)!.children.map((id) => canvas().elements.get(id)!.componentType);
const frame = () => act(async () => void (await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))));

function typeSearch(text: string): void {
  act(() => {
    search().focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search(), text);
    search().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  canvas().reset();
  useFilesStore.getState().reset();
  useHistoryStore.getState().clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(React.createElement(React.Fragment, null, React.createElement(Workspace), React.createElement(ComponentPalette), React.createElement(Canvas))));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('after a search and a double-click in the palette', () => {
  it('the focus is on the new element, the search is as it was typed, and Delete deletes the element', async () => {
    typeSearch('badge');
    expect(document.activeElement).toBe(search());
    act(() => void row('Badge').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await frame();
    expect(count('Badge')).toBe(1);
    const [id] = canvas().selectedIds;
    const added = host.querySelector<HTMLElement>(`[data-canvas-element-id="${id}"]`)!;
    expect(document.activeElement).toBe(added);
    expect(search().value).toBe('badge');

    key(added, 'Delete');
    expect(count('Badge')).toBe(0);
    // One step: Undo brings it back.
    act(() => void undoCanvas());
    expect(count('Badge')).toBe(1);
  });
});

describe('after a search and a double-click, with something on the page already', () => {
  it('Alt+Shift with an arrow moves the new element, and Ctrl+Z takes back the move and then the element', async () => {
    act(() => {
      canvas().addElement('Text', canvas().rootId!, undefined, { starter: true });
      canvas().deselectAll();
    });
    typeSearch('badge');
    act(() => void row('Badge').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await frame();
    expect(order()).toEqual(['Text', 'Badge']);
    const press = (init: KeyboardEventInit) => act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
    // In the search field these were the field's own keys, and nothing on the canvas moved.
    press({ key: 'ArrowUp', altKey: true, shiftKey: true });
    await frame();
    expect(order()).toEqual(['Badge', 'Text']);
    press({ key: 'z', ctrlKey: true });
    expect(order()).toEqual(['Text', 'Badge']);
    press({ key: 'z', ctrlKey: true });
    expect(order()).toEqual(['Text']);
    expect(search().value).toBe('badge');
  });
});

describe('after Enter on a row of the palette', () => {
  it('the focus stays on the row for the next one, and Delete there deletes what was added', async () => {
    act(() => row('Stack').focus());
    key(row('Stack'), 'Enter');
    await frame();
    expect(count('Stack')).toBe(1);
    expect(document.activeElement).toBe(row('Stack'));
    // The next row adds into what was just added: a page is built this way.
    act(() => row('Card').focus());
    key(row('Card'), 'Enter');
    await frame();
    expect(canvas().elements.get(canvas().selectedIds[0])!.componentType).toBe('Card');
    expect(document.activeElement).toBe(row('Card'));

    key(row('Card'), 'Delete');
    expect(count('Card')).toBe(0);
    expect(count('Stack')).toBe(1);
    act(() => void undoCanvas());
    expect(count('Card')).toBe(1);
    // Backspace is the same key on a keyboard that has no Delete.
    act(() => canvas().selectElement([...canvas().elements.values()].find((el) => el.componentType === 'Card')!.id));
    key(row('Card'), 'Backspace');
    expect(count('Card')).toBe(0);
  });

  it('deletes nothing where nothing is selected, and never the page', () => {
    act(() => row('Stack').focus());
    key(row('Stack'), 'Delete');
    expect(canvas().elements.size).toBe(1);
    act(() => canvas().selectElement(canvas().rootId));
    key(row('Stack'), 'Delete');
    expect(canvas().elements.has(canvas().rootId)).toBe(true);
    expect(useHistoryStore.getState().past).toHaveLength(0);
  });

  it('leaves Delete to the search field while that is being typed in', () => {
    act(() => row('Badge').focus());
    key(row('Badge'), 'Enter');
    typeSearch('bad');
    key(search(), 'Delete');
    expect(count('Badge')).toBe(1);
  });
});
