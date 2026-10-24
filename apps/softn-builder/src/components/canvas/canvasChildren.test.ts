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
import { useProjectStore } from '../../stores/projectStore';
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
    // Each on the page itself: with one selected, the next would go beside its words.
    for (const type of ['Text', 'Heading', 'Badge', 'Tag', 'Kbd', 'Button', 'Alert']) {
      canvas().deselectAll();
      insertFromPalette(type);
    }
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

describe('something that stands in a line of words, over an element whose content is its words', () => {
  // A labelled Button took nothing at all once it stopped drawing a box for
  // children, so `<Button><Icon name="plus" /> Add</Button>`, the commonest
  // pattern there is, could be made only in Code. An Icon, a Kbd, a Badge, a
  // Tag or a Spinner is part of a line of words, and is taken into one: on
  // the side of the words the pointer is on.

  /** Let `dragged` go over the element of type `over`, at `x` across it and `y` down it (each 0 to 1). */
  function dropOn(over: string, dragged: string, x: number, y: number): void {
    placed(canvas().rootId!, 0);
    const node = placed(byType(over).id, 200);
    act(() => canvas().setDraggedType(dragged));
    act(() => {
      node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300 * x, clientY: 200 + 100 * y }));
    });
    release(node);
    act(() => canvas().setDraggedType(null));
  }

  /** The page as written, which has to be the page the same file gives back. */
  function written(): string {
    const text = source();
    const again = parseSource(text);
    expect(again.fidelity.reasons, text).toEqual([]);
    expect(generateSource(again.elements, again.rootId, ''), 'written again from what was read').toBe(text);
    return text;
  }

  it('goes after the words when let go on their right, with the space a line of words has', () => {
    open('<App><Text>Press</Text></App>');
    mount();
    dropOn('Text', 'Kbd', 0.8, 0.5);
    expect(written()).toBe('<App>\n  <Text>Press <Kbd keys="Ctrl+K" /></Text>\n</App>');
  });

  it('goes before the words when let go on their left', () => {
    open('<App><Button>Add</Button></App>');
    mount();
    dropOn('Button', 'Icon', 0.2, 0.5);
    expect(written()).toBe('<App>\n  <Button><Icon name="check" size={20} /> Add</Button>\n</App>');
  });

  it('shows on the element which side that is, before it is let go', () => {
    open('<App><Heading>Inbox</Heading></App>');
    mount();
    placed(canvas().rootId!, 0);
    const node = placed(byType('Heading').id, 200);
    act(() => canvas().setDraggedType('Badge'));
    act(() => {
      node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 250, clientY: 250 }));
    });
    expect(canvas().dropIndicator).toMatchObject({ parentId: byType('Heading').id, side: 'end' });
    expect(host.querySelector('[data-drop-side="end"]')).not.toBeNull();
    expect(host.textContent).toContain('after its words');
    act(() => {
      node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 250 }));
    });
    expect(host.querySelector('[data-drop-side="start"]')).not.toBeNull();
    expect(host.textContent).toContain('before its words');
    act(() => canvas().setDraggedType(null));
  });

  describe('where the words are a small part of the row the element is drawn as', () => {
    // A Button is a row of the page, and its label the left end of that
    // row. Measured against the row, every point on the label was "before
    // its words": "after" began at the middle of the row, far to the right
    // of the label, and that is where the bar was drawn too. And an Icon
    // meant to go beside the Button had only the top and the bottom few
    // pixels of the row to be let go in. The words are what is measured:
    // on them is into them, and the rest of the row is beside the element,
    // as it is for anything else.

    /** The words as a browser would measure them: 16 to 76 across a row that is 300 wide. */
    const words = { left: 16, right: 76, width: 60, top: 230, bottom: 270, height: 40, x: 16, y: 230, toJSON: () => ({}) };
    const ranges = Range.prototype as { getBoundingClientRect?: () => DOMRect };
    let unmeasured: (() => DOMRect) | undefined;
    beforeEach(() => {
      unmeasured = ranges.getBoundingClientRect;
      ranges.getBoundingClientRect = () => words as DOMRect;
    });
    afterEach(() => {
      if (unmeasured) ranges.getBoundingClientRect = unmeasured;
      else delete ranges.getBoundingClientRect;
    });

    /** Hold an Icon over the Button at `x` across the row and `y` down the page, and say what is offered. */
    function held(x: number, y = 250) {
      placed(canvas().rootId!, 0);
      const node = placed(byType('Button').id, 200);
      act(() => canvas().setDraggedType('Icon'));
      act(() => {
        node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
      });
      return canvas().dropIndicator;
    }

    it('goes before or after them by which half of the words the pointer is on', () => {
      open('<App><Button>Save</Button></App>');
      mount();
      expect(held(30)).toEqual({ parentId: byType('Button').id, index: 0, side: 'start' });
      expect(held(60)).toEqual({ parentId: byType('Button').id, index: 0, side: 'end' });
      act(() => canvas().setDraggedType(null));
    });

    it('is shown where it would go: the bar stands at that end of the words, not of the row', () => {
      open('<App><Button>Save</Button></App>');
      mount();
      held(60);
      expect(host.querySelector<HTMLElement>('[data-drop-side="end"]')!.style.left).toBe('78px');
      held(30);
      expect(host.querySelector<HTMLElement>('[data-drop-side="start"]')!.style.left).toBe('11px');
      act(() => canvas().setDraggedType(null));
    });

    it('goes beside the element anywhere on the row away from its words, at any height', () => {
      open('<App><Button>Save</Button></App>');
      mount();
      expect(held(200, 240)).toEqual({ parentId: canvas().rootId, index: 0 });
      expect(held(200, 260)).toEqual({ parentId: canvas().rootId, index: 1 });
      // A little past the end of the words is still on them: a label is a small thing to aim at.
      expect(held(90)).toMatchObject({ parentId: byType('Button').id, side: 'end' });
      act(() => canvas().setDraggedType(null));
    });
  });

  it('still goes beside the element in its upper and lower quarter, as anything does', () => {
    open('<App><Button>Add</Button></App>');
    mount();
    dropOn('Button', 'Icon', 0.5, 0.1);
    dropOn('Button', 'Badge', 0.5, 0.9);
    expect(byType('App').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['Icon', 'Button', 'Badge']);
    expect(byType('Button').children).toEqual([]);
  });

  it('is the only kind taken: a Card or another Button goes beside', () => {
    open('<App><Text>One</Text></App>');
    mount();
    dropOn('Text', 'Card', 0.5, 0.5);
    dropOn('Text', 'Button', 0.5, 0.5);
    expect(byType('Text').children).toEqual([]);
    expect(source()).toContain('<Text>One</Text>\n  <Button');
  });

  it('is not taken by its own kind, nor a Tag by a Button, which would hold a button inside a button', () => {
    open('<App><Badge>New</Badge><Button>Add</Button></App>');
    const context = { elements: canvas().elements };
    expect(canDropInto(byType('Badge'), 'Badge', context)).toBe(false);
    expect(canDropInto(byType('Badge'), 'Icon', context)).toBe(true);
    expect(canDropInto(byType('Button'), 'Tag', context)).toBe(false);
    expect(canDropInto(byType('Button'), 'Spinner', context)).toBe(true);
  });

  it('is taken the same way when it is moved there from elsewhere on the page', () => {
    open('<App><Heading>Inbox</Heading><Badge>3</Badge></App>');
    mount();
    placed(canvas().rootId!, 0);
    const node = placed(byType('Heading').id, 200);
    act(() => canvas().setDraggedElementId(byType('Badge').id));
    act(() => {
      node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 280, clientY: 250 }));
    });
    release(node);
    expect(written()).toBe('<App>\n  <Heading>Inbox <Badge>3</Badge></Heading>\n</App>');
  });

  it('is still the only kind taken once the element holds one: a Text with a key takes a Badge and not a Card', () => {
    open('<App><Text>Press <Kbd>S</Kbd></Text><Stack><Text>Deep</Text></Stack></App>');
    const text = byType('Text');
    const context = { elements: canvas().elements };
    expect(canDropInto(text, 'Badge', context)).toBe(true);
    expect(canDropInto(text, '#if', context)).toBe(true);
    expect(canDropInto(text, '#text', context)).toBe(true);
    expect(canDropInto(text, 'Card', context)).toBe(false);
    expect(canDropInto(text, 'Button', context)).toBe(false);
    // A native element that holds elements is a container like any other.
    open('<App><div><span>One</span></div></App>');
    expect(canDropInto(byType('div'), 'Card', { elements: canvas().elements })).toBe(true);
  });

  it('goes beside the whole line when it is let go over a word or a key in it and is no part of one', () => {
    // The word under the pointer had nowhere to offer and said so, and that
    // was the answer: nothing was shown, and the Card landed at the end of
    // the page when the button was let go.
    open('<App><Heading>Above</Heading><Text>Hold <Kbd>S</Kbd></Text></App>');
    mount();
    placed(canvas().rootId!, 0);
    const text = byType('Text');
    placed(text.id, 200);
    const words = host.querySelector<HTMLElement>(`[data-canvas-element-id="${text.children[0]}"]`)!.parentElement!;
    act(() => canvas().setDraggedType('Card'));
    act(() => {
      words.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 220 }));
    });
    expect(canvas().dropIndicator).toEqual({ parentId: canvas().rootId, index: 1 });
    act(() => {
      words.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 280 }));
    });
    expect(canvas().dropIndicator).toEqual({ parentId: canvas().rootId, index: 2 });
    act(() => canvas().setDraggedType(null));
  });

  it('is shown no place where neither the word under it nor anything around that has one', () => {
    // Asking outwards must still end: a place shown a moment ago is taken
    // away when the last to be asked has none either.
    open('<App><Text>Hold <Kbd>S</Kbd></Text></App>');
    mount();
    placed(canvas().rootId!, 0);
    const text = byType('Text');
    placed(text.id, 200);
    const words = host.querySelector<HTMLElement>(`[data-canvas-element-id="${text.children[0]}"]`)!.parentElement!;
    act(() => canvas().setDropIndicator({ parentId: canvas().rootId!, index: 0 }));
    // A branch of a block is dropped nowhere on its own.
    act(() => canvas().setDraggedType('#else'));
    act(() => {
      words.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 220 }));
    });
    expect(canvas().dropIndicator).toBeNull();
    act(() => canvas().setDraggedType(null));
  });

  it('is joined in a line that holds elements by a Text, which is a run of its words, and by what the line holds changing places', () => {
    // The shipped apps style part of a line with a Text inside a Text (79
    // times in the 78 pages of the directory's apps) and with a span (11).
    // Held to the kinds the palette marks as part of a line alone, such a
    // line took no second run, and its own runs could not be put in
    // another order.
    open('<App><Text>Score: <Text weight="bold">{score}</Text> <span>pts</span></Text><Kbd>S</Kbd></App>');
    const context = { elements: canvas().elements };
    const line = [...canvas().elements.values()].find((element) => element.componentType === 'Text' && element.parentId === canvas().rootId)!;
    expect(canDropInto(line, 'Text', context)).toBe(true);
    expect(canDropInto(line, 'span', { ...context, draggedId: byType('span').id })).toBe(true);
    // Still not what is no part of a line, nor a span from somewhere else.
    expect(canDropInto(line, 'Card', context)).toBe(false);
    expect(canDropInto(line, 'span', context)).toBe(false);
    // A key that holds its letter is not a line a Text goes into.
    expect(canDropInto(byType('Kbd'), 'Text', context)).toBe(false);
  });

  it('is the only kind a key takes too, once it holds its letter as words', () => {
    // `<Kbd>S</Kbd>` holds its letter as words, having no Text field for it,
    // and anything that holds elements took more of any kind: a Button let
    // go over the key went inside the key.
    open('<App><Kbd>S</Kbd><Greeting>Hello <b>you</b></Greeting></App>');
    const context = { elements: canvas().elements };
    expect(canDropInto(byType('Kbd'), 'Button', context)).toBe(false);
    expect(canDropInto(byType('Kbd'), 'Card', context)).toBe(false);
    expect(canDropInto(byType('Kbd'), 'Icon', context)).toBe(true);
    expect(canDropInto(byType('Kbd'), '#text', context)).toBe(true);
    // A component the registry does not know, a page's own, takes any kind.
    expect(canDropInto(byType('Greeting'), 'Card', context)).toBe(true);
  });

  it('is taken by a Text that has no words yet', () => {
    open('<App><Text size="lg" /></App>');
    mount();
    dropOn('Text', 'Icon', 0.5, 0.5);
    expect(written()).toBe('<App>\n  <Text size="lg">\n    <Icon name="check" size={20} />\n  </Text>\n</App>');
  });
});

