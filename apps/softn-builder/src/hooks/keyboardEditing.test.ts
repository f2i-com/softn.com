// @vitest-environment jsdom
/**
 * A page can be built and rearranged without a mouse.
 *
 * Enter on a palette item, and a double-click, put the new element at the
 * end of the page whatever was selected, and Ctrl+V pasted there too: the
 * only way to put anything inside a container, or between two elements,
 * was to drag it. Nothing moved an element at all except a drag. So a page
 * of any depth could not be made from the keyboard, and with a mouse every
 * new element was a trip to the bottom of the page and a drag back.
 *
 * What is added goes where the selection is: into the selected element
 * when it takes it, after it when it does not. And the selected element
 * moves with Alt+Shift and an arrow: up and down among its siblings, right
 * into the container before it, left out of the one it is in. Every one of
 * these goes through the rules a drop obeys, is one step for Undo, and is
 * said aloud.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSource } from '../utils/sourceParser';
import { generateSource } from '../utils/sourceGenerator';
import { useCanvasStore } from '../stores/canvasStore';
import { useHistoryStore } from '../stores/historyStore';
import { useFilesStore } from '../stores/filesStore';
import { undoCanvas } from '../utils/canvasHistory';
import type { CanvasElement as Element } from '../types/builder';
import { Canvas } from '../components/canvas/Canvas';
import { insertFromPalette } from '../components/panels/ComponentPalette';
import { useWorkspaceShortcuts, type WorkspaceShortcutActions } from './useWorkspaceShortcuts';

let root: Root;
let host: HTMLDivElement;

const canvas = () => useCanvasStore.getState();
const byType = (type: string): Element => [...canvas().elements.values()].find((el) => el.componentType === type)!;
const byText = (text: string): Element => [...canvas().elements.values()].find((el) => el.props.children === text)!;

/** The page as written, which has to be the page the same file gives back. */
function source(): string {
  const written = generateSource(canvas().elements, canvas().rootId, '');
  const again = parseSource(written);
  expect(again.fidelity.reasons, written).toEqual([]);
  expect(generateSource(again.elements, again.rootId, ''), 'written again from what was read').toBe(written);
  return written;
}

function open(text: string): void {
  const parsed = parseSource(text);
  canvas().loadState(parsed.elements, parsed.rootId);
}

function Harness() {
  const actions = {
    blocked: false, narrow: false, canvas: true,
    save: vi.fn(), open: vi.fn(), create: vi.fn(), export: vi.fn(), shortcuts: vi.fn(), changeView: vi.fn(),
  } as WorkspaceShortcutActions;
  useWorkspaceShortcuts(actions);
  return React.createElement(Canvas);
}

