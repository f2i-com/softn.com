// @vitest-environment jsdom
/**
 * Words stay when an element is put beside them, and are seen wherever they
 * are.
 *
 * The model keeps an element's words in one of two ways. Words that are all
 * a tag holds are its text (`<Button>Save</Button>`); words with an element
 * among them are elements themselves, in their place among the children
 * (`<Button>Save <Icon … /></Button>`). The generator writes the text only
 * for an element with no children, so every edit that gave such an element
 * its first child took the words out of the file: an Icon dropped on a
 * Button left a button with no label, `Add #else` on `#if (saved) Saved
 * #end` emptied the branch it was added to, and a component added to a page
 * that was only words replaced them. The canvas went on drawing the words
 * and the panel went on showing them in its Text field, so nothing said
 * they were gone until the app ran. The panel wrote the same way: words
 * typed into the Text field of `<Text>Press <Kbd>S</Kbd></Text>` were drawn
 * on the canvas and never written.
 *
 * And words the panel has no Text field for were not seen at all: a block
 * whose branch is a sentence was drawn as an empty block asking for
 * elements, a Card that holds a sentence as an empty Card.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSource } from '../../utils/sourceParser';
import { generateSource } from '../../utils/sourceGenerator';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { TEXT_NODE_TYPE, type CanvasElement as Element } from '../../types/builder';
import { CanvasElement } from './CanvasElement';
import { PropertyPanel } from '../panels/PropertyPanel';

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

function canvas() {
  return useCanvasStore.getState();
}

function open(source: string): void {
  const parsed = parseSource(source);
  expect(parsed.fidelity.reasons, source).toEqual([]);
  canvas().loadState(parsed.elements, parsed.rootId);
}

function byType(type: string): Element {
  return [...canvas().elements.values()].find((el) => el.componentType === type)!;
}

/** The page as it is written, which has to be the page the same file gives back. */
function source(options: { skipRootAppWrapper?: boolean } = {}): string {
  const written = generateSource(canvas().elements, canvas().rootId!, '', [], options);
  const again = parseSource(written);
  expect(again.fidelity.reasons, written).toEqual([]);
  expect(generateSource(again.elements, again.rootId, '', [], options), 'written again from what was read').toBe(written);
  return written;
}

function mount(node: React.ReactElement): void {
  root = createRoot(host);
  act(() => root!.render(node));
}

describe('an element put into one that holds words', () => {
  it('dropped on a Button, stands after its label', () => {
    open('<App>\n  <Button>Save</Button>\n</App>');
    const button = byType('Button');
    // Where the canvas puts a drop into an element with no children: first.
    canvas().addElement('Icon', button.id, 0, { starter: true });
    expect(source()).toBe('<App>\n  <Button>Save<Icon name="check" size={20} /></Button>\n</App>');
  });

  it('leaves the words as an element of their own, where they can be picked and moved', () => {
    open('<App>\n  <Text>Hello World</Text>\n</App>');
    const text = byType('Text');
    canvas().addElement('Kbd', text.id, 0, { starter: true });
    const held = byType('Text').children.map((id) => canvas().elements.get(id)!);
    expect(held.map((el) => el.componentType)).toEqual([TEXT_NODE_TYPE, 'Kbd']);
    expect(held[0].props.children).toBe('Hello World');
    expect(byType('Text').props.children).toBeUndefined();
  });

  it('moved into a Button, does not take its label', () => {
    open('<App>\n  <Badge>New</Badge>\n  <Button>Save</Button>\n</App>');
    canvas().moveElement(byType('Badge').id, byType('Button').id, 0);
    expect(source()).toBe('<App>\n  <Button>Save<Badge>New</Badge></Button>\n</App>');
  });

  it('pasted into a Button, does not take its label', () => {
    open('<App>\n  <Badge>New</Badge>\n  <Button>Save</Button>\n</App>');
    canvas().selectElement(byType('Badge').id);
    canvas().copySelected();
    canvas().paste(byType('Button').id);
    expect(source()).toBe('<App>\n  <Badge>New</Badge>\n  <Button>Save<Badge>New</Badge></Button>\n</App>');
  });

  it('added to a page that is only words, follows them', () => {
    open('Hello {name}');
    canvas().addElement('Badge', canvas().rootId, undefined, { starter: true });
    expect(source({ skipRootAppWrapper: true })).toBe('Hello {name}<Badge variant="default">Badge</Badge>');
  });
});

