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
