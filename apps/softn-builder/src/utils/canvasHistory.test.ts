// @vitest-environment jsdom
/**
 * Undo is where a person presses it, and takes back what they can see.
 *
 * Four ways it was not. The toolbar offered Undo in every view, and in Data
 * it took back the last change to the canvas, which is not on the screen
 * there: a collection had just been added, Undo was pressed, and an element
 * was gone from a page nobody was looking at. Ctrl+Z was heard only while
 * the canvas held the focus, so after picking an element in the hierarchy,
 * or adding one from the palette, it did nothing. It was matched as a
 * small `z`, which is not what a keyboard sends with Caps Lock on. And a
 * step back put the page on the canvas the way opening a file does, which
 * emptied the clipboard and forgot the page's imports.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSource } from './sourceParser';
import { generateSource } from './sourceGenerator';
import { useCanvasStore } from '../stores/canvasStore';
import { useHistoryStore } from '../stores/historyStore';
import { useFilesStore } from '../stores/filesStore';
import { Toolbar } from '../components/toolbar/Toolbar';
import { Canvas } from '../components/canvas/Canvas';
import { insertFromPalette } from '../components/panels/ComponentPalette';
import { useWorkspaceShortcuts, type WorkspaceShortcutActions } from '../hooks/useWorkspaceShortcuts';

let root: Root;
let host: HTMLDivElement;

const canvas = () => useCanvasStore.getState();
const source = () => generateSource(canvas().elements, canvas().rootId, '');
const byType = (type: string) => [...canvas().elements.values()].find((el) => el.componentType === type)!;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // The toolbar asks whether it is running as an installed app; jsdom has no answer.
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  useCanvasStore.getState().reset();
  useFilesStore.getState().reset();
  useHistoryStore.getState().clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function toolbar(view: 'design' | 'data' | 'preview' | 'code', activeFileType: 'ui' | 'logic' | 'asset' | null = 'ui'): void {
  const nothing = () => {};
  act(() =>
    root.render(
      React.createElement(Toolbar, { view, activeFileType, onViewChange: nothing, onSave: nothing, onNew: nothing, onOpen: nothing, onShortcuts: nothing, onExport: nothing })
    )
  );
}

const button = (name: string) => [...host.querySelectorAll('button')].find((el) => el.textContent?.trim() === name)!;

describe('Undo in the toolbar', () => {
  it('is offered in Design, where the canvas is', () => {
    insertFromPalette('Badge');
    toolbar('design');
    expect(button('Undo').disabled).toBe(false);
    act(() => button('Undo').click());
    expect(source()).toBe('<App theme="system" />');
    expect(button('Redo').disabled).toBe(false);
  });

  it.each(['data', 'preview', 'code'] as const)('is not offered in %s, where it would change a page that is not on the screen', (view) => {
    insertFromPalette('Badge');
    toolbar(view);
    expect(button('Undo').disabled).toBe(true);
    expect(button('Undo').title).toContain('Design');
  });

  it('is not offered while a logic file is open in place of the canvas', () => {
    insertFromPalette('Badge');
    toolbar('design', 'logic');
    expect(button('Undo').disabled).toBe(true);
  });

  it('keeps what was copied, the page’s imports and the selection', () => {
    const parsed = parseSource('<import Header from="./Header.ui" />\n<App>\n  <Header />\n  <Text>Kept</Text>\n</App>');
    canvas().loadState(parsed.elements, parsed.rootId, parsed.imports);
    canvas().selectElement(byType('Text').id);
    canvas().copySelected();
    insertFromPalette('Badge');
    canvas().selectElement(byType('Text').id);
    toolbar('design');

    act(() => button('Undo').click());
    expect(source()).not.toContain('Badge');
    expect(canvas().getImportSource('Header')).toBe('./Header.ui');
    expect(canvas().selectedIds).toEqual([byType('Text').id]);
    canvas().paste(null);
    expect(source().match(/<Text>Kept<\/Text>/g)).toHaveLength(2);
  });
});

describe('Ctrl+Z', () => {
  function shortcuts(patch: Partial<WorkspaceShortcutActions> = {}) {
    const actions = {
      blocked: false, narrow: false, canvas: true,
      save: vi.fn(), open: vi.fn(), create: vi.fn(), export: vi.fn(), shortcuts: vi.fn(), changeView: vi.fn(),
      ...patch,
    } as WorkspaceShortcutActions;
    function Harness() {
      useWorkspaceShortcuts(actions);
      return React.createElement('div', null,
        React.createElement('button', { id: 'elsewhere' }, 'A row of the hierarchy'),
        React.createElement('input', { id: 'field', type: 'text' }),
        React.createElement('input', { id: 'tick', type: 'checkbox' }),
        React.createElement('textarea', { id: 'editor' })
      );
    }
    act(() => root.render(React.createElement(Harness)));
  }

  function press(key: string, target: string, options: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...options });
    act(() => {
      host.querySelector(`#${target}`)!.dispatchEvent(event);
    });
    return event;
  }

  it('undoes from anywhere in Design that is not a field being typed in', () => {
    insertFromPalette('Badge');
    shortcuts();
    expect(press('z', 'elsewhere').defaultPrevented).toBe(true);
    expect(source()).toBe('<App theme="system" />');
    press('y', 'tick');
    expect(source()).toContain('Badge');
    press('z', 'tick');
    press('z', 'elsewhere', { shiftKey: true });
    expect(source()).toContain('Badge');
  });

  it('is the field’s own, and the code editor’s, while one of them is being typed in', () => {
    insertFromPalette('Badge');
    shortcuts();
    expect(press('z', 'field').defaultPrevented).toBe(false);
    expect(press('z', 'editor').defaultPrevented).toBe(false);
    expect(source()).toContain('Badge');
  });

  it('does nothing where the canvas is not on the screen', () => {
    insertFromPalette('Badge');
    shortcuts({ canvas: false } as Partial<WorkspaceShortcutActions>);
    press('z', 'elsewhere');
    expect(source()).toContain('Badge');
  });

  it('is read whatever Caps Lock says, here and on the canvas itself', () => {
    insertFromPalette('Badge');
    shortcuts();
    press('Z', 'elsewhere');
    expect(source()).toBe('<App theme="system" />');

    // The canvas on its own, as its tests mount it.
    act(() => root.render(React.createElement(Canvas)));
    insertFromPalette('Badge');
    const board = host.querySelector<HTMLElement>('[data-builder-canvas]')!;
    act(() => {
      board.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(source()).toBe('<App theme="system" />');
  });
});
