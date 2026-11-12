// @vitest-environment jsdom
/**
 * Pictures and other assets in the navigator.
 *
 * The Files panel listed the assets of a bundle that was opened and had no
 * way to take one in (utils/addAssets.ts). It adds them now; and since a
 * page names a picture by its path, deleting one says which pages use it,
 * and renaming one takes the pages that name it along (utils/
 * renameInProject.ts), as one step that Undo takes back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { useProjectStore } from '../../stores/projectStore';
import { MAX_ASSET_BYTES } from '../../utils/addAssets';
import { assetCall } from '../../utils/assetSource';
import { redoCanvas, undoCanvas } from '../../utils/canvasHistory';
import { useHistoryStore } from '../../stores/historyStore';
import { answerConfirm, currentConfirm, useConfirmStore } from '../../utils/confirm';
import { FileNavigator } from './FileNavigator';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

let host: HTMLDivElement;
let root: Root;

function mount(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(React.createElement(FileNavigator)));
}

const files = () => useFilesStore.getState();
const rowNames = () => [...host.querySelectorAll<HTMLElement>('[data-file-row]')].map((row) => row.textContent ?? '');
const rowOf = (name: string) => [...host.querySelectorAll<HTMLElement>('[data-file-row]')].find((row) => row.textContent?.startsWith(name))!;
const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? null;

function idAt(path: string): string {
  return [...files().nodes.values()].find((node) => node.path === path)!.id;
}

/** Hand the navigator's file input what a file picker hands it, and wait for the files to be taken in. */
async function pick(...picked: { name: string; size?: number; bytes?: Uint8Array }[]): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('[data-add-assets-input]')!;
  const list = picked.map(({ name, size, bytes = PNG }) => ({ name, size: size ?? bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer }));
  Object.defineProperty(input, 'files', { configurable: true, value: list });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Rename a row from the keyboard: F2, the new name, Enter. */
