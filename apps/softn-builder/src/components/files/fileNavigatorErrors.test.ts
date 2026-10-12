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
import { answerConfirm, currentConfirm, useConfirmStore } from '../../utils/confirm';

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
  useConfirmStore.setState({ queue: [] });
});

/** Right-click a file's row and choose Delete; the question it asks, if any. */
function askToDelete(name: string): string | null {
  const row = [...host.querySelectorAll<HTMLElement>('[data-file-row]')].find((el) => el.textContent?.startsWith(name))!;
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  const del = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === 'Delete')!;
  act(() => del.click());
  return currentConfirm()?.message ?? null;
}

/** Answer the question on the screen, and let what waits for the answer run. */
async function answer(yes: boolean): Promise<void> {
  await act(async () => {
    answerConfirm(currentConfirm()!.id, yes);
    await Promise.resolve();
  });
}

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

  it('says which pages use a file before it is deleted', async () => {
    // The question was only 'Delete file "Banner.ui"?'. A page that imports
    // it was left importing a file that is not there, and the export wrote
    // it that way: the first sign was the app that ran.
    const files = useFilesStore.getState();
    const banner = files.createFile('ui', 'Banner.ui', 'ui');
    files.createFile('ui', 'Unused.ui', 'ui');
    files.updateUIFileSource('main_ui', '<import Banner from="./Banner.ui" />\n<App>\n  <Banner />\n</App>');
    expect(useFilesStore.getState().usersOf(banner)).toEqual(['ui/main.ui']);

    const asked: string[] = [];
    mount();
    for (const name of ['Banner.ui', 'Unused.ui']) {
      asked.push(askToDelete(name)!);
      // The menu is gone while the question is asked, and nothing is deleted until it is answered.
      expect(host.querySelector('[role="menuitem"]')).toBeNull();
      expect(useFilesStore.getState().uiFiles.size).toBe(3);
      await answer(false);
    }
    expect(asked[0]).toContain('Banner.ui');
    expect(asked[0]).toContain('ui/main.ui');
    expect(asked[1]).toBe('Delete file "Unused.ui"?');
    // Nothing was deleted: the answer was no.
    expect(useFilesStore.getState().uiFiles.size).toBe(3);
  });

  it('deletes on a yes, and not what is no longer there', async () => {
    const files = useFilesStore.getState();
    files.createFile('ui', 'Gone.ui', 'ui');
    files.createFile('ui', 'Kept.ui', 'ui');
    mount();
    expect(askToDelete('Gone.ui')).toBe('Delete file "Gone.ui"?');
    await answer(true);
    expect([...useFilesStore.getState().uiFiles.values()].map((file) => file.path)).not.toContain('ui/Gone.ui');

    // Asked about, then deleted some other way before the answer: a yes deletes nothing else.
    expect(askToDelete('Kept.ui')).toBe('Delete file "Kept.ui"?');
    const kept = [...useFilesStore.getState().uiFiles.values()].find((file) => file.path === 'ui/Kept.ui')!;
    act(() => useFilesStore.getState().deleteFile(kept.id));
    const before = useFilesStore.getState().uiFiles.size;
    await answer(true);
    expect(useFilesStore.getState().uiFiles.size).toBe(before);
  });

  it('counts a page that links a logic file as using it', () => {
    const files = useFilesStore.getState();
    const helper = files.createFile('logic', 'helper.logic', 'logic');
    files.createFile('ui', 'Other.ui', 'ui');
    const other = [...useFilesStore.getState().uiFiles.values()].find((file) => file.path === 'ui/Other.ui')!;
    files.updateUIFileSource(other.id, '<logic src="../logic/helper.logic" />\n<App>\n  <Text>Other</Text>\n</App>');
    expect(useFilesStore.getState().usersOf(helper)).toEqual(['ui/Other.ui']);
  });
});