function press(key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  const target = host.querySelector<HTMLElement>('[data-builder-canvas]')!;
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const move = (arrow: 'Up' | 'Down' | 'Left' | 'Right') => press(`Arrow${arrow}`, { altKey: true, shiftKey: true });
const said = () => host.querySelector('[data-canvas-announcement]')?.textContent ?? '';

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useCanvasStore.getState().reset();
  useFilesStore.getState().reset();
  useHistoryStore.getState().clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(React.createElement(Harness)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a component taken from the palette with Enter or a double-click', () => {
  it('goes to the end of the page when nothing is selected', () => {
    open('<App>\n  <Card></Card>\n  <Text>Last</Text>\n</App>');
    insertFromPalette('Badge');
    expect(source()).toBe('<App>\n  <Card />\n  <Text>Last</Text>\n  <Badge variant="default">Badge</Badge>\n</App>');
  });

  it('goes into the selected element when that takes it', () => {
    open('<App>\n  <Card></Card>\n  <Text>Last</Text>\n</App>');
    canvas().selectElement(byType('Card').id);
    insertFromPalette('Heading');
    expect(source()).toBe('<App>\n  <Card>\n    <Heading level={1}>Heading</Heading>\n  </Card>\n  <Text>Last</Text>\n</App>');
  });

  it('goes after the selected element when that does not take it, and so one after another', () => {
    open('<App>\n  <Stack>\n    <Heading>One</Heading>\n    <Text>Three</Text>\n  </Stack>\n</App>');
    canvas().selectElement(byText('One').id);
    insertFromPalette('Input');
    insertFromPalette('Divider');
    expect(byType('Stack').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['Heading', 'Input', 'Divider', 'Text']);
  });

  it('goes into the words of a selected Button when it is part of a line of words', () => {
    open('<App>\n  <Button>Add</Button>\n</App>');
    canvas().selectElement(byType('Button').id);
    insertFromPalette('Icon');
    expect(source()).toBe('<App>\n  <Button>Add <Icon name="check" size={20} /></Button>\n</App>');
  });

  it('added straight after a Text it has just added, stands after it and not among its words', () => {
    // What the palette adds is selected, so that its properties are in front
    // of the person. A Badge asked for next is the next element of the page:
    // into the words of the Text only the person could have meant by picking
    // the Text themselves, which the test above does.
    open('<App>\n  <Card></Card>\n</App>');
    canvas().selectElement(byType('Card').id);
    insertFromPalette('Text');
    insertFromPalette('Badge');
    expect(byType('Card').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['Text', 'Badge']);
    expect(byType('Text').children).toEqual([]);
    source();
    // Picked by hand afterwards, the same Text takes the next one into its words.
    canvas().selectElement(byType('Text').id);
    insertFromPalette('Kbd');
    expect(byType('Text').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['#text', 'Kbd']);
  });

  it('added straight after a container it has just added, goes into it', () => {
    open('<App></App>');
    insertFromPalette('Stack');
    insertFromPalette('Card');
    insertFromPalette('Heading');
    expect(byType('Card').parentId).toBe(byType('Stack').id);
    expect(byType('Heading').parentId).toBe(byType('Card').id);
  });

  it('goes after what holds the selection where that is the nearest place that takes it', () => {
    open('<App>\n  <ButtonGroup>\n    <Button>One</Button>\n  </ButtonGroup>\n  <Text>Last</Text>\n</App>');
    canvas().selectElement(byType('Button').id);
    insertFromPalette('Card');
    expect(byType('App').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['ButtonGroup', 'Card', 'Text']);
  });

  it('goes into the branch of a selected block, before its #empty', () => {
    open('<App>\n  #each (task in tasks)\n    <Text>{task}</Text>\n  #empty\n    <Text>None</Text>\n  #end\n</App>');
    canvas().selectElement(byType('#each').id);
    insertFromPalette('Badge');
    expect(byType('#each').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['Text', 'Badge', '#empty']);
  });

  it('is one step for Undo', () => {
    open('<App>\n  <Card></Card>\n</App>');
    canvas().selectElement(byType('Card').id);
    insertFromPalette('Heading');
    expect(useHistoryStore.getState().past).toHaveLength(1);
    undoCanvas();
    expect(source()).toBe('<App>\n  <Card />\n</App>');
  });
});

