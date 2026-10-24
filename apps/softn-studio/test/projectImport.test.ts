import { describe, expect, it, vi } from 'vitest';
import { MAX_ZIP_INPUT_BYTES } from '@softn/core';
import { strToU8, zipSync } from 'fflate';
import {
  hasZipSignature,
  normalizeProjectPath,
  readJsonProject,
  readProjectArchive,
  readProjectFile,
  resolveProjectRelativePath,
} from '../src/lib/projectImport';

describe('project import', () => {
  it('rejects an oversized local file before reading or allocating its bytes', async () => {
    const arrayBuffer = vi.fn();
    await expect(readProjectFile({ name: 'large.softn', size: MAX_ZIP_INPUT_BYTES + 1, arrayBuffer })).rejects.toThrow('smaller than 200 MB');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('explains a local file read failure and accepts an available file', async () => {
    await expect(readProjectFile({ name: 'missing.softn', size: 10, arrayBuffer: async () => { throw new Error('NotReadableError'); } })).rejects.toThrow('Check that the file is still available');
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(readProjectFile({ name: 'notes.SOFTN', size: bytes.length, arrayBuffer: async () => bytes.buffer })).resolves.toEqual(bytes);
  });

  // "Could not import notes.softn: Invalid ZIP: missing end-of-central-directory" named the
  // failure in the parser's terms. It is said in the person's, with the reader's words kept as
  // the cause.
  it('says in words that a damaged or cut-off file is not a readable bundle', () => {
    const whole = zipSync({ 'manifest.json': strToU8('{}') });
    for (const bytes of [strToU8('just some text, renamed .softn'), whole.slice(0, whole.length - 10)]) {
      let thrown: Error | null = null;
      try {
        readProjectArchive(bytes);
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown?.message).toMatch(/^This file is not a readable \.softn bundle or ZIP archive: it may be damaged, or only partly downloaded\./);
      expect(thrown?.message).not.toMatch(/end-of-central-directory|Invalid ZIP/);
      expect(String((thrown?.cause as Error | undefined)?.message)).toMatch(/ZIP/);
    }
  });

  it('recognizes normal and empty ZIP records without treating arbitrary data as an archive', () => {
    expect(hasZipSignature(zipSync({ 'hello.txt': strToU8('hello') }))).toBe(true);
    expect(hasZipSignature(zipSync({}))).toBe(true);
    expect(hasZipSignature(strToU8('PK but not a ZIP record'))).toBe(false);
    expect(hasZipSignature(strToU8('plain text'))).toBe(false);
  });

  it('reads text and binary entries through the validated archive reader', () => {
    const archive = zipSync({
      'ui/main.ui': strToU8('<Text>Hello</Text>'),
      'assets/pixel.png': new Uint8Array([137, 80, 78, 71]),
    });

    const entries = readProjectArchive(archive);
    expect(entries).toEqual([
      { path: 'ui/main.ui', content: '<Text>Hello</Text>' },
      { path: 'assets/pixel.png', content: new Uint8Array([137, 80, 78, 71]) },
    ]);
  });

  it('rejects an archive whose entry bytes no longer match its checksum', () => {
    const payload = strToU8('checksum payload');
    const archive = zipSync({ 'data.txt': payload }, { level: 0 });
    const start = archive.findIndex((_byte, index) =>
      payload.every((payloadByte, offset) => archive[index + offset] === payloadByte)
    );
    expect(start).toBeGreaterThan(-1);
    archive[start] ^= 0xff;

    expect(hasZipSignature(archive)).toBe(true);
    expect(() => readProjectArchive(archive)).toThrow();
  });

  it('rejects archive entries whose paths collide canonically', () => {
    const archive = zipSync({
      'UI/Main.ui': strToU8('<Text>First</Text>'),
      'ui/main.ui': strToU8('<Text>Second</Text>'),
    });

    expect(() => readProjectArchive(archive)).toThrow(/colliding project paths/i);
  });

  it('rejects paths that escape or alias the project root', () => {
    expect(normalizeProjectPath('../secret.ui')).toBeNull();
    expect(normalizeProjectPath('/absolute.ui')).toBeNull();
    expect(normalizeProjectPath('C:\\absolute.ui')).toBeNull();
    expect(normalizeProjectPath('ui/./main.ui')).toBeNull();
    expect(normalizeProjectPath('ui//main.ui')).toBeNull();
    expect(normalizeProjectPath('ui\\\\main.ui')).toBeNull();
    expect(normalizeProjectPath('ui\\main.ui')).toBe('ui/main.ui');
  });

  it('resolves relative imports canonically and refuses to traverse above the root', () => {
    expect(resolveProjectRelativePath('ui/pages/home.ui', '../components/card.ui')).toBe(
      'ui/components/card.ui'
    );
    expect(resolveProjectRelativePath('ui/main.ui', '../logic/main.logic')).toBe(
      'logic/main.logic'
    );
    expect(resolveProjectRelativePath('ui/main.ui', 'logic/shared.logic')).toBe(
      'logic/shared.logic'
    );
    expect(resolveProjectRelativePath('ui/main.ui', '../../outside.logic')).toBeNull();
    expect(resolveProjectRelativePath('ui/main.ui', './/components/card.ui')).toBeNull();
  });

  it('keeps only safe string files from JSON projects', () => {
    expect(
      readJsonProject(
        JSON.stringify({
          files: {
            'ui/main.ui': '<Text>Hello</Text>',
            '../outside.ui': '<Text>No</Text>',
            'data.json': { unexpected: true },
          },
        })
      )
    ).toEqual([{ path: 'ui/main.ui', content: '<Text>Hello</Text>' }]);
  });

  it('rejects JSON projects with paths that alias after canonicalization', () => {
    expect(
      readJsonProject(
        JSON.stringify({
          files: {
            'ui/main.ui': '<Text>First</Text>',
            'ui\\main.ui': '<Text>Second</Text>',
          },
        })
      )
    ).toEqual([]);

    expect(
      readJsonProject(
        JSON.stringify({
          files: {
            'UI/Main.ui': '<Text>First</Text>',
            'ui/main.ui': '<Text>Second</Text>',
          },
        })
      )
    ).toEqual([]);
  });
});

/**
 * Text or bytes is core's decision. Studio's own extension list had no `.py`,
 * so a Python app imported with its logic as bytes: not shown to the model,
 * not composable in the preview, not readable by the validator.
 */
/**
 * A bundle someone zipped by hand: the folder itself, compressed from Finder
 * or Explorer. That archive holds the project one folder down, entries for
 * the folders themselves, and on a Mac a `__MACOSX/` tree of resource forks
 * and `.DS_Store` files. None of it is the project, and all of it used to be
 * imported as if it were: an app with no manifest at its root, a
 * `__MACOSX/ui/._main.ui` read as a page. The safety rules are unchanged, and
 * are checked before anything is left out.
 */
describe('a bundle zipped by hand', () => {
  const MANIFEST = JSON.stringify({ name: 'Tasks', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } });
  const PAGE = '<App><Text>Tasks</Text></App>';
  const dir = new Uint8Array(0);
  const paths = (archive: Uint8Array) => readProjectArchive(archive).map((entry) => entry.path).sort();

  it('opens what is inside the one folder that holds everything, manifest included', () => {
    const archive = zipSync({
      'Tasks/': dir,
      'Tasks/manifest.json': strToU8(MANIFEST),
      'Tasks/ui/': dir,
      'Tasks/ui/main.ui': strToU8(PAGE),
    });
    expect(readProjectArchive(archive)).toEqual([
      { path: 'manifest.json', content: MANIFEST },
      { path: 'ui/main.ui', content: PAGE },
    ]);
  });

  it('judges a path again once its folder is taken off', () => {
    // Inside the folder `Tasks/C:/notes.txt` is an odd name and nothing more.
    // Out of it, it is a path that starts with a drive letter, which no
    // project path may: the rule is asked of the path the project will have.
    const archive = zipSync({
      'Tasks/manifest.json': strToU8(MANIFEST),
      'Tasks/ui/main.ui': strToU8(PAGE),
      'Tasks/C:/notes.txt': strToU8('x'),
    });
    expect(() => readProjectArchive(archive)).toThrow(/unsafe project path/);
  });

  it('leaves out the __MACOSX tree and every .DS_Store, at any depth', () => {
    const archive = zipSync({
      'manifest.json': strToU8(MANIFEST),
      'ui/main.ui': strToU8(PAGE),
      '.DS_Store': new Uint8Array([0, 0, 0, 1]),
      'ui/.DS_Store': new Uint8Array([0, 0, 0, 1]),
      '__MACOSX/': dir,
      '__MACOSX/._manifest.json': new Uint8Array([0, 5, 22, 7]),
      '__MACOSX/ui/._main.ui': new Uint8Array([0, 5, 22, 7]),
    });
    expect(paths(archive)).toEqual(['manifest.json', 'ui/main.ui']);
  });

  it('does both at once: a folder compressed on a Mac', () => {
    const archive = zipSync({
      'Tasks/': dir,
      'Tasks/.DS_Store': new Uint8Array([0, 0, 0, 1]),
      'Tasks/manifest.json': strToU8(MANIFEST),
      'Tasks/ui/main.ui': strToU8(PAGE),
      '__MACOSX/': dir,
      '__MACOSX/Tasks/': dir,
      '__MACOSX/Tasks/._manifest.json': new Uint8Array([0, 5, 22, 7]),
      '__MACOSX/Tasks/ui/._main.ui': new Uint8Array([0, 5, 22, 7]),
    });
    expect(paths(archive)).toEqual(['manifest.json', 'ui/main.ui']);
  });

  it('keeps the folder when something sits beside it, or when the manifest is already at the root', () => {
    expect(paths(zipSync({ 'Tasks/manifest.json': strToU8(MANIFEST), 'Tasks/ui/main.ui': strToU8(PAGE), 'README.md': strToU8('# Tasks') })))
      .toEqual(['README.md', 'Tasks/manifest.json', 'Tasks/ui/main.ui']);
    expect(paths(zipSync({ 'manifest.json': strToU8(MANIFEST), 'ui/main.ui': strToU8(PAGE) }))).toEqual(['manifest.json', 'ui/main.ui']);
  });

  it('keeps a folder that holds everything but no manifest: it is not a wrapped bundle', () => {
    expect(paths(zipSync({ 'ui/main.ui': strToU8(PAGE), 'ui/pages/about.ui': strToU8('<Text>About</Text>') }))).toEqual(['ui/main.ui', 'ui/pages/about.ui']);
  });

  // The archive reader drops an entry whose path would leave the bundle before Studio sees it.
  // Opening the folder's contents must not give such an entry a way back in.
  it('never opens an entry whose path leaves the bundle, under a folder that is left out or one that is opened', () => {
    expect(paths(zipSync({ 'manifest.json': strToU8(MANIFEST), '__MACOSX/../../outside.ui': strToU8('x'), '/absolute.ui': strToU8('x') }))).toEqual(['manifest.json']);
    expect(paths(zipSync({ 'Tasks/manifest.json': strToU8(MANIFEST), 'Tasks/../outside.ui': strToU8('x'), 'Tasks//ui/main.ui': strToU8('x') }))).toEqual(['manifest.json']);
  });

  // A name with two dots inside it is a file of the project's (Studio's export wrote them), and
  // the reader leaves it out: the project opened without it, and nothing said so.
  it('says which file the reader left out for two dots in its name, in a folder or not, and opens the rest', () => {
    const told: string[][] = [];
    const tell = (names: string[]) => told.push(names);
    const flat = readProjectArchive(zipSync({ 'manifest.json': strToU8(MANIFEST), 'ui/main.ui': strToU8(PAGE), 'assets/version..png': new Uint8Array([1]) }), tell);
    expect(flat.map((entry) => entry.path).sort()).toEqual(['manifest.json', 'ui/main.ui']);
    const wrapped = readProjectArchive(zipSync({ 'Tasks/manifest.json': strToU8(MANIFEST), 'Tasks/ui/..hidden.ui': strToU8(PAGE) }), tell);
    expect(wrapped.map((entry) => entry.path)).toEqual(['manifest.json']);
    expect(told).toEqual([['assets/version..png'], ['Tasks/ui/..hidden.ui']]);
    // Escapes, and the Mac's litter of such a file, are left out as they were, unremarked.
    readProjectArchive(zipSync({ 'manifest.json': strToU8(MANIFEST), '__MACOSX/assets/._version..png': strToU8('x'), '../outside.ui': strToU8('x') }), tell);
    expect(told).toHaveLength(2);
  });

  it('still refuses names that collide by case, checked on the paths the project will have', () => {
    expect(() => readProjectArchive(zipSync({ 'Tasks/manifest.json': strToU8(MANIFEST), 'Tasks/ui/Main.ui': strToU8('a'), 'Tasks/ui/main.ui': strToU8('b') }))).toThrow(/colliding project paths/i);
    // Two spellings of the folder are two folders: nothing is unwrapped, and their files collide.
    expect(() => readProjectArchive(zipSync({ 'Tasks/manifest.json': strToU8(MANIFEST), 'tasks/manifest.json': strToU8(MANIFEST) }))).toThrow(/colliding project paths/i);
  });

  // Size limits and checksums are the archive reader's, and every entry still comes through it first.
  it('still refuses a folder-wrapped archive whose bytes do not match their checksum', () => {
    const archive = zipSync({ 'Tasks/manifest.json': strToU8(MANIFEST), 'Tasks/ui/main.ui': strToU8(PAGE) }, { level: 0 });
    const corrupt = archive.slice();
    const at = corrupt.findIndex((_, i) => corrupt[i] === 0x3c && corrupt[i + 1] === 0x41);
    corrupt[at + 1] ^= 0xff;
    expect(() => readProjectArchive(corrupt)).toThrow();
  });
});

describe('which imported entries are text', () => {
  it('decodes Python logic as text and keeps images and fonts as bytes, as classifyAsset says', () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const font = new Uint8Array([0, 1, 0, 0]);
    // Core carries SVG as bytes, but Studio decodes it so the model can edit
    // an icon as it always could.
    const svg = strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const archive = zipSync({
      'assets/logo.svg': svg,
      'logic/main.py': strToU8('count = 0\n'),
      'shaders/glow.wgsl': strToU8('@fragment fn main() {}'),
      'models/cube.gltf': strToU8('{"asset":{"version":"2.0"}}'),
      'assets/pixel.png': png,
      'assets/face.woff2': font,
    });

    const entries = new Map(readProjectArchive(archive).map((entry) => [entry.path, entry.content]));
    expect(entries.get('logic/main.py')).toBe('count = 0\n');
    expect(entries.get('shaders/glow.wgsl')).toBe('@fragment fn main() {}');
    expect(entries.get('models/cube.gltf')).toBe('{"asset":{"version":"2.0"}}');
    expect(entries.get('assets/pixel.png')).toEqual(png);
    expect(entries.get('assets/face.woff2')).toEqual(font);
    expect(entries.get('assets/logo.svg')).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
  });

  it('reads back as text what the write tool writes as text, and keeps unknown bytes as bytes', () => {
    // The writer takes any text it is sent unless the type is one kept as
    // bytes. The importer asked core's registry, which calls an extension
    // it does not know "bytes": a .csv the AI wrote came back from its own
    // export as bytes it could not read.
    const blob = new Uint8Array([0x89, 0x00, 0xff, 0xfe, 0x01]);
    const archive = zipSync({
      'data/tasks.csv': strToU8('id,title\n1,Buy milk\n'),
      'README': strToU8('What this app is.\n'),
      'notes/todo.txt': strToU8('caf\u00e9, na\u00efve\n'),
      'data/blob.dat': blob,
      'data/export.dat': strToU8('plain words in a file of no known kind'),
      'assets/pixel.png': strToU8('not really a picture, but named as one'),
    });
    const entries = new Map(readProjectArchive(archive).map((entry) => [entry.path, entry.content]));
    expect(entries.get('data/tasks.csv')).toBe('id,title\n1,Buy milk\n');
    expect(entries.get('README')).toBe('What this app is.\n');
    expect(entries.get('notes/todo.txt')).toBe('caf\u00e9, na\u00efve\n');
    // Not UTF-8, so decoding it would not encode back to the same bytes.
    expect(entries.get('data/blob.dat')).toEqual(blob);
    // And a file of no known kind that is text is read as the text it is.
    expect(entries.get('data/export.dat')).toBe('plain words in a file of no known kind');
    // A type that is bytes stays bytes whatever is in it.
    expect(typeof entries.get('assets/pixel.png')).toBe('object');
  });

  it("decodes a private backend's migrations as text, so its agent can read the schema and write the next one", () => {
    const archive = zipSync({
      'server/main.logic': strToU8('function listItems(req) { return {status: 200, body: {}}; }'),
      'server/migrations/001.sql': strToU8('CREATE TABLE items(id INTEGER PRIMARY KEY);'),
    });
    const entries = new Map(readProjectArchive(archive).map((entry) => [entry.path, entry.content]));
    expect(entries.get('server/migrations/001.sql')).toBe('CREATE TABLE items(id INTEGER PRIMARY KEY);');
    expect(entries.get('server/main.logic')).toContain('function listItems');
  });

  it('keeps decoding the source formats Studio always read as text, which core has no entry for', () => {
    const archive = zipSync({
      'src/helper.ts': strToU8('export const a = 1;\n'),
      'config/app.yaml': strToU8('name: app\n'),
      'config/app.toml': strToU8('name = "app"\n'),
    });
    const entries = new Map(readProjectArchive(archive).map((entry) => [entry.path, entry.content]));
    expect(entries.get('src/helper.ts')).toBe('export const a = 1;\n');
    expect(entries.get('config/app.yaml')).toBe('name: app\n');
    expect(entries.get('config/app.toml')).toBe('name = "app"\n');
  });
});
