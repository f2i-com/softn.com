// @vitest-environment jsdom
/**
 * A phone's panels are sheets over the canvas, and the sections under
 * Properties fold to their headings.
 *
 * Below 900 pixels the editor was a notice that said to find a wider
 * screen. The canvas has the screen there now, and each panel is opened
 * over it from a bar at the bottom (App.tsx): what is held here is that a
 * sheet is a dialog a person can leave, by Escape or by pressing outside
 * it, and gets the focus while it is open.
 *
 * In a wide window the hierarchy and the app's data sat under Properties at
 * a fixed 45% of the column, whatever was in them, and the properties of a
 * selected element had what was left: one field and a half at 1024 by 768.
 * Each is a section that folds to its heading now, and the heading says
 * what the section holds.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sheet } from './Sheet';
import { TreeView } from './panels/TreeView';
import { DataPanel } from './panels/DataPanel';
import { useCanvasStore } from '../stores/canvasStore';
import { useSchemaStore } from '../stores/schemaStore';
import { insertFromPalette } from './panels/ComponentPalette';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useCanvasStore.getState().reset();
  useSchemaStore.getState().reset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a sheet over the canvas', () => {
  const open = (onClose: () => void) =>
    act(() =>
      root.render(
        // The third argument is the sheet's content; its type asks for it among the props as well.
        React.createElement(Sheet, { title: 'Components', onClose } as React.ComponentProps<typeof Sheet>, React.createElement('button', { type: 'button', 'data-inside': '' }, 'Hide'))
      )
    );

  it('is a dialog named for its panel, with the focus inside it', () => {
    open(() => undefined);
    const sheet = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(sheet.getAttribute('aria-label')).toBe('Components');
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(host.querySelector('[data-inside]'));
  });

  it('is closed by Escape', () => {
    let closed = 0;
    open(() => { closed += 1; });
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(closed).toBe(1);
  });

  it('says where it was pressed, for a panel whose rows put it away', () => {
    // The Files sheet goes away when a file is picked in it (App.tsx): the press is told with what was pressed.
    const pressed: string[] = [];
    act(() =>
      root.render(
        React.createElement(
          Sheet,
          { title: 'Files', onClose: () => undefined, onPress: (event) => { pressed.push((event.target as HTMLElement).getAttribute('data-file-row') ?? ''); } } as React.ComponentProps<typeof Sheet>,
          React.createElement('div', { 'data-file-row': 'main.ui' }, 'main.ui')
        )
      )
    );
    act(() => void host.querySelector<HTMLElement>('[data-file-row]')!.click());
    expect(pressed).toEqual(['main.ui']);
  });

  // The canvas says what was done ("Deleted Heading.") in a region a screen reader reads out.
  // Behind an open sheet the canvas is out of its reach, and what was done from the sheet was
  // said to nobody: the sheet has such a region of its own, inside the dialog it is.
  it('says what is done while it is open, inside itself, and not what was said before it opened', () => {
    act(() => useCanvasStore.getState().announce('Deleted Card.'));
    open(() => undefined);
    const sheet = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const live = sheet.querySelector<HTMLElement>('[data-canvas-announcement]')!;
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('');

    act(() => useCanvasStore.getState().announce('Deleted Heading.'));
    expect(live.textContent).toBe('Deleted Heading.');
    // The same words again are said again: a new element, which a screen reader reads as an addition.
    const first = live.firstElementChild;
    act(() => useCanvasStore.getState().announce('Deleted Heading.'));
    expect(live.textContent).toBe('Deleted Heading.');
    expect(live.firstElementChild).not.toBe(first);
  });

  it('is closed by a press outside it, and not by one inside', () => {
    let closed = 0;
    open(() => { closed += 1; });
    act(() => void host.querySelector<HTMLElement>('[data-inside]')!.click());
    expect(closed).toBe(0);
    act(() => void host.querySelector<HTMLElement>('.bl-sheet-backdrop')!.click());
    expect(closed).toBe(1);
  });
});

describe('the hierarchy as a section under Properties', () => {
  it('folds to its heading, which says how many elements it holds', () => {
    insertFromPalette('Stack');
    insertFromPalette('Heading');
    let folded = false;
    const draw = () => act(() => root.render(React.createElement(TreeView, { collapsed: folded, onToggle: () => { folded = !folded; } })));
    draw();
    const head = () => host.querySelector<HTMLButtonElement>('[data-section="hierarchy"]')!;
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(head().textContent).toContain('Hierarchy');
    expect(head().querySelector('.bl-section-count')?.textContent).toBe('2');
    expect(host.querySelector('[role="tree"]')).not.toBeNull();

    act(() => void head().click());
    draw();
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[role="tree"]')).toBeNull();
  });

  it('has a way to put its sheet away on a phone, and no fold', () => {
    let closed = 0;
    act(() => root.render(React.createElement(TreeView, { onClose: () => { closed += 1; } })));
    expect(host.querySelector('[data-section]')).toBeNull();
    act(() => void host.querySelector<HTMLButtonElement>('button[aria-label="Hide hierarchy"]')!.click());
    expect(closed).toBe(1);
  });

  it('offers Delete on the selected row, which a finger cannot hover over', () => {
    const id = insertFromPalette('Stack')!;
    act(() => root.render(React.createElement(TreeView)));
    const row = host.querySelector<HTMLElement>(`[data-hierarchy-row="${id}"]`)!;
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(row.querySelector('button[aria-label="Delete Stack"]')).not.toBeNull();
  });
});

describe('the app’s data as a section under Properties', () => {
  it('says its two counts on the heading while it is folded', () => {
    act(() => root.render(React.createElement(DataPanel, { collapsed: true, onToggle: () => undefined })));
    const head = host.querySelector<HTMLButtonElement>('[data-section="data"]')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.textContent).toContain('0 collections, 0 records');
    expect(host.textContent).not.toContain('No collections yet');
  });

  it('shows where collections are made once it is opened', () => {
    act(() => root.render(React.createElement(DataPanel, { collapsed: false, onToggle: () => undefined })));
    expect(host.textContent).toContain('No collections yet. Design them and add sample records in the Data view.');
  });
});
