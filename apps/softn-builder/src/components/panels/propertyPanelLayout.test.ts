// @vitest-environment jsdom
/**
 * What the property panel puts first, and where it starts.
 *
 * A card for control flow stood above every element's own properties, and
 * the groups under it were all open, so at 1024 by 768 one property was in
 * sight. The element's own properties are first now, the groups a person
 * seldom needs are folded to their headings (and say when something in them
 * is set), a new selection is read from the top, and with nothing selected
 * the panel says so in a line and offers the project's theme.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSource } from '../../utils/sourceParser';
import { generateSource } from '../../utils/sourceGenerator';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
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

/** Open `source` on the canvas and show the panel, with nothing selected yet. */
function open(source: string): void {
  const parsed = parseSource(source);
  canvas().loadState(parsed.elements, parsed.rootId);
  root = createRoot(host);
  act(() => root!.render(React.createElement(PropertyPanel)));
}

function idOf(tag: string, nth = 0): string {
  return [...canvas().elements.values()].filter((el) => el.componentType === tag)[nth].id;
}

function select(tag: string, nth = 0): string {
  const id = idOf(tag, nth);
  act(() => canvas().selectElement(id));
  return id;
}

/** The groups of the panel in the order they are drawn, each with whether it is open. */
function groups(): string[] {
  return [...host.querySelectorAll('[data-prop-group]')].map((group) => {
    const name = group.getAttribute('data-prop-group')!;
    const head = group.querySelector(':scope > button[aria-expanded]');
    return head ? `${name}:${head.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed'}` : name;
  });
}

const head = (name: string) => host.querySelector<HTMLButtonElement>(`[data-prop-group="${name}"] > button`)!;
const labels = (within: ParentNode = host) => [...within.querySelectorAll('label')].map((label) => label.textContent);
const scroller = () => host.querySelector<HTMLElement>('.bl-pp-body')!;

function type(input: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the order of the panel', () => {
  it('has the element\'s own properties first, and the wrapping in a block last', () => {
    open('<App><Stack><Button>Go</Button></Stack></App>');
    select('Button');
    expect(groups()).toEqual(['own', 'events:open', 'accessibility:open', 'bindings:closed', 'handlers:closed', 'style:closed', 'directives:closed', 'control-flow']);
    // Its words, then what the component lists, in its order; under no heading.
    const own = host.querySelector('[data-prop-group="own"]')!;
    // (The last two are the component's own that the entry left out: componentRegistry.ts, EXPECTED_PROPS.)
    expect(labels(own)).toEqual(['Text', 'variant', 'size', 'disabled', 'loading', 'fullWidth', 'type', 'title', 'rounded', 'iconOnly']);
    expect(own.closest('section')).toBeNull();
    // Nothing of the panel stands between its top and those fields but what the element is.
    const body = scroller();
    expect(body.firstElementChild!.contains(own)).toBe(true);
    expect(body.lastElementChild!.querySelector('[data-block-action="wrap-if"]')).not.toBeNull();
    expect(body.lastElementChild!.querySelector('[data-block-action="wrap-each"]')).not.toBeNull();
  });

  it('gives a list its data among its own properties, not under Advanced', () => {
    open('<App><SmartList data={tasks} primary="title" /></App>');
    select('SmartList');
    expect(labels(host.querySelector('[data-prop-group="own"]')!)).toContain('data');
    expect(host.textContent).not.toContain('Advanced');
    expect(host.textContent).not.toContain('Main');
  });

  it('names what is selected in its header, with what it is beside the name and on no line of its own', () => {
    open('<App><Stack><Button>Go</Button></Stack></App>');
    select('Button');
    expect(host.querySelector('[data-selection-name]')?.textContent).toBe('Button');
    expect(host.querySelector('[data-selection-kind]')?.textContent).toBe('Interactive button');
    expect(scroller().textContent).not.toContain('Interactive button');
    // The fields are the first thing under the header.
    expect(scroller().firstElementChild!.firstElementChild).toBe(host.querySelector('[data-prop-group="own"]'));
  });

  it('puts a short field beside its label, and gives words and expressions the panel\'s width', () => {
    open('<App><Modal open={showModal} title="Hello" size="lg" closeOnEscape={false}>Body</Modal></App>');
    select('Modal');
    const fieldOf = (name: string) => [...host.querySelectorAll('label')].find((label) => label.textContent === name)!.closest('.bl-pp-field')!;
    for (const name of ['title', 'size', 'closeOnEscape']) expect(fieldOf(name).hasAttribute('data-inline'), name).toBe(true);
    expect(fieldOf('open').hasAttribute('data-inline')).toBe(false);
  });
});

