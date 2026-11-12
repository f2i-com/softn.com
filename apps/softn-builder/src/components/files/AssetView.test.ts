// @vitest-environment jsdom
/**
 * An asset open in the middle of the workspace.
 *
 * It said the asset's name, type and size in a card and could do nothing
 * with it. Held here: what it says of a picture, of a text file and of a
 * file it cannot show; that another file can be put in the asset's place
 * from it, under the same path, and is seen at once; and that a file of
 * another kind is refused in the view, with what to do instead.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { useProjectStore } from '../../stores/projectStore';
import { answerConfirm, currentConfirm, useConfirmStore } from '../../utils/confirm';
import { ConfirmDialog } from '../feedback/ConfirmDialog';
import { AssetView } from './AssetView';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const NEWER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9, 9]);

let host: HTMLDivElement;
let root: Root;
/** The bytes behind each address the view was given for a picture: jsdom makes none of its own. */
let made: Blob[];
const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;

const files = () => useFilesStore.getState();
const text = (selector: string) => host.querySelector(selector)?.textContent ?? null;
const said = () => useNotificationStore.getState().notifications.map((n) => `${n.type}: ${n.message}`);

/** Put a file among the project's assets and open it, as the Files panel does. */
function openAsset(name: string, bytes: Uint8Array, type: string): string {
  let id = '';
  act(() => {
    id = files().addAssetFile('assets', name, type, bytes);
    files().openFile(id);
  });
  return id;
}

