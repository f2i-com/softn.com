// @vitest-environment jsdom
/**
 * A component callback in the panel (`onRemove`, the registry's `event`
 * type) is an event: the field reads and writes the element's event map
 * under its `@` key, and the exported source says `@remove={...}`. It used
 * to be written as a string prop, which reached the component as text and
 * did nothing.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseSource } from '../../utils/sourceParser';
import { generateSource } from '../../utils/sourceGenerator';
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

function type(input: HTMLInputElement, text: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('writes a callback prop into the event map and exports it as @remove', () => {
  const parsed = parseSource('<App><Tag removable>Alpha</Tag></App>');
  const tag = [...parsed.elements.values()].find((element) => element.componentType === 'Tag')!;
  useCanvasStore.getState().loadState(parsed.elements, parsed.rootId);
  useCanvasStore.getState().selectElement(tag.id);
  root = createRoot(host);
  act(() => root!.render(React.createElement(PropertyPanel)));

  const label = [...host.querySelectorAll('label')].find((element) => element.textContent === '@remove')!;
  expect(label, 'the panel offers onRemove as @remove').toBeTruthy();
  const input = document.getElementById(label.htmlFor) as HTMLInputElement;
  expect(input.value).toBe('');

  type(input, 'drop(item)');
  const after = useCanvasStore.getState().elements.get(tag.id)!;
  expect(after.events).toEqual({ remove: 'drop(item)' });
  expect(after.props).not.toHaveProperty('onRemove');
  expect(input.value).toBe('drop(item)');

  const source = generateSource(useCanvasStore.getState().elements, useCanvasStore.getState().rootId!, '');
  expect(source).toContain('@remove={drop(item)}');
  expect(source).not.toContain('onRemove');

  // Clearing the field removes the event rather than leaving an empty handler.
  type(input, '');
  expect(useCanvasStore.getState().elements.get(tag.id)!.events).toEqual({});
});

it('shows the handler a file already carries as @remove', () => {
  const parsed = parseSource('<App><Tag removable @remove={drop(item)}>Alpha</Tag></App>');
  const tag = [...parsed.elements.values()].find((element) => element.componentType === 'Tag')!;
  useCanvasStore.getState().loadState(parsed.elements, parsed.rootId);
  useCanvasStore.getState().selectElement(tag.id);
  root = createRoot(host);
  act(() => root!.render(React.createElement(PropertyPanel)));
  const label = [...host.querySelectorAll('label')].find((element) => element.textContent === '@remove')!;
  expect((document.getElementById(label.htmlFor) as HTMLInputElement).value).toBe('drop(item)');
});

// ---------------------------------------------------------------------------
// Handler help, one field per event, and one undo step per field edit.
// ---------------------------------------------------------------------------

function mountButton(language: 'javascript' | 'python'): HTMLButtonElement['id'] {
  useFilesStore.getState().reset(language);
  const parsed = parseSource('<App><Button>Go</Button></App>');
  const button = [...parsed.elements.values()].find((element) => element.componentType === 'Button')!;
  useCanvasStore.getState().loadState(parsed.elements, parsed.rootId);
  useCanvasStore.getState().selectElement(button.id);
  useHistoryStore.getState().clear();
  root = createRoot(host);
  act(() => root!.render(React.createElement(PropertyPanel)));
  return button.id;
}

function field(label: string): HTMLInputElement {
  const found = [...host.querySelectorAll('label')].filter((element) => element.textContent === label);
  expect(found, `one ${label} field`).toHaveLength(1);
  return document.getElementById(found[0].htmlFor) as HTMLInputElement;
}

function suggestions(input: HTMLInputElement): string[] {
  const list = input.getAttribute('list');
  return list ? [...document.getElementById(list)!.querySelectorAll('option')].map((option) => option.value) : [];
}

it('offers a Button its click handler once, not as a component event and a generic @click', () => {
  mountButton('javascript');
  field('@click');
});

it('suggests the linked JavaScript file\'s functions by name', () => {
  mountButton('javascript');
  expect(suggestions(field('@click'))).toEqual(['increment', 'decrement']);
  expect(host.textContent).toContain('logic/main.logic');
  expect(host.textContent).not.toContain('Logic tab');
});

it('suggests a Python function without parameters as an arrow, since a handler is passed the event', () => {
  mountButton('python');
  expect(suggestions(field('@click'))).toEqual(['() => increment()', '() => decrement()']);
  expect(host.textContent).toContain('logic/main.py');
});

it('warns, without refusing, when a handler names a function the logic does not define', () => {
  const id = mountButton('python');
  const input = field('@click');
  type(input, 'incremnt()');
  expect(host.querySelector('[data-handler-warning]')?.textContent).toBe('No function named incremnt in logic/main.py.');
  expect(useCanvasStore.getState().elements.get(id)!.events).toEqual({ click: 'incremnt()' });
  type(input, '() => increment()');
  expect(host.querySelector('[data-handler-warning]')).toBeNull();
});

it('makes typing into a field one undo step, and leaving the field ends it', () => {
  const id = mountButton('javascript');
  const input = field('@click');
  for (const text of ['s', 'sa', 'sav', 'save']) type(input, text);
  expect(useHistoryStore.getState().past).toHaveLength(1);

  act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  type(input, 'save()');
  expect(useHistoryStore.getState().past).toHaveLength(2);

  // Undo steps back over the whole run, to before `save` was typed.
  const canvas = useCanvasStore.getState();
  const previous = useHistoryStore.getState().undo({ elements: canvas.elements, rootId: canvas.rootId, timestamp: Date.now() })!;
  expect(previous.elements.get(id)!.events).toEqual({ click: 'save' });
  const first = useHistoryStore.getState().undo({ elements: previous.elements, rootId: previous.rootId, timestamp: Date.now() })!;
  expect(first.elements.get(id)!.events ?? {}).toEqual({});
});

it('says how many are selected, rather than that nothing is', () => {
  const parsed = parseSource('<App><Button>A</Button><Button>B</Button></App>');
  const [a, b] = [...parsed.elements.values()].filter((element) => element.componentType === 'Button');
  useCanvasStore.getState().loadState(parsed.elements, parsed.rootId);
  useCanvasStore.getState().selectElement(a.id);
  useCanvasStore.getState().selectElement(b.id, true);
  root = createRoot(host);
  act(() => root!.render(React.createElement(PropertyPanel)));
  expect(host.textContent).toContain('2 elements selected');
  expect(host.textContent).not.toContain('Nothing selected');
});