describe('Ctrl+V', () => {
  function copy(type: string): void {
    canvas().selectElement(byType(type).id);
    canvas().copySelected();
  }

  it('pastes after the selected element, not at the end of the page', () => {
    open('<App>\n  <Input placeholder="Copied" />\n  <Heading>One</Heading>\n  <Text>Last</Text>\n</App>');
    copy('Input');
    canvas().selectElement(byType('Heading').id);
    press('v', { ctrlKey: true });
    expect(byType('App').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['Input', 'Heading', 'Input', 'Text']);
  });

  it('pastes into a selected container, in the branch of a block and before its #empty', () => {
    open('<App>\n  <Badge>Copied</Badge>\n  #each (task in tasks)\n    <Text>{task}</Text>\n  #empty\n    <Text>None</Text>\n  #end\n</App>');
    copy('Badge');
    canvas().selectElement(byType('#each').id);
    press('v', { ctrlKey: true });
    expect(byType('#each').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['Text', 'Badge', '#empty']);
    expect(source()).toContain('<Badge>Copied</Badge>\n  #empty');
  });

  it('does not paste a third pane into a Split, and says so', () => {
    open('<App>\n  <Box id="copied"></Box>\n  <Split><Box id="a"></Box><Box id="b"></Box></Split>\n</App>');
    canvas().selectElement(byType('Box').id);
    canvas().copySelected();
    canvas().selectElement(byType('Split').id);
    press('v', { ctrlKey: true });
    // It goes after the Split, which is the nearest place that takes it.
    expect(byType('Split').children).toHaveLength(2);
    expect(byType('App').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['Box', 'Split', 'Box']);
  });

  it('pastes several things together, where all of them can go', () => {
    // A Badge can stand in a Heading's words and a Card cannot. Placed by
    // the first thing copied alone, the Badge went into the Heading and the
    // Card was not pasted anywhere, with nothing said.
    open('<App>\n  <Badge>Copied</Badge>\n  <Card></Card>\n  <Heading>One</Heading>\n</App>');
    canvas().selectMultiple([byType('Badge').id, byType('Card').id]);
    canvas().copySelected();
    canvas().selectElement(byType('Heading').id);
    press('v', { ctrlKey: true });
    expect(byType('App').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['Badge', 'Card', 'Heading', 'Badge', 'Card']);
    expect(byType('Heading').children).toEqual([]);
  });

  it('pasted twice, is two beside each other and not one inside the other', () => {
    // What is pasted is selected, and a paste goes into the selection when
    // that takes it: a container pasted twice would be a copy inside a copy.
    open('<App>\n  <Box id="one"></Box>\n  <Split><Box id="a"></Box></Split>\n</App>');
    const [first] = byType('App').children;
    canvas().selectMultiple([first]);
    canvas().copySelected();
    canvas().selectElement(byType('Split').id);
    press('v', { ctrlKey: true });
    expect(byType('Split').children).toHaveLength(2);
    press('v', { ctrlKey: true });
    // Beside the first copy is the Split, which is full: after the Split.
    expect(byType('Split').children).toHaveLength(2);
    expect(byType('App').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['Box', 'Split', 'Box']);
    const pasted = byType('App').children[2];
    expect(canvas().elements.get(pasted)!.children).toEqual([]);
  });

  it('passes by a container that takes only part of what was copied, and pastes all of it after', () => {
    open('<App>\n  <Text>Loose</Text>\n  <Button>Copied</Button>\n  <ButtonGroup><Button>One</Button></ButtonGroup>\n</App>');
    canvas().selectMultiple([byText('Loose').id, byText('Copied').id]);
    canvas().copySelected();
    canvas().selectElement(byType('ButtonGroup').id);
    press('v', { ctrlKey: true });
    expect(byType('ButtonGroup').children).toHaveLength(1);
    expect(byType('App').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['Text', 'Button', 'ButtonGroup', 'Text', 'Button']);
    expect(said()).toBe('');
  });

  it('says how much was pasted when part of what was copied has no place anywhere', () => {
    // An `#else` belongs to its `#if` and is pasted nowhere on its own.
    open('<App>\n  <Text>Loose</Text>\n  #if (ok)\n    <Text>Yes</Text>\n  #else\n    <Text>No</Text>\n  #end\n</App>');
    canvas().selectMultiple([byText('Loose').id, byType('#else').id]);
    canvas().copySelected();
    canvas().deselectAll();
    press('v', { ctrlKey: true });
    expect(byType('App').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['Text', '#if', 'Text']);
    expect(said()).toBe('Pasted 1 of 2: the rest has no place there.');
  });

  it('pastes at the end of the page when nothing is selected, as before', () => {
    open('<App>\n  <Badge>Copied</Badge>\n  <Text>Last</Text>\n</App>');
    copy('Badge');
    canvas().deselectAll();
    press('v', { ctrlKey: true });
    expect(byType('App').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['Badge', 'Text', 'Badge']);
  });
});

