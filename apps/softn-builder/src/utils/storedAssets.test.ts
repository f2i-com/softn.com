// @vitest-environment jsdom
/**
 * A project's pictures stay restorable while its text is kept as it changes.
 *
 * The copy of unsaved work was the whole project in one string, pictures
 * included while they were under a megabyte and a half, and without them
 * above that. So a project with a two megabyte picture, which the browser
 * had kept whole since its last Save, lost the picture from the record at
 * the first edit after it; and a project under the budget had every
 * picture encoded and written again for each word typed.
 *
 * The assets are a record of their own now (utils/storedAssets.ts), written
 * when the set of them changes. What is held here: the picture is there to
 * restore after an edit; an edit to the text writes no asset; adding,
 * replacing and removing one each do; a store that refuses the assets still
 * takes the text, and the offer says what is missing; a record from before
 * restores; a Save that ends late pairs nothing wrongly; and another tab's
 * assets are another tab's copy.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_DELAY_MS, RECOVERY_TAKEN, useRecoveryCopy } from '../hooks/useRecoveryCopy';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import type { AssetFile } from '../types/builder';
import { SESSION_STORAGE_KEY, captureSession, commitProjectSnapshot, exportQuarantinedSession, prepareSessionSnapshot, quarantineSession } from './openProject';
import { restoreOffer, writeRecoveryCopy } from './recoveryCopy';
import { resetPersistedRevisions, saveProject } from './saveProject';
import { SESSION_ASSETS_HEAD_KEY, SESSION_ASSETS_KEY, captureAssets, joinStoredSession, resetRefusedAssets } from './storedAssets';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const TWO_MEGABYTES = 2 * 1024 * 1024;
const canvas = () => useCanvasStore.getState();
const text = () => window.localStorage.getItem(SESSION_STORAGE_KEY);
const assets = () => window.localStorage.getItem(SESSION_ASSETS_KEY);

function edit(words: string): void {
  const id = canvas().addElement('Text', canvas().rootId!, undefined, { starter: true });
  canvas().updateElementProps(id, { children: words });
}

/** A picture of this size whose bytes depend on `seed`, so that two of one size are two pictures. */
function picture(bytes: number, seed = 1): Uint8Array {
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 997) data[i] = (i * 31 + seed) & 0xff;
  data[0] = seed;
  return data;
}

/** Put an asset in the project, as the Files panel does: a new entry, and nothing changed in place. */
function setAsset(name: string, data: Uint8Array | null): void {
  const files = useFilesStore.getState();
  const id = `asset_${name}`;
  const nodes = new Map(files.nodes);
  const assetFiles = new Map(files.assetFiles);
  const folder = [...nodes.values()].find((node) => node.type === 'folder' && node.path === 'assets')!;
  if (data === null) {
    assetFiles.delete(id);
    nodes.delete(id);
    nodes.set(folder.id, { ...folder, children: (folder.children ?? []).filter((child) => child !== id) });
  } else {
    assetFiles.set(id, { name, bundlePath: `assets/${name}`, type: 'image/png', data });
    if (!nodes.has(id)) {
      nodes.set(id, { id, name, path: `assets/${name}`, type: 'file', fileType: 'asset', parentId: folder.id, isDirty: false } as never);
      nodes.set(folder.id, { ...folder, children: [...(folder.children ?? []), id] });
    }
  }
  useFilesStore.setState({ nodes, assetFiles });
  useProjectStore.getState().markDirty();
}

/** What the next open would restore: the stored text with the stored assets put back into it. */
function restored(): { files: Map<string, AssetFile>; missing: number; total: number; words: string[]; tree: string[] } {
  const joined = joinStoredSession(text()!, assets());
  const snapshot = prepareSessionSnapshot(joined.raw);
  if (snapshot.files.kind !== 'state') throw new Error('a stored session comes back as the files it held');
  return {
    files: snapshot.files.assetFiles,
    missing: joined.assets.missing,
    total: joined.assets.total,
    words: [...snapshot.canvas.elements.values()].map((element) => String(element.props.children ?? '')).filter(Boolean),
    tree: [...snapshot.files.nodes.values()].filter((node) => node.fileType === 'asset').map((node) => node.path),
  };
}

