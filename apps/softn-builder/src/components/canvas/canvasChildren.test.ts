// @vitest-environment jsdom
/**
 * What the canvas offers to hold children is what holds them when the app
 * runs.
 *
 * Every element whose registry entry said it took children was drawn with a
 * dashed box under it, "Drop children here", and took whatever was dropped
 * there. The entries said so of components that draw none: a Tabs, a Table,
 * an Accordion, a Menu, a Breadcrumb and a Toast are each given a list as a
 * property and ignore what is written between their tags, so a Card dropped
 * into a Tabs was on the canvas, in the file, and nowhere in the app. They
 * said so of a Text, a Heading, a Badge, a Tag and a key, whose content is
 * their words. And an `App`, which is the page itself, was in the palette
 * and could be put inside the page.
 *
 * Three more rules were kept by nothing. A Split draws two panes and no
 * third. An AvatarGroup holds Avatars, which is nearly always an `#each`
 * around one, and the `#each` was refused for not being an Avatar; while
 * anything at all could be dropped into a block inside it.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSource } from '../../utils/sourceParser';
import { generateSource } from '../../utils/sourceGenerator';
import { canDropInto } from '../../utils/blocks';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { useHistoryStore } from '../../stores/historyStore';
import type { CanvasElement as Element } from '../../types/builder';
import { insertFromPalette } from '../panels/ComponentPalette';
import { Canvas } from './Canvas';
import { CanvasElement } from './CanvasElement';

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useCanvasStore.getState().reset();
  useFilesStore.getState().reset();
  useHistoryStore.getState().clear();
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
  canvas().loadState(parsed.elements, parsed.rootId);
}

function byType(type: string): Element {
  return [...canvas().elements.values()].find((el) => el.componentType === type)!;
}

function source(): string {
  return generateSource(canvas().elements, canvas().rootId!, '');
}

function mount(): void {
  root = createRoot(host);
  act(() => root!.render(React.createElement(CanvasElement, { elementId: canvas().rootId!, depth: 0 })));
}

/** The canvas node of an element, given a place on the page 100 pixels high. */
function placed(id: string, top: number): HTMLElement {
  const node = host.querySelector<HTMLElement>(`[data-canvas-element-id="${id}"]`)!.parentElement!;
  node.getBoundingClientRect = () => ({ top, bottom: top + 100, left: 0, right: 300, width: 300, height: 100, x: 0, y: top, toJSON: () => ({}) });
  return node;
}

function pointerAt(node: HTMLElement, y: number): void {
  act(() => {
    node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: y }));
  });
}

