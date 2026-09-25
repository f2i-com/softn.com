// @vitest-environment jsdom
/** The hierarchy panel works from the keyboard; its rows were mouse-only. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { TreeView } from './TreeView';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;
let stack: string;
let text: string;

const canvas = () => useCanvasStore.getState();
const row = (id: string) => host.querySelector<HTMLElement>(`[data-hierarchy-row="${id}"]`)!;
const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  canvas().reset();
  useHistoryStore.getState().clear();
  stack = canvas().addElement('Stack', canvas().rootId);
  text = canvas().addElement('Text', stack);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(React.createElement(TreeView)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the hierarchy from the keyboard', () => {
  it('is a tree with one row in the Tab order', () => {
    expect(host.querySelector('[role="tree"]')).not.toBeNull();
    const rows = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  it('selects with Enter, walks with the arrows, folds with left and right', () => {
    press(row(stack), 'Enter');
    expect(canvas().selectedIds).toEqual([stack]);
    expect(row(stack).getAttribute('aria-selected')).toBe('true');
    expect(row(stack).tabIndex).toBe(0);

    row(stack).focus();
    press(row(stack), 'ArrowDown');
    expect(document.activeElement).toBe(row(text));

    press(row(stack), 'ArrowLeft');
    expect(row(stack).getAttribute('aria-expanded')).toBe('false');
    expect(row(text)).toBeNull();
    press(row(stack), 'ArrowRight');
    expect(row(text)).not.toBeNull();
  });

  it('deletes with Delete, as one undoable step', () => {
    press(row(text), 'Delete');
    expect(canvas().elements.has(text)).toBe(false);
    expect(useHistoryStore.getState().past.length).toBe(1);
  });
});