const save = () => saveProject({ view: 'design', existingHandle: null, build: async () => new Uint8Array([1]), writeFile: async () => null });
/** How many times the store was asked to take the assets record, from here on. */
function assetWrites(): () => number {
  const spy = vi.spyOn(Storage.prototype, 'setItem');
  return () => spy.mock.calls.filter(([key]) => key === SESSION_ASSETS_KEY).length;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  useNotificationStore.getState().clearAll();
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  canvas().reset();
  useSchemaStore.getState().reset();
  useHistoryStore.getState().clear();
  resetPersistedRevisions();
  resetRefusedAssets();
  useProjectStore.getState().setName('Field Notes');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a project with a two megabyte picture', () => {
  it('has the picture to restore after a Save and an edit: the copy of the edit does not take it out of the store', { timeout: 30000 }, async () => {
    const bytes = picture(TWO_MEGABYTES);
    setAsset('photo.png', bytes);
    expect((await save()).kind).toBe('saved');
    expect(restored().files.get('asset_photo.png')?.data.byteLength).toBe(TWO_MEGABYTES);

    edit('typed after the save');
    expect(writeRecoveryCopy({ view: 'design' })).toMatchObject({ kind: 'written', assets: 'kept' });
    const back = restored();
    expect(back.words).toContain('typed after the save');
    expect(back.missing).toBe(0);
    expect(back.tree).toEqual(['assets/photo.png']);
    // Byte for byte.
    const data = back.files.get('asset_photo.png')!.data;
    expect(data.length === bytes.length && data.every((byte, at) => byte === bytes[at])).toBe(true);
    // And it is the whole project that comes back onto the canvas and into Files.
    commitProjectSnapshot(prepareSessionSnapshot(joinStoredSession(text()!, assets()).raw));
    expect(useFilesStore.getState().assetFiles.get('asset_photo.png')!.data.byteLength).toBe(TWO_MEGABYTES);
  });

  it('is not written again for an edit to the text, and the text does not carry it', { timeout: 30000 }, async () => {
    setAsset('photo.png', picture(TWO_MEGABYTES));
    await save();
    const written = assetWrites();
    for (const words of ['one', 'two', 'three']) {
      edit(words);
      expect(writeRecoveryCopy({ view: 'design' }).kind).toBe('written');
    }
    await save();
    expect(written()).toBe(0);
    expect(text()!.length).toBeLessThan(50_000);
    expect(text()).toContain('three');
  });
});

describe('the record of a project\'s assets', () => {
  it('is written when one is added, when one is replaced and when one is removed, and removed with the last', () => {
    const written = assetWrites();
    setAsset('a.png', picture(4000, 1));
    writeRecoveryCopy({ view: 'design' });
    expect(written()).toBe(1);
    setAsset('b.png', picture(5000, 2));
    writeRecoveryCopy({ view: 'design' });
    expect(written()).toBe(2);
    // Replaced by another of the same name and the same size: other bytes.
    setAsset('a.png', picture(4000, 9));
    writeRecoveryCopy({ view: 'design' });
    expect(written()).toBe(3);
    expect(restored().files.get('asset_a.png')!.data[0]).toBe(9);
    setAsset('b.png', null);
    writeRecoveryCopy({ view: 'design' });
    expect(written()).toBe(4);
    expect([...restored().files.keys()]).toEqual(['asset_a.png']);
    // The same set again is not a change.
    edit('words');
    writeRecoveryCopy({ view: 'design' });
    expect(written()).toBe(4);

    setAsset('a.png', null);
    writeRecoveryCopy({ view: 'design' });
    expect(assets()).toBeNull();
    expect(window.localStorage.getItem(SESSION_ASSETS_HEAD_KEY)).toBeNull();
    expect(restored().total).toBe(0);
  });

  it('is known by what it holds: the same assets in another order, or read again, are the same set', () => {
    const a: AssetFile = { name: 'a.png', bundlePath: 'assets/a.png', type: 'image/png', data: picture(3000, 1) };
    const b: AssetFile = { name: 'b.png', bundlePath: 'assets/b.png', type: 'image/png', data: picture(3000, 2) };
    const one = captureAssets(new Map([['1', a], ['2', b]])).signature;
    expect(captureAssets(new Map([['2', b], ['1', a]])).signature).toBe(one);
    // Other bytes of the same length, another name, another size: each another set.
    expect(captureAssets(new Map([['1', a], ['2', { ...b, data: picture(3000, 3) }]])).signature).not.toBe(one);
    expect(captureAssets(new Map([['1', a], ['2', { ...b, bundlePath: 'assets/c.png' }]])).signature).not.toBe(one);
    expect(captureAssets(new Map([['1', a], ['2', { ...b, data: picture(3001, 2) }]])).signature).not.toBe(one);
    // The same bytes in a new array, as a project opened again holds them.
    expect(captureAssets(new Map([['1', { ...a, data: new Uint8Array(a.data) }], ['2', b]])).signature).toBe(one);
  });
});