describe('an element being moved, held over itself or over what it holds', () => {
  it('is offered no place there, and stays where it is when let go', () => {
    // A Card held over its own Text was shown a line inside itself, where
    // it cannot go: let go there, nothing moved and an Undo step was
    // recorded for it all the same. And the place shown a moment before it
    // came back over itself stayed up, so putting it down where it was
    // picked up moved it there.
    open('<App><Heading>Top</Heading><Card><Text>In</Text></Card></App>');
    mount();
    placed(canvas().rootId!, 0);
    const card = placed(byType('Card').id, 200);
    const text = placed(byType('Text').id, 240);
    act(() => canvas().setDraggedElementId(byType('Card').id));
    act(() => canvas().setDropIndicator({ parentId: canvas().rootId!, index: 0 }));
    pointerAt(text, 250);
    expect(canvas().dropIndicator).toBeNull();

    act(() => canvas().setDropIndicator({ parentId: canvas().rootId!, index: 0 }));
    pointerAt(card, 210);
    expect(canvas().dropIndicator).toBeNull();

    const steps = useHistoryStore.getState().past.length;
    release(text);
    expect(byType('App').children.map((id) => canvas().elements.get(id)!.componentType)).toEqual(['Heading', 'Card']);
    expect(useHistoryStore.getState().past).toHaveLength(steps);
    act(() => canvas().setDraggedElementId(null));
  });
});

