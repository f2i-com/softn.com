// @vitest-environment jsdom
/**
 * The files at a project's root are in the file tree. A project written as a
 * site keeps its main page and its code there, `index.html` and `main.js`,
 * and only folders were drawn at the root: those two were in the project and
 * nowhere in the tree, so neither could be opened, renamed or deleted there.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strToU8, zipSync } from 'fflate';
import { useFilesStore } from '../../stores/filesStore';
import { useProjectStore } from '../../stores/projectStore';
import { useCanvasStore } from '../../stores/canvasStore';
import { loadBundle } from '../../utils/bundleLoader';
import { commitProjectSnapshot, prepareProjectSnapshot } from '../../utils/openProject';
import { FileNavigator } from './FileNavigator';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useCanvasStore.getState().reset();
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the file tree of a project written as a site', () => {
  it('lists the files at its root, after its folders', async () => {
    const manifest = { name: 'Site', version: '1.0.0', main: 'index.html', files: { ui: ['index.html', 'pages/home.html'], logic: ['main.js'] } };
    const bundle = await loadBundle(
      zipSync({
        'manifest.json': strToU8(JSON.stringify(manifest)),
        'index.html': strToU8('<import Home from="./pages/home.html" />\n<script src="main.js"></script>\n<App><Home /></App>\n'),
        'pages/home.html': strToU8('<p>Home</p>\n'),
        'main.js': strToU8('let n = 1\n'),
      })
    );
    commitProjectSnapshot(prepareProjectSnapshot(bundle));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(React.createElement(FileNavigator)));
    const names = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].map((row) => row.textContent ?? '');
    const at = (name: string) => names.findIndex((row) => row.startsWith(name));
    expect(at('index.html')).toBeGreaterThan(at('pages'));
    expect(at('main.js')).toBeGreaterThan(at('index.html'));
  });
});