describe('a store that will not take the assets', () => {
  /** A store with room for the text and none for a record of assets larger than `room`. */
  function tight(room: number) {
    const real = window.localStorage;
    const attempts: string[] = [];
    return {
      attempts,
      storage: {
        getItem: (key: string) => real.getItem(key),
        removeItem: (key: string) => real.removeItem(key),
        setItem: (key: string, value: string) => {
          attempts.push(key);
          if (key === SESSION_ASSETS_KEY && value.length > room) throw new DOMException('full', 'QuotaExceededError');
          real.setItem(key, value);
        },
      },
    };
  }

  it('still takes the text, and the offer says the pictures are not in it', () => {
    setAsset('photo.png', picture(60_000));
    edit('kept all the same');
    const { storage } = tight(1000);
    expect(writeRecoveryCopy({ view: 'design', storage })).toMatchObject({ kind: 'written', assets: 'left-out' });
    const back = restored();
    expect(back.words).toContain('kept all the same');
    expect(back).toMatchObject({ total: 1, missing: 1, tree: [] });
    expect(back.files.size).toBe(0);
    expect(restoreOffer(text()!, { total: 1, missing: 1 })).toContain('Its pictures and other assets could not be kept in this browser and are not in it: add them again, or open the file you last saved.');
  });

  it('is not asked again for the same set at every change, and is asked when the set is another', () => {
    setAsset('photo.png', picture(60_000));
    const { storage, attempts } = tight(1000);
    for (const words of ['one', 'two', 'three']) {
      edit(words);
      writeRecoveryCopy({ view: 'design', storage });
    }
    expect(attempts.filter((key) => key === SESSION_ASSETS_KEY)).toHaveLength(1);
    setAsset('photo.png', picture(61_000));
    writeRecoveryCopy({ view: 'design', storage });
    expect(attempts.filter((key) => key === SESSION_ASSETS_KEY)).toHaveLength(2);
  });

  it('is asked again by a Save: a Save is asked for, and room may have been made since', async () => {
    setAsset('photo.png', picture(60_000));
    const { storage, attempts } = tight(1000);
    for (const words of ['one', 'two']) {
      edit(words);
      writeRecoveryCopy({ view: 'design', storage });
    }
    expect(attempts.filter((key) => key === SESSION_ASSETS_KEY)).toHaveLength(1);
    await saveProject({ view: 'design', existingHandle: null, build: async () => new Uint8Array([1]), writeFile: async () => null, storage });
    expect(attempts.filter((key) => key === SESSION_ASSETS_KEY)).toHaveLength(2);
  });

  it('keeps what it had: a picture added that does not fit leaves the others to restore, and the offer counts', () => {
    setAsset('small.png', picture(3000));
    const { storage } = tight(20_000);
    edit('first');
    expect(writeRecoveryCopy({ view: 'design', storage })).toMatchObject({ assets: 'kept' });
    setAsset('large.png', picture(60_000));
    expect(writeRecoveryCopy({ view: 'design', storage })).toMatchObject({ kind: 'written', assets: 'left-out' });
    const back = restored();
    expect(back).toMatchObject({ total: 2, missing: 1, tree: ['assets/small.png'] });
    expect(restoreOffer(text()!, { total: 2, missing: 1 })).toContain('1 of its 2 pictures and other assets could not be kept in this browser and is not in it');
  });

  it('is said by a Save too, which is still a save', async () => {
    setAsset('photo.png', picture(60_000));
    const { storage } = tight(1000);
    const outcome = await saveProject({ view: 'design', existingHandle: null, build: async () => new Uint8Array([1]), writeFile: async () => null, storage });
    expect(outcome).toMatchObject({ kind: 'saved', sessionStored: true, sessionAssets: 'left-out' });
    expect(restoreOffer(text()!, { total: 1, missing: 1 })).toBe('Restore the last locally saved builder session? Its pictures and other assets could not be kept in this browser and are not in it: add them again, or open the file you last saved.');
  });
});

describe('a record from before the assets were kept apart', () => {
  it('restores as it did: its assets are in it', () => {
    setAsset('photo.png', picture(5000));
    edit('old words');
    const old = JSON.stringify(captureSession('design'));
    expect(old).toContain('"assetFiles":[["asset_photo.png"');
    const joined = joinStoredSession(old, null);
    expect(joined.raw).toBe(old);
    expect(joined.assets).toEqual({ total: 1, missing: 0 });
    const snapshot = prepareSessionSnapshot(joined.raw);
    if (snapshot.files.kind !== 'state') throw new Error('a stored session comes back as the files it held');
    expect(snapshot.files.assetFiles.get('asset_photo.png')!.data.byteLength).toBe(5000);
    expect(restoreOffer(old, joined.assets)).toBe('Restore the last locally saved builder session?');
  });
});