describe('a component the canvas draws as itself', () => {
  // Ten components were drawn by hand and every other was a card with its
  // name on it, so a page of Badges, Tabs and form controls was a stack of
  // grey cards. Nothing else about the element on the canvas changes with
  // what is drawn inside it.

  /** The drawing inside the element of this type: the component itself, or null where a stand-in is drawn. */
  function drawnIn(type: string): HTMLElement | null {
    return host.querySelector<HTMLElement>(`[data-canvas-element-id="${byType(type).id}"] > [aria-hidden="true"] > [data-softn-drawn]`);
  }

  it('is the component, where it was a card that named it', () => {
    open('<App><Badge variant="success">Shipped</Badge><Progress value={40} /><Checkbox label="Done" /></App>');
    mount();
    expect(drawnIn('Badge')!.textContent).toBe('Shipped');
    expect(drawnIn('Progress')!.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('40');
    expect(drawnIn('Checkbox')!.querySelector('input[type="checkbox"]')).not.toBeNull();
    // The card said what it was in words; the element still does, for the hierarchy and a screen reader.
    expect(host.querySelector(`[data-canvas-element-id="${byType('Badge').id}"]`)!.getAttribute('aria-label')).toBe('Select Badge component');
  });

  it('is a picture: inert, with nothing in it that takes the focus, and the element around it is what is picked', () => {
    open('<App><Checkbox label="Done" /><Select placeholder="Pick" /></App>');
    mount();
    for (const type of ['Checkbox', 'Select']) {
      const drawing = drawnIn(type)!;
      expect(drawing.hasAttribute('inert'), type).toBe(true);
      const element = host.querySelector<HTMLElement>(`[data-canvas-element-id="${byType(type).id}"]`)!;
      // One tab stop for the element, as before: the canvas item itself.
      expect(element.getAttribute('role')).toBe('treeitem');
      expect([...element.querySelectorAll('input, button, select, [tabindex]')].filter((node) => !node.closest('[inert]')), type).toEqual([]);
    }
    act(() => {
      drawnIn('Checkbox')!.querySelector('input')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(canvas().selectedIds).toEqual([byType('Checkbox').id]);
  });

  it('is still drawn by hand where what is measured on the canvas is the drawing: a Button, a Text, a Heading', () => {
    open('<App><Button>Save</Button><Text>Words</Text><Heading>Title</Heading><Card></Card><Stack></Stack></App>');
    mount();
    for (const type of ['Button', 'Text', 'Heading', 'Card', 'Stack']) expect(drawnIn(type), type).toBeNull();
  });

  it('stays itself when it holds an element among its words, drawn with both in it, and they are still its children to pick up', () => {
    // It went back to a card with its name: a Badge turned grey the moment
    // an Icon was put in it, and so did a Tag and a CopyButton.
    open('<App><Badge variant="success"><Icon name="check" /> Shipped</Badge><Tag><Kbd keys="K" /> Key</Tag><CopyButton value="x"><Icon name="copy" /> Copy</CopyButton></App>');
    mount();
    const badge = drawnIn('Badge')!;
    expect(badge.textContent).toBe(' Shipped');
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(drawnIn('Tag')!.querySelector('kbd')!.textContent).toBe('K');
    expect(drawnIn('CopyButton')!.textContent).toContain('Copy');
    // What it holds is below it as before, each a thing to select, move and delete.
    expect(hasChildrenArea('Badge')).toBe(true);
    expect(drawnIn('Icon')).not.toBeNull();

    // The drawing follows what it holds: the Icon taken out, and the words changed.
    const words = [...canvas().elements.values()].find((el) => el.props.children === ' Shipped')!;
    act(() => canvas().updateElementProps(words.id, { children: ' Done' }));
    expect(drawnIn('Badge')!.textContent).toBe(' Done');
    act(() => canvas().deleteElement(byType('Icon').id));
    expect(drawnIn('Badge')!.textContent?.trim()).toBe('Done');
    expect(drawnIn('Badge')!.querySelector('svg')).toBeNull();
  });

  it('is a card again when it holds something that does not stand among words', () => {
    // A Card in a Badge is nothing the Badge can be drawn with inside it.
    open('<App><Badge>New <Card></Card></Badge></App>');
    mount();
    expect(drawnIn('Badge')).toBeNull();
    expect(hasChildrenArea('Badge')).toBe(true);
  });

  it('stays itself over what it lays out under its own content, and is a card where it would lay its children out itself', () => {
    // An EmptyState puts what it holds under its description, which is
    // where the canvas draws an element's children. What a Skeleton holds is
    // shown in place of the Skeleton, and a Stat lays its children out itself.
    open('<App><EmptyState title="Nothing yet"><Button>Add</Button></EmptyState><Skeleton><Text>Loaded</Text></Skeleton><Stat label="Open" value="3" /></App>');
    mount();
    expect(drawnIn('EmptyState')!.textContent).toContain('Nothing yet');
    // Drawn once, below it, and not inside the drawing as well.
    expect(drawnIn('EmptyState')!.textContent).not.toContain('Add');
    expect(hasChildrenArea('EmptyState')).toBe(true);
    expect(drawnIn('Skeleton')).toBeNull();
    // Holding nothing, a container is drawn as itself, and still takes a drop.
    expect(drawnIn('Stat')!.textContent).toContain('Open');
    expect(hasChildrenArea('Stat')).toBe(true);
    expect(dropFromPalette('Text', 'Stat')).toEqual(['Text']);
    expect(drawnIn('Stat')).toBeNull();
  });

  describe('a picture of the project\'s own', () => {
    // Driven in Chromium first, with one picture in the project's assets:
    //
    //   written                          the canvas          Preview, and the app
    //   <Image src="assets/a.png">       the picture         "Failed to load"
    //   <Image src={asset("…")}>         "Missing image…"    the picture
    //   <Avatar src={asset("…")}>        initials            the picture
    //
    // The app is handed a file of its bundle by `asset("…")` and by nothing
    // else, and the first row is what the panel's own list of assets wrote.
    const made: Blob[] = [];
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    const element = (id: string) => host.querySelector<HTMLElement>(`[data-canvas-element-id="${id}"]`)!;
    const all = (type: string) => [...canvas().elements.values()].filter((el) => el.componentType === type);

    beforeEach(() => {
      made.length = 0;
      URL.createObjectURL = (blob: Blob) => `blob:picture-${made.push(blob)}`;
      URL.revokeObjectURL = () => undefined;
      act(() => useProjectStore.getState().setAssets([{ name: 'ada.png', bundlePath: 'assets/ada.png', type: 'image/png', data: new Uint8Array([1, 2, 3]) }]));
    });
    afterEach(() => {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
      act(() => useProjectStore.getState().setAssets([]));
    });

    it('is drawn for an Image that asks for it as the app does, and not for its bare path', () => {
      open('<App><Image src={asset("assets/ada.png")} alt="called" /><Image src="assets/ada.png" alt="by path" /><Image src="assets/missing.png" alt="not there" /></App>');
      mount();
      const [called, byPath, missing] = all('Image');
      expect(element(called.id).querySelector('img')?.getAttribute('src')).toBe('blob:picture-1');
      expect(element(byPath.id).querySelector('img')).toBeNull();
      expect(element(byPath.id).textContent).toContain('assets/ada.png is written as a path, which the app does not load. Choose the picture under Asset in Properties.');
      expect(element(missing.id).textContent).toContain('Missing image source: assets/missing.png');
      expect(made).toHaveLength(1);
    });

    it('is drawn for an Avatar that asks for it, where every Avatar showed its initials', () => {
      // Nothing drawn on the canvas is given an address to fetch, so an
      // Avatar with an address keeps its initials here. A picture in the
      // project's assets is bytes the page already holds.
      open('<App><Avatar name="Ada Lovelace" src={asset(\'assets/ada.png\')} /><Tag>between</Tag><Avatar name="Grace Hopper" src="https://example.com/grace.png" /><Avatar name="Mary Shelley" src="assets/ada.png" /></App>');
      mount();
      const [ada, grace, mary] = all('Avatar');
      const drawing = (id: string) => element(id).querySelector<HTMLElement>(':scope > [aria-hidden="true"] > [data-softn-drawn]')!;
      expect(drawing(ada.id).querySelector('img')?.getAttribute('src')).toBe('blob:picture-1');
      expect(made).toHaveLength(1);
      expect(drawing(grace.id).querySelector('img')).toBeNull();
      expect(drawing(grace.id).textContent).toBe('GH');
      // By its path the app shows initials, and so does the canvas.
      expect(drawing(mary.id).querySelector('img')).toBeNull();
      expect(drawing(mary.id).textContent).toBe('MS');
    });

    it('is an SVG drawn from a data: URL, which no one can open as a page of the Builder', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
      act(() => useProjectStore.getState().setAssets([{ name: 'logo.svg', bundlePath: 'assets/logo.svg', type: 'image/svg+xml', data: new TextEncoder().encode(svg) }]));
      open('<App><Image src={asset("assets/logo.svg")} alt="logo" /></App>');
      mount();
      const src = element(all('Image')[0].id).querySelector('img')?.getAttribute('src') ?? '';
      expect(src.startsWith('data:image/svg+xml;base64,')).toBe(true);
      expect(atob(src.split(',')[1])).toBe(svg);
      expect(made).toHaveLength(0);
    });
  });

  it('is drawn in the project\'s theme, on an artboard that is the app\'s page in that theme', () => {
    // The artboard was paper whatever the project, and a dark project's
    // components stood on it as black tiles among light ones; for a while
    // everything was drawn light to be one thing. The artboard is the
    // app's page now: its tokens are the project's, its colours the
    // page's, and what is drawn on it by hand reads the same.
    const whole = (source: string) => {
      act(() => root?.unmount());
      open(source);
      root = createRoot(host);
      act(() => root!.render(React.createElement(Canvas)));
      return {
        board: host.querySelector<HTMLElement>('[data-builder-canvas]')!,
        page: host.querySelector<HTMLElement>('[data-builder-canvas] [data-builder-page]')!,
      };
    };
    useProjectStore.getState().setThemeMode('dark');
    try {
      const dark = whole('<App theme="system"><Badge>Shipped</Badge><Text>Words</Text></App>');
      expect(dark.board.getAttribute('data-app-tokens')).toBe('dark');
      expect(dark.page.getAttribute('data-builder-page')).toBe('dark');
      // The page is what a dark App makes of its own container.
      expect(dark.page.classList.contains('softn-theme-dark')).toBe(true);
      expect(dark.page.style.getPropertyValue('background')).toContain('--color-bg');
      // The hand-drawn Text and the drawn Badge are both inside it.
      expect(dark.page.contains(host.querySelector(`[data-canvas-element-id="${byType('Text').id}"]`))).toBe(true);
      expect(drawnIn('Badge')!.getAttribute('data-softn-drawn')).toBe('dark');

      // A page that pins light in a dark project is a light page with the
      // light tokens: the tokens go with the page, as the app runs it.
      const pinned = whole('<App theme="light"><Badge>Shipped</Badge></App>');
      expect(pinned.board.getAttribute('data-app-tokens')).toBe('light');
      expect(pinned.page.getAttribute('data-builder-page')).toBe('light');
      expect(pinned.page.classList.contains('softn-theme-light')).toBe(true);
    } finally {
      useProjectStore.getState().setThemeMode('light');
    }
    const light = whole('<App><Badge>Shipped</Badge></App>');
    expect(light.board.getAttribute('data-app-tokens')).toBe('light');
    expect(light.page.getAttribute('data-builder-page')).toBe('light');
  });

  it('is not drawn for a name the page has imported over: that is the page\'s own component', () => {
    const parsed = parseSource('<App><Badge>Mine</Badge></App>');
    canvas().loadState(parsed.elements, parsed.rootId, [{ name: 'Badge', source: './Badge.ui' }]);
    mount();
    expect(drawnIn('Badge')).toBeNull();
    expect(host.textContent).toContain('Imported');
  });

  it('is measured for a drop among its words by the component, not by the page it is drawn in', () => {
    // The page around a drawn component is as wide as the row. Measured by
    // that, an Icon let go anywhere on the row of a Badge went into it.
    open('<App><Badge>Shipped</Badge></App>');
    mount();
    const measured: Node[] = [];
    const ranges = Range.prototype as { getBoundingClientRect?: () => DOMRect; selectNodeContents: (node: Node) => void };
    const select = ranges.selectNodeContents;
    const box = ranges.getBoundingClientRect;
    ranges.selectNodeContents = function (this: Range, node: Node) {
      measured.push(node);
      return select.call(this, node);
    };
    ranges.getBoundingClientRect = () => ({ left: 16, right: 76, width: 60, top: 230, bottom: 270, height: 40, x: 16, y: 230, toJSON: () => ({}) }) as DOMRect;
    try {
      placed(canvas().rootId!, 0);
      const node = placed(byType('Badge').id, 200);
      act(() => canvas().setDraggedType('Icon'));
      act(() => {
        node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 60, clientY: 250 }));
      });
      expect(canvas().dropIndicator).toEqual({ parentId: byType('Badge').id, index: 0, side: 'end' });
      expect(measured.some((at) => (at as HTMLElement).hasAttribute?.('data-softn-drawn-content'))).toBe(true);
      act(() => {
        node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 250 }));
      });
      expect(canvas().dropIndicator).toEqual({ parentId: canvas().rootId, index: 1 });
    } finally {
      ranges.selectNodeContents = select;
      if (box) ranges.getBoundingClientRect = box;
      else delete ranges.getBoundingClientRect;
      act(() => canvas().setDraggedType(null));
    }
  });
});

