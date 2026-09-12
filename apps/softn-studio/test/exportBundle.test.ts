/**
 * What the export writes, and what it refuses to write silently.
 *
 * Two defects pinned here. SHR-05: buildBundle rejected any path containing
 * two dots, so a legitimate asset such as assets/version..png was dropped
 * from the archive without a word, and an entry whose path aliased another
 * (case, backslashes) silently overwrote it. STU-08: the manifest spread
 * the project's existing file groups and only replaced `server` when server
 * files remained, so a server group declared once survived the deletion of
 * its last file and the runtime was told to load a file that was not there.
 */

import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { composeBundleSource } from '@softn/core';
import { buildBundle, normalizeManifest, normalizeManifestForBundle, planBundle } from '../src/lib/exportBundle';
import { validateProject } from '../src/lib/validator';
import type { VFSFile } from '../src/types/studio';

const toVfs = (files: Array<{ path: string; content: string | Uint8Array }>) =>
  new Map<string, VFSFile>(
    files.map((f) => [
      f.path,
      { path: f.path, content: f.content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 },
    ]),
  );

const manifestWith = (files: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'App', version: '1.0.0', main: 'ui/main.ui', files, ...extra });

describe('the export and a name with adjacent dots', () => {
  it('keeps assets/version..png in the archive, in the manifest, and past the validator', () => {
    const vfs = toVfs([
      { path: 'manifest.json', content: manifestWith({}) },
      { path: 'ui/main.ui', content: '<App></App>' },
      { path: 'assets/version..png', content: new Uint8Array([1, 2, 3]) },
    ]);
    const archive = unzipSync(buildBundle(vfs, 0));
    expect(Object.keys(archive).sort()).toEqual(['assets/version..png', 'manifest.json', 'ui/main.ui']);
    expect(archive['assets/version..png']).toEqual(new Uint8Array([1, 2, 3]));
    const manifest = JSON.parse(new TextDecoder().decode(archive['manifest.json']));
    expect(manifest.files.assets).toEqual(['assets/version..png']);
    expect(validateProject(vfs, null).filter((e) => e.level === 'error')).toEqual([]);
  });
});

describe('the export and paths it cannot write', () => {
  it('reports a traversal path as a validation error and refuses the export rather than dropping the file', () => {
    const vfs = toVfs([
      { path: 'manifest.json', content: manifestWith({}) },
      { path: 'ui/main.ui', content: '<App></App>' },
      { path: '../escape.ui', content: '<App></App>' },
    ]);
    const plan = planBundle(vfs);
    expect(plan.entries.has('../escape.ui')).toBe(false);
    expect(plan.problems.some((p) => p.level === 'error' && p.file === '../escape.ui')).toBe(true);
    expect(validateProject(vfs, null).some((e) => e.level === 'error' && e.file === '../escape.ui')).toBe(true);
    expect(() => buildBundle(vfs)).toThrow(/escape\.ui/);
  });

  it('reports two files that are one path on a case-insensitive disk instead of letting one overwrite the other', () => {
    const vfs = toVfs([
      { path: 'manifest.json', content: manifestWith({}) },
      { path: 'ui/main.ui', content: '<App>first</App>' },
      { path: 'UI/Main.ui', content: '<App>second</App>' },
    ]);
    const plan = planBundle(vfs);
    const collisions = plan.problems.filter((p) => p.type === 'path-collision');
    expect(collisions.map((p) => p.file).sort()).toEqual(['UI/Main.ui', 'ui/main.ui']);
    expect(() => buildBundle(vfs)).toThrow(/UI\/Main\.ui/);
    expect(validateProject(vfs, null).filter((e) => e.type === 'path-collision')).toHaveLength(2);
  });

  it('keeps private editor state out however it is spelled', () => {
    const vfs = toVfs([
      { path: 'manifest.json', content: manifestWith({}) },
      { path: 'ui/main.ui', content: '<App></App>' },
      { path: 'builder/blueprint.json', content: '{}' },
      { path: 'Builder/notes.json', content: '{}' },
      { path: 'builder\\state.json', content: '{}' },
    ]);
    const plan = planBundle(vfs);
    expect([...plan.entries.keys()].sort()).toEqual(['manifest.json', 'ui/main.ui']);
    expect(plan.problems.filter((p) => p.level === 'error')).toEqual([]);
    const archive = unzipSync(buildBundle(vfs, 0));
    expect(Object.keys(archive).some((k) => /builder/i.test(k))).toBe(false);
  });
});

