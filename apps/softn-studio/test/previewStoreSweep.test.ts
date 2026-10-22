/**
 * The preview keeps its records in memory now (VisualCanvas.tsx), and what
 * its stores kept in localStorage before is swept once a session: every
 * `xdb:studio-preview-…` key, and nothing else.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetPreviewScriptStorage,
  resetPreviewStoreSweepForTests,
  sweepPersistedPreviewStores,
} from '../src/lib/previewProject';

/** A Storage over a Map, with the methods the sweep uses. */
function storageOf(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}

beforeEach(() => resetPreviewStoreSweepForTests());

describe('the sweep of the preview stores kept in localStorage', () => {
  it('removes every key a preview kept under a project’s id, and leaves every other', () => {
    const storage = storageOf({
      'xdb:studio-preview-notes:tasks': '[]',
      'xdb:studio-preview-notes::meta': '{}',
      'xdb:studio-preview-shop:orders': '[]',
      'softn:studio-preview-notes:theme': 'dark',
      'xdb:notes:tasks': '[]',
      'softn:notes:theme': 'light',
      'studio:settings': '{}',
    });
    sweepPersistedPreviewStores(storage);
    expect(Array.from({ length: storage.length }, (_, i) => storage.key(i)).sort()).toEqual([
      'softn:notes:theme',
      'studio:settings',
      'xdb:notes:tasks',
    ]);
  });

  it('takes what a preview’s script kept under its store’s id with the store', () => {
    const storage = storageOf({ 'softn:__ephemeral_1:theme': 'dark', 'softn:__ephemeral_10:theme': 'light' });
    forgetPreviewScriptStorage('__ephemeral_1', storage);
    expect(storage.getItem('softn:__ephemeral_1:theme')).toBeNull();
    expect(storage.getItem('softn:__ephemeral_10:theme')).toBe('light');
  });

  it('sweeps once a session', () => {
    const storage = storageOf({ 'xdb:studio-preview-a:x': '[]' });
    sweepPersistedPreviewStores(storage);
    storage.setItem('xdb:studio-preview-b:y', '[]');
    sweepPersistedPreviewStores(storage);
    expect(storage.getItem('xdb:studio-preview-b:y')).toBe('[]');
  });

  it('says nothing when storage refuses', () => {
    const refusing = { get length(): number { throw new Error('denied'); } } as unknown as Storage;
    expect(() => sweepPersistedPreviewStores(refusing)).not.toThrow();
  });
});