describe('a Stack and a Box on the canvas', () => {
  it('say what they are, as every other container does', () => {
    // Each was a grey bar with nothing written on it: every other
    // component is drawn with its name, and these two, which a page is
    // mostly made of, could be told apart only by hovering over each.
    open('<App><Stack direction="horizontal"><Box></Box></Stack><Card></Card></App>');
    mount();
    const named = (type: string) => host.querySelector(`[data-canvas-element-id="${byType(type).id}"] > [aria-hidden] [data-canvas-container-name]`)?.textContent;
    expect(named('Stack')).toBe('Stack · horizontal');
    expect(named('Box')).toBe('Box');
  });
});

describe('the empty page', () => {
  function emptyCanvas(props: { onShowComponents?: () => void } = {}): void {
    root = createRoot(host);
    act(() => root!.render(React.createElement(Canvas, props)));
  }

  it('says to drag one from Components while that panel is open', () => {
    emptyCanvas();
    expect(host.textContent).toContain('Drag one from Components onto this page');
    expect(host.querySelector('[data-action="show-components"]')).toBeNull();
  });

  it('opens the Components panel from its own sentence where the panel is shut', () => {
    // In a narrow window the panel starts as a rail at the far left, and the
    // page still said "Drag one from Components", which was not there.
    let opened = 0;
    emptyCanvas({ onShowComponents: () => { opened += 1; } });
    const open = host.querySelector<HTMLButtonElement>('[data-action="show-components"]')!;
    expect(open.textContent).toBe('Open Components');
    expect(host.textContent).toContain('Open Components, then drag one onto this page');
    act(() => open.click());
    expect(opened).toBe(1);
  });
});

