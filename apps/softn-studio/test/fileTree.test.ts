/** @vitest-environment jsdom */
/**
 * The Files panel's tree apart from how it is drawn (components/panels/
 * fileTree.ts): the rows in the order they are shown, what the panel remembers
 * of a project's folders, and a folder handed over as a zip.
 */

import { unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  NO_MEMORY,
  alreadyRevealed,
  buildRows,
  folderIsOpen,
  forgetTreeMemory,
  loadTreeMemory,
  saveTreeMemory,
  stillEmpty,
  withFolder,
  withMoved,
  withRevealed,
  withoutFolder,
  type TreeMemory,
} from '../src/components/panels/fileTree';
import { zipFolder } from '../src/lib/fileTransfer';
import type { VFSFile } from '../src/types/studio';

const PATHS = ['manifest.json', 'index.html', 'pages/page-10.html', 'pages/page-2.html', 'pages/parts/card.html', 'assets/logo.png', 'builder/plan.md', 'Zebra.txt', 'apple.txt'];

const rowsOf = (memory: TreeMemory, empty: string[] = memory.empty) =>
  buildRows(PATHS, empty, (path, depth) => folderIsOpen(memory, path, depth));

beforeEach(() => forgetTreeMemory());

describe('the rows of the tree', () => {
  it('are folders before files, by name with numbers in their order, and Studio’s own folder last', () => {
    const rows = rowsOf(NO_MEMORY);
    expect(rows.map((row) => row.path)).toEqual([
      'assets', 'assets/logo.png',
      'pages', 'pages/parts', 'pages/page-2.html', 'pages/page-10.html',
      'apple.txt', 'index.html', 'manifest.json', 'Zebra.txt',
      'builder',
    ]);
  });

  it('say where each is: its depth, its folder, its place among its folder’s rows, and how many files a folder holds', () => {
    const rows = rowsOf(NO_MEMORY);
    const pages = rows.find((row) => row.path === 'pages')!;
    expect(pages).toMatchObject({ isDir: true, depth: 0, parent: '', open: true, count: 3, position: 2, setSize: 7 });
    const second = rows.find((row) => row.path === 'pages/page-2.html')!;
    expect(second).toMatchObject({ isDir: false, depth: 1, parent: 'pages', position: 2, setSize: 3 });
    expect(rows.find((row) => row.path === 'pages/parts')).toMatchObject({ open: false, count: 1 });
    expect(rows.find((row) => row.path === 'builder')).toMatchObject({ isPrivate: true, open: false, count: 1 });
  });

  it('leave out what is in a closed folder, and show what is in one that was opened', () => {
    const closed = withFolder(NO_MEMORY, 'pages', false);
    expect(rowsOf(closed).map((row) => row.path)).not.toContain('pages/page-2.html');
    const deeper = withFolder(NO_MEMORY, 'pages/parts', true);
    expect(rowsOf(deeper).map((row) => row.path)).toContain('pages/parts/card.html');
  });

  it('include a folder a person made that holds nothing yet, with no files to count', () => {
    const rows = rowsOf({ ...NO_MEMORY, empty: ['assets/icons', 'drafts'] });
    expect(rows.find((row) => row.path === 'drafts')).toMatchObject({ isDir: true, count: 0, depth: 0 });
    // Not shown until its folder is: assets is open.
    expect(rows.find((row) => row.path === 'assets/icons')).toMatchObject({ isDir: true, count: 0, depth: 1, parent: 'assets' });
  });
});