describe('the manifest and a server group', () => {
  it('keeps declared helper execution order after import and export while including new files', () => {
    const vfs = toVfs([
      { path: 'manifest.json', content: manifestWith({ logic: ['logic/z-base.logic', 'logic/a-derived.logic', 'logic/main.logic', 'logic/z-base.logic', 'logic/deleted.logic'] }) },
      { path: 'ui/main.ui', content: '<logic src="../logic/main.logic" /><Text>{answer}</Text>' },
      { path: 'logic/z-base.logic', content: 'let base = 40;' },
      { path: 'logic/a-derived.logic', content: 'let derived = base + 2;' },
      { path: 'logic/main.logic', content: 'let answer = derived;' },
      { path: 'logic/new-helper.logic', content: 'let extra = true;' },
    ]);
    const archive = unzipSync(buildBundle(vfs, 0));
    const textFiles = new Map(Object.entries(archive).map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]));
    const manifest = JSON.parse(textFiles.get('manifest.json')!);
    expect(manifest.files.logic).toEqual(['logic/z-base.logic', 'logic/a-derived.logic', 'logic/main.logic', 'logic/new-helper.logic']);
    const source = composeBundleSource(textFiles, manifest.main, manifest.files.logic).source;
    expect(source.indexOf('let base')).toBeLessThan(source.indexOf('let derived'));
    expect(source.indexOf('let derived')).toBeLessThan(source.indexOf('let answer'));
    expect(source.match(/let base/g)).toHaveLength(1);
    expect(source).toContain('let extra = true;');
  });

  const base = [
    { path: 'ui/main.ui', content: '<App></App>' },
    { path: 'logic/app.logic', content: 'let x = 1' },
  ];

  it('drops the server group when the last server file is deleted', () => {
    const before = toVfs([
      { path: 'manifest.json', content: manifestWith({ ui: ['ui/main.ui'], logic: ['logic/app.logic'], server: ['server/api.logic'] }) },
      ...base,
      { path: 'server/api.logic', content: 'export function api() {}' },
    ]);
    expect(JSON.parse(normalizeManifestForBundle(before)!).files.server).toEqual(['server/api.logic']);

    const after = new Map(before);
    after.delete('server/api.logic');
    const manifest = JSON.parse(normalizeManifestForBundle(after)!);
    expect(manifest.files).not.toHaveProperty('server');
    // The inspector agrees: nothing in the archive points at a missing server file.
    expect(validateProject(after, null).filter((e) => e.level === 'error')).toEqual([]);
  });

  it('removes only the deleted path when one of several server files goes', () => {
    const vfs = toVfs([
      { path: 'manifest.json', content: manifestWith({ server: ['server/a.logic', 'server/b.logic'] }) },
      ...base,
      { path: 'server/a.logic', content: 'a' },
      { path: 'server/b.logic', content: 'b' },
    ]);
    vfs.delete('server/a.logic');
    expect(JSON.parse(normalizeManifestForBundle(vfs)!).files.server).toEqual(['server/b.logic']);
  });

  it('keeps unknown metadata, and prunes an unknown group entry that names a file no longer in the project, with a warning', () => {
    const vfs = toVfs([
      {
        path: 'manifest.json',
        content: manifestWith(
          { ui: ['ui/main.ui'], fonts: ['assets/a.woff2', 'assets/gone.woff2'], layout: { grid: 12 } },
          { window: { width: 800 }, x_custom: 'kept' },
        ),
      },
      ...base,
      { path: 'assets/a.woff2', content: new Uint8Array([0]) },
    ]);
    const { manifest, warnings } = normalizeManifest(vfs);
    const parsed = JSON.parse(manifest!);
    expect(parsed.window).toEqual({ width: 800 });
    expect(parsed.x_custom).toBe('kept');
    expect(parsed.files.layout).toEqual({ grid: 12 });
    expect(parsed.files.fonts).toEqual(['assets/a.woff2']);
    expect(parsed.files.assets).toEqual(['assets/a.woff2']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ file: 'manifest.json', level: 'warning', type: 'manifest-stale-entry' });
    expect(warnings[0].message).toContain('assets/gone.woff2');
    // The validator carries the same warning.
    expect(validateProject(vfs, null).some((e) => e.type === 'manifest-stale-entry')).toBe(true);
  });
});