describe('a selected element', () => {
  it('is outlined, with nothing at its corners that looks like it resizes', () => {
    // Four squares stood at the corners with resize cursors and did
    // nothing: an element's size is its properties, not a drag. They also
    // took the press, so an element could not be picked up by a corner.
    open('<App><Card></Card></App>');
    mount();
    act(() => canvas().selectElement(byType('Card').id));
    const node = host.querySelector<HTMLElement>(`[data-canvas-element-id="${byType('Card').id}"]`)!;
    const outline = node.querySelector<HTMLElement>('[data-selection-outline]')!;
    expect(outline).not.toBeNull();
    expect(outline.style.pointerEvents).toBe('none');
    expect(outline.children).toHaveLength(0);
    expect([...node.querySelectorAll<HTMLElement>('*')].filter((el) => el.style.cursor.includes('resize'))).toEqual([]);
  });
});

describe('words, moved', () => {
  it('do not go into a container that holds one kind of element', () => {
    // A block may, being how its elements are made; the rule read any type
    // beginning `#` as a block, and words are `#text`.
    open('<App><AvatarGroup></AvatarGroup><Card>Loose <Badge>words</Badge></Card></App>');
    const words = [...canvas().elements.values()].find((el) => el.componentType === '#text')!;
    expect(canDropInto(byType('AvatarGroup'), words.componentType, { elements: canvas().elements, draggedId: words.id })).toBe(false);
    expect(canDropInto(byType('AvatarGroup'), '#each', { elements: canvas().elements })).toBe(true);
  });
});