describe('what the panel remembers of a project’s folders', () => {
  it('opens the folders a file is in to show it, and changes nothing when they are open', () => {
    const shown = withRevealed(NO_MEMORY, 'pages/parts/card.html');
    expect(folderIsOpen(shown, 'pages/parts', 1)).toBe(true);
    expect(withRevealed(shown, 'pages/parts/card.html')).toBe(shown);
    // A folder at the top that was closed by hand is opened again for the file.
    const reopened = withRevealed(withFolder(NO_MEMORY, 'pages', false), 'pages/page-2.html');
    expect(folderIsOpen(reopened, 'pages', 0)).toBe(true);
  });

  it('opens them once for a file: opening the panel again is not another file', () => {
    expect(alreadyRevealed('p1', 'pages/a.html')).toBe(false);
    expect(alreadyRevealed('p1', 'pages/a.html')).toBe(true);
    expect(alreadyRevealed('p1', 'pages/b.html')).toBe(false);
    expect(alreadyRevealed('p2', 'pages/b.html')).toBe(false);
  });

  it('follows a folder that is renamed or moved, and lets go of one that is deleted', () => {
    const memory: TreeMemory = { open: ['pages/parts', 'assets/icons'], closed: ['pages'], empty: ['pages/parts/new'] };
    expect(withMoved(memory, { from: 'pages', to: 'screens', folder: true })).toEqual({ open: ['screens/parts', 'assets/icons'], closed: ['screens'], empty: ['screens/parts/new'] });
    expect(withoutFolder(memory, 'pages')).toEqual({ open: ['assets/icons'], closed: [], empty: [] });
  });

  it('counts a folder as empty only while nothing is in it', () => {
    expect(stillEmpty(['icons', 'drafts'], ['icons/home.svg', 'index.html'])).toEqual(['drafts']);
  });

  it('is kept by project in this browser, and comes back after the panel is opened again', () => {
    const memory: TreeMemory = { open: ['pages/parts'], closed: ['assets'], empty: ['drafts'] };
    saveTreeMemory('p1', memory);
    expect(loadTreeMemory('p1')).toEqual(memory);
    expect(loadTreeMemory('p2')).toEqual(NO_MEMORY);
    // What the browser kept, read as a page loaded later would read it.
    const kept = JSON.parse(window.localStorage.getItem('softn.studio.files-panel')!) as Record<string, TreeMemory>;
    expect(kept.p1).toMatchObject(memory);
  });

  it('keeps the newest twelve projects, so it does not grow with every project ever opened', () => {
    for (let n = 1; n <= 15; n++) saveTreeMemory(`p${n}`, { ...NO_MEMORY, open: [`folder-${n}`] });
    const kept = JSON.parse(window.localStorage.getItem('softn.studio.files-panel')!) as Record<string, unknown>;
    expect(Object.keys(kept)).toHaveLength(12);
    expect(kept.p15).toBeDefined();
  });

  it('takes a damaged record for none', () => {
    window.localStorage.setItem('softn.studio.files-panel', '{"p9":{"open":"yes","closed":[1,"assets"],"empty":null}}');
    expect(loadTreeMemory('p9')).toEqual({ open: [], closed: ['assets'], empty: [] });
    window.localStorage.setItem('softn.studio.files-panel', 'not json');
    expect(loadTreeMemory('p9')).toEqual(NO_MEMORY);
  });
});

describe('a folder as a zip', () => {
  const file = (content: string | Uint8Array): VFSFile => ({ path: '', content, mimeType: '', lastModified: 0, lastModifiedBy: 'user', version: 1 });

  it('holds the folder’s files under the folder’s own name, and nothing else', () => {
    const files = new Map<string, VFSFile>([
      ['assets/icons/home.svg', file('<svg/>')],
      ['assets/icons/small/dot.png', file(new Uint8Array([1, 2, 3]))],
      ['assets/iconset.svg', file('<svg id="set"/>')],
      ['index.html', file('<h1>Hi</h1>')],
    ]);
    const unpacked = unzipSync(zipFolder(files, 'assets/icons'));
    expect(Object.keys(unpacked).sort()).toEqual(['icons/home.svg', 'icons/small/dot.png']);
    expect(new TextDecoder().decode(unpacked['icons/home.svg'])).toBe('<svg/>');
    expect(unpacked['icons/small/dot.png']).toEqual(new Uint8Array([1, 2, 3]));
  });
});
