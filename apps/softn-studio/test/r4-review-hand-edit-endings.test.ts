/** @vitest-environment jsdom */
/**
 * Round 4 review of a hand edit's line endings (Round 3, stores/editStore.ts): a text box hands
 * its text back with \n alone, and the draft is kept in the file's own endings. A file whose
 * endings are mixed is written with the ending most of its lines have: taken as \r\n for any
 * \r\n in it, a file of \n lines with one \r\n line pasted in was written again whole, every
 * line of it with the other ending, for a change of one word.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { beginHandEdit, saveHandEdit } from '../src/lib/handEdit';
import { asTyped, hasUnsavedDraft, useEditStore } from '../src/stores/editStore';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';

beforeEach(() => {
  useWorkspaceStore.getState().reset();
  useAIStore.getState().resetSession();
  useEditStore.getState().close();
  useVFSStore.getState().reset();
});

/** Open `path` for editing, type `edit` into its box as the box holds it, and save. */
function editAndSave(path: string, content: string, edit: (shown: string) => string): string | Uint8Array | null {
  useVFSStore.getState().hydrateFiles([{ path, content }]);
  expect(beginHandEdit(path)).toBeNull();
  const shown = asTyped(useEditStore.getState().draft!.text);
  useEditStore.getState().change(edit(shown));
  expect(saveHandEdit()).toEqual({ ok: true, changed: true });
  return useVFSStore.getState().readFile(path);
}

describe('a hand edit of a file whose line endings are mixed', () => {
  it('writes again only the lines that do not end as most of the file does: mostly \\n', () => {
    const base = 'line 1\nline 2\nline 3\r\nline 4\nline 5\n';
    expect(editAndSave('notes.txt', base, (shown) => shown.replace('line 1', 'line one'))).toBe('line one\nline 2\nline 3\nline 4\nline 5\n');
  });

  it('writes again only the lines that do not end as most of the file does: mostly \\r\\n', () => {
    const base = 'line 1\r\nline 2\r\nline 3\nline 4\r\nline 5\r\n';
    expect(editAndSave('notes.txt', base, (shown) => shown.replace('line 1', 'line one'))).toBe('line one\r\nline 2\r\nline 3\r\nline 4\r\nline 5\r\n');
  });

  it('has nothing to save once what was typed is taken back again', () => {
    const base = 'line 1\nline 2\nline 3\r\nline 4\nline 5\n';
    useVFSStore.getState().hydrateFiles([{ path: 'notes.txt', content: base }]);
    expect(beginHandEdit('notes.txt')).toBeNull();
    const shown = asTyped(useEditStore.getState().draft!.text);
    useEditStore.getState().change(shown.replace('line 1', 'line one'));
    expect(hasUnsavedDraft()).toBe(true);
    useEditStore.getState().change(shown);
    expect(hasUnsavedDraft()).toBe(false);
    expect(saveHandEdit()).toEqual({ ok: true, changed: false });
    expect(useVFSStore.getState().readFile('notes.txt')).toBe(base);
    expect(useVFSStore.getState().history).toEqual([]);
  });

  it('keeps a file written with \\r\\n alone in \\r\\n, and one written with \\n alone in \\n', () => {
    expect(editAndSave('win.txt', 'a\r\nb\r\n', (shown) => shown.replace('a', 'A'))).toBe('A\r\nb\r\n');
    useEditStore.getState().close();
    expect(editAndSave('unix.txt', 'a\nb\n', (shown) => shown.replace('a', 'A'))).toBe('A\nb\n');
  });
});
