// @vitest-environment jsdom
/**
 * A change of tab, judged against what the project was kept as.
 *
 * As a tab is changed, the page left is flushed while the canvas still holds
 * it and the page opened is already the active one (useActiveFileOnCanvas.ts).
 * The project is judged at that flush (utils/savedPoint.ts). The canvas was
 * taken for the active page's once it had that page's root; and pages read
 * in the same millisecond could have the same ids, root and all. Judged
 * then, the page opened was held against the page left, and the project
 * said "Unsaved" with nothing changed. The canvas says which page it holds
 * now (canvasStore, pageId), and the project is judged again once it holds
 * the page opened.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useProjectStore } from '../stores/projectStore';
import { keepSavedPoint } from '../utils/savedPoint';
import type { CanvasElement } from '../types/builder';
import { useActiveFileOnCanvas } from './useActiveFileOnCanvas';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** A page whose root has the id every page read in that millisecond got. */
function page(words: string): Map<string, CanvasElement> {
  return new Map<string, CanvasElement>([
    ['elem_1_0', { id: 'elem_1_0', componentType: 'App', props: {}, children: ['elem_1_1'], parentId: null }],
    ['elem_1_1', { id: 'elem_1_1', componentType: 'Text', props: { children: words }, children: [], parentId: 'elem_1_0' }],
  ]);
}

function Host(): null {
  useActiveFileOnCanvas();
  return null;
}

let root: Root | undefined;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

describe('a tab changed between two pages with the same root', () => {
  it('leaves a project with nothing changed saved', () => {
    const files = useFilesStore.getState();
    const other = files.createFile('ui', 'other.ui', 'ui');
    files.setActiveFile('main_ui');
    const uiFiles = new Map(useFilesStore.getState().uiFiles);
    uiFiles.set('main_ui', { ...uiFiles.get('main_ui')!, elements: page('Main'), rootId: 'elem_1_0' });
    uiFiles.set(other, { ...uiFiles.get(other)!, elements: page('Other'), rootId: 'elem_1_0' });
    useFilesStore.setState({ uiFiles });
    // Opened like this: what the project is held against.
    useProjectStore.getState().markClean();
    keepSavedPoint();

    root = createRoot(document.body.appendChild(document.createElement('div')));
    act(() => root!.render(React.createElement(Host)));
    expect(useCanvasStore.getState().elements.get('elem_1_1')!.props.children).toBe('Main');

    act(() => {
      useFilesStore.getState().setActiveFile(other);
      // The flush of the page left, before the canvas is given the page opened.
      useProjectStore.getState().markDirty();
    });
    expect(useCanvasStore.getState().elements.get('elem_1_1')!.props.children).toBe('Other');
    expect(useProjectStore.getState().isDirty).toBe(false);
  });
});
