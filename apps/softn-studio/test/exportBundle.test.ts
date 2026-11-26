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

import { describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { composeBundleSource } from '@softn/core';
import { buildBundle, buildRunnableBundle, normalizeManifest, normalizeManifestForBundle, planBundle } from '../src/lib/exportBundle';
import { readProjectArchive } from '../src/lib/projectImport';
import { validateProject } from '../src/lib/validator';
import type { VFSFile } from '../src/types/studio';
import { READING_LIST_PYTHON } from '../src/examples/readingListPython';

const toVfs = (files: Array<{ path: string; content: string | Uint8Array }>) =>
  new Map<string, VFSFile>(
    files.map((f) => [
      f.path,
      { path: f.path, content: f.content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 },
    ]),
  );

const manifestWith = (files: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'App', version: '1.0.0', main: 'ui/main.ui', files, ...extra });

// The export wrote assets/version..png, and every SoftN reader (this one's, the directory's,
// the hosts') took the two dots for a way out of the bundle and left the file out: the app
// opened without its asset and the directory refused the bundle. Studio keeps such a file, as
// a project may have one, and says what stops the export.
describe('the export and a name with adjacent dots', () => {
  it('refuses assets/version..png, naming it and why, rather than writing what no reader opens', () => {
    const vfs = toVfs([
      { path: 'manifest.json', content: manifestWith({}) },
      { path: 'ui/main.ui', content: '<App></App>' },
      { path: 'assets/version..png', content: new Uint8Array([1, 2, 3]) },
    ]);
    const plan = planBundle(vfs);
    expect(plan.entries.has('assets/version..png')).toBe(false);
    expect(plan.problems).toEqual([expect.objectContaining({ file: 'assets/version..png', level: 'error', type: 'unsafe-path', message: expect.stringMatching(/two dots in a row/) })]);
    expect(validateProject(vfs, null).some((e) => e.level === 'error' && e.file === 'assets/version..png')).toBe(true);
    expect(() => buildBundle(vfs)).toThrow(/version\.\.png/);
    // Renamed, it goes in as it is.
    const renamed = toVfs([...vfs.values()].map((f) => (f.path === 'assets/version..png' ? { ...f, path: 'assets/version.png' } : f)));
    const archive = unzipSync(buildBundle(renamed, 0));
    expect(Object.keys(archive).sort()).toEqual(['assets/version.png', 'manifest.json', 'ui/main.ui']);
    expect(archive['assets/version.png']).toEqual(new Uint8Array([1, 2, 3]));
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

  it('reports a file where another path needs a folder of the same name, however it is spelled', () => {
    for (const [file, inside] of [['ui', 'ui/main.ui'], ['UI', 'ui/main.ui'], ['assets/img', 'Assets/IMG/logo.png']]) {
      const vfs = toVfs([
        { path: 'manifest.json', content: manifestWith({}) },
        { path: 'ui/main.ui', content: '<App></App>' },
        { path: file, content: 'x' },
        ...(inside === 'ui/main.ui' ? [] : [{ path: inside, content: new Uint8Array([1]) }]),
      ]);
      const collisions = planBundle(vfs).problems.filter((p) => p.type === 'path-collision');
      expect(collisions.map((p) => p.file), file).toEqual([file]);
      expect(collisions[0].message).toContain(`"${inside}" needs a folder`);
      expect(() => buildBundle(vfs), file).toThrow(/needs a folder of the same name/);
      expect(validateProject(vfs, null).some((e) => e.type === 'path-collision' && e.file === file), file).toBe(true);
    }
    // A name that only begins like a folder's is another name.
    const fine = toVfs([
      { path: 'manifest.json', content: manifestWith({}) },
      { path: 'ui/main.ui', content: '<App></App>' },
      { path: 'u', content: 'x' },
      { path: 'ui.txt', content: 'x' },
    ]);
    expect(planBundle(fine).problems.filter((p) => p.type === 'path-collision')).toEqual([]);
  });

  it('refuses a file named __proto__ at any depth, by name, while allowing normal names', () => {
    const files = [
      { path: 'manifest.json', content: manifestWith({}) },
      { path: 'ui/main.ui', content: '<App></App>' },
    ];
    expect(() => buildBundle(toVfs([...files, { path: '__proto__', content: new Uint8Array([7, 8, 9]) }]), 0)).toThrow(
      /may not be named "__proto__"/,
    );
    expect(() => buildBundle(toVfs([...files, { path: 'assets/__proto__', content: new Uint8Array([7, 8, 9]) }]), 0)).toThrow(
      /may not be named "__proto__"/,
    );
    const archive = unzipSync(buildBundle(toVfs([...files, { path: 'assets/proto.bin', content: new Uint8Array([7, 8, 9]) }]), 0));
    expect(archive['assets/proto.bin']).toEqual(new Uint8Array([7, 8, 9]));
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

/**
 * A `.py` file is logic. The groups matched `.logic` only, so a Python app's
 * modules were filed under assets and the runtime never loaded the helper the
 * entry imports by name.
 */
describe('the export and the .js files a project carries', () => {
  const html = (files: Array<{ path: string; content: string }>, listed: Record<string, unknown> = {}) =>
    toVfs([{ path: 'manifest.json', content: manifestWith(listed, { main: 'index.html' }) }, ...files]);

  it('files as logic the scripts its pages link and what they import, and nothing else', () => {
    const vfs = html([
      { path: 'index.html', content: '<script src="softn/softn.js"></script><script src="main.js"></script><p>{n}</p>' },
      { path: 'pages/about.html', content: '<script src="../lib/about.js"></script><p>About</p>' },
      { path: 'main.js', content: 'import { twice } from "./lib/helpers.js"\nlet n = twice(1)' },
      { path: 'lib/helpers.js', content: 'export function twice(n) { return n * 2 }' },
      { path: 'lib/about.js', content: 'let about = 1' },
      { path: 'softn/softn.js', content: '(function () {})()' },
      { path: 'vendor/chart.min.js', content: 'window.Chart = 1' },
      { path: 'sw.js', content: 'self.addEventListener("fetch", () => {})' },
    ]);
    const manifest = JSON.parse(normalizeManifestForBundle(vfs)!) as { files: Record<string, string[]> };
    expect([...manifest.files.logic].sort()).toEqual(['lib/about.js', 'lib/helpers.js', 'main.js']);
    expect([...manifest.files.assets].sort()).toEqual(['softn/softn.js', 'sw.js', 'vendor/chart.min.js']);
  });

  it('keeps what the manifest files under assets there, and a Python app Python', () => {
    const vfs = html(
      [
        { path: 'index.html', content: '<script src="main.py"></script><p>{n}</p>' },
        { path: 'main.py', content: 'n = 1\n' },
        { path: 'vendor/chart.js', content: 'window.Chart = 1' },
        { path: 'help/guide.html', content: '<p>Read me</p>' },
      ],
      { assets: ['vendor/chart.js', 'help/guide.html'] }
    );
    const manifest = JSON.parse(normalizeManifestForBundle(vfs)!) as { files: Record<string, string[]> };
    expect(manifest.files.logic).toEqual(['main.py']);
    expect(manifest.files.ui).toEqual(['index.html']);
    expect([...manifest.files.assets].sort()).toEqual(['help/guide.html', 'vendor/chart.js']);
    expect(validateProject(vfs, null).filter((e) => /mixes Python and JavaScript/.test(e.message))).toEqual([]);
  });
});

describe('the export and Python logic', () => {
  it('files the Python example under logic, helpers first as declared, and not under assets', () => {
    const vfs = toVfs(READING_LIST_PYTHON.files);
    const manifest = JSON.parse(normalizeManifestForBundle(vfs)!) as { files: Record<string, string[]> };
    expect(manifest.files.logic).toEqual(['shelf.py', 'main.py']);
    // The example's icon is its one asset; no .py file is filed beside it.
    expect(manifest.files.assets).toEqual(['assets/icon.svg']);
  });

  it('does not file server-side Python under server, since no backend host runs it', () => {
    const vfs = toVfs([
      { path: 'manifest.json', content: manifestWith({}) },
      { path: 'ui/main.ui', content: '<App></App>' },
      { path: 'server/api.py', content: 'def handle(request):\n    return {}\n' },
    ]);
    const manifest = JSON.parse(normalizeManifestForBundle(vfs)!) as { files: Record<string, string[]> };
    expect(manifest.files.server ?? []).toEqual([]);
    expect(manifest.files.logic).toEqual([]);
  });

  it('exports the Python example as a bundle the runtime composes as Python', () => {
    const entries = unzipSync(buildBundle(toVfs(READING_LIST_PYTHON.files)));
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json'])) as { main: string; files: { logic: string[] } };
    const text = new Map(
      Object.entries(entries)
        .filter(([path]) => /\.(ui|html|py)$/.test(path))
        .map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]),
    );
    const composed = composeBundleSource(text, manifest.main, manifest.files.logic);
    expect(composed.languages).toContain('python');
    expect(composed.python?.modules).toEqual(['shelf', 'main']);
  });
});

// Every entry was deflated at level 6, pictures and sound included: they do not shrink, and
// deflating them was most of the time an export took. They are stored as they are now, and
// text is deflated hardest; what comes out is the same bytes either way.
describe('how the export compresses', () => {
  const noise = (length: number, seed: number) => {
    const out = new Uint8Array(length);
    let a = seed;
    for (let i = 0; i < length; i++) out[i] = (a = (Math.imul(a, 1103515245) + 12345) >>> 0) >>> 24;
    return out;
  };
  const project = toVfs([
    { path: 'manifest.json', content: manifestWith({}) },
    { path: 'ui/main.ui', content: `<App>\n${'  <Text>Hello</Text>\n'.repeat(200)}</App>\n` },
    { path: 'assets/photo.jpg', content: noise(40_000, 1) },
    { path: 'assets/song.mp3', content: noise(30_000, 2) },
    { path: 'assets/face.woff2', content: noise(20_000, 3) },
    { path: 'assets/tone.wav', content: new Uint8Array(30_000).fill(7) },
    { path: 'data/table.dat', content: new Uint8Array(10_000).fill(9) },
  ]);
  /** The compression method of each entry, from the archive's own directory. */
  const methods = (zip: Uint8Array): Record<string, number> => {
    const out: Record<string, number> = {};
    unzipSync(zip, { filter: (file) => { out[file.name] = file.compression; return false; } });
    return out;
  };

  it.each([
    ['Export bundle', (files: Map<string, VFSFile>) => buildRunnableBundle(files)],
    ['a handoff', async (files: Map<string, VFSFile>) => buildBundle(files)],
  ])('%s stores what is compressed already, deflates the rest, and reads back as the same files', async (_name, build) => {
    const zip = await build(project);
    expect(methods(zip)).toEqual({
      'manifest.json': 8,
      'ui/main.ui': 8,
      'assets/photo.jpg': 0,
      'assets/song.mp3': 0,
      'assets/face.woff2': 0,
      'assets/tone.wav': 8,
      'data/table.dat': 8,
    });
    // Read as Studio's import reads a bundle (core's reader, which every SoftN host shares).
    const back = new Map(readProjectArchive(zip).map((entry) => [entry.path, entry.content]));
    const planned = planBundle(project).entries;
    expect([...back.keys()].sort()).toEqual([...planned.keys()].sort());
    for (const [path, bytes] of planned) {
      const content = back.get(path)!;
      expect(typeof content === 'string' ? new TextEncoder().encode(content) : content).toEqual(bytes);
    }
  });
});

// The validator, the bundle summary, the preview and the logic check each asked for the same
// files' plan after every change, the check once for every page, and every file of the project
// was encoded each time. It is made once for a set of files now.
describe('the plan of a set of files', () => {
  const project = () => toVfs([
    { path: 'manifest.json', content: manifestWith({}) },
    { path: 'ui/main.ui', content: '<App><Text>1</Text></App>' },
    { path: 'assets/a.png', content: new Uint8Array([1, 2, 3]) },
  ]);

  it('is made once for the same files, and made again when one of them is replaced, in the same map too', () => {
    const files = project();
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      planBundle(files);
      const made = encode.mock.calls.length;
      planBundle(files);
      normalizeManifest(files);
      normalizeManifestForBundle(files);
      expect(encode.mock.calls.length).toBe(made);
      files.set('ui/main.ui', { ...files.get('ui/main.ui')!, content: '<App><Text>2</Text></App>' });
      expect(new TextDecoder().decode(planBundle(files).entries.get('ui/main.ui'))).toBe('<App><Text>2</Text></App>');
      files.delete('assets/a.png');
      expect(planBundle(files).entries.has('assets/a.png')).toBe(false);
    } finally {
      encode.mockRestore();
    }
  });

  it('hands each caller a plan of its own to change', () => {
    const files = project();
    const first = planBundle(files);
    first.entries.delete('ui/main.ui');
    first.problems.push({ file: 'x', level: 'error', type: 'x', message: 'x' });
    const second = planBundle(files);
    expect(second.entries.has('ui/main.ui')).toBe(true);
    expect(second.problems).toEqual([]);
    expect(JSON.parse(new TextDecoder().decode(second.entries.get('manifest.json'))).files.ui).toEqual(['ui/main.ui']);
  });
});
