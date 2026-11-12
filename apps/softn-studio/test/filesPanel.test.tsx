/** @vitest-environment jsdom */
/**
 * The Files panel shows the file the workspace has active, and choosing a
 * file is the only way it changes which that is.
 *
 * The panel kept a selection of its own, which began empty every time it was
 * opened; finding none, it selected the bundle's main file and made that the
 * workspace's active file. So opening the panel — or reloading a project saved
 * with it open, as the examples are — threw away the file the person was
 * looking at and put the entry page on the canvas. The active file is part of
 * the saved project, so opening the panel was also a change to save.
 *
 * And the panel is a file manager: a person can run a project from it without
 * asking the AI. Each row and the empty space have a menu (a right-click, the
 * row's "more" button, the menu key), the tree is worked from the keyboard,
 * files come in by a button, a drop or a paste, and while the AI is working
 * the panel is for looking.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesPanel } from '../src/components/panels/FilesPanel';
import { forgetTreeMemory } from '../src/components/panels/fileTree';
import { describeUnit, groupHistory } from '../src/components/panels/HistoryPanel';
import { useAIStore, useEditStore, useVFSStore, useWorkspaceStore } from '../src/stores';
import { useFilesPanelStore } from '../src/stores/filesPanelStore';

let root: Root;
let container: HTMLDivElement;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]);

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  forgetTreeMemory();
  useFilesPanelStore.getState().setClip(null);
  useAIStore.getState().setAgentState('idle');
  useEditStore.getState().close();
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useVFSStore.getState().hydrateFiles([
    { path: 'manifest.json', content: JSON.stringify({ name: 'Club', version: '1.0.0', main: 'ui/main.ui' }) },
    { path: 'ui/main.ui', content: '<App />' },
    { path: 'ui/pages/settings.ui', content: '<Text>Settings</Text>' },
    { path: 'logic/main.logic', content: 'let count = 0' },
  ]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const vfs = () => useVFSStore.getState();
const mount = () => act(() => root.render(<FilesPanel />));
const rows = () => [...container.querySelectorAll<HTMLElement>('[role="treeitem"][data-path]')];
const shown = () => rows().map((r) => r.dataset.path);
const row = (path: string) => container.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`)!;
/** The file the tree marks as the one showing. */
const marked = () => container.querySelector('[role="treeitem"][aria-current="true"]')?.getAttribute('data-path') ?? null;
const notice = () => container.querySelector('.st-files-notice')?.textContent ?? null;
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const menuLabels = () => menuItems().map((item) => item.querySelector('.st-fmenu-label')!.textContent);
const choose = (label: string) => act(() => menuItems().find((item) => item.querySelector('.st-fmenu-label')!.textContent === label)!.click());
const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
const rightClick = (target: Element) =>
  act(() => { target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })); });