/** Hand the view's file input what a file picker hands it, and wait for the file to be read. */
async function pick(name: string, bytes: Uint8Array): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('[data-replace-asset-input]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [{ name, size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer }] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The picture, read by the browser at the size given. */
function drawPicture(width: number, height: number): void {
  const img = host.querySelector<HTMLImageElement>('img')!;
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: width });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: height });
  act(() => {
    img.dispatchEvent(new Event('load'));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  made = [];
  URL.createObjectURL = (blob: Blob | MediaSource) => `blob:test/${made.push(blob as Blob)}`;
  URL.revokeObjectURL = () => {};
  useCanvasStore.getState().reset();
  useProjectStore.getState().reset();
  files().reset();
  useConfirmStore.setState({ queue: [] });
  useNotificationStore.getState().clearAll();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(React.createElement(AssetView)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

describe('a picture, open', () => {
  it('says its path, kind and size, its size in pixels once it is drawn, and how a page asks for it', () => {
    openAsset('team-photo.png', PNG, 'image/png');
    expect(host.querySelector('[data-asset-view]')!.getAttribute('data-asset-view')).toBe('picture');
    expect(text('h2')).toBe('assets/team-photo.png');
    expect(text('[data-asset-facts]')).toBe('PNG picture · 7 bytes');
    const img = host.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:test/1');
    expect(img.getAttribute('alt')).toBe('assets/team-photo.png');
    drawPicture(320, 200);
    expect(text('[data-asset-facts]')).toBe('PNG picture · 7 bytes · 320 × 200 pixels');
    expect(text('[data-asset-use]')).toBe(
      'To show it on a page, select an Image there and choose it under Asset. A page or the logic asks for it as asset("assets/team-photo.png").Copy'
    );
    expect(host.querySelector('[data-action="copy-asset-call"]')!.getAttribute('aria-label')).toBe('Copy asset("assets/team-photo.png")');
  });

  it('says so when the picture cannot be drawn, and still offers to replace it', () => {
    openAsset('team-photo.png', PNG, 'image/png');
    act(() => {
      host.querySelector('img')!.dispatchEvent(new Event('error'));
    });
    expect(host.querySelector('img')).toBeNull();
    expect(text('[data-asset-note]')).toMatch(/^This picture could not be drawn\./);
    expect(host.querySelector('button[data-action="replace-asset"]')).not.toBeNull();
  });

  it('counts no pixels for an SVG, which has none of its own', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    openAsset('mark.svg', svg, 'image/svg+xml');
    expect(host.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    drawPicture(300, 150);
    expect(text('[data-asset-facts]')).toBe(`SVG picture · ${svg.byteLength} bytes`);
  });
});

describe('another file put in its place from the view', () => {
  it('is asked of the picker by kind, asked about, and then shown at once under the same path', async () => {
    const id = openAsset('team-photo.png', PNG, 'image/png');
    drawPicture(320, 200);
    const button = host.querySelector<HTMLButtonElement>('button[data-action="replace-asset"]')!;
    expect(button.textContent).toBe('Replace…');
    expect(host.querySelector<HTMLInputElement>('[data-replace-asset-input]')!.accept).toBe('.png');

    await pick('newer.png', NEWER);
    expect(currentConfirm()).toMatchObject({ title: 'Replace picture', confirmLabel: 'Replace' });
    // Held back while it is asked, and still able to take the focus the question hands back.
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    await act(async () => {
      answerConfirm(currentConfirm()!.id, true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect([...files().assetFiles.get(id)!.data]).toEqual([...NEWER]);
    expect(files().nodes.get(id)!.path).toBe('assets/team-photo.png');
    expect(files().activeFileId).toBe(id);
    // A new address, for the new bytes; the size in pixels is the new picture's, once it is drawn.
    expect(host.querySelector('img')!.getAttribute('src')).toBe('blob:test/2');
    expect(made[1].size).toBe(NEWER.byteLength);
    expect(text('[data-asset-facts]')).toBe('PNG picture · 9 bytes');
    drawPicture(640, 400);
    expect(text('[data-asset-facts]')).toBe('PNG picture · 9 bytes · 640 × 400 pixels');
    expect(said()).toEqual(['success: Replaced assets/team-photo.png']);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  // The question hands the focus back to what opened it when it closes, which is before the
  // view has heard that the file is in place: a button that was `disabled` meanwhile could not
  // take it, and the keyboard was left at the top of the page.
  it('has the focus back on Replace once the question is answered', async () => {
    act(() => root.render(React.createElement(React.Fragment, null, React.createElement(AssetView), React.createElement(ConfirmDialog))));
    openAsset('team-photo.png', PNG, 'image/png');
    const button = host.querySelector<HTMLButtonElement>('button[data-action="replace-asset"]')!;
    button.focus();
    await pick('newer.png', NEWER);
    const ok = host.querySelector<HTMLButtonElement>('[role="alertdialog"] [data-confirm="ok"]')!;
    expect(document.activeElement).toBe(host.querySelector('[role="alertdialog"] [data-confirm="cancel"]'));
    await act(async () => {
      ok.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
  });

  it('is refused in the view when it is another kind of file, with what to do instead', async () => {
    const id = openAsset('team-photo.png', PNG, 'image/png');
    await pick('holiday.jpg', NEWER);
    expect(currentConfirm()).toBeNull();
    expect(text('[role="alert"] > span')).toBe(
      'holiday.jpg is a .jpg file, and assets/team-photo.png is a .png file. Replacing keeps the name, and the name tells the app what kind of file it is. Choose a .png file, or add holiday.jpg as a new picture and choose it where this one is used.'
    );
    expect([...files().assetFiles.get(id)!.data]).toEqual([...PNG]);
    expect(said()).toEqual([]);

    act(() => host.querySelector<HTMLButtonElement>('[role="alert"] button[aria-label="Dismiss message"]')!.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not say of the next file what was said of the last', async () => {
    openAsset('team-photo.png', PNG, 'image/png');
    await pick('holiday.jpg', NEWER);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    openAsset('other.png', PNG, 'image/png');
    expect(text('h2')).toBe('assets/other.png');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('a file that is not a picture, open', () => {
  it('shows a text file its text', () => {
    openAsset('places.json', new TextEncoder().encode('{ "places": [] }\n'), 'application/json');
    expect(host.querySelector('[data-asset-view]')!.getAttribute('data-asset-view')).toBe('text');
    expect(text('[data-asset-facts]')).toBe('JSON file · 17 bytes');
    expect(text('pre')).toBe('{ "places": [] }\n');
    expect(text('[data-asset-use]')).toBe('A page or the logic asks for it as asset("assets/places.json").Copy');
    expect(host.querySelector<HTMLInputElement>('[data-replace-asset-input]')!.accept).toBe('.json');
  });

  it('says what a file it cannot show is, how it is asked for, and offers the same actions', () => {
    openAsset('notes.pdf', new Uint8Array([1, 2, 3, 4, 5]), 'application/pdf');
    expect(host.querySelector('[data-asset-view]')!.getAttribute('data-asset-view')).toBe('file');
    expect(text('[data-asset-facts]')).toBe('PDF file · 5 bytes');
    expect(host.querySelector('img')).toBeNull();
    expect(text('[data-asset-note]')).toBe(
      'Files of this kind are not shown here. Pictures (PNG, JPEG, GIF, WebP, SVG and BMP) and text files are. The app carries it as it is.'
    );
    expect(text('[data-asset-use]')).toBe('A page or the logic asks for it as asset("assets/notes.pdf").Copy');
    expect(host.querySelector('button[data-action="replace-asset"]')).not.toBeNull();
    expect(host.querySelector('button[data-action="copy-asset-call"]')).not.toBeNull();
  });
});

describe('the text a page asks for it by', () => {
  async function pressCopy(): Promise<HTMLButtonElement> {
    const button = host.querySelector<HTMLButtonElement>('button[data-action="copy-asset-call"]')!;
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return button;
  }

  it('is put on the clipboard, and the button says so', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (words: string) => void written.push(words) } });
    try {
      openAsset('team-photo.png', PNG, 'image/png');
      const button = await pressCopy();
      expect(written).toEqual(['asset("assets/team-photo.png")']);
      expect(button.textContent).toBe('Copied');
      expect(said()).toEqual([]);
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('is selected, to be copied by hand, on a page that has no clipboard', async () => {
    openAsset('team-photo.png', PNG, 'image/png');
    const button = await pressCopy();
    expect(button.textContent).toBe('Copy');
    expect(window.getSelection()!.toString()).toBe('asset("assets/team-photo.png")');
    expect(said()).toEqual(['info: It could not be copied from here. The text is selected, so you can copy it yourself.']);
  });
});

describe('no asset to show', () => {
  it('says the file is not in the project, and where to go', () => {
    expect(host.textContent).toBe('File not foundIt is no longer in the project. Choose another file in the Files panel.');
  });
});
