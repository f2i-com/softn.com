/**
 * The order of the import's rules: every path is judged before anything is
 * set aside or renamed.
 *
 * The archive reader drops entries whose paths leave the bundle, so no real
 * archive reaches Studio with one (projectImport.test.ts). Studio's own
 * refusal is the second line, for whatever a reader may one day let through,
 * and it has to hold wherever the path sits: under the `__MACOSX/` tree that
 * is otherwise left out, and under the folder whose name is otherwise taken
 * off. So the reader is stood in for here, and hands Studio what it never
 * does.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readProjectArchive } from '../src/lib/projectImport';

const entries = vi.hoisted(() => ({ next: new Map<string, Uint8Array>() }));

vi.mock('@softn/core', async (original) => ({
  ...(await original<typeof import('@softn/core')>()),
  openBundleArchive: () => ({ readAll: () => entries.next, unsafeNames: () => [] }),
}));

const bytes = (text: string) => new TextEncoder().encode(text);
const MANIFEST = bytes(JSON.stringify({ name: 'Tasks', version: '1.0.0', main: 'ui/main.ui' }));

beforeEach(() => {
  entries.next = new Map();
});

describe('an archive entry whose path Studio refuses', () => {
  it.each([
    ['at the root', { 'manifest.json': MANIFEST, '../outside.ui': bytes('x') }],
    ['under the __MACOSX tree, which is otherwise left out', { 'manifest.json': MANIFEST, '__MACOSX/../outside.ui': bytes('x') }],
    ['as a .DS_Store, which is otherwise left out', { 'manifest.json': MANIFEST, 'ui//.DS_Store': bytes('x') }],
    ['under the folder that is otherwise opened', { 'Tasks/manifest.json': MANIFEST, 'Tasks/../outside.ui': bytes('x') }],
    ['with a drive letter', { 'manifest.json': MANIFEST, 'C:/outside.ui': bytes('x') }],
  ])('refuses the whole archive: %s', (_where, files) => {
    entries.next = new Map(Object.entries(files));
    expect(() => readProjectArchive(new Uint8Array())).toThrow(/unsafe project path/i);
  });

  it('opens the same archives once the path is not there', () => {
    entries.next = new Map(Object.entries({ 'Tasks/manifest.json': MANIFEST, 'Tasks/ui/main.ui': bytes('<App />'), '__MACOSX/Tasks/._manifest.json': bytes('x') }));
    expect(readProjectArchive(new Uint8Array()).map((entry) => entry.path)).toEqual(['manifest.json', 'ui/main.ui']);
  });
});
