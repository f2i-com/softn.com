// @vitest-environment jsdom
/**
 * Typing in the logic dock with a page on the canvas.
 *
 * Driven first: SimLives open, 427 elements on the canvas, and sixty keys
 * typed into its logic took nineteen seconds to land, with React warning of
 * an update loop. Every element of the page read the whole logic again at
 * each key: each held every file of the project, to find the strings a
 * picture's `src` may name, which only an Image and an Avatar use; and each
 * ran its picture effect again, setting state that had not changed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { zipSync } from 'fflate';
import { loadBundle } from '../../utils/bundleLoader';
import { parseStringLiteralVariables } from '../../utils/logicStringLiterals';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { Canvas } from './Canvas';

vi.mock('../../utils/logicStringLiterals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/logicStringLiterals')>();
  return { ...actual, parseStringLiteralVariables: vi.fn(actual.parseStringLiteralVariables) };
});

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// fflate takes a value for a file by `instanceof Uint8Array`, which jsdom's TextEncoder fails.
const encode = (text: string) => Uint8Array.from(new TextEncoder().encode(text));
const picture = (n: number) => `let iconUrl = "data:image/svg+xml,${n}"\n`;

let root: Root | null = null;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('a key typed into the logic', () => {
  it('is read again for the pictures on the canvas, and for nothing else there', async () => {
    const manifest = { name: 'Typing', version: '1.0.0', description: '', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'], xdb: [], assets: [] } };
    const page = '<logic src="../logic/main.logic" />\n<Stack>\n  <Heading>Title</Heading>\n  <Text>Words</Text>\n  <Button>Go</Button>\n  <Image src={iconUrl} />\n</Stack>';
    const bundle = await loadBundle(zipSync({ 'manifest.json': encode(JSON.stringify(manifest)), 'ui/main.ui': encode(page), 'logic/main.logic': encode(picture(0)) }));
    const files = useFilesStore.getState();
    files.loadFromBundle(bundle.uiFiles, bundle.logicFiles, new Map());
    const [id, main] = [...bundle.uiFiles].find(([, file]) => file.path === 'ui/main.ui')!;
    files.setActiveFile(id);
    useCanvasStore.setState({ elements: main.elements, rootId: main.rootId });
    const logic = [...useFilesStore.getState().logicFiles.values()][0].id;

    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(React.createElement(Canvas)));
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/svg+xml,0');

    const read = vi.mocked(parseStringLiteralVariables);
    read.mockClear();
    for (let key = 1; key <= 5; key += 1) act(() => useFilesStore.getState().updateLogicFile(logic, picture(key)));
    // Once a key, for the one Image: not once a key for each of the six elements drawn.
    expect(read).toHaveBeenCalledTimes(5);
    // And the picture still follows what is typed.
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/svg+xml,5');
  });

  it('leaves the tree of files as it is once the file is marked as changed', () => {
    // A new tree at each key was the whole workspace drawn again at each key:
    // the app holds the tree, for the tabs and the Files panel.
    const files = useFilesStore.getState();
    const logic = [...files.logicFiles.values()][0].id;
    files.updateLogicFile(logic, 'let a = 1\n');
    const marked = useFilesStore.getState().nodes;
    expect(marked.get(logic)!.isDirty).toBe(true);
    useFilesStore.getState().updateLogicFile(logic, 'let a = 12\n');
    useFilesStore.getState().updateUIFileSource('main_ui', '<App>\n  <Text>One</Text>\n</App>\n');
    const page = useFilesStore.getState().nodes;
    useFilesStore.getState().updateUIFileSource('main_ui', '<App>\n  <Text>One more</Text>\n</App>\n');
    expect(useFilesStore.getState().nodes).toBe(page);
    expect(page.get(logic)).toBe(marked.get(logic));
  });
});
