// @vitest-environment jsdom
/**
 * Opening a project contacts nobody.
 *
 * A component the canvas draws as itself is given no address the browser
 * would go and fetch (utils/drawnProps.ts): the app that runs asks its
 * permissions before a picture is loaded, and the canvas has none to ask.
 * The Image the canvas draws by hand was older than that rule and did not
 * follow it. `<Image src="https://…">` was put into an `<img>` as the file
 * was opened, so opening somebody else's bundle to look at it told the
 * host of every picture in it that it had been opened, and from where.
 *
 * A picture at an address is not loaded until the person asks for it, on
 * the canvas or in the panel: what is drawn in its place names the address
 * and offers "Show", for as long as the editor is open. A picture of the
 * project's own, and one written into the page as `data:`, were never a
 * request to anyone, and are drawn as before.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSource } from '../../utils/sourceParser';
import { forgetShownPictures, isRemoteAddress, remoteShown, showRemotePicture } from '../../utils/remotePictures';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { useProjectStore } from '../../stores/projectStore';
import { PropertyPanel } from '../panels/PropertyPanel';
import { CanvasElement } from './CanvasElement';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const DATA = 'data:image/png;base64,iVBORw0KGgo=';
let host: HTMLDivElement;
let root: Root;

const canvas = () => useCanvasStore.getState();
const images = () => [...canvas().elements.values()].filter((el) => el.componentType === 'Image');
const node = (id: string) => host.querySelector<HTMLElement>(`[data-canvas-element-id="${id}"]`)!;
const loaded = () => [...host.querySelectorAll('img')].map((img) => img.getAttribute('src'));

function open(source: string): void {
  const parsed = parseSource(source);
  canvas().loadState(parsed.elements, parsed.rootId);
  act(() => root.render(React.createElement(React.Fragment, null, React.createElement(CanvasElement, { elementId: canvas().rootId!, depth: 0 }), React.createElement(PropertyPanel))));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  canvas().reset();
  useFilesStore.getState().reset();
  useProjectStore.getState().reset();
  forgetShownPictures();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('an Image whose picture is at an address', () => {
  it('is not loaded because the page was opened: its place names the address and offers to show it', () => {
    open('<App><Image src="https://pictures.example/a.png" alt="A" /><Image src="http://pictures.example/b.png" alt="B" /></App>');
    expect(loaded()).toEqual([]);
    const [a] = images();
    expect(node(a.id).textContent).toContain('https://pictures.example/a.png');
    expect(node(a.id).textContent).toContain('Not loaded');
    const show = node(a.id).querySelector<HTMLElement>('[data-action="show-remote-picture"]')!;
    expect(show.textContent).toBe('Show');
    // What is drawn for an element takes no pointer (it is a picture of the element): the button says it does.
    expect(show.style.pointerEvents).toBe('auto');
  });

  it('is loaded once it is asked for, wherever else on the page the same address is, and no other', () => {
    open('<App><Image src="https://pictures.example/a.png" /><Image src="https://pictures.example/a.png" /><Image src="https://elsewhere.example/c.png" /></App>');
    const [first] = images();
    act(() => node(first.id).querySelector<HTMLButtonElement>('[data-action="show-remote-picture"]')!.click());
    expect(loaded()).toEqual(['https://pictures.example/a.png', 'https://pictures.example/a.png']);
    // Asking selects nothing by itself going wrong: the press is the button's.
    expect(node(images()[2].id).querySelector('[data-action="show-remote-picture"]')).not.toBeNull();
  });

  it('can be asked for from the panel, where the keyboard reaches', () => {
    open('<App><Image src="https://pictures.example/a.png" /></App>');
    act(() => canvas().selectElement(images()[0].id));
    const show = host.querySelector<HTMLButtonElement>('[data-action="show-remote-picture-panel"]')!;
    expect(show.textContent).toBe('Show it on the canvas');
    act(() => show.click());
    expect(loaded()).toEqual(['https://pictures.example/a.png']);
    expect(host.querySelector('[data-action="show-remote-picture-panel"]')).toBeNull();
  });

  it('is asked for again in the next project: what was shown is forgotten when another is opened', () => {
    showRemotePicture('https://pictures.example/a.png');
    expect(remoteShown('https://pictures.example/a.png')).toBe(true);
    act(() => useProjectStore.getState().newWorkspace());
    expect(remoteShown('https://pictures.example/a.png')).toBe(false);
  });
});

describe('a picture that asks nothing of anyone', () => {
  it('is drawn as the page is opened: one written into the page, and one of the project\'s own', () => {
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = () => 'blob:picture-1';
    URL.revokeObjectURL = () => undefined;
    try {
      act(() => useProjectStore.getState().setAssets([{ name: 'ada.png', bundlePath: 'assets/ada.png', type: 'image/png', data: new Uint8Array([1, 2, 3]) }]));
      open(`<App><Image src="${DATA}" /><Image src={asset("assets/ada.png")} /></App>`);
      expect(loaded()).toEqual([DATA, 'blob:picture-1']);
      expect(host.querySelector('[data-action="show-remote-picture"]')).toBeNull();
    } finally {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });
});

describe('an address the browser would go to', () => {
  it('is one with a host in it, however it is written', () => {
    for (const address of ['https://a.example/x.png', 'HTTP://a.example/x.png', '//a.example/x.png', ' https://a.example/x.png']) expect(isRemoteAddress(address), address).toBe(true);
    for (const address of [DATA, 'blob:http://localhost/1', 'assets/x.png', './x.png', '']) expect(isRemoteAddress(address), address).toBe(false);
  });
});