describe('Alt+Shift and an arrow', () => {
  const SOURCE = '<App>\n  <Heading>One</Heading>\n  <Card>\n    <Text>In the card</Text>\n  </Card>\n  <Text>Three</Text>\n</App>';
  const order = (type: string) => byType(type).children.map((id) => {
    const child = canvas().elements.get(id)!;
    return (child.props.children as string | undefined) ?? child.componentType;
  });

  it('moves the selected element down and up among its siblings, a step of Undo each', () => {
    open(SOURCE);
    canvas().selectElement(byText('One').id);
    expect(move('Down').defaultPrevented).toBe(true);
    expect(order('App')).toEqual(['Card', 'One', 'Three']);
    move('Down');
    expect(order('App')).toEqual(['Card', 'Three', 'One']);
    expect(useHistoryStore.getState().past).toHaveLength(2);
    move('Up');
    expect(order('App')).toEqual(['Card', 'One', 'Three']);
    undoCanvas();
    expect(order('App')).toEqual(['Card', 'Three', 'One']);
    expect(canvas().selectedIds).toEqual([byText('One').id]);
  });

  it('takes Alt and an arrow up or down too, which no browser keeps for itself', () => {
    open(SOURCE);
    canvas().selectElement(byText('Three').id);
    press('ArrowUp', { altKey: true });
    expect(order('App')).toEqual(['One', 'Three', 'Card']);
  });

  it('moves it right, into the container just before it, at the end', () => {
    open(SOURCE);
    canvas().selectElement(byText('Three').id);
    move('Right');
    expect(order('App')).toEqual(['One', 'Card']);
    expect(order('Card')).toEqual(['In the card', 'Three']);
  });

  it('moves it left, out of what holds it, to just after that', () => {
    open(SOURCE);
    canvas().selectElement(byText('In the card').id);
    move('Left');
    expect(order('App')).toEqual(['One', 'Card', 'In the card', 'Three']);
    expect(source()).toContain('<Card />\n  <Text>In the card</Text>');
  });

  it('moves it out of an #else to after the whole #if, not into the #if after its #else', () => {
    open('<App>\n  #if (ok)\n    <Text>Yes</Text>\n  #else\n    <Text>No</Text>\n  #end\n  <Text>After</Text>\n</App>');
    canvas().selectElement(byText('No').id);
    move('Left');
    expect(order('App')).toEqual(['#if', 'No', 'After']);
    expect(source()).toBe('<App>\n  #if (ok)\n    <Text>Yes</Text>\n  #else\n  #end\n  <Text>No</Text>\n  <Text>After</Text>\n</App>');
  });

  it('does not move it where a drop would not go, and says why', () => {
    open('<App>\n  <ButtonGroup>\n    <Button>One</Button>\n  </ButtonGroup>\n  <Text>Loose</Text>\n  <Heading>Leaf</Heading>\n  <Card></Card>\n</App>');
    const before = source();
    canvas().selectElement(byText('Loose').id);
    move('Right');
    expect(source()).toBe(before);
    expect(said()).toContain('ButtonGroup');
    // A Heading is not a container: nothing goes into it.
    canvas().selectElement(byType('Card').id);
    move('Right');
    expect(source()).toBe(before);
    expect(useHistoryStore.getState().past).toHaveLength(0);
  });

  it('stays within the branch of a block: down does not pass its #empty', () => {
    open('<App>\n  #each (task in tasks)\n    <Text>{task}</Text>\n    <Badge>Last</Badge>\n  #empty\n    <Text>None</Text>\n  #end\n</App>');
    canvas().selectElement(byType('Badge').id);
    const before = source();
    move('Down');
    expect(source()).toBe(before);
    expect(said()).toMatch(/last|end/i);
  });

  it('keeps the words of what it moves into, and gives them back as text to what it leaves', () => {
    open('<App>\n  <Button>Add</Button>\n  <Icon name="plus" />\n</App>');
    canvas().selectElement(byType('Icon').id);
    move('Right');
    expect(source()).toBe('<App>\n  <Button>Add <Icon name="plus" /></Button>\n</App>');
    move('Left');
    expect(byType('Button').props.children).toBe('Add ');
    expect(byType('App').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['Button', 'Icon']);
  });

  it('says where the element is now', () => {
    open(SOURCE);
    canvas().selectElement(byText('One').id);
    move('Down');
    expect(said()).toBe('Heading moved down: 2 of 3 in the page.');
    canvas().selectElement(byText('Three').id);
    move('Up');
    move('Right');
    expect(said()).toBe('Text moved into Card: 2 of 2.');
    move('Left');
    expect(said()).toBe('Text moved out of Card: 2 of 3 in the page.');
    const live = host.querySelector('[data-canvas-announcement]')!;
    expect(live.getAttribute('aria-live')).toBe('polite');
  });

  it('does nothing with nothing selected, or with the page itself', () => {
    open(SOURCE);
    const before = source();
    move('Down');
    canvas().selectElement(canvas().rootId);
    move('Down');
    expect(source()).toBe(before);
  });
});
