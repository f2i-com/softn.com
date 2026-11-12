/** @vitest-environment jsdom */
/**
 * On a phone, renaming or moving the file that is open stays in Files.
 *
 * The phone shows one panel at a time, and a file chosen in Files or Pages
 * is shown by going to the preview. That was done whenever the path of the
 * file on the canvas changed, and the Files panel now rewrites that path
 * when the open file is renamed or moved, so the canvas goes on showing it:
 * a person typing a new name for the open file was taken to the preview as
 * they pressed Enter. Pinned here: a file that is chosen is still shown; one
 * that is renamed, moved, or moved with its folder is followed without a
 * word; and a file chosen after the open one was deleted is a file chosen.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openExampleInStores } from '../src/examples';
import { READING_LIST } from '../src/examples/readingList';
import { deleteEntry, moveEntry, renameEntry } from '../src/lib/fileOps';
import { movedByLastStep, useFileChosen } from '../src/lib/shownFile';
import { useEditStore, useVFSStore, useWorkspaceStore } from '../src/stores';
import type { VFSEvent } from '../src/types/studio';

const workspace = () => useWorkspaceStore.getState();
const event = (type: VFSEvent['type'], path: string, transactionId?: string): VFSEvent => ({ type, path, timestamp: 1, source: 'user', transactionId });

describe('what was last done to the files', () => {
  it('took a file from one path to another when it left the first and arrived at the second in that one step', () => {
    const rename = [event('update', 'main.js', 'earlier'), event('delete', 'pages/home.html', 'rename'), event('create', 'pages/start.html', 'rename'), event('update', 'index.html', 'rename')];
    expect(movedByLastStep(rename, 'pages/home.html', 'pages/start.html')).toBe(true);
    // Another file, the other way round, or no file at all: not that.
    expect(movedByLastStep(rename, 'pages/about.html', 'pages/start.html')).toBe(false);
    expect(movedByLastStep(rename, 'pages/start.html', 'pages/home.html')).toBe(false);
    expect(movedByLastStep(rename, null, 'pages/start.html')).toBe(false);
    expect(movedByLastStep(rename, 'pages/home.html', null)).toBe(false);
    expect(movedByLastStep([], 'a', 'b')).toBe(false);
  });

  it('did not, once something else has been done since, or when the two happened in separate steps', () => {
    const since = [event('delete', 'a.html', 'rename'), event('create', 'b.html', 'rename'), event('update', 'main.js', 'edit')];
    expect(movedByLastStep(since, 'a.html', 'b.html')).toBe(false);
    const apart = [event('delete', 'a.html', 'one'), event('create', 'b.html', 'two')];
    expect(movedByLastStep(apart, 'a.html', 'b.html')).toBe(false);
    // An event recorded with no step of its own is no rename.
    expect(movedByLastStep([event('delete', 'a.html'), event('create', 'b.html')], 'a.html', 'b.html')).toBe(false);
  });
});

describe('a phone, with Files showing', () => {
  let container: HTMLDivElement;
  let root: Root;
  /** How many times the phone was taken to the preview. */
  let shown = 0;
  function Phone() {
    useFileChosen(() => {
      shown += 1;
    });
    return null;
  }

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useEditStore.getState().close();
    useVFSStore.getState().reset();
    workspace().reset();
    openExampleInStores(READING_LIST);
    shown = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Phone />));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows a file that is chosen', () => {
    act(() => workspace().setActiveFilePath('pages/home.html'));
    expect(shown).toBe(1);
    act(() => workspace().setActiveFilePath('pages/about.html'));
    expect(shown).toBe(2);
    // The same file again is no change, and the canvas left with no file of its own is nothing to show.
    act(() => workspace().setActiveFilePath('pages/about.html'));
    act(() => workspace().setActiveFilePath(null));
    expect(shown).toBe(2);
  });

  it('stays where it is when the open file is renamed', () => {
    act(() => workspace().setActiveFilePath('pages/home.html'));
    expect(shown).toBe(1);
    let result!: ReturnType<typeof renameEntry>;
    act(() => {
      result = renameEntry('pages/home.html', false, 'start.html');
    });
    expect(result.ok).toBe(true);
    // The canvas follows the file to its new name, and that is all.
    expect(workspace().activeFilePath).toBe('pages/start.html');
    expect(shown).toBe(1);
  });

  it('stays where it is when the open file is moved, by itself or with its folder', () => {
    act(() => workspace().setActiveFilePath('pages/about.html'));
    act(() => {
      expect(moveEntry('pages/about.html', false, '').ok).toBe(true);
    });
    expect(workspace().activeFilePath).toBe('about.html');
    expect(shown).toBe(1);

    act(() => workspace().setActiveFilePath('pages/home.html'));
    expect(shown).toBe(2);
    act(() => {
      expect(renameEntry('pages', true, 'screens').ok).toBe(true);
    });
    expect(workspace().activeFilePath).toBe('screens/home.html');
    expect(shown).toBe(2);
  });

  it('still shows a file chosen after a rename, and one chosen after the open file was deleted', () => {
    act(() => workspace().setActiveFilePath('pages/home.html'));
    act(() => {
      renameEntry('pages/home.html', false, 'start.html');
    });
    expect(shown).toBe(1);
    // Chosen now: the rename is still the newest step, and it is not what brought this file up.
    act(() => workspace().setActiveFilePath('pages/about.html'));
    expect(shown).toBe(2);
    act(() => workspace().setActiveFilePath('pages/start.html'));
    expect(shown).toBe(3);

    act(() => {
      expect(deleteEntry('main.js', false).ok).toBe(true);
    });
    act(() => workspace().setActiveFilePath('main.js'));
    act(() => workspace().setActiveFilePath('pages/about.html'));
    expect(shown).toBe(5);
  });
});
