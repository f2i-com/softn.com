// @vitest-environment jsdom
/**
 * The navigator says why a file action was refused, and makes `.py` files.
 *
 * The store refuses a name that is taken, a `.py` name Python cannot import,
 * and deleting the entry file or the logic it links; each refusal is shown
 * where it was asked, with the form left open to correct it. A logic file
 * named `helpers.py` used to be created as `helpers.py.logic`.
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

/** Open the quick-create form from its toolbar button, type a name, press Enter. */
function create(buttonTitle: string, name: string): void {
  act(() => host.querySelector<HTMLButtonElement>(`button[title="${buttonTitle}"]`)!.click());
  const input = host.querySelector<HTMLInputElement>('input[type="text"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(input, name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

function alertText(): string | null {
  return host.querySelector('[role="alert"]')?.textContent ?? null;
}

function logicPaths(): string[] {
  return [...useFilesStore.getState().logicFiles.values()].map((file) => file.path).sort();
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

describe('creating files in the navigator', () => {
  it('creates a .py logic file under its own name', () => {
    mount();
    create('New logic file', 'helpers.py');
    expect(logicPaths()).toContain('logic/helpers.py');
    expect(logicPaths()).not.toContain('logic/helpers.py.logic');
    const helpers = [...useFilesStore.getState().logicFiles.values()].find((file) => file.path === 'logic/helpers.py')!;
    expect(helpers.content.startsWith('# helpers.py')).toBe(true);
    expect(alertText()).toBeNull();
  });

  it('shows why a reserved Python name was refused, and keeps the form open', () => {
    mount();
    create('New logic file', 'json.py');
    expect(alertText()).toMatch(/reserved module name json\.py/);
    expect(logicPaths()).not.toContain('logic/json.py');
    expect(host.querySelector('input[type="text"]')).not.toBeNull();
  });

  it('shows why a taken name was refused', () => {
    mount();
    create('New UI file', 'main');
    expect(alertText()).toMatch(/ui\/main\.ui already exists/);
    expect(useFilesStore.getState().uiFiles.size).toBe(1);
  });

  it('names an extensionless logic file in the project\'s language', () => {
    useProjectStore.getState().reset('python');
    useFilesStore.getState().reset('python');
    mount();
    create('New logic file', 'utils');
    expect(logicPaths()).toEqual(['logic/main.py', 'logic/utils.py']);
  });
});

describe('deleting from the navigator', () => {
  it('offers no Delete for the entry file, and says why', () => {
    mount();
    const row = [...host.querySelectorAll<HTMLElement>('div')].find(
      (el) => el.textContent?.startsWith('main.ui') && el.querySelector('span')
    )!;
    act(() => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    const del = [...host.querySelectorAll<HTMLElement>('div')].find((el) => el.textContent === 'Delete')!;
    expect(del.getAttribute('aria-disabled')).toBe('true');
    expect(del.title).toMatch(/entry file/);
  });
});
