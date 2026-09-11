/**
 * The VFS store's history contract.
 *
 * The original defects: createFile overwrote an existing path while recording
 * only a `create` event, so undo deleted the file instead of restoring what
 * had been there; updateFile created an absent file with no before-image;
 * an import was recorded as one `create` per file, so undoing it removed the
 * project file by file; and undo restored content but not the version or
 * author, so a file's identity drifted from its history. STU-06 makes create
 * and update fail fast, groups history into transactions that undo, redo
 * and prune as whole units, and restores exact before-images.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_HISTORY, useVFSStore } from '../src/stores/vfsStore';

const store = () => useVFSStore.getState();

beforeEach(() => {
  store().reset();
});

describe('VFS history', () => {
  it('restores binary content when an asset update is undone', () => {
    const original = new Uint8Array([1, 2, 3]);
    store().createFile('assets/icon.png', original);
    store().updateFile('assets/icon.png', new Uint8Array([9, 8, 7]));

    // Mutating the caller-owned buffer must not rewrite the saved history.
    original[0] = 42;
    store().undoLast();

    expect(store().readFile('assets/icon.png')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('restores a binary asset deleted by an AI turn', () => {
    store().createFile('assets/sound.wav', new Uint8Array([4, 5, 6]));
    store().deleteFile('assets/sound.wav', 'ai');

    store().revertAIChanges();

    expect(store().readFile('assets/sound.wav')).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('does not add a phantom history entry when deleting a missing file', () => {
    store().deleteFile('missing.txt');
    expect(store().history).toEqual([]);
  });

  it('clears stale undo state when hydrating a different project', () => {
    store().createFile('old.txt', 'old');
    store().undoLast();
    expect(store().undoStack).toHaveLength(1);

    store().hydrateFiles([{ path: 'new.txt', content: 'new' }]);

    expect(store().undoStack).toEqual([]);
    expect(store().history).toEqual([]);
  });
});

describe('create and update contracts', () => {
  it('createFile refuses an existing path and leaves it untouched', () => {
    store().createFile('ui/main.ui', 'first');
    expect(() => store().createFile('ui/main.ui', 'second')).toThrow(/already exists/);
    expect(store().readFile('ui/main.ui')).toBe('first');
    expect(store().history).toHaveLength(1);
  });

  it('createFile refuses a path that is not a canonical project path, or an alias of a file already there', () => {
    expect(() => store().createFile('../escape.ui', 'x')).toThrow(/not a project path/);
    expect(() => store().createFile('ui\\main.ui', 'x')).toThrow(/not canonical/);
    store().createFile('ui/main.ui', 'x');
    expect(() => store().createFile('UI/Main.ui', 'y')).toThrow(/same file as ui\/main.ui/);
    expect(() => store().batchCreateFiles([{ path: 'a/b.ui', content: '1' }, { path: 'A/B.ui', content: '2' }])).toThrow(/same file/);
    expect(store().files.size).toBe(1);
    // Private editor state is a valid path; only the model is kept out of it.
    store().createFile('builder/blueprint.json', '{}');
    expect(store().files.size).toBe(2);
  });

  it('updateFile refuses an absent path and records nothing', () => {
    expect(() => store().updateFile('ui/nothere.ui', 'x')).toThrow(/no such file/);
    expect(store().files.has('ui/nothere.ui')).toBe(false);
    expect(store().history).toEqual([]);
  });
});

describe('undo restores identical bytes and metadata', () => {
  it('after an update', () => {
    store().createFile('a.txt', 'one', 'user');
    store().updateFile('a.txt', 'two', 'user');
    const before = { ...store().files.get('a.txt')! };
    store().updateFile('a.txt', 'three', 'ai');
    store().undoLast();
    const restored = store().files.get('a.txt')!;
    expect(restored.content).toBe('two');
    expect(restored.version).toBe(before.version);
    expect(restored.lastModifiedBy).toBe(before.lastModifiedBy);
    expect(restored.lastModified).toBe(before.lastModified);
  });

  it('after a delete', () => {
    store().createFile('a.txt', 'one', 'ai');
    store().updateFile('a.txt', 'two', 'ai');
    const before = { ...store().files.get('a.txt')! };
    store().deleteFile('a.txt', 'user');
    store().undoLast();
    expect(store().files.get('a.txt')).toEqual(before);
  });

  it('after a create, and redo brings it back', () => {
    store().createFile('a.txt', 'one', 'ai');
    const made = { ...store().files.get('a.txt')! };
    store().undoLast();
    expect(store().files.has('a.txt')).toBe(false);
    store().redoLast();
    expect(store().files.get('a.txt')).toEqual(made);
  });

  it('keeps binary before-images as copies on the way in and on the way out', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    store().createFile('b.bin', bytes);
    store().updateFile('b.bin', new Uint8Array([4]));
    store().undoLast();
    const restored = store().readFile('b.bin') as Uint8Array;
    restored[0] = 99;
    // Redo, then undo again: the history still holds the untouched image.
    store().redoLast();
    store().undoLast();
    expect(store().readFile('b.bin')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('makes redo unavailable once a new edit follows an undo', () => {
    store().createFile('a.txt', 'one');
    store().updateFile('a.txt', 'two');
    store().undoLast();
    store().updateFile('a.txt', 'other');
    expect(store().undoStack).toEqual([]);
    store().redoLast();
    expect(store().readFile('a.txt')).toBe('other');
  });
});

describe('imports and transactions are single undo units', () => {
  it('undoes an import in one step and redoes it in one step', () => {
    store().batchCreateFiles([
      { path: 'manifest.json', content: '{}' },
      { path: 'ui/main.ui', content: '<App/>' },
      { path: 'assets/a.png', content: new Uint8Array([1]) },
    ]);
    expect(store().files.size).toBe(3);
    store().undoLast();
    expect(store().files.size).toBe(0);
    store().redoLast();
    expect(store().files.size).toBe(3);
    expect(store().readFile('assets/a.png')).toEqual(new Uint8Array([1]));
  });

  it('applies a transaction atomically and undoes it as one unit', () => {
    store().createFile('keep.txt', 'keep');
    store().createFile('gone.txt', 'gone');
    store().createFile('asset.bin', new Uint8Array([7, 7]));
    const id = store().applyTransaction(
      [
        { op: 'create', path: 'new.txt', content: 'new' },
        { op: 'update', path: 'keep.txt', content: 'kept, edited' },
        { op: 'delete', path: 'gone.txt' },
        { op: 'update', path: 'asset.bin', content: new Uint8Array([8]) },
      ],
      'ai',
      'turn-1',
    );
    expect(id).toBe('turn-1');
    expect(store().readFile('new.txt')).toBe('new');
    expect(store().files.has('gone.txt')).toBe(false);
    expect(store().history.filter((e) => e.transactionId === 'turn-1')).toHaveLength(4);

    store().undoLast();
    expect(store().files.has('new.txt')).toBe(false);
    expect(store().readFile('keep.txt')).toBe('keep');
    expect(store().readFile('gone.txt')).toBe('gone');
    expect(store().readFile('asset.bin')).toEqual(new Uint8Array([7, 7]));
    expect(store().files.get('keep.txt')!.version).toBe(1);

    store().redoLast();
    expect(store().readFile('keep.txt')).toBe('kept, edited');
    expect(store().files.has('gone.txt')).toBe(false);
  });

  it('commits nothing when any record of a transaction is invalid', () => {
    store().createFile('exists.txt', 'x');
    expect(() =>
      store().applyTransaction(
        [
          { op: 'update', path: 'exists.txt', content: 'y' },
          { op: 'create', path: 'exists.txt', content: 'z' },
        ],
        'ai',
      ),
    ).toThrow();
    expect(store().readFile('exists.txt')).toBe('x');
    expect(store().history).toHaveLength(1);
    expect(() => store().applyTransaction([{ op: 'delete', path: 'nothere.txt' }], 'ai')).toThrow(/no such file/);
  });

  it('reverts a named transaction explicitly, and refuses when later edits touch its files', () => {
    store().createFile('a.txt', 'a1');
    store().createFile('b.txt', 'b1');
    store().applyTransaction([{ op: 'update', path: 'a.txt', content: 'a2' }, { op: 'delete', path: 'b.txt' }], 'ai', 'turn-x');
    store().createFile('c.txt', 'c1', 'user');

    const reverted = store().revertTransaction('turn-x');
    expect(reverted.ok).toBe(true);
    expect(store().readFile('a.txt')).toBe('a1');
    expect(store().readFile('b.txt')).toBe('b1');
    expect(store().readFile('c.txt')).toBe('c1');
    expect(store().history.some((e) => e.transactionId === 'turn-x')).toBe(false);
    expect(store().revertTransaction('turn-x')).toMatchObject({ ok: false });

    store().applyTransaction([{ op: 'update', path: 'a.txt', content: 'a3' }], 'ai', 'turn-y');
    store().updateFile('a.txt', 'a4 by hand', 'user');
    const refused = store().revertTransaction('turn-y');
    expect(refused).toMatchObject({ ok: false });
    expect(store().readFile('a.txt')).toBe('a4 by hand');
  });

  it('never splits a transaction when pruning history at the cap', () => {
    for (let i = 0; i < MAX_HISTORY - 5; i++) store().createFile(`f${i}.txt`, 'x');
    const records = Array.from({ length: 20 }, (_, i) => ({ op: 'create' as const, path: `t${i}.txt`, content: 'y' }));
    store().applyTransaction(records, 'ai', 'big');
    const history = store().history;
    expect(history.length).toBeLessThanOrEqual(MAX_HISTORY);
    expect(history.filter((e) => e.transactionId === 'big')).toHaveLength(20);
    // A single unit larger than the cap is kept whole rather than cut.
    store().reset();
    store().createFile('before.txt', 'x');
    const huge = Array.from({ length: MAX_HISTORY + 10 }, (_, i) => ({ op: 'create' as const, path: `h${i}.txt`, content: 'y' }));
    store().applyTransaction(huge, 'ai', 'huge');
    expect(store().history.filter((e) => e.transactionId === 'huge')).toHaveLength(MAX_HISTORY + 10);
    expect(store().history.some((e) => e.path === 'before.txt')).toBe(false);
    store().undoLast();
    expect(store().files.size).toBe(1);
  });

  it('revertAIChanges undoes trailing AI units and stops at the first user edit', () => {
    store().createFile('u.txt', 'user', 'user');
    store().applyTransaction([{ op: 'create', path: 'x.txt', content: 'x' }], 'ai', 't1');
    store().applyTransaction([{ op: 'update', path: 'u.txt', content: 'ai edit' }], 'ai', 't2');
    store().revertAIChanges();
    expect(store().files.has('x.txt')).toBe(false);
    expect(store().readFile('u.txt')).toBe('user');
    expect(store().history).toHaveLength(1);
  });
});
