import { beforeEach, describe, expect, it } from 'vitest';
import { useVFSStore } from '../src/stores/vfsStore';

beforeEach(() => {
  useVFSStore.getState().reset();
});

describe('VFS history', () => {
  it('restores binary content when an asset update is undone', () => {
    const original = new Uint8Array([1, 2, 3]);
    useVFSStore.getState().createFile('assets/icon.png', original);
    useVFSStore.getState().updateFile('assets/icon.png', new Uint8Array([9, 8, 7]));

    // Mutating the caller-owned buffer must not rewrite the saved history.
    original[0] = 42;
    useVFSStore.getState().undoLast();

    expect(useVFSStore.getState().readFile('assets/icon.png')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('restores a binary asset deleted by an AI turn', () => {
    useVFSStore.getState().createFile('assets/sound.wav', new Uint8Array([4, 5, 6]));
    useVFSStore.getState().deleteFile('assets/sound.wav', 'ai');

    useVFSStore.getState().revertAIChanges();

    expect(useVFSStore.getState().readFile('assets/sound.wav')).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('does not add a phantom history entry when deleting a missing file', () => {
    useVFSStore.getState().deleteFile('missing.txt');
    expect(useVFSStore.getState().history).toEqual([]);
  });

  it('clears stale undo state when hydrating a different project', () => {
    useVFSStore.getState().createFile('old.txt', 'old');
    useVFSStore.getState().undoLast();
    expect(useVFSStore.getState().undoStack).toHaveLength(1);

    useVFSStore.getState().hydrateFiles([{ path: 'new.txt', content: 'new' }]);

    expect(useVFSStore.getState().undoStack).toEqual([]);
    expect(useVFSStore.getState().history).toEqual([]);
  });
});
