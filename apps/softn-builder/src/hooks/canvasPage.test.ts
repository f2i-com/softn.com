// @vitest-environment jsdom
/**
 * The page the canvas holds, and the file that is open in the middle.
 *
 * They are the same almost always, and three things went wrong where they
 * were not. Each was driven first in the Builder, in a browser.
 *
 * A project made here, left with its second page open and restored on the
 * next open, came back with its first page empty. The restore replaces the
 * workspace as the page starts, in an effect that runs before the two here;
 * they went on with what they had been drawn with, which was the empty
 * project of a moment before: its page was put on the canvas, and then
 * flushed into the restored `main.ui`, which has the same id in every
 * project made here.
 *
 * With a logic file open in the middle, the Hierarchy and Properties panels
 * still hold the last page. An edit made there was written to no file, was
 * not "Unsaved", and was gone when the page was opened again.
 *
 * And a page written in Code and saved, then stepped back with Undo: the
 * canvas held the page as it was before, under the root it had then, and
 * was taken for no page at all. Nothing done on it from there on was
 * "Unsaved", no copy was kept for recovery, and closing the tab asked
 * nothing.
 */

import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { readBundleEntries } from '@softn/core';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import { loadBundle } from '../utils/bundleLoader';
import { buildProjectBundle, flushCanvasToActiveFile } from '../utils/buildProjectBundle';
import { undoCanvas } from '../utils/canvasHistory';
import { captureSession, commitProjectSnapshot, prepareProjectSnapshot, prepareSessionSnapshot } from '../utils/openProject';
import { resetPersistedRevisions, saveProject } from '../utils/saveProject';
import { useActiveFileOnCanvas } from './useActiveFileOnCanvas';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const MAIN = '<logic src="../logic/main.logic" />\n\n<App>\n\n  <Text>First</Text>\n</App>\n';
const ABOUT = '<App>\n\n  <Text>About</Text>\n</App>\n';

const files = () => useFilesStore.getState();
const canvas = () => useCanvasStore.getState();
const unsaved = () => useProjectStore.getState().isDirty;
const idOf = (path: string) => [...files().uiFiles.values(), ...files().logicFiles.values()].find((file) => file.path === path)!.id;
const types = (path: string) => [...files().uiFiles.get(idOf(path))!.elements.values()].map((element) => element.componentType);
const words = () => [...canvas().elements.values()].map((element) => element.props.children).filter((text): text is string => typeof text === 'string');
const text = () => [...canvas().elements.values()].find((element) => element.componentType === 'Text')!;
const exported = async (path: string) => new TextDecoder().decode(readBundleEntries(await buildProjectBundle()).get(path));

function Host(): null {
  useActiveFileOnCanvas();
  return null;
}

/** As the app restores a session: as the page starts, before the canvas is given its page (App.tsx, useProjectStartup). */
function Restoring({ raw }: { raw: string }): null {
  useEffect(() => {
    commitProjectSnapshot(prepareSessionSnapshot(raw));
  }, [raw]);
  useActiveFileOnCanvas();
  return null;
}

function reset(): void {
  resetPersistedRevisions();
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
  useSchemaStore.getState().reset();
  useHistoryStore.getState().clear();
}

let root: Root | undefined;

function mount(element: React.ReactElement): void {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  act(() => root!.render(element));
}

async function openBundle(): Promise<void> {
  const manifest = { name: 'Pages', version: '1.0.0', description: '', main: 'ui/main.ui', files: { ui: ['ui/main.ui', 'ui/about.ui'], logic: ['logic/main.logic'], xdb: [], assets: [] } };
  const bundle = await loadBundle(zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'ui/main.ui': strToU8(MAIN),
    'ui/about.ui': strToU8(ABOUT),
    'logic/main.logic': strToU8('let count = 0;\n'),
  }));
  commitProjectSnapshot(prepareProjectSnapshot(bundle));
  useHistoryStore.getState().clear();
  mount(React.createElement(Host));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  reset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

describe('a project made here, left with its second page open', () => {
  it('is restored with each page holding what it held', () => {
    // The first page is given a heading, a second page is made and given a divider, and that is what is kept.
    const main = files().uiFiles.get('main_ui')!;
    canvas().loadState(main.elements, main.rootId);
    canvas().addElement('Heading', canvas().rootId, undefined, { starter: true });
    flushCanvasToActiveFile();
    const about = files().createFile('ui', 'about.ui', 'ui');
    canvas().loadState(files().uiFiles.get(about)!.elements, files().uiFiles.get(about)!.rootId);
    canvas().addElement('Divider', canvas().rootId, undefined, { starter: true });
    flushCanvasToActiveFile();
    expect(types('ui/main.ui')).toEqual(['App', 'Heading']);
    const raw = JSON.stringify(captureSession('design'));

    // The next open: the page starts with an empty project, and the session is restored.
    reset();
    mount(React.createElement(Restoring, { raw }));
    expect(files().activeFileId).toBe(about);
    expect(canvas().elements.size).toBe(2);
    expect(types('ui/about.ui')).toEqual(['App', 'Divider']);
    expect(types('ui/main.ui')).toEqual(['App', 'Heading']);
  });
});