const focused = () => (document.activeElement as HTMLElement | null)?.dataset.path ?? null;
const box = () => container.querySelector<HTMLInputElement>('input.st-tree-input');
const hint = () => container.querySelector('.st-tree-hint')?.textContent ?? '';
/** Type into the box a name is given in, as a person does: React hears the change. */
const typeName = (value: string) => act(() => {
  const input = box()!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
/** The newest unit of the history, as the History panel names it. */
const lastUnit = () => {
  const units = groupHistory(vfs().history);
  return units.length === 0 ? null : describeUnit(units[units.length - 1]).title;
};
/** A file as the browser hands one over from a picker, a drop or the clipboard. */
const fileOf = (name: string, bytes: Uint8Array = PNG, lastModified = Date.now() - 86_400_000) => ({
  name,
  size: bytes.byteLength,
  type: name.endsWith('.png') ? 'image/png' : '',
  lastModified,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
});
/** Dispatch an event that carries files or text, and let what it starts finish. */
async function carry(target: Element, type: string, carried: Record<string, unknown>): Promise<Event> {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: carried });
  await act(async () => {
    target.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return event;
}
const paste = (target: Element, files: unknown[], text = '') => carry(target, 'paste', { files, getData: () => text });

describe('the files panel', () => {
  it('marks the file the workspace has active, inside its folder, and leaves it active when the panel opens', () => {
    useWorkspaceStore.getState().setActiveFilePath('ui/pages/settings.ui');
    mount();
    expect(useWorkspaceStore.getState().activeFilePath).toBe('ui/pages/settings.ui');
    expect(marked()).toBe('ui/pages/settings.ui');
  });

  it('with no file active, marks the page the canvas shows and changes nothing', () => {
    mount();
    expect(useWorkspaceStore.getState().activeFilePath).toBeNull();
    expect(marked()).toBe('ui/main.ui');
    // The page the app opens on says so.
    expect(row('ui/main.ui').textContent).toContain('main page');
    expect(vfs().history).toEqual([]);
  });

  // A project made in Studio keeps its plan and brief under builder/, which the export leaves
  // out. The panel counted them into "files in the bundle", twice what the bundle held, and
  // listed the folder like any other.
  it('counts the files the export will hold, and says which folder is Studio’s own and not exported', () => {
    act(() => {
      vfs().createFile('builder/blueprint.json', '{}');
      vfs().createFile('builder/requirements.md', '# Club');
    });
    mount();
    const foot = container.querySelector('.st-files-foot')!.textContent!;
    expect(foot).toMatch(/^4 files in the bundle, [\d.]+ (bytes|KB)\./);
    expect(foot).toMatch(/2 more under builder\/ are Studio’s notes: kept with the project, not exported\./);
    expect(row('builder').textContent).toContain('not exported');
    // The folders that are exported say nothing of the kind, and Studio's own comes last, closed.
    expect(row('ui').textContent).not.toContain('not exported');
    expect(shown()[shown().length - 1]).toBe('builder');
    expect(row('builder').getAttribute('aria-expanded')).toBe('false');
  });

  it('says nothing about Studio’s notes in a project that has none', () => {
    mount();
    expect(container.querySelector('.st-files-foot')!.textContent).toMatch(/^4 files in the bundle, [\d.]+ bytes\.$/);
  });

  it('makes the file that is chosen the active one', () => {
    useWorkspaceStore.getState().setActiveFilePath('ui/pages/settings.ui');
    mount();
    act(() => row('logic/main.logic').click());
    expect(useWorkspaceStore.getState().activeFilePath).toBe('logic/main.logic');
    expect(marked()).toBe('logic/main.logic');
  });
});

describe('the tree', () => {
  it('is a tree to a screen reader: folders before files, each row with its level, place and what it is', () => {
    mount();
    const tree = container.querySelector('[role="tree"]')!;
    expect(tree.getAttribute('aria-label')).toBe('Project files');
    expect(shown()).toEqual(['logic', 'logic/main.logic', 'ui', 'ui/pages', 'ui/main.ui', 'manifest.json']);
    expect(row('ui/pages').getAttribute('aria-expanded')).toBe('false');
    expect(row('ui').getAttribute('aria-expanded')).toBe('true');
    expect(row('ui').getAttribute('aria-level')).toBe('1');
    expect(row('ui/main.ui').getAttribute('aria-level')).toBe('2');
    expect(row('manifest.json').getAttribute('aria-posinset')).toBe('3');
    expect(row('manifest.json').getAttribute('aria-setsize')).toBe('3');
    expect(row('ui').getAttribute('aria-label')).toBe('ui, folder, 2 files');
    expect(row('ui/main.ui').getAttribute('aria-label')).toMatch(/^main\.ui, page, 7 bytes, the main page, on the canvas$/);
  });

  it('is one stop for Tab: the row of the file showing, until the keyboard moves', () => {
    mount();
    expect(rows().filter((r) => r.tabIndex === 0).map((r) => r.dataset.path)).toEqual(['ui/main.ui']);
  });

  it('opens and closes a folder, and remembers it when the panel is opened again', () => {
    mount();
    act(() => row('logic').click());
    expect(row('logic').getAttribute('aria-expanded')).toBe('false');
    expect(shown()).not.toContain('logic/main.logic');
    // A folder inside another starts closed, and is opened by hand.
    expect(shown()).not.toContain('ui/pages/settings.ui');
    act(() => row('ui/pages').click());
    expect(shown()).toContain('ui/pages/settings.ui');
    act(() => root.unmount());
    root = createRoot(container);
    mount();
    expect(row('logic').getAttribute('aria-expanded')).toBe('false');
    expect(shown()).not.toContain('logic/main.logic');
    expect(shown()).toContain('ui/pages/settings.ui');
  });

  it('moves with the arrow keys, Home and End, and opens and closes folders with right and left', () => {
    mount();
    act(() => row('logic').focus());
    press(row('logic'), 'ArrowDown');
    expect(focused()).toBe('logic/main.logic');
    press(row('logic/main.logic'), 'ArrowLeft');
    expect(focused()).toBe('logic');
    press(row('logic'), 'ArrowLeft');
    expect(row('logic').getAttribute('aria-expanded')).toBe('false');
    press(row('logic'), 'ArrowRight');
    expect(row('logic').getAttribute('aria-expanded')).toBe('true');
    press(row('logic'), 'ArrowRight');
    expect(focused()).toBe('logic/main.logic');
    press(row('logic/main.logic'), 'End');
    expect(focused()).toBe('manifest.json');
    press(row('manifest.json'), 'Home');
    expect(focused()).toBe('logic');
    press(row('logic'), 'ArrowUp');
    expect(focused()).toBe('logic');
    // The row the keyboard is on is the one Tab comes back to.
    expect(rows().filter((r) => r.tabIndex === 0).map((r) => r.dataset.path)).toEqual(['logic']);
    expect(row('logic').getAttribute('aria-selected')).toBe('true');
  });

  it('opens a file with Enter, and jumps to a name as it is typed', () => {
    mount();
    act(() => row('logic').focus());
    press(row('logic'), 'm');
    expect(focused()).toBe('logic/main.logic');
    // The same letter again goes on to the next name that starts with it.
    press(row('logic/main.logic'), 'm');
    expect(focused()).toBe('ui/main.ui');
    press(row('ui/main.ui'), 'm');
    expect(focused()).toBe('manifest.json');
    press(row('manifest.json'), 'Enter');
    expect(useWorkspaceStore.getState().activeFilePath).toBe('manifest.json');
    // Other letters after the first narrow the name down: "man" is the manifest, not main.
    act(() => row('logic').focus());
    press(row('logic'), 'm');
    press(document.activeElement!, 'a');
    expect(focused()).toBe('logic/main.logic');
    press(document.activeElement!, 'n');
    expect(focused()).toBe('manifest.json');
  });
});

describe('the menu of a row', () => {
  it('opens on a right-click with what can be done to a file', () => {
    mount();
    rightClick(row('logic/main.logic'));
    expect(document.querySelector('[role="menu"]')!.getAttribute('aria-label')).toBe('Actions for logic/main.logic');
    expect(menuLabels()).toEqual(['Open', 'Rename', 'Duplicate', 'Copy', 'Cut', 'Download', 'Copy path', 'Delete']);
    // The first item has the focus, so the keyboard is in the menu.
    expect(document.activeElement).toBe(menuItems()[0]);
  });

  it('for a folder has what can be put in it as well', () => {
    mount();
    rightClick(row('ui'));
    expect(menuLabels()).toEqual(['New file', 'New folder', 'Add files here', 'Paste', 'Rename', 'Duplicate', 'Copy', 'Cut', 'Download as a zip', 'Copy path', 'Delete']);
  });

  it('on the empty space is the project’s: new file, new folder, add files, paste', () => {
    mount();
    rightClick(container.querySelector('[role="tree"]')!);
    expect(document.querySelector('[role="menu"]')!.getAttribute('aria-label')).toBe('Actions for Project files');
    expect(menuLabels()).toEqual(['New file', 'New folder', 'Add files', 'Paste']);
  });

  it('opens from the row’s "more" button, the only way on a touch screen, and the button closes it again', () => {
    mount();
    const more = row('logic/main.logic').querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    expect(more.getAttribute('aria-label')).toBe('More actions for main.logic');
    act(() => more.click());
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(menuLabels()[0]).toBe('Open');
    // Opening the menu is not opening the file.
    expect(useWorkspaceStore.getState().activeFilePath).toBeNull();
    act(() => more.click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('opens from the keyboard with the menu key or Shift+F10, moves with the arrows, and Escape gives the focus back', () => {
    mount();
    act(() => row('manifest.json').focus());
    press(row('manifest.json'), 'F10', { shiftKey: true });
    expect(menuLabels()[0]).toBe('Open');
    press(document.activeElement!, 'ArrowDown');
    expect(document.activeElement!.textContent).toContain('Rename');
    press(document.activeElement!, 'End');
    expect(document.activeElement!.textContent).toContain('Delete');
    press(document.activeElement!, 'd');
    expect(document.activeElement!.textContent).toContain('Duplicate');
    press(document.activeElement!, 'Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(focused()).toBe('manifest.json');
    press(row('manifest.json'), 'ContextMenu');
    expect(menuLabels()).toContain('Rename');
  });

  it('closes on a press outside it', () => {
    mount();
    rightClick(row('manifest.json'));
    act(() => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe('renaming', () => {
  it('from the menu puts a box where the name was, shows the name the file will really have, and renames on Enter', () => {
    mount();
    rightClick(row('logic/main.logic'));
    choose('Rename');
    expect(box()!.getAttribute('aria-label')).toBe('New name for main.logic');
    expect(box()!.value).toBe('main.logic');
    expect(document.activeElement).toBe(box());
    // The name without its ending is what is selected.
    expect([box()!.selectionStart, box()!.selectionEnd]).toEqual([0, 4]);
    typeName('app logic.logic');
    expect(hint()).toBe('It will be named app-logic.logic.');
    press(box()!, 'Enter');
    expect(box()).toBeNull();
    expect(shown()).toContain('logic/app-logic.logic');
    expect(shown()).not.toContain('logic/main.logic');
    expect(lastUnit()).toBe('Renamed main.logic to app-logic.logic');
    expect(groupHistory(vfs().history)).toHaveLength(1);
    expect(notice()).toContain('Renamed main.logic to app-logic.logic.');
    // The focus is on the row under its new name.
    expect(focused()).toBe('logic/app-logic.logic');
  });

  it('with F2, to a name that is taken, keeps the box open and says why; Escape leaves the name as it was', () => {
    mount();
    act(() => row('ui/main.ui').focus());
    press(row('ui/main.ui'), 'F2');
    typeName('pages');
    press(box()!, 'Enter');
    expect(box()).not.toBeNull();
    expect(hint()).toBe('There is already a pages in ui.');
    expect(box()!.getAttribute('aria-invalid')).toBe('true');
    typeName('icons/main.ui');
    expect(hint()).toMatch(/A name cannot hold a slash/);
    press(box()!, 'Escape');
    expect(box()).toBeNull();
    expect(shown()).toContain('ui/main.ui');
    expect(vfs().history).toEqual([]);
    expect(focused()).toBe('ui/main.ui');
  });

  it('takes what names the file along, and says so', () => {
    act(() => vfs().updateFile('ui/main.ui', '<logic src="logic/main.logic" />'));
    mount();
    act(() => row('logic/main.logic').focus());
    press(row('logic/main.logic'), 'F2');
    typeName('app.logic');
    press(box()!, 'Enter');
    expect(vfs().readFile('ui/main.ui')).toBe('<logic src="logic/app.logic" />');
    expect(notice()).toContain('ui/main.ui names it as logic/app.logic now.');
  });

  it('is refused for the manifest, with the reason', () => {
    mount();
    act(() => row('manifest.json').focus());
    press(row('manifest.json'), 'F2');
    expect(box()).toBeNull();
    expect(notice()).toMatch(/manifest\.json keeps its name and its place/);
  });
});

describe('deleting', () => {
  it('a file nothing depends on goes at once with Delete, and Undo in the notice brings it back', () => {
    mount();
    act(() => row('logic/main.logic').focus());
    press(row('logic/main.logic'), 'Delete');
    expect(shown()).not.toContain('logic/main.logic');
    expect(lastUnit()).toBe('Deleted main.logic');
    expect(notice()).toContain('Deleted logic/main.logic.');
    // The folder a person has just emptied stays, marked as empty, and has the focus's neighbour.
    expect(row('logic').textContent).toContain('empty');
    expect(focused()).toBe('ui');
    const undo = [...container.querySelectorAll<HTMLButtonElement>('.st-files-notice button')].find((b) => b.textContent === 'Undo')!;
    act(() => undo.click());
    expect(vfs().files.has('logic/main.logic')).toBe(true);
    expect(notice()).toContain('Undone: Deleted main.logic.');
  });

  it('the main page is asked about first, saying what the app loses, and Cancel keeps it', () => {
    mount();
    rightClick(row('ui/main.ui'));
    choose('Delete');
    const dialog = container.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Delete main.ui?');
    expect(dialog.textContent).toContain('ui/main.ui is the app’s main page: the app opens on it.');
    expect(dialog.textContent).toContain('manifest.json names it, and will be left asking for a file that is not there.');
    expect(dialog.textContent).toContain('History can undo this.');
    // Cancel has the focus: Enter pressed again does not delete.
    expect(document.activeElement!.textContent).toBe('Cancel');
    press(document.activeElement!, 'Escape');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(vfs().files.has('ui/main.ui')).toBe(true);
    expect(focused()).toBe('ui/main.ui');
  });

  it('a folder is asked about with how much it holds, and goes whole as one unit', () => {
    mount();
    act(() => row('ui').focus());
    press(row('ui'), 'Delete');
    const dialog = container.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Delete the folder ui?');
    expect(dialog.textContent).toContain('It holds 2 files, and they go with it.');
    act(() => [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!.click());
    expect([...vfs().files.keys()].sort()).toEqual(['logic/main.logic', 'manifest.json']);
    expect(groupHistory(vfs().history)).toHaveLength(1);
    expect(lastUnit()).toBe('Deleted the folder ui');
  });
});

describe('copy, cut, paste and duplicate', () => {
  it('Ctrl+D duplicates under a numbered name, and the copy has the focus', () => {
    mount();
    act(() => row('logic/main.logic').focus());
    press(row('logic/main.logic'), 'd', { ctrlKey: true });
    expect(shown()).toContain('logic/main-2.logic');
    expect(focused()).toBe('logic/main-2.logic');
    expect(notice()).toContain('Duplicated main.logic: the copy is main-2.logic.');
    expect(lastUnit()).toBe('Duplicated main.logic');
  });

  it('Ctrl+C on a file and a paste on a folder puts a copy in the folder', async () => {
    mount();
    act(() => row('logic/main.logic').focus());
    press(row('logic/main.logic'), 'c', { ctrlKey: true });
    expect(notice()).toContain('Copied main.logic.');
    act(() => row('ui').focus());
    const event = await paste(row('ui'), []);
    expect(event.defaultPrevented).toBe(true);
    expect(vfs().files.has('ui/main.logic')).toBe(true);
    expect(vfs().files.has('logic/main.logic')).toBe(true);
    expect(lastUnit()).toBe('Copied main.logic to ui');
    // It can be pasted again: a copy is not used up.
    await paste(row('ui'), []);
    expect(vfs().files.has('ui/main-2.logic')).toBe(true);
  });

  it('Cmd+X on a folder marks it as cut, and a paste moves it with everything in it, once', async () => {
    mount();
    act(() => row('ui/pages').focus());
    press(row('ui/pages'), 'x', { metaKey: true });
    expect(row('ui/pages').dataset.cut).toBe('true');
    expect(row('ui/pages').getAttribute('aria-label')).toMatch(/, cut$/);
    act(() => row('logic').focus());
    await paste(row('logic'), []);
    expect(vfs().files.has('logic/pages/settings.ui')).toBe(true);
    expect(vfs().files.has('ui/pages/settings.ui')).toBe(false);
    expect(lastUnit()).toBe('Moved pages to logic');
    expect(focused()).toBe('logic/pages');
    expect(useFilesPanelStore.getState().clip).toBeNull();
    // Nothing is left to paste.
    await paste(row('logic'), []);
    expect(notice()).toMatch(/There is nothing here to paste yet/);
  });

  it('a paste on a file puts the copy beside it', async () => {
    mount();
    act(() => row('manifest.json').focus());
    press(row('manifest.json'), 'c', { ctrlKey: true });
    act(() => row('ui/main.ui').focus());
    await paste(row('ui/main.ui'), []);
    expect(vfs().files.has('ui/manifest.json')).toBe(true);
  });

  it('what was copied in one project is not pasted into another', async () => {
    mount();
    act(() => row('manifest.json').focus());
    press(row('manifest.json'), 'c', { ctrlKey: true });
    act(() => useWorkspaceStore.setState({ projectId: 'another-project' }));
    act(() => row('ui').focus());
    await paste(row('ui'), []);
    expect(vfs().files.has('ui/manifest.json')).toBe(false);
  });
});

describe('files from the computer', () => {
  it('a pasted screenshot gets a name that says what it is, goes with the assets, and has the focus', async () => {
    mount();
    act(() => row('manifest.json').focus());
    const event = await paste(row('manifest.json'), [fileOf('image.png', PNG, Date.now())]);
    expect(event.defaultPrevented).toBe(true);
    expect(vfs().readFile('assets/pasted-picture.png')).toEqual(PNG);
    expect(notice()).toContain('Added pasted-picture.png to assets.');
    expect(focused()).toBe('assets/pasted-picture.png');
    expect(lastUnit()).toBe('Added pasted-picture.png');
    // A second one does not write over the first.
    await paste(row('assets/pasted-picture.png'), [fileOf('image.png', PNG, Date.now())]);
    expect(vfs().files.has('assets/pasted-picture-2.png')).toBe(true);
  });

  it('pasted with a folder selected land in that folder, under their own names', async () => {
    mount();
    act(() => row('ui/pages').focus());
    await paste(row('ui/pages'), [fileOf('team photo.png'), fileOf('logo.png')]);
    expect(vfs().files.has('ui/pages/team-photo.png')).toBe(true);
    expect(vfs().files.has('ui/pages/logo.png')).toBe(true);
    expect(notice()).toContain('Added 2 files to ui/pages.');
    expect(notice()).toContain('team photo.png is kept as team-photo.png.');
    expect(groupHistory(vfs().history)).toHaveLength(1);
  });

  it('pasted text is not made into a file, and the panel says so', async () => {
    mount();
    act(() => row('ui').focus());
    const event = await paste(row('ui'), [], 'some words');
    expect(vfs().history).toEqual([]);
    expect(notice()).toMatch(/The clipboard holds text, not a file, so nothing was added\./);
    expect(event.defaultPrevented).toBe(false);
  });

  it('a paste into the box a name is typed in is the box’s own', async () => {
    mount();
    act(() => row('manifest.json').focus());
    press(row('manifest.json'), 'c', { ctrlKey: true });
    act(() => row('ui/main.ui').focus());
    press(row('ui/main.ui'), 'F2');
    const event = await paste(box()!, [], 'ui/main.ui');
    expect(event.defaultPrevented).toBe(false);
    expect(groupHistory(vfs().history)).toHaveLength(0);
  });

  it('chosen with the Add files button go where each belongs by kind', async () => {
    mount();
    const add = [...container.querySelectorAll<HTMLButtonElement>('.st-files-bar button')].find((b) => b.textContent === 'Add files')!;
    act(() => add.click());
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.multiple).toBe(true);
    Object.defineProperty(input, 'files', { configurable: true, value: [fileOf('logo.png'), fileOf('about.html', new TextEncoder().encode('<h1>About</h1>'))] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vfs().readFile('assets/logo.png')).toEqual(PNG);
    expect(vfs().readFile('about.html')).toBe('<h1>About</h1>');
    expect(lastUnit()).toBe('Added 2 files');
  });

  it('dropped on a folder light it up and land in it; dropped on the empty space go by kind', async () => {
    mount();
    const over = await carry(row('ui/pages'), 'dragover', { types: ['Files'], dropEffect: 'none' });
    expect(over.defaultPrevented).toBe(true);
    expect(row('ui/pages').dataset.drop).toBe('true');
    await carry(row('ui/pages'), 'drop', { types: ['Files'], files: [fileOf('logo.png')] });
    expect(vfs().files.has('ui/pages/logo.png')).toBe(true);
    expect(row('ui/pages').dataset.drop).toBeUndefined();
    // On a file's row: the folder the file is in.
    await carry(row('logic/main.logic'), 'drop', { types: ['Files'], files: [fileOf('note.png')] });
    expect(vfs().files.has('logic/note.png')).toBe(true);
    const tree = container.querySelector('[role="tree"]')!;
    await carry(tree, 'dragover', { types: ['Files'], dropEffect: 'none' });
    expect((tree as HTMLElement).dataset.drop).toBe('true');
    await carry(tree, 'drop', { types: ['Files'], files: [fileOf('photo.png')] });
    expect(vfs().files.has('assets/photo.png')).toBe(true);
  });

  it('a dropped folder comes in with its folders', async () => {
    mount();
    const entry = (name: string, children?: unknown[]) => children
      ? { isFile: false, isDirectory: true, name, createReader: () => { let given = false; return { readEntries: (done: (list: unknown[]) => void) => { done(given ? [] : children); given = true; } }; } }
      : { isFile: true, isDirectory: false, name, file: (done: (file: unknown) => void) => done(fileOf(name)) };
    const dropped = entry('icons', [entry('home.png'), entry('small', [entry('dot.png')])]);
    await carry(row('ui'), 'drop', { types: ['Files'], items: [{ kind: 'file', webkitGetAsEntry: () => dropped }], files: [] });
    expect(vfs().files.has('ui/icons/home.png')).toBe(true);
    expect(vfs().files.has('ui/icons/small/dot.png')).toBe(true);
    expect(lastUnit()).toBe('Added 2 files');
  });
});

describe('moving by dragging', () => {
  const drag = async (from: string, onto: Element) => {
    await carry(row(from), 'dragstart', { setData: () => undefined, effectAllowed: 'none' });
    const over = await carry(onto, 'dragover', { types: ['text/plain'], dropEffect: 'none' });
    await carry(onto, 'drop', { types: ['text/plain'] });
    return over;
  };

  it('a file onto a folder moves it there, as cut and paste would', async () => {
    mount();
    expect(row('logic/main.logic').draggable).toBe(true);
    const over = await drag('logic/main.logic', row('ui/pages'));
    expect(over.defaultPrevented).toBe(true);
    expect(vfs().files.has('ui/pages/main.logic')).toBe(true);
    expect(vfs().files.has('logic/main.logic')).toBe(false);
    expect(lastUnit()).toBe('Moved main.logic to ui/pages');
    expect(focused()).toBe('ui/pages/main.logic');
  });

  it('onto the empty space moves it to the top of the project', async () => {
    mount();
    await drag('ui/pages', container.querySelector('[role="tree"]')!);
    expect(vfs().files.has('pages/settings.ui')).toBe(true);
    expect(lastUnit()).toBe('Moved pages to the top of the project');
  });

  it('a folder cannot be dropped into itself, and letting go where it was changes nothing', async () => {
    mount();
    await drag('ui', row('ui/pages'));
    expect(vfs().history).toEqual([]);
    await drag('ui/main.ui', row('ui'));
    expect(vfs().history).toEqual([]);
  });
});

describe('new files and folders', () => {
  it('New file in a folder’s menu makes an empty file there, opens it, and is one unit', () => {
    mount();
    rightClick(row('ui/pages'));
    choose('New file');
    expect(box()!.getAttribute('aria-label')).toBe('Name of the new file');
    expect(hint()).toMatch(/A name with its ending/);
    typeName('about.ui');
    press(box()!, 'Enter');
    expect(vfs().readFile('ui/pages/about.ui')).toBe('');
    expect(lastUnit()).toBe('Created about.ui');
    expect(useWorkspaceStore.getState().activeFilePath).toBe('ui/pages/about.ui');
    expect(focused()).toBe('ui/pages/about.ui');
  });

  it('New folder makes a folder that is there, marked empty, until a file is put in it; nothing is written for it', () => {
    mount();
    const newFolder = container.querySelector<HTMLButtonElement>('.st-files-bar button[aria-label="New folder"]')!;
    act(() => newFolder.click());
    typeName('icons');
    press(box()!, 'Enter');
    expect(shown()).toContain('icons');
    expect(row('icons').textContent).toContain('empty');
    expect(row('icons').getAttribute('aria-label')).toBe('icons, folder, empty');
    expect(vfs().history).toEqual([]);
    expect(focused()).toBe('icons');
    // New file with the folder selected goes into it, and the folder is a folder like any other.
    act(() => container.querySelector<HTMLButtonElement>('.st-files-bar button[aria-label="New file"]')!.click());
    typeName('home.svg');
    press(box()!, 'Enter');
    expect(vfs().files.has('icons/home.svg')).toBe(true);
    expect(row('icons').textContent).not.toContain('empty');
  });

  it('a new folder can be renamed and deleted like any other, though it holds no file', () => {
    mount();
    act(() => container.querySelector<HTMLButtonElement>('.st-files-bar button[aria-label="New folder"]')!.click());
    typeName('icons');
    press(box()!, 'Enter');
    press(row('icons'), 'F2');
    typeName('glyphs');
    press(box()!, 'Enter');
    expect(shown()).toContain('glyphs');
    expect(shown()).not.toContain('icons');
    press(row('glyphs'), 'Delete');
    expect(shown()).not.toContain('glyphs');
    expect(vfs().history).toEqual([]);
  });
});

describe('a project with no files', () => {
  it('offers New file and Add files, and New file makes the first one', () => {
    vfs().reset();
    mount();
    expect(container.querySelector('[role="tree"]')).toBeNull();
    const offered = [...container.querySelectorAll<HTMLButtonElement>('.st-files-empty button')];
    expect(offered.map((b) => b.textContent)).toEqual(['New file', 'Add files']);
    act(() => offered[0].click());
    typeName('index.html');
    press(box()!, 'Enter');
    expect(vfs().files.has('index.html')).toBe(true);
    expect(shown()).toEqual(['index.html']);
  });
});

describe('while the AI is working', () => {
  beforeEach(() => useAIStore.getState().setAgentState('building'));

  it('says so above the tree, and what the panel still does', () => {
    mount();
    expect(container.querySelector('.st-files-busy')!.textContent).toBe('The AI is working. Files can be opened, copied and downloaded. Adding, renaming, moving and deleting wait until the run stops.');
  });

  it('keeps every action that changes the project in the menu, off, with the reason, and leaves the others on', () => {
    mount();
    rightClick(row('ui'));
    const state = Object.fromEntries(menuItems().map((item) => [item.querySelector('.st-fmenu-label')!.textContent, item.getAttribute('aria-disabled') === 'true']));
    expect(state).toEqual({
      'New file': true, 'New folder': true, 'Add files here': true, Paste: true, Rename: true, Duplicate: true, Cut: true, Delete: true,
      Copy: false, 'Download as a zip': false, 'Copy path': false,
    });
    expect(document.querySelector('.st-fmenu-note')!.textContent).toBe('The AI is working: changes wait until the run stops.');
    // An item that is off does nothing, and the menu stays.
    choose('Delete');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('refuses the keys, a paste and a drop with the reason, writes nothing, and no row can be dragged', async () => {
    mount();
    act(() => row('logic/main.logic').focus());
    press(row('logic/main.logic'), 'Delete');
    expect(notice()).toMatch(/The AI is working, and may be reading or writing these files\. Changes wait until the run stops\./);
    press(row('logic/main.logic'), 'F2');
    expect(box()).toBeNull();
    press(row('logic/main.logic'), 'd', { ctrlKey: true });
    await paste(row('logic/main.logic'), [fileOf('image.png', PNG, Date.now())]);
    await carry(row('ui'), 'drop', { types: ['Files'], files: [fileOf('logo.png')] });
    expect(vfs().history).toEqual([]);
    expect([...vfs().files.keys()]).toHaveLength(4);
    expect(row('logic/main.logic').draggable).toBe(false);
    // A file can still be opened.
    press(row('logic/main.logic'), 'Enter');
    expect(useWorkspaceStore.getState().activeFilePath).toBe('logic/main.logic');
  });
});
