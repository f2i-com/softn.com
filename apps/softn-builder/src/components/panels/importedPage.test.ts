// @vitest-environment jsdom
/**
 * A page used inside another has no properties to set.
 *
 * The panel offered an imported element everything it offers an unknown
 * component: a className, events, bindings, directives. None of it does
 * anything. The app is put together by replacing the tag with the content
 * of the page it names (core, source-composer.ts), and what was written on
 * the tag is dropped. The panel says what the element is, and opens the
 * file its content is in.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { PropertyPanel } from './PropertyPanel';

let root: Root | undefined;
let host: HTMLDivElement;
let rowFile = '';

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useCanvasStore.getState().reset();
  const files = useFilesStore.getState();
  files.reset();
  rowFile = files.createFile('ui/components', 'task-row.ui', 'ui');
  files.updateUIFileSource(rowFile, '<Stack>\n  <Text>A row</Text>\n</Stack>\n');
  files.updateUIFileSource('main_ui', '<import TaskRow from="./components/task-row.ui" />\n<import Gone from="./gone.ui" />\n<App>\n  <TaskRow />\n  <Gone />\n  <Mystery />\n</App>\n');
  files.setActiveFile('main_ui');
  const main = useFilesStore.getState().uiFiles.get('main_ui')!;
  useCanvasStore.getState().loadState(main.elements, main.rootId, main.imports);
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

function select(type: string): void {
  const canvas = useCanvasStore.getState();
  canvas.selectElement([...canvas.elements.values()].find((element) => element.componentType === type)!.id);
  act(() => root?.unmount());
  root = createRoot(host);
  act(() => root!.render(React.createElement(PropertyPanel)));
}

const fields = () => host.querySelectorAll('input, textarea, select').length;

describe('the properties of a page used inside another', () => {
  it('are none: the panel says what it is, where its content is, and offers nothing to set', () => {
    select('TaskRow');
    expect(host.querySelector('[data-imported-page]')!.textContent).toBe('A page used inside another is its content; it reads this page’s state.');
    expect(host.textContent).toContain('ui/components/task-row.ui');
    expect(fields()).toBe(0);
    for (const word of ['className', '@click', ':bind', 'Bindings', 'Directives', 'Events']) expect(host.textContent, word).not.toContain(word);
  });

  it('opens the file the page is', () => {
    select('TaskRow');
    const open = host.querySelector<HTMLButtonElement>('[data-action="open-imported-page"]')!;
    expect(open.textContent).toBe('Open ui/components/task-row.ui');
    act(() => open.click());
    expect(useFilesStore.getState().activeFileId).toBe(rowFile);
    expect(useFilesStore.getState().openTabs).toContain(rowFile);
  });

  it('says so when the file it names is not in the project, and offers nothing to open', () => {
    select('Gone');
    expect(host.querySelector('[data-imported-page]')).not.toBeNull();
    expect(host.querySelector('[data-action="open-imported-page"]')).toBeNull();
    expect(host.textContent).toContain('The project has no ui/gone.ui');
    expect(fields()).toBe(0);
  });

  it('is not what an element nothing imports is given: that one keeps its fields', () => {
    select('Mystery');
    expect(host.querySelector('[data-imported-page]')).toBeNull();
    expect(fields()).toBeGreaterThan(0);
  });
});