describe('an edit made in the panels with a logic file open in the middle', () => {
  it('is an edit of the page the canvas holds: unsaved, written by a save, and there when the page is opened again', async () => {
    await openBundle();
    act(() => files().openFile(idOf('logic/main.logic')));
    expect(unsaved()).toBe(false);
    // The Properties panel still holds the page's elements.
    act(() => canvas().updateElementProps(text().id, { children: 'Typed with the logic open' }));
    expect(unsaved()).toBe(true);
    expect(await exported('ui/main.ui')).toContain('Typed with the logic open');
    act(() => files().openFile(idOf('ui/main.ui')));
    expect(words()).toEqual(['Typed with the logic open']);
    expect(files().uiFiles.get(idOf('ui/main.ui'))!.originalSource).toContain('Typed with the logic open');
  });

  it('is left on the canvas, and written to its page, when another page is opened from there', async () => {
    await openBundle();
    act(() => files().openFile(idOf('logic/main.logic')));
    act(() => canvas().updateElementProps(text().id, { children: 'Typed with the logic open' }));
    act(() => files().openFile(idOf('ui/about.ui')));
    expect(words()).toEqual(['About']);
    expect(files().uiFiles.get(idOf('ui/main.ui'))!.originalSource).toContain('Typed with the logic open');
    expect(files().uiFiles.get(idOf('ui/about.ui'))!.originalSource).toBe(ABOUT);
  });
});

describe('a project opened with no page in the middle', () => {
  // The canvas is given a page as the project is opened, and no page is
  // opened after that to say whose it is: the opening says (openProject.ts).
  it('has its edits in the panels written to the page, after a session left with the logic open is restored', async () => {
    await openBundle();
    act(() => files().openFile(idOf('logic/main.logic')));
    const raw = JSON.stringify(captureSession('design'));
    act(() => root?.unmount());
    reset();
    mount(React.createElement(Restoring, { raw }));
    expect(files().activeFileId).toBe(idOf('logic/main.logic'));
    expect(words()).toEqual(['First']);

    act(() => canvas().updateElementProps(text().id, { children: 'Typed after the restore' }));
    expect(unsaved()).toBe(true);
    expect(await exported('ui/main.ui')).toContain('Typed after the restore');
  });

  it('leaves a page as it was when it is opened over a canvas that is no page\'s', async () => {
    // A session whose canvas is not what any of its pages holds: nobody's,
    // and not the page that is opened next, which it used to be written into.
    await openBundle();
    act(() => files().openFile(idOf('logic/main.logic')));
    const session = captureSession('design');
    const stray = session.canvas.elements.map(([id, element]) => [id, element.componentType === 'Text' ? { ...element, props: { children: 'Nobody\'s' } } : element]);
    const raw = JSON.stringify({ ...session, canvas: { ...session.canvas, elements: stray } });
    act(() => root?.unmount());
    reset();
    mount(React.createElement(Restoring, { raw }));
    expect(canvas().pageId).toBeNull();

    act(() => files().openFile(idOf('ui/about.ui')));
    expect(words()).toEqual(['About']);
    expect(files().uiFiles.get(idOf('ui/about.ui'))!.originalSource).toBe(ABOUT);
    expect(files().uiFiles.get(idOf('ui/main.ui'))!.originalSource).toBe(MAIN);
  });

  it('has them written to its entry, where the entry is not ui/main.ui and no file is opened', async () => {
    const manifest = { name: 'Entry', version: '1.0.0', description: '', main: 'ui/app.ui', files: { ui: ['ui/app.ui'], logic: [], xdb: [], assets: [] } };
    const bundle = await loadBundle(zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'ui/app.ui': strToU8(ABOUT) }));
    commitProjectSnapshot(prepareProjectSnapshot(bundle));
    mount(React.createElement(Host));
    expect(files().activeFileId).toBeNull();
    expect(words()).toEqual(['About']);

    act(() => canvas().updateElementProps(text().id, { children: 'Typed with no file open' }));
    expect(unsaved()).toBe(true);
    expect(await exported('ui/app.ui')).toContain('Typed with no file open');
  });
});

describe('a page written in Code and saved, then stepped back with Undo', () => {
  it('is unsaved, and so is what is done on the canvas from there', async () => {
    await openBundle();
    const main = idOf('ui/main.ui');
    act(() => {
      // As the Code view writes: one step for Undo, then the text (SourceView.tsx).
      useHistoryStore.getState().push(canvas().elements, canvas().rootId);
      files().updateUIFileSource(main, MAIN.replace('First', 'Written in Code'));
    });
    expect(words()).toEqual(['Written in Code']);
    await act(async () => {
      await saveProject({ view: 'code', existingHandle: null, storage: { setItem: () => undefined, getItem: () => null, removeItem: () => undefined }, writeFile: async () => null });
    });
    expect(unsaved()).toBe(false);

    act(() => void undoCanvas());
    // The canvas is the page as it was before it was written in Code: not what the file holds.
    expect(words()).toEqual(['First']);
    expect(unsaved()).toBe(true);
    act(() => canvas().updateElementProps(text().id, { children: 'More work' }));
    expect(unsaved()).toBe(true);
    expect(await exported('ui/main.ui')).toContain('More work');
  });
});

describe('a page whose text is typed back in Code, then stepped back with Undo', () => {
  it('is unsaved while the canvas has yet to be written over that text', async () => {
    await openBundle();
    const main = idOf('ui/main.ui');
    act(() => {
      useHistoryStore.getState().push(canvas().elements, canvas().rootId);
      files().updateUIFileSource(main, MAIN.replace('First', 'Written in Code'));
    });
    // The text it was opened as, read again: the same page under new ids.
    act(() => files().updateUIFileSource(main, MAIN));
    act(() => void undoCanvas());
    // The canvas is the page as it was opened, and the file holds its text;
    // but the canvas is not what that text was read as this time, and the
    // next flush writes the page again, in the Builder's layout.
    expect(files().uiFiles.get(main)!.originalSource).toBe(MAIN);
    expect(unsaved()).toBe(true);
    expect(await exported('ui/main.ui')).not.toBe(MAIN);
    expect(unsaved()).toBe(true);
  });
});
