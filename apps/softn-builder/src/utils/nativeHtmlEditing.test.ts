// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseSource } from './sourceParser';
import { nativeElementMeta } from './nativeHtmlMetadata';
import { getComponentMeta, getComponentNames } from './componentRegistry';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { CanvasElement } from '../components/canvas/CanvasElement';
import { PropertyPanel } from '../components/panels/PropertyPanel';

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

it('exposes existing native markup in the inspector without adding it to the component palette', () => {
  expect(getComponentMeta('h1')?.propSchema).toContainEqual({ name: 'children', type: 'string' });
  expect(getComponentNames()).not.toContain('h1');
  expect(getComponentMeta('input')?.allowChildren).toBe(false);
  expect(getComponentMeta('UnknownCustomWidget')).toBeUndefined();
});

it('shows and edits a native heading through its labeled text property', () => {
  const parsed = parseSource('<App><h1 className="title">Plan the day</h1></App>');
  const heading = [...parsed.elements.values()].find(element => element.componentType === 'h1')!;
  useCanvasStore.getState().loadState(parsed.elements, parsed.rootId);
  useCanvasStore.getState().selectElement(heading.id);
  root = createRoot(host);
  act(() => root!.render(React.createElement(React.Fragment, null,
    React.createElement(CanvasElement, { elementId: heading.id }), React.createElement(PropertyPanel))));
  expect(host.querySelector('[data-canvas-leaf-text]')?.textContent).toBe('Plan the day');
  const label = [...host.querySelectorAll('label')].find(element => element.textContent === 'Text Content')!;
  const input = document.getElementById(label.htmlFor) as HTMLInputElement;
  expect(input.value).toBe('Plan the day');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Make room for an idea');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(useCanvasStore.getState().elements.get(heading.id)?.props.children).toBe('Make room for an idea');
  expect(host.querySelector('[data-canvas-leaf-text]')?.textContent).toBe('Make room for an idea');
});

it('keeps expression attributes and app-specific attributes represented, without a dead text field for a container', () => {
  const parsed = parseSource('<App><button className={active ? "selected" : ""} disabled={busy} data-focus="tasks"><span>Save</span></button></App>');
  const button = [...parsed.elements.values()].find(element => element.componentType === 'button')!;
  const schema = nativeElementMeta(button)!.propSchema;
  expect(schema).toContainEqual(expect.objectContaining({ name: 'className', type: 'expression' }));
  expect(schema).toContainEqual(expect.objectContaining({ name: 'disabled', type: 'expression' }));
  expect(schema).toContainEqual({ name: 'data-focus', type: 'string' });
  expect(schema.some(prop => prop.name === 'children')).toBe(false);
});