describe('a group a person seldom needs', () => {
  it('is closed until it is opened, and stays as it was left for the next element', () => {
    open('<App><Input /><Input /></App>');
    select('Input');
    expect(labels()).not.toContain(':bind');
    act(() => head('bindings').click());
    expect(head('bindings').getAttribute('aria-expanded')).toBe('true');
    expect(labels()).toContain(':bind');
    select('Input', 1);
    expect(labels()).toContain(':bind');
    act(() => head('bindings').click());
    expect(labels()).not.toContain(':bind');
  });

  it('is open where something in it is set, and does not fold while that is emptied', () => {
    open('<App><Input :bind={title} @keydown={go(event)} className="wide" /><Input /></App>');
    select('Input');
    expect(groups()).toEqual(['own', 'events:open', 'bindings:open', 'handlers:open', 'style:open', 'directives:closed', 'control-flow']);
    const bind = document.getElementById([...host.querySelectorAll('label')].find((label) => label.textContent === ':bind')!.htmlFor) as HTMLTextAreaElement;
    type(bind, '');
    expect(generateSource(canvas().elements, canvas().rootId, '')).not.toContain(':bind');
    expect(head('bindings').getAttribute('aria-expanded')).toBe('true');
    // The next element holds nothing there: closed again.
    select('Input', 1);
    expect(groups()).toEqual(['own', 'events:open', 'bindings:closed', 'handlers:closed', 'style:closed', 'directives:closed', 'control-flow']);
  });

  it('says on its heading how many are set when it is closed over them', () => {
    open('<App><Input :bind={title} :disabled={busy} /></App>');
    select('Input');
    expect(head('bindings').textContent).toBe('Bindings');
    act(() => head('bindings').click());
    expect(head('bindings').getAttribute('aria-expanded')).toBe('false');
    expect(head('bindings').textContent).toBe('Bindings2 set');
    expect(host.querySelector('[data-prop-group="bindings"] [data-group-set]')?.textContent).toBe('2 set');
    // Open, the fields say it themselves.
    act(() => head('bindings').click());
    expect(head('bindings').textContent).toBe('Bindings');
  });
});

describe('where the panel starts', () => {
  it('is the top for a new selection, and is left alone while a field is typed in', () => {
    open('<App><Input placeholder="One" /><Input placeholder="Two" /></App>');
    select('Input');
    scroller().scrollTop = 240;

    // Typing in a field of the same element moves nothing.
    const placeholder = document.getElementById([...host.querySelectorAll('label')].find((label) => label.textContent === 'placeholder')!.htmlFor) as HTMLInputElement;
    type(placeholder, 'On');
    type(placeholder, 'One more');
    expect(scroller().scrollTop).toBe(240);
    act(() => head('directives').click());
    expect(scroller().scrollTop).toBe(240);

    select('Input', 1);
    expect(scroller().scrollTop).toBe(0);

    // And for no selection, and for several.
    scroller().scrollTop = 120;
    act(() => canvas().deselectAll());
    expect(scroller().scrollTop).toBe(0);
    scroller().scrollTop = 60;
    act(() => {
      canvas().selectElement(idOf('Input'));
      canvas().selectElement(idOf('Input', 1), true);
    });
    expect(scroller().scrollTop).toBe(0);
  });
});

describe('nothing selected', () => {
  it('is said in a line at the top, with the project\'s theme under it', () => {
    open('<App><Button>Go</Button></App>');
    const body = scroller();
    const said = body.querySelector('[data-nothing-selected]')!;
    expect(body.firstElementChild).toBe(said);
    expect(said.textContent).toBe('Nothing selectedPick an element on the canvas or in the hierarchy to change it here.');
    expect(said.querySelector('svg')).toBeNull();
    expect(groups()).toEqual(['theme:open']);
    expect(body.querySelectorAll('[data-project-theme] [role="radio"]')).toHaveLength(3);
    // No selection, so nothing to move or delete.
    expect(host.querySelector('[data-selection-action]')).toBeNull();
  });

  it('gives way to the element that is picked, and comes back when it is let go', () => {
    open('<App><Button>Go</Button></App>');
    select('Button');
    expect(host.querySelector('[data-nothing-selected]')).toBeNull();
    act(() => canvas().deselectAll());
    expect(host.querySelector('[data-nothing-selected]')).not.toBeNull();
  });
});

describe('the page', () => {
  it('has the project\'s theme after its own properties', () => {
    open('<App><Button>Go</Button></App>');
    act(() => canvas().selectElement(canvas().rootId));
    expect(groups().slice(0, 2)).toEqual(['own', 'theme:open']);
    expect(host.querySelector('[data-block-action="wrap-if"]')).toBeNull();
  });
});
