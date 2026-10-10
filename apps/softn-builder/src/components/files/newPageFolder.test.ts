// @vitest-environment jsdom
/**
 * A new page is made among the pages.
 *
 * "New UI file" puts the file beside the one that is open, which is right
 * for a page made while a page is open. With a component file open it put
 * the page in `ui/components/`, among the files that are made to be used
 * inside pages and have no App of their own. The form did say so, in small
 * letters; a person who chose "Page" had no reason to read them.
 *
 * A page made while a component is open goes to `ui/`, and the form says
 * where each kind will land as the kind is chosen.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useFilesStore } from '../../stores/filesStore';
import { createComponentFile, pageFolderBeside } from '../../utils/componentFile';
import { FileNavigator } from './FileNavigator';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;

const files = () => useFilesStore.getState();
const paths = () => [...files().uiFiles.values()].map((file) => file.path).sort();
const says = () => [...host.querySelectorAll('div')].map((node) => node.textContent ?? '').find((text) => /^in [\w/-]+\/$/.test(text));
const press = (label: string) => act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
const kind = (which: 'page' | 'component') => act(() => host.querySelector<HTMLButtonElement>(`[data-new-file-kind="${which}"]`)!.click());

function nameIt(name: string): void {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="File name"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  files().reset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(React.createElement(FileNavigator)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a new page, made while a component file is open', () => {
  it('goes to ui/, and the form says so before it is made', () => {
    act(() => void createComponentFile('row'));
    expect(files().uiFiles.get(files().activeFileId!)!.path).toBe('ui/components/row.ui');

    press('New UI file');
    expect(says()).toBe('in ui/');
    // The other kind is among the components, and choosing back says the page's place again.
    kind('component');
    expect(says()).toBe('in ui/components/');
    kind('page');
    expect(says()).toBe('in ui/');

    nameIt('tasks');
    expect(paths()).toEqual(['ui/components/row.ui', 'ui/main.ui', 'ui/tasks.ui']);
  });

  it('goes to ui/ from a folder inside the components too', () => {
    act(() => void createComponentFile('cell', 'ui/components/table'));
    press('New UI file');
    expect(says()).toBe('in ui/');
  });
});

describe('a new page, made while a page is open', () => {
  it('is beside it, as before, whatever folder that is', () => {
    act(() => void files().createFile('ui/pages', 'home.ui', 'ui'));
    press('New UI file');
    expect(says()).toBe('in ui/pages/');
    nameIt('about');
    expect(paths()).toContain('ui/pages/about.ui');
  });
});

describe('where a page goes beside a file', () => {
  it('is the file\'s folder, unless that is the components\' or inside it', () => {
    expect(pageFolderBeside('ui')).toBe('ui');
    expect(pageFolderBeside('ui/pages')).toBe('ui/pages');
    expect(pageFolderBeside('ui/components')).toBe('ui');
    expect(pageFolderBeside('ui/components/table')).toBe('ui');
    // A folder that only begins the same way is not the components'.
    expect(pageFolderBeside('ui/components-old')).toBe('ui/components-old');
  });
});
