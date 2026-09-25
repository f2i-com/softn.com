// @vitest-environment jsdom
/**
 * The file tree works from the keyboard. Its rows were plain divs with click
 * handlers, so no file could be opened, renamed or deleted without a mouse.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useFilesStore } from '../../stores/filesStore';
import { useProjectStore } from '../../stores/projectStore';
import { FileNavigator } from './FileNavigator';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;

function mount(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(React.createElement(FileNavigator)));
}

function row(name: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) => el.textContent?.startsWith(name));
  if (!found) throw new Error(`no row for ${name}`);
  return found;
}

function press(target: Element, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the file tree from the keyboard', () => {
  it('is a tree of focusable rows that says which file is open', () => {
    mount();
    expect(host.querySelector('[role="tree"]')?.getAttribute('aria-label')).toBe('Project files');
    const rows = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    expect(rows.length).toBeGreaterThan(2);
    for (const r of rows) expect(r.tabIndex).toBe(0);
    const folder = row('logic');
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    expect(folder.hasAttribute('aria-selected')).toBe(false);
  });

  it('opens a file with Enter and walks the rows with the arrows', () => {
    mount();
    const logic = row('main.logic');
    logic.focus();
    press(logic, 'Enter');
    expect(useFilesStore.getState().activeFileId).toBe(logic.getAttribute('data-file-row'));
    expect(row('main.logic').getAttribute('aria-selected')).toBe('true');

    press(row('main.logic'), 'ArrowUp');
    expect(document.activeElement).toBe(row('logic'));
    press(row('logic'), 'ArrowLeft');
    expect(row('logic').getAttribute('aria-expanded')).toBe('false');
    expect(() => row('main.logic')).toThrow();
    press(row('logic'), 'ArrowRight');
    expect(row('logic').getAttribute('aria-expanded')).toBe('true');
  });

  it('renames with F2', () => {
    mount();
    const id = row('main.logic').getAttribute('data-file-row');
    press(row('main.logic'), 'F2');
    const input = host.querySelector(`[data-file-row="${id}"] input`);
    expect(input).not.toBeNull();
    expect((input as HTMLInputElement).value).toBe('main.logic');
  });

  it('opens the menu with the menu key, focuses it, and gives focus back on Escape', () => {
    mount();
    const folder = row('ui');
    folder.focus();
    press(folder, 'ContextMenu');
    const menu = host.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    const items = [...menu!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(['New UI file', 'New logic file', 'New folder', 'Rename', 'Delete']);
    expect(document.activeElement).toBe(items[0]);
    press(items[0], 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    press(items[1], 'Escape');
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(row('ui'));
  });
});
