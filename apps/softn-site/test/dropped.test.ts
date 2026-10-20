// Kept in src/lib/ until now, where the workspace's `test/**` include never
// ran it.
import { describe, expect, it } from 'vitest';
import { bundleFiles, dragHasFiles, droppedFiles, isBundleFile, MAX_WALK_DEPTH, onDroppedBundles, stashDroppedBundles, takeDroppedBundles } from '../src/lib/dropped';

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

/** A dropped file or folder as the browser's entries API presents it. Folders list their children two at a time. */
type FakeEntry = { name: string; isFile: boolean; isDirectory: boolean; file?: unknown; createReader?: unknown };
const opened: string[] = [];
function fileEntry(f: File): FakeEntry {
  return {
    name: f.name,
    isFile: true,
    isDirectory: false,
    file: (ok: (f: File) => void) => {
      opened.push(f.name);
      ok(f);
    },
  };
}
function folderEntry(name: string, children: FakeEntry[]): FakeEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let at = 0;
      return {
        readEntries: (ok: (batch: FakeEntry[]) => void) => {
          const batch = children.slice(at, at + 2);
          at += batch.length;
          setTimeout(() => ok(batch), 0);
        },
      };
    },
  };
}
/** A drop's DataTransfer: `files` as the browser lists them (a folder is an empty, typeless file), `items` with their entries. */
function dropOf(entries: FakeEntry[]): DataTransfer {
  return {
    types: ['Files'],
    files: entries.map((e) => new File([], e.name)),
    items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
  } as unknown as DataTransfer;
}

describe('a dropped folder', () => {
  it('is opened for the bundles in it, folders within it too, in name order', async () => {
    opened.length = 0;
    const folder = folderEntry('apps', [
      fileEntry(file('b.softn')),
      fileEntry(file('readme.md', 'text/markdown')),
      folderEntry('more', [fileEntry(file('c.softn')), fileEntry(file('shot.png', 'image/png'))]),
      fileEntry(file('a.softn')),
      folderEntry('.git', [fileEntry(file('hidden.softn'))]),
      folderEntry('node_modules', [fileEntry(file('dep.zip'))]),
      fileEntry(file('archive', 'application/zip')),
    ]);
    const files = await droppedFiles(dropOf([folder]));
    expect(bundleFiles(files).map((f) => f.name)).toEqual(['a.softn', 'archive', 'b.softn', 'c.softn']);
    // A file whose name says it is not a bundle is not even opened.
    expect(opened).not.toContain('readme.md');
    expect(opened).not.toContain('shot.png');
  });

  it('takes loose files dropped beside the folder, and leaves a drop with no folder as the browser listed it', async () => {
    const loose = fileEntry(file('loose.softn'));
    const both = await droppedFiles(dropOf([loose, folderEntry('more', [fileEntry(file('inner.softn'))])]));
    expect(both.map((f) => f.name)).toEqual(['loose.softn', 'inner.softn']);

    const plain = dropOf([fileEntry(file('one.softn')), fileEntry(file('two.softn'))]);
    expect(await droppedFiles(plain)).toEqual(Array.from(plain.files));
    // A browser with no entries API, or a test's drag: the files list.
    const listOnly = { types: ['Files'], files: [file('x.softn')] } as unknown as DataTransfer;
    expect((await droppedFiles(listOnly)).map((f) => f.name)).toEqual(['x.softn']);
    expect(await droppedFiles(null)).toEqual([]);
  });

  it('stops so many folders down', async () => {
    let nested: FakeEntry = fileEntry(file('deep.softn'));
    for (let i = 0; i < MAX_WALK_DEPTH + 2; i++) nested = folderEntry(`d${i}`, [nested]);
    expect(await droppedFiles(dropOf([nested]))).toEqual([]);
  });
});