describe('a stored session that will not restore', () => {
  it('is set aside with its pictures: the next project\'s work does not take them out of the store, and the download has them', async () => {
    setAsset('photo.png', picture(5000, 7));
    edit('words that would not restore');
    writeRecoveryCopy({ view: 'design' });
    quarantineSession(text()!, new Error('will not restore'), assets());
    expect(text()).toBeNull();
    // A new project, and work in it. Its copy names no asset, and so removes
    // the record of them: which was the pictures of the session set aside.
    useProjectStore.getState().reset();
    useFilesStore.getState().reset();
    canvas().reset();
    edit('new work');
    expect(writeRecoveryCopy({ view: 'design' }).kind).toBe('written');
    expect(assets()).toBeNull();

    // What Export → Recovery hands over, read back as a session.
    let handed: Blob | null = null;
    const address = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
    const before = { create: address.createObjectURL, revoke: address.revokeObjectURL };
    address.createObjectURL = (blob: Blob) => { handed = blob; return 'blob:kept'; };
    address.revokeObjectURL = () => undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      expect(await exportQuarantinedSession()).toBe(true);
    } finally {
      address.createObjectURL = before.create;
      address.revokeObjectURL = before.revoke;
    }
    const downloaded = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(handed!);
    });
    const snapshot = prepareSessionSnapshot(downloaded);
    if (snapshot.files.kind !== 'state') throw new Error('a stored session comes back as the files it held');
    const photo = snapshot.files.assetFiles.get('asset_photo.png');
    expect(photo?.data.byteLength).toBe(5000);
    expect(photo?.data[0]).toBe(7);
    expect([...snapshot.canvas.elements.values()].some((element) => element.props.children === 'words that would not restore')).toBe(true);
  });
});

describe('a Save that ends after the work has gone on', () => {
  /** A Save whose file is written when the function handed back is called. */
  function slowSave() {
    let done!: () => void;
    const saving = saveProject({ view: 'design', existingHandle: null, build: async () => new Uint8Array([1]), writeFile: () => new Promise((resolve) => { done = () => resolve(null); }) });
    return { saving, finish: async () => { done(); return saving; } };
  }

  it('leaves the newer text with the newer picture: it writes neither of its own', async () => {
    setAsset('photo.png', picture(4000, 1));
    const { finish } = slowSave();
    await new Promise((resolve) => setTimeout(resolve, 0));
    setAsset('photo.png', picture(4000, 2));
    edit('after the save began');
    expect(writeRecoveryCopy({ view: 'design' })).toMatchObject({ kind: 'written', assets: 'kept' });
    expect(await finish()).toMatchObject({ kind: 'saved', sessionStored: false, sessionSuperseded: true });
    const back = restored();
    expect(back.missing).toBe(0);
    expect(back.words).toContain('after the save began');
    expect(back.files.get('asset_photo.png')!.data[0]).toBe(2);
  });

  it('writes the picture it captured with the text it captured, not the one the project has by then', async () => {
    setAsset('photo.png', picture(4000, 1));
    edit('as saved');
    const { finish } = slowSave();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Replaced while the file is being written, and no copy kept of that yet.
    setAsset('photo.png', picture(4000, 2));
    expect(await finish()).toMatchObject({ kind: 'saved', sessionStored: true, sessionAssets: 'kept' });
    const back = restored();
    expect(back.missing).toBe(0);
    expect(back.files.get('asset_photo.png')!.data[0]).toBe(1);
  });
});

describe('two tabs', () => {
  let host: HTMLDivElement;
  let root: Root;
  function Editor(): null {
    useRecoveryCopy('design');
    return null;
  }
  const said = () => useNotificationStore.getState().notifications.map((notification) => notification.message);

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(React.createElement(Editor)));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('a tab whose assets, or whose text, another tab has just replaced is told, once', () => {
    const fromOther = (key: string) => act(() => void window.dispatchEvent(new StorageEvent('storage', { key, newValue: '{}' })));
    act(() => setAsset('photo.png', picture(3000)));
    act(() => edit('mine'));
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10));
    expect(said()).toEqual([]);
    // The other tab's Save, or its own copy, writes these keys: this tab's are no longer what is stored.
    fromOther(SESSION_ASSETS_KEY);
    fromOther(SESSION_STORAGE_KEY);
    fromOther(SESSION_ASSETS_HEAD_KEY);
    expect(said()).toEqual([RECOVERY_TAKEN]);
  });

  it('the last tab to write is the one whose assets are stored', () => {
    act(() => setAsset('photo.png', picture(3000, 1)));
    act(() => edit('mine'));
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10));
    // Another tab puts its own set in the store, with the head that says so.
    window.localStorage.setItem(SESSION_ASSETS_KEY, JSON.stringify({ signature: 'another tab', files: [] }));
    window.localStorage.setItem(SESSION_ASSETS_HEAD_KEY, JSON.stringify({ signature: 'another tab', tab: 'other' }));
    act(() => edit('mine again'));
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10));
    expect(restored()).toMatchObject({ total: 1, missing: 0 });
  });
});
