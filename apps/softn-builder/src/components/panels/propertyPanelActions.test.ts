// @vitest-environment jsdom
/**
 * What is selected can be moved, duplicated and deleted from the panel.
 *
 * Each was a key and nothing else: Alt+Shift with an arrow, Ctrl+D, Delete.
 * On a phone the panel is a sheet and there is no keyboard, so an element
 * could be neither moved nor removed. The four buttons in the panel's
 * header do what the keys do, by the calls the keys make, and Undo takes
 * each back as it takes the key's.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSource } from '../../utils/sourceParser';
import { generateSource } from '../../utils/sourceGenerator';
import { redoCanvas, undoCanvas } from '../../utils/canvasHistory';
import { moveSelected } from '../../utils/keyboardMoves';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { useHistoryStore } from '../../stores/historyStore';
import { PropertyPanel } from './PropertyPanel';

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useCanvasStore.getState().reset();
  useFilesStore.getState().reset();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const canvas = () => useCanvasStore.getState();
const steps = () => useHistoryStore.getState().past.length;

const PAGE = '<App>\n  <Heading>One</Heading>\n  <Text>Two</Text>\n  <Button>Three</Button>\n</App>';

function open(source: string): void {
  const parsed = parseSource(source);
  canvas().loadState(parsed.elements, parsed.rootId);
  useHistoryStore.getState().clear();
  root = createRoot(host);
  act(() => root!.render(React.createElement(PropertyPanel)));
}

function select(tag: string, nth = 0): string {
  const id = [...canvas().elements.values()].filter((el) => el.componentType === tag)[nth].id;
  act(() => canvas().selectElement(id));
  return id;
}

const source = () => generateSource(canvas().elements, canvas().rootId, '');
const button = (action: 'up' | 'down' | 'duplicate' | 'remove') => host.querySelector<HTMLButtonElement>(`[data-selection-action="${action}"]`)!;
const press = (action: 'up' | 'down' | 'duplicate' | 'remove') => act(() => button(action).click());
const possible = (action: 'up' | 'down' | 'duplicate' | 'remove') => button(action).getAttribute('aria-disabled') !== 'true';
const all = ['up', 'down', 'duplicate', 'remove'] as const;

describe('the buttons for what is selected', () => {
  it('are four, each with a name and the key that does the same', () => {
    open(PAGE);
    select('Text');
    expect(all.map((action) => button(action).getAttribute('aria-label'))).toEqual(['Move up', 'Move down', 'Duplicate', 'Delete']);
    expect(all.map((action) => button(action).title)).toEqual(['Move up (Alt+Shift+↑)', 'Move down (Alt+Shift+↓)', 'Duplicate (Ctrl+D)', 'Delete (Del)']);
    // Buttons, in the panel's header and not among the fields that scroll.
    for (const action of all) {
      expect(button(action).tagName).toBe('BUTTON');
      expect(button(action).closest('.bl-pp-body')).toBeNull();
    }
  });

  it('are not there with nothing selected', () => {
    open(PAGE);
    expect(host.querySelector('[data-selection-action]')).toBeNull();
  });
});

describe('move up and move down', () => {
  it('move the element among its siblings, as the keys do, one step for Undo each', () => {
    open(PAGE);
    select('Text');
    press('up');
    expect(source()).toBe('<App>\n  <Text>Two</Text>\n  <Heading>One</Heading>\n  <Button>Three</Button>\n</App>');
    expect(steps()).toBe(1);
    press('down');
    press('down');
    expect(source()).toBe('<App>\n  <Heading>One</Heading>\n  <Button>Three</Button>\n  <Text>Two</Text>\n</App>');
    expect(steps()).toBe(3);

    // The key makes the same move from the same place.
    const byButton = source();
    act(() => { undoCanvas(); });
    act(() => { moveSelected('down'); });
    expect(source()).toBe(byButton);

    act(() => { undoCanvas(); });
    act(() => { undoCanvas(); });
    act(() => { undoCanvas(); });
    expect(source()).toBe(PAGE);
    act(() => { redoCanvas(); });
    expect(source()).toBe('<App>\n  <Text>Two</Text>\n  <Heading>One</Heading>\n  <Button>Three</Button>\n</App>');
  });

  it('are not possible past the first and the last place, and a press there changes nothing', () => {
    open(PAGE);
    select('Heading');
    expect(all.map(possible)).toEqual([false, true, true, true]);
    press('up');
    expect(source()).toBe(PAGE);
    expect(steps()).toBe(0);
    // Said, as the key says it, and the button is still there for Tab.
    expect(canvas().announcement).toContain('Heading is first in the page.');
    expect(button('up').disabled).toBe(false);

    select('Button');
    expect(all.map(possible)).toEqual([true, false, true, true]);
    press('down');
    expect(source()).toBe(PAGE);
    expect(steps()).toBe(0);
  });

  it('follow the element: the last press of Move up is the one that ends it', () => {
    open(PAGE);
    select('Button');
    press('up');
    expect(possible('up')).toBe(true);
    press('up');
    expect(possible('up')).toBe(false);
    expect(possible('down')).toBe(true);
  });

  it('keep an element inside its branch of a block', () => {
    open('<App>\n  #if (ready)\n    <Text>A</Text>\n    <Text>B</Text>\n  #else\n    <Text>C</Text>\n  #end\n</App>');
    select('Text', 1);
    // B is last in the #if's own branch: the #else after it is not a place to move to.
    expect(all.map(possible)).toEqual([true, false, true, true]);
    // The branch itself stays with its block.
    select('#else');
    expect(all.map(possible)).toEqual([false, false, false, true]);
  });
});

describe('duplicate', () => {
  it('puts a copy after the element and selects it, and Undo takes it back', () => {
    open(PAGE);
    const original = select('Text');
    press('duplicate');
    expect(source()).toBe('<App>\n  <Heading>One</Heading>\n  <Text>Two</Text>\n  <Text>Two</Text>\n  <Button>Three</Button>\n</App>');
    expect(canvas().selectedIds).toHaveLength(1);
    expect(canvas().selectedIds[0]).not.toBe(original);
    expect(steps()).toBe(1);
    // The button is still under the pointer, for the copy: once more.
    press('duplicate');
    expect(source().match(/<Text>Two<\/Text>/g)).toHaveLength(3);
    act(() => { undoCanvas(); });
    act(() => { undoCanvas(); });
    expect(source()).toBe(PAGE);
  });

  it('is not possible where what holds the element has no room for another', () => {
    open('<App>\n  <Split>\n    <Text>Left</Text>\n    <Text>Right</Text>\n  </Split>\n</App>');
    select('Text');
    const before = source();
    expect(possible('duplicate')).toBe(false);
    press('duplicate');
    expect(source()).toBe(before);
    expect(steps()).toBe(0);
    expect(possible('remove')).toBe(true);
  });
});

describe('delete', () => {
  it('removes the element, and Undo brings it back', () => {
    open(PAGE);
    select('Text');
    press('remove');
    expect(source()).toBe('<App>\n  <Heading>One</Heading>\n  <Button>Three</Button>\n</App>');
    expect(canvas().selectedIds).toEqual([]);
    expect(steps()).toBe(1);
    // The selection went with it, and its buttons.
    expect(host.querySelector('[data-selection-action]')).toBeNull();
    expect(host.querySelector('[data-nothing-selected]')).not.toBeNull();
    act(() => { undoCanvas(); });
    expect(source()).toBe(PAGE);
  });
});

describe('the page itself', () => {
  it('is not moved, duplicated or deleted', () => {
    open(PAGE);
    act(() => canvas().selectElement(canvas().rootId));
    expect(all.map(possible)).toEqual([false, false, false, false]);
    for (const action of all) press(action);
    expect(source()).toBe(PAGE);
    expect(steps()).toBe(0);
  });
});

describe('several elements selected', () => {
  it('are duplicated and deleted together, one step each, and not moved', () => {
    open(PAGE);
    const heading = select('Heading');
    const text = [...canvas().elements.values()].find((el) => el.componentType === 'Text')!.id;
    act(() => canvas().selectElement(text, true));
    expect(canvas().selectedIds).toEqual([heading, text]);
    expect(host.querySelector('[data-selection-name]')?.textContent).toBe('2 elements selected');
    expect(all.map(possible)).toEqual([false, false, true, true]);
    press('up');
    expect(source()).toBe(PAGE);
    expect(steps()).toBe(0);

    press('remove');
    expect(source()).toBe('<App>\n  <Button>Three</Button>\n</App>');
    expect(steps()).toBe(1);
    act(() => { undoCanvas(); });
    expect(source()).toBe(PAGE);
  });
});
