// @vitest-environment jsdom
/**
 * A throw in the Builder's drawing stops it with words, not a blank page,
 * and the unsaved work it holds is kept for recovery as it stops.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppBoundary } from './AppBoundary';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import { SESSION_STORAGE_KEY } from '../utils/openProject';
import { recoveryOf } from '../utils/recoveryCopy';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root;
let host: HTMLDivElement;

function Broken(): React.ReactElement {
  throw new Error('a page it could not draw');
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
  useSchemaStore.getState().reset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('the Builder stopped by an error', () => {
  it('says so, keeps the unsaved work for recovery, and offers a reload', () => {
    useProjectStore.getState().setName('Field Notes');
    const id = useCanvasStore.getState().addElement('Text', useCanvasStore.getState().rootId!, undefined, { starter: true });
    useCanvasStore.getState().updateElementProps(id, { children: 'Words not saved' });
    expect(useProjectStore.getState().isDirty).toBe(true);

    act(() => root.render(React.createElement(AppBoundary, null, React.createElement(Broken))));
    const alert = host.querySelector('[data-builder-stopped]')!;
    expect(alert.textContent).toContain('The Builder stopped');
    expect(alert.textContent).toContain('a page it could not draw');
    expect(alert.textContent).toContain('Your unsaved work has been kept in this browser');
    expect(host.querySelector('button')?.textContent).toBe('Reload the Builder');

    const stored = window.localStorage.getItem(SESSION_STORAGE_KEY)!;
    expect(recoveryOf(stored)).toMatchObject({ unsaved: true, name: 'Field Notes' });
    expect(stored).toContain('Words not saved');
  });

  it('writes nothing for a project with nothing unsaved', () => {
    useProjectStore.getState().markClean();
    act(() => root.render(React.createElement(AppBoundary, null, React.createElement(Broken))));
    expect(host.textContent).toContain('Reload to carry on');
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it('draws the Builder as it is while nothing throws', () => {
    act(() => root.render(React.createElement(AppBoundary, null, React.createElement('p', null, 'the Builder'))));
    expect(host.textContent).toBe('the Builder');
  });
});