function rename(name: string, to: string): void {
  act(() => {
    rowOf(name).dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
  });
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="New name for ${name}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, to);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

/** An Image on the open page whose picture is `path`, in the page's file. */
function showOnPage(path: string): void {
  const canvas = useCanvasStore.getState();
  const image = canvas.addElement('Image', canvas.rootId);
  canvas.updateElement(image, { props: { src: assetCall(path) }, expressionProps: ['src'] });
  const now = useCanvasStore.getState();
  files().updateUIFile('main_ui', now.elements, now.rootId);
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useCanvasStore.getState().reset();
  useHistoryStore.getState().clear();
  useProjectStore.getState().reset();
  files().reset();
  useConfirmStore.setState({ queue: [] });
  mount();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('adding a picture in the navigator', () => {
  it('is offered by a button, and lists what is picked under assets and opens it', async () => {
    const button = host.querySelector<HTMLButtonElement>('button[data-action="add-assets"]')!;
    expect(button.getAttribute('aria-label')).toBe('Add a picture or file');
    await pick({ name: 'Team Photo.png' }, { name: 'notes.pdf' });
    expect(rowNames()).toEqual(['ui', 'main.ui', 'logic', 'main.logic', 'assets', 'Team-Photo.png', 'notes.pdf']);
    expect(files().activeFileId).toBe(idAt('assets/Team-Photo.png'));
    expect(alertText()).toBeNull();
  });

  it('says why a file was left out, and adds the others', async () => {
    await pick({ name: 'film.mp4', size: MAX_ASSET_BYTES + 1 }, { name: 'logo.png' });
    expect(alertText()).toMatch(/^film\.mp4 is \d+ MB, and one file of an app can be 50 MB at most\./);
    expect(rowNames()).toContain('logo.png');
    expect(rowNames()).not.toContain('film.mp4');
  });

  it('is offered for a folder from its menu, and goes into that folder', async () => {
    act(() => void files().createFolder('assets', 'team'));
    act(() => {
      rowOf('team').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    const item = host.querySelector<HTMLElement>('[role="menuitem"][data-action="add-assets-here"]')!;
    expect(item.textContent).toBe('Add a picture or file');
    act(() => item.click());
    await pick({ name: 'ada.png' });
    expect([...files().assetFiles.values()].map((asset) => asset.bundlePath)).toEqual(['assets/team/ada.png']);
  });
});

describe('a picture that a page shows', () => {
  beforeEach(async () => {
    await pick({ name: 'logo.png' }, { name: 'spare.png' });
    showOnPage('assets/logo.png');
  });

  it('is asked about with the page named before it is deleted', async () => {
    act(() => {
      rowOf('logo.png').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    act(() => [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === 'Delete')!.click());
    expect(currentConfirm()!.message).toBe('Delete file "logo.png"?\n\nui/main.ui uses it, and will be left pointing at a file that is not there.');
    await act(async () => {
      answerConfirm(currentConfirm()!.id, false);
      await Promise.resolve();
    });
    expect(rowNames()).toContain('logo.png');
  });

  const said = () => useNotificationStore.getState().notifications.map((n) => `${n.type}: ${n.message}`);
  const srcOnPage = () => [...files().uiFiles.get('main_ui')!.elements.values()].find((el) => el.componentType === 'Image')!.props.src;
  const srcOnCanvas = () => [...useCanvasStore.getState().elements.values()].find((el) => el.componentType === 'Image')!.props.src;

  // A page's imports and its logic always followed a rename; the path a page asks
  // `asset("…")` for did not, and the panel said afterwards which pages were left asking
  // for a file that was not there. It follows now, on the page and on the canvas.
  it('is followed by the page when it is renamed, and the panel says who follows it', () => {
    act(() => useCanvasStore.getState().holdPage('main_ui'));
    act(() => useNotificationStore.getState().clearAll());
    rename('logo.png', 'brand.png');
    expect(rowNames()).toContain('brand.png');
    expect(alertText()).toBeNull();
    expect(srcOnPage()).toBe('asset("assets/brand.png")');
    expect(srcOnCanvas()).toBe('asset("assets/brand.png")');
    // The canvas holds the page's own tree, so nothing loads it again and drops the selection.
    expect(useCanvasStore.getState().elements).toBe(files().uiFiles.get('main_ui')!.elements);
    expect(said()).toEqual(['success: ui/main.ui asks for it as assets/brand.png now. Undo gives the old name back.']);
  });

  it('gives the old name back on Undo, the page and the canvas with it, and takes it again on Redo', () => {
    act(() => useCanvasStore.getState().holdPage('main_ui'));
    rename('logo.png', 'brand.png');
    act(() => useNotificationStore.getState().clearAll());
    act(() => void undoCanvas());
    expect(rowNames()).toContain('logo.png');
    expect(rowNames()).not.toContain('brand.png');
    expect(srcOnPage()).toBe('asset("assets/logo.png")');
    expect(srcOnCanvas()).toBe('asset("assets/logo.png")');
    expect(said()).toEqual(['info: assets/brand.png is assets/logo.png again.']);
    act(() => void redoCanvas());
    expect(rowNames()).toContain('brand.png');
    expect(srcOnPage()).toBe('asset("assets/brand.png")');
    expect(srcOnCanvas()).toBe('asset("assets/brand.png")');
  });

  it('is followed when the folder it is in is renamed', () => {
    act(() => useNotificationStore.getState().clearAll());
    rename('assets', 'media');
    expect(alertText()).toBeNull();
    expect(srcOnPage()).toBe('asset("media/logo.png")');
    expect(said()).toEqual(['success: ui/main.ui asks for what is in it as media now. Undo gives the old name back.']);
  });

  it('names a page that was renamed with the folder where it is now', () => {
    act(() => {
      files().createFolder('', 'site');
      files().addAssetFile('site', 'pic.png', 'image/png', PNG);
      const home = files().createFile('site', 'home.ui', 'ui');
      files().updateUIFileSource(home, '<App>\n  <Image src={asset("site/pic.png")} />\n</App>');
    });
    act(() => useNotificationStore.getState().clearAll());
    rename('site', 'web');
    expect(said()).toEqual(['success: web/home.ui asks for what is in it as web now. Undo gives the old name back.']);
    const home = [...files().uiFiles.values()].find((file) => file.path === 'web/home.ui')!;
    expect(home.originalSource).toBe('<App>\n  <Image src={asset("web/pic.png")} />\n</App>');
  });

  it('says nothing of a picture no page shows, and a rename that was refused changes nothing', () => {
    act(() => useNotificationStore.getState().clearAll());
    rename('spare.png', 'extra.png');
    expect(alertText()).toBeNull();
    expect(said()).toEqual([]);
    rename('logo.png', 'extra.png');
    expect(alertText()).toBe('assets/extra.png already exists. Choose another name.×');
    expect(srcOnPage()).toBe('asset("assets/logo.png")');
    expect(said()).toEqual([]);
  });
});

// A newer picture under the same name: it was delete, then add again (utils/addAssets.ts, replaceAsset).
describe('replacing a picture from its row', () => {
  const NEWER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9, 9]);
  const menuItems = () => [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent);
  const said = () => useNotificationStore.getState().notifications.map((n) => `${n.type}: ${n.message}`);

  function openMenu(name: string): void {
    act(() => {
      rowOf(name).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
  }

  /** Choose Replace for a row, and hand its file input what a file picker hands it. */
  async function replace(name: string, file: { name: string; size?: number; bytes?: Uint8Array }): Promise<HTMLInputElement> {
    openMenu(name);
    act(() => host.querySelector<HTMLElement>('[role="menuitem"][data-action="replace-asset"]')!.click());
    const input = host.querySelector<HTMLInputElement>('[data-replace-asset-input]')!;
    const bytes = file.bytes ?? PNG;
    Object.defineProperty(input, 'files', { configurable: true, value: [{ name: file.name, size: file.size ?? bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer }] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return input;
  }

  async function answer(yes: boolean): Promise<void> {
    await act(async () => {
      answerConfirm(currentConfirm()!.id, yes);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  beforeEach(async () => {
    useNotificationStore.getState().clearAll();
    await pick({ name: 'logo.png' });
    showOnPage('assets/logo.png');
    act(() => files().openFile('main_ui'));
  });

  it('is offered for a picture beside Rename and Delete, and not for a page or a folder', () => {
    openMenu('logo.png');
    expect(menuItems()).toEqual(['Rename', 'Replace…', 'Delete']);
    openMenu('main.ui');
    expect(menuItems()).not.toContain('Replace…');
    openMenu('assets');
    expect(menuItems()).not.toContain('Replace…');
  });

  it('asks the picker for the kind the name says, asks first with the page named, and puts the file in its place', async () => {
    const id = idAt('assets/logo.png');
    const input = await replace('logo.png', { name: 'newer.png', bytes: NEWER });
    expect(input.accept).toBe('.png');
    expect(currentConfirm()!.message).toBe(
      'Put newer.png (9 bytes) in place of assets/logo.png (7 bytes)? The picture that is there now leaves the project, and Undo does not bring it back.\n\nui/main.ui uses it, and will get the new one.'
    );
    expect([...files().assetFiles.get(id)!.data]).toEqual([...PNG]);

    await answer(true);
    expect([...files().assetFiles.get(id)!.data]).toEqual([...NEWER]);
    expect(idAt('assets/logo.png')).toBe(id);
    expect(rowNames()).toEqual(['ui', 'main.ui', 'logic', 'main.logic', 'assets', 'logo.png']);
    // The page that was open stays open: it is where the new picture is seen.
    expect(files().activeFileId).toBe('main_ui');
    expect(useProjectStore.getState().isDirty).toBe(true);
    expect(said()).toEqual(['success: Replaced assets/logo.png']);
    expect(alertText()).toBeNull();
  });

  it('leaves the picture as it is on a no', async () => {
    await replace('logo.png', { name: 'newer.png', bytes: NEWER });
    await answer(false);
    expect([...files().assetFiles.get(idAt('assets/logo.png'))!.data]).toEqual([...PNG]);
    expect(said()).toEqual([]);
    expect(alertText()).toBeNull();
  });

  it('says in the panel why a file of another kind, or one too large, was not taken, and asks nothing', async () => {
    await replace('logo.png', { name: 'holiday.jpg', bytes: NEWER });
    expect(currentConfirm()).toBeNull();
    expect(alertText()).toBe(
      'holiday.jpg is a .jpg file, and assets/logo.png is a .png file. Replacing keeps the name, and the name tells the app what kind of file it is. Choose a .png file, or add holiday.jpg as a new picture and choose it where this one is used.×'
    );
    await replace('logo.png', { name: 'huge.png', size: MAX_ASSET_BYTES + 1 });
    expect(alertText()).toMatch(/^huge\.png is \d+ MB, and one file of an app can be 50 MB at most\./);
    expect([...files().assetFiles.get(idAt('assets/logo.png'))!.data]).toEqual([...PNG]);
    expect(said()).toEqual([]);
  });

  it('says so, and changes nothing, when the file is the one that is there', async () => {
    await replace('logo.png', { name: 'logo copy.png' });
    expect(currentConfirm()).toBeNull();
    expect(said()).toEqual(['info: logo copy.png is what assets/logo.png holds already. Nothing was changed.']);
  });
});