function release(node: HTMLElement): void {
  act(() => {
    node.firstElementChild!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

/** Whether the element of this type is drawn with a place for children under it. */
function hasChildrenArea(type: string): boolean {
  const node = host.querySelector<HTMLElement>(`[data-canvas-element-id="${byType(type).id}"]`)!;
  return [...node.children].some((child) => child.hasAttribute('data-children-area'));
}

/** What `into` holds once `dragged` has been released over the middle of it. */
function dropFromPalette(dragged: string, into: string): string[] {
  const target = byType(into);
  placed(canvas().rootId!, 0);
  const node = placed(target.id, 200);
  act(() => canvas().setDraggedType(dragged));
  pointerAt(node, 250);
  release(node);
  act(() => canvas().setDraggedType(null));
  return byType(into).children.map((id) => canvas().elements.get(id)!.componentType);
}

describe('a place to drop children', () => {
  it('is not drawn under an element whose content is its words', () => {
    for (const type of ['Text', 'Heading', 'Badge', 'Tag', 'Kbd', 'Button', 'Alert']) insertFromPalette(type);
    mount();
    expect(host.textContent).not.toContain('Drop children here');
    for (const type of ['Text', 'Heading', 'Badge', 'Tag', 'Kbd', 'Button', 'Alert']) {
      expect(hasChildrenArea(type), type).toBe(false);
    }
  });

  it('is not drawn under a component that draws only the list it is given', () => {
    for (const type of ['Tabs', 'Table', 'Accordion', 'Menu', 'Breadcrumb', 'Toast']) insertFromPalette(type);
    mount();
    expect(host.textContent).not.toContain('Drop children here');
  });

  it('is drawn under an empty container, and under a Button once it holds an element', () => {
    open('<App><Stack></Stack><Card></Card><Button>Save<Icon name="check" /></Button><Text>Press <Kbd>S</Kbd></Text></App>');
    mount();
    for (const type of ['Stack', 'Card', 'Button', 'Text']) expect(hasChildrenArea(type), type).toBe(true);
  });
});

describe('a drop over the middle of an element', () => {
  it('goes beside a Text, not into it', () => {
    open('<App><Text>One</Text></App>');
    mount();
    expect(dropFromPalette('Badge', 'Text')).toEqual([]);
    expect(source()).toBe('<App>\n  <Text>One</Text>\n  <Badge variant="default">Badge</Badge>\n</App>');
  });

  it('goes beside a Tabs, which would not draw it', () => {
    open('<App><Tabs tabs={[{ key: "a", label: "A" }]} /></App>');
    mount();
    expect(dropFromPalette('Card', 'Tabs')).toEqual([]);
    expect(source()).toContain('<Tabs tabs={[{ key: "a", label: "A" }]} />\n  <Card');
  });

  it('goes beside a Button that has its label: where no place is drawn, nothing is taken', () => {
    open('<App><Button>Save</Button></App>');
    mount();
    expect(dropFromPalette('Button', 'Button')).toEqual([]);
    expect(source()).toBe('<App>\n  <Button>Save</Button>\n  <Button variant="primary" size="md">Click me</Button>\n</App>');
  });

  it('goes into a Button that has no label, and into one that already holds an element', () => {
    open('<App><Button variant="ghost" /></App>');
    mount();
    expect(hasChildrenArea('Button')).toBe(true);
    expect(dropFromPalette('Icon', 'Button')).toEqual(['Icon']);
    expect(dropFromPalette('Badge', 'Button')).toEqual(['Icon', 'Badge']);
  });
});

describe('the page itself', () => {
  it('is not put inside the page from the palette', () => {
    expect(insertFromPalette('App')).toBeNull();
    expect(source()).toBe('<App theme="system" />');
    expect(useHistoryStore.getState().past).toHaveLength(0);
  });

  it('is not dropped on the canvas, wherever the pointer is let go', () => {
    insertFromPalette('Stack');
    root = createRoot(host);
    act(() => root!.render(React.createElement(Canvas)));
    const board = host.querySelector<HTMLElement>('[data-builder-canvas]')!;
    act(() => canvas().setDraggedType('App'));
    act(() => {
      board.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(source()).not.toContain('<App theme="system" />');
    expect(source().match(/<App/g)).toHaveLength(1);
  });

  it('takes nothing but what the palette offers when something is dragged in from outside', () => {
    // The canvas also listens for the browser's own drag and drop, and read
    // the dragged text as the name of a component: a phrase dragged in from
    // another window became an element called by that phrase, and a file
    // that no longer parsed.
    root = createRoot(host);
    act(() => root!.render(React.createElement(Canvas)));
    const board = host.querySelector<HTMLElement>('[data-builder-canvas]')!;
    const dropOf = (text: string) => {
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { getData: () => text, dropEffect: 'none' } });
      act(() => {
        board.dispatchEvent(event);
      });
    };
    dropOf('see you at 5 <b>sharp</b>');
    dropOf('App');
    expect(source()).toBe('<App theme="system" />');
    dropOf('Badge');
    expect(source()).toBe('<App theme="system">\n  <Badge variant="default">Badge</Badge>\n</App>');
  });

  it('is not held by anything, and is not copied with what it holds', () => {
    open('<App><Stack><Text>One</Text></Stack></App>');
    const context = { elements: canvas().elements };
    expect(canDropInto(byType('Stack'), 'App', context)).toBe(false);
    expect(canDropInto(byType('App'), 'App', context)).toBe(false);

    // The page picked in the hierarchy, copied and pasted, was the whole page
    // again inside itself.
    canvas().selectMultiple([canvas().rootId!]);
    canvas().copySelected();
    canvas().paste(null);
    expect(source().match(/<App/g)).toHaveLength(1);
  });
});

describe('a container that holds one kind of element', () => {
  const SOURCE = '<App><AvatarGroup>#each (person in people)\n<Avatar name={person.name} />\n#end</AvatarGroup><Card></Card></App>';

  it('takes a block, which is how its elements are usually made', () => {
    open('<App><AvatarGroup></AvatarGroup><ButtonGroup></ButtonGroup></App>');
    const context = { elements: canvas().elements };
    expect(canDropInto(byType('AvatarGroup'), '#each', context)).toBe(true);
    expect(canDropInto(byType('ButtonGroup'), '#if', context)).toBe(true);
    expect(canDropInto(byType('AvatarGroup'), 'Card', context)).toBe(false);
  });

  it('holds the same kind inside that block, and nothing else', () => {
    open(SOURCE);
    const context = { elements: canvas().elements };
    expect(canDropInto(byType('#each'), 'Avatar', context)).toBe(true);
    expect(canDropInto(byType('#each'), 'Card', context)).toBe(false);
    // A block that stands in a plain container takes anything, as before.
    canvas().addElement('#if', byType('Card').id, 0);
    expect(canDropInto(byType('#if'), 'Card', { elements: canvas().elements })).toBe(true);
  });
});

describe('a Split', () => {
  it('takes two panes and not a third', () => {
    open('<App><Split><Box></Box></Split><Box id="loose"></Box></App>');
    const split = () => byType('Split');
    expect(canDropInto(split(), 'Box', { elements: canvas().elements })).toBe(true);
    canvas().addElement('Box', split().id, 1);
    expect(canDropInto(split(), 'Box', { elements: canvas().elements })).toBe(false);
  });

  it('is not given a third by duplicating one of its two', () => {
    open('<App><Split><Box id="a"></Box><Box id="b"></Box></Split><Stack><Box id="c"></Box></Stack></App>');
    const [first] = byType('Split').children;
    expect(canvas().duplicateElement(first)).toBeNull();
    expect(byType('Split').children).toHaveLength(2);
    // Where there is room for another, a duplicate is made as before.
    const [inStack] = byType('Stack').children;
    expect(canvas().duplicateElement(inStack)).not.toBeNull();
    expect(byType('Stack').children).toHaveLength(2);
  });

  it('lets its own panes change places', () => {
    open('<App><Split><Box id="a"></Box><Box id="b"></Box></Split></App>');
    const [first] = byType('Split').children;
    expect(canDropInto(byType('Split'), 'Box', { elements: canvas().elements, draggedId: first })).toBe(true);
  });
});