describe('the line that shows where a drop would go, between two elements of the page', () => {
  it('takes up no room, so the element under the pointer is not pushed out from under it', () => {
    // It was three pixels of the page's flow. Held in the top few pixels of
    // an element, a drop was offered before it, the line pushed the element
    // down from under the pointer, which the canvas took for the pointer
    // leaving, and the offer was withdrawn: let go there, what was dragged
    // landed at the end of the page.
    open('<App><Heading>One</Heading><Text>Two</Text></App>');
    root = createRoot(host);
    act(() => root!.render(React.createElement(Canvas)));
    act(() => canvas().setDraggedType('Divider'));
    act(() => canvas().setDropIndicator({ parentId: canvas().rootId!, index: 1 }));
    const line = host.querySelector<HTMLElement>('[data-drop-line]')!;
    expect(line).not.toBeNull();
    const px = (value: string) => Number.parseFloat(value || '0');
    expect(px(line.style.height) + px(line.style.marginTop) + px(line.style.marginBottom)).toBe(0);
    act(() => canvas().setDraggedType(null));
    act(() => canvas().setDropIndicator(null));
  });
});

describe('a drop over the middle of an element', () => {
  it('goes beside a Text when it is not part of a line of words', () => {
    // This used to be a Badge, which is now taken into the Text (above).
    open('<App><Text>One</Text></App>');
    mount();
    expect(dropFromPalette('Card', 'Text')).toEqual([]);
    expect(source()).toBe('<App>\n  <Text>One</Text>\n  <Card padding="md" variant="elevated" />\n</App>');
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
