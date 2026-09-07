import { describe, expect, it } from 'vitest';
import { bundleFiles, dragHasFiles, isBundleFile, onDroppedBundles, stashDroppedBundles, takeDroppedBundles } from './dropped';

const file = (name: string, type = '') => new File([new Uint8Array([0x50, 0x4b])], name, { type });

describe('bundles dropped anywhere on the site', () => {
  it('takes .softn and .zip files by name, and a zip by type only when the name says nothing', () => {
    expect(isBundleFile(file('Notes.softn'))).toBe(true);
    expect(isBundleFile(file('NOTES.SOFTN', 'application/octet-stream'))).toBe(true);
    expect(isBundleFile(file('archive.zip', 'application/zip'))).toBe(true);
    expect(isBundleFile(file('archive', 'application/zip'))).toBe(true);
    expect(isBundleFile(file('photo.png', 'image/png'))).toBe(false);
    expect(isBundleFile(file('notes.txt', 'text/plain'))).toBe(false);
  });

  it('tells a listener when bundles are stashed, and not when nothing was', () => {
    let heard = 0;
    const stop = onDroppedBundles(() => {
      heard += 1;
    });
    stashDroppedBundles([file('photo.png', 'image/png')]);
    expect(heard).toBe(0);
    stashDroppedBundles([file('a.softn')]);
    expect(heard).toBe(1);
    stop();
    stashDroppedBundles([file('b.softn')]);
    expect(heard).toBe(1);
    takeDroppedBundles();
  });

  it('keeps a drop in order, bundles only, and hands it over once', () => {
    const dropped = [file('b.softn'), file('readme.txt', 'text/plain'), file('a.softn')];
    expect(bundleFiles(dropped).map((f) => f.name)).toEqual(['b.softn', 'a.softn']);
    expect(stashDroppedBundles(dropped)).toBe(2);
    expect(takeDroppedBundles().map((f) => f.name)).toEqual(['b.softn', 'a.softn']);
    expect(takeDroppedBundles()).toEqual([]);
  });

  it('a drop with no bundle stashes nothing', () => {
    expect(stashDroppedBundles([file('photo.png', 'image/png')])).toBe(0);
    expect(takeDroppedBundles()).toEqual([]);
  });

  it('only a drag that carries files counts', () => {
    expect(dragHasFiles(null)).toBe(false);
    expect(dragHasFiles({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false);
    expect(dragHasFiles({ types: ['Files'] } as unknown as DataTransfer)).toBe(true);
  });
});