describe('the last element taken away from beside the words', () => {
  // The words were left as an element inside a Button that held nothing
  // else: no Text field in the panel, which said its words stood "among the
  // elements it holds", until the file was closed and opened again.
  it('leaves them the text of the element again when it is deleted', () => {
    open('<App>\n  <Button>Save<Icon name="check" /></Button>\n</App>');
    canvas().selectElement(byType('Icon').id);
    canvas().deleteElement(byType('Icon').id);
    expect(byType('Button').props.children).toBe('Save');
    expect(byType('Button').children).toEqual([]);
    expect(canvas().elements.size).toBe(2);
    expect(source()).toBe('<App>\n  <Button>Save</Button>\n</App>');

    canvas().selectElement(byType('Button').id);
    mount(React.createElement(PropertyPanel));
    expect([...host.querySelectorAll('label')].some((el) => el.textContent === 'Text')).toBe(true);
  });

  it('leaves them the text of the element again when it is moved out', () => {
    open('<App>\n  <Text>Press <Kbd>S</Kbd></Text>\n</App>');
    canvas().moveElement(byType('Kbd').id, canvas().rootId, 1);
    expect(byType('Text').props.children).toBe('Press ');
    expect(byType('Text').children).toEqual([]);
    expect(source()).toBe('<App>\n  <Text>Press </Text>\n  <Kbd>S</Kbd>\n</App>');
  });

  it('leaves them an element where there is no Text field to show them in', () => {
    open('<App>\n  <Card>Note <Badge>New</Badge></Card>\n</App>');
    canvas().deleteElement(byType('Badge').id);
    const held = byType('Card').children.map((id) => canvas().elements.get(id)!.componentType);
    expect(held).toEqual([TEXT_NODE_TYPE]);
    expect(source()).toBe('<App>\n  <Card>Note </Card>\n</App>');
  });
});

describe('a block whose branch is words', () => {
  it('keeps them when #else is added', () => {
    open('<App>\n  #if (saved)\n    Saved at {time}\n  #end\n</App>');
    canvas().addBlockBranch(byType('#if').id, 'else');
    expect(source()).toBe('<App>\n  #if (saved)\n    Saved at {time}\n  #else\n  #end\n</App>');
  });

  it('keeps them when an element is dropped into it', () => {
    open('<App>\n  #each (n in names)\n    {n}\n  #end\n</App>');
    const each = byType('#each');
    canvas().addElement('Badge', each.id, each.children.length, { starter: true });
    expect(source()).toBe('<App>\n  #each (n in names)\n    {n}<Badge variant="default">Badge</Badge>\n  #end\n</App>');
  });

  it('shows them on the canvas, in the branch', () => {
    open('<App>\n  #if (saved)\n    Saved at {time}\n  #end\n</App>');
    mount(React.createElement(CanvasElement, { elementId: byType('#if').id }));
    expect(host.querySelector('[data-canvas-text-node]')?.textContent).toBe('Saved at {time}');
    expect(host.textContent).not.toContain('Drop the elements of this branch here');
  });
});

describe('words the panel has no field for', () => {
  it('are shown inside a Card that holds only them', () => {
    open('<App>\n  <Card>Nothing here yet.</Card>\n</App>');
    mount(React.createElement(CanvasElement, { elementId: byType('Card').id }));
    expect(host.querySelector('[data-canvas-text-node]')?.textContent).toBe('Nothing here yet.');
    expect(host.textContent).not.toContain('Drop children here');
  });

  it('are still the text of an element that has a Text field', () => {
    open('<App>\n  <Text>Hello</Text>\n  <p>Plain</p>\n</App>');
    expect(byType('Text').props.children).toBe('Hello');
    expect(byType('p').props.children).toBe('Plain');
    expect(byType('Text').children).toEqual([]);
  });
});

describe('the Text field of the panel', () => {
  const label = (name: string) => [...host.querySelectorAll('label')].find((el) => el.textContent === name);

  it('is not offered for an element whose words stand among elements', () => {
    open('<App>\n  <Text>Press <Kbd>S</Kbd> to save</Text>\n</App>');
    canvas().selectElement(byType('Text').id);
    mount(React.createElement(PropertyPanel));
    // What it wrote was drawn on the canvas and left out of the file.
    expect(label('Text')).toBeUndefined();
    expect(label('size')).toBeDefined();
    expect(host.querySelector('[data-words-among-elements]')?.textContent).toContain('words');
  });

  it('is not offered for one that holds elements and no words, and the panel does not speak of words', () => {
    open('<App>\n  <Button><Icon name="check" /></Button>\n</App>');
    canvas().selectElement(byType('Button').id);
    mount(React.createElement(PropertyPanel));
    expect(label('Text')).toBeUndefined();
    expect(host.querySelector('[data-words-among-elements]')).toBeNull();
    expect(host.querySelector('[data-holds-elements]')?.textContent).toContain('Text field');
  });

  it('is offered for one that holds only words', () => {
    open('<App>\n  <Text>Press S to save</Text>\n</App>');
    canvas().selectElement(byType('Text').id);
    mount(React.createElement(PropertyPanel));
    expect(label('Text')).toBeDefined();
    expect(host.querySelector('[data-words-among-elements]')).toBeNull();
  });
});
