// @vitest-environment jsdom
/**
 * A dragged element lands where the canvas shows it will.
 *
 * Three ways it did not. Every element on the canvas listens for the pointer
 * moving over it and says where a drop would go, and the pointer over a Card
 * inside a Stack is over both: the Stack heard last, so its answer stood,
 * and nothing could be dropped into the Card at all. An element dragged down
 * its own list was put one place past where it was shown, because the place
 * was counted with the element still in the list. And a drop into an `#each`
 * that has an `#empty` went after the `#empty`, which in the source is
 * inside it: the element showed only when the list was empty.
 *
 * The rules of what may hold what (a ButtonGroup holds Buttons, an `#else`
 * belongs to its `#if`) changed the cursor and nothing else; the drop was
 * made whatever they said.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSource } from '../../utils/sourceParser';
import { generateSource } from '../../utils/sourceGenerator';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { CanvasElement } from './CanvasElement';

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
  canvas().loadState(parsed.elements, parsed.rootId);
}

function byText(text: string) {
  return [...canvas().elements.values()].find((el) => el.props.children === text)!;
}

function byType(type: string) {
  return [...canvas().elements.values()].find((el) => el.componentType === type)!;
}

function source(): string {
  return generateSource(canvas().elements, canvas().rootId!, '');
}

/** The children of the element of this type, as their text or type. */
function inside(type: string): string[] {
  return byType(type).children.map((id) => {
    const child = canvas().elements.get(id)!;
    return (child.props.children as string | undefined) ?? child.componentType;
  });
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

describe('moving an element within its own list', () => {
  beforeEach(() => open('<App><Stack><Text>A</Text><Text>B</Text><Text>C</Text><Text>D</Text></Stack></App>'));

  it('down, lands after the element it was dropped below', () => {
    const stack = byType('Stack');
    // The canvas counts the place with A still in the list: after B is 2.
    canvas().moveElement(byText('A').id, stack.id, 2);
    expect(inside('Stack')).toEqual(['B', 'A', 'C', 'D']);
  });

  it('down to the end, is last', () => {
    canvas().moveElement(byText('A').id, byType('Stack').id, 4);
    expect(inside('Stack')).toEqual(['B', 'C', 'D', 'A']);
  });

  it('up, lands before the element it was dropped above', () => {
    canvas().moveElement(byText('D').id, byType('Stack').id, 1);
    expect(inside('Stack')).toEqual(['A', 'D', 'B', 'C']);
  });

  it('onto its own place, stays', () => {
    canvas().moveElement(byText('B').id, byType('Stack').id, 1);
    expect(inside('Stack')).toEqual(['A', 'B', 'C', 'D']);
    canvas().moveElement(byText('B').id, byType('Stack').id, 2);
    expect(inside('Stack')).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('the pointer over an element inside another', () => {
  beforeEach(() => {
    open('<App><Stack><Text>Top</Text><Card><Text>In the card</Text></Card><Text>Bottom</Text></Stack></App>');
    mount();
  });

  it('is a drop into the inner one, not the one around it', () => {
    const card = byType('Card');
    placed(byType('Stack').id, 0);
    const node = placed(card.id, 200);
    act(() => canvas().setDraggedType('Button'));
    pointerAt(node, 250);
    expect(canvas().dropIndicator).toEqual({ parentId: card.id, index: 1 });

    release(node);
    expect(inside('Card')).toEqual(['In the card', 'Click me']);
    expect(inside('Stack')).toEqual(['Top', 'Card', 'Bottom']);
  });

  it('moves one element onto the upper half of another', () => {
    const top = placed(byText('Top').id, 100);
    placed(byType('Stack').id, 0);
    act(() => canvas().setDraggedElementId(byText('Bottom').id));
    pointerAt(top, 110);
    release(top);
    expect(inside('Stack')).toEqual(['Bottom', 'Top', 'Card']);
  });
});

describe('a drop into a block that has another branch', () => {
  it('goes into the branch of the block, before #empty', () => {
    open('<App>#each (task in tasks)\n<Text>{task}</Text>\n#empty\n<Text>None</Text>\n#end</App>');
    const each = byType('#each');
    // Where the canvas put a drop into the block: after its last child.
    canvas().addElement('Badge', each.id, each.children.length, { starter: true });
    expect(inside('#each')).toEqual(['{task}', 'Badge', '#empty']);
    expect(source()).toContain('<Badge variant="default">Badge</Badge>\n  #empty');
  });

  it('goes before #elseif and #else, by a move as well', () => {
    open('<App><Text>Loose</Text>#if (a)\n<Text>One</Text>\n#elseif (b)\n<Text>Two</Text>\n#else\n<Text>Three</Text>\n#end</App>');
    const block = byType('#if');
    canvas().moveElement(byText('Loose').id, block.id, block.children.length);
    expect(inside('#if')).toEqual(['One', 'Loose', '#elseif', '#else']);
  });
});

describe('what may not be dropped', () => {
  it('a branch stays with its block', () => {
    open('<App><Stack></Stack>#if (a)\n<Text>One</Text>\n#else\n<Text>Two</Text>\n#end</App>');
    const before = source();
    canvas().moveElement(byType('#else').id, byType('Stack').id, 0);
    expect(source()).toBe(before);
  });

  it('a Text is not dropped into a ButtonGroup, which holds Buttons', () => {
    open('<App><ButtonGroup><Button>One</Button></ButtonGroup><Text>Loose</Text></App>');
    mount();
    const group = byType('ButtonGroup');
    const node = placed(group.id, 0);
    act(() => canvas().setDraggedElementId(byText('Loose').id));
    pointerAt(node, 50);
    release(node);
    expect(inside('ButtonGroup')).toEqual(['One']);

    // A Button is.
    act(() => canvas().setDraggedType('Button'));
    pointerAt(node, 50);
    release(node);
    expect(inside('ButtonGroup')).toEqual(['One', 'Click me']);
  });
});
