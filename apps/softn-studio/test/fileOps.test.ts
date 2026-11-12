/**
 * What a person does to the project's files from the Files panel
 * (lib/fileOps.ts): each action is one unit of the history under a name in
 * plain words, nothing is written over, the app stays one its readers open,
 * what names a file follows it, and nothing is written while a run works.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { describeUnit, groupHistory } from '../src/components/panels/HistoryPanel';
import { forgetAppliedMigrations, rememberAppliedMigrations } from '../src/lib/agent/appliedMigrations';
import { executeTool } from '../src/lib/agent/executeTool';
import { buildProjectContext } from '../src/lib/agent/prompt';
import {
  addFiles,
  copyEntry,
  createFile,
  deleteEntry,
  folderAsSpelled,
  moveEntry,
  newFolderPath,
  planDeletion,
  renameEntry,
  undoFileOp,
  type PickedFile,
} from '../src/lib/fileOps';
import { MAX_APP_BYTES, MAX_APP_FILES, MAX_FILE_BYTES } from '../src/lib/fileRules';
import { useAIStore, useEditStore, useVFSStore, useWorkspaceStore } from '../src/stores';

const vfs = () => useVFSStore.getState();
const paths = () => [...vfs().files.keys()].sort();
const text = (path: string) => vfs().readFile(path) as string;

/** The newest unit of the history, as the History panel would name it. */
const lastUnit = () => {
  const units = groupHistory(vfs().history);
  return describeUnit(units[units.length - 1]);
};
const unitCount = () => groupHistory(vfs().history).length;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]);

/** A file as the browser hands one over. */
function picked(name: string, content: Uint8Array | string = PNG, size?: number): PickedFile {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return {
    name,
    size: size ?? bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

beforeEach(() => {
  forgetAppliedMigrations();
  useAIStore.getState().setAgentState('idle');
  useEditStore.getState().close();
  useWorkspaceStore.getState().reset();
  vfs().reset();
  vfs().hydrateFiles([
    { path: 'manifest.json', content: JSON.stringify({ name: 'Club', version: '1.0.0', main: 'index.html', icon: 'assets/logo.png' }, null, 2) },
    { path: 'permission.json', content: '{"permissions":{}}' },
    { path: 'index.html', content: '<img src="assets/logo.png"><script src="main.js"></script>' },
    { path: 'main.js', content: 'const logo = asset("assets/logo.png")' },
    { path: 'pages/about.html', content: '<a href="../index.html">Home</a>' },
    { path: 'assets/logo.png', content: PNG },
    { path: 'builder/requirements.md', content: '# Club' },
  ]);
});

describe('a new file', () => {
  it('is one unit, named for what was made, and starts empty', () => {
    const result = createFile('pages', 'contact.html');
    expect(result).toMatchObject({ ok: true, label: 'Created contact.html', focus: 'pages/contact.html' });
    expect(text('pages/contact.html')).toBe('');
    expect(unitCount()).toBe(1);
    expect(lastUnit()).toEqual({ title: 'Created contact.html', detail: 'pages/contact.html' });
    expect(vfs().files.get('pages/contact.html')!.lastModifiedBy).toBe('user');
    expect(useWorkspaceStore.getState().isDirty).toBe(true);
  });

  it('is given the name it was shown it would get', () => {
    const result = createFile('', 'my notes.txt');
    expect(result.ok && result.focus).toBe('my-notes.txt');
  });

  it('is refused where the name is taken, in any case, and nothing is written over', () => {
    expect(createFile('', 'INDEX.html')).toEqual({ ok: false, reason: 'There is already a INDEX.html in the top of the project.' });
    expect(createFile('', 'assets')).toMatchObject({ ok: false });
    expect(text('index.html')).toContain('<img');
    expect(unitCount()).toBe(0);
  });

  it('is refused as a picture, and among Studio’s notes', () => {
    expect(createFile('assets', 'photo.png')).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot start empty/) });
    expect(createFile('builder', 'mine.md')).toMatchObject({ ok: false, reason: expect.stringMatching(/Studio keeps its own notes/) });
  });
});

describe('a new folder', () => {
  it('has a path and writes nothing: a folder with nothing in it is no file', () => {
    expect(newFolderPath('assets', 'icons')).toEqual({ ok: true, path: 'assets/icons' });
    expect(unitCount()).toBe(0);
  });

  it('is refused where a file, a folder or another new folder has the name', () => {
    expect(newFolderPath('', 'Pages')).toMatchObject({ ok: false });
    expect(newFolderPath('', 'main.js')).toMatchObject({ ok: false });
    expect(newFolderPath('', 'drafts', ['drafts'])).toMatchObject({ ok: false });
    expect(newFolderPath('', 'builder')).toMatchObject({ ok: false });
  });
});

describe('files from the computer', () => {
  it('go where each belongs when no folder was pointed at, as one unit', async () => {
    const result = await addFiles([{ file: picked('photo.png') }, { file: picked('contact.html', '<h1>Contact</h1>') }, { file: picked('theme.mp3', new Uint8Array([1, 2])) }], null);
    expect(result.refused).toEqual([]);
    expect(result.added.map((a) => a.path)).toEqual(['assets/photo.png', 'contact.html', 'assets/theme.mp3']);
    expect(vfs().readFile('assets/photo.png')).toEqual(PNG);
    // A page is text, so it can be read and edited; a picture is its bytes.
    expect(text('contact.html')).toBe('<h1>Contact</h1>');
    expect(unitCount()).toBe(1);
    expect(lastUnit().title).toBe('Added 3 files');
    expect(result.done).toMatchObject({ label: 'Added 3 files', said: 'Added 3 files.', focus: 'assets/photo.png' });
  });

  it('go into the folder that was pointed at', async () => {
    const result = await addFiles([{ file: picked('photo.png') }], 'pages');
    expect(result.added).toEqual([{ path: 'pages/photo.png', given: 'photo.png' }]);
    expect(result.done).toMatchObject({ label: 'Added photo.png', said: 'Added photo.png to pages.' });
  });

  it('never write over a file: a name that is taken is numbered, and the name is said', async () => {
    const result = await addFiles([{ file: picked('logo.png', new Uint8Array([9])) }, { file: picked('LOGO.png', new Uint8Array([8])) }], null);
    expect(result.added.map((a) => a.path)).toEqual(['assets/logo-2.png', 'assets/LOGO-3.png']);
    expect(vfs().readFile('assets/logo.png')).toEqual(PNG);
    expect(result.done!.notes).toEqual([
      'There was already a logo.png in assets, so this one is logo-2.png.',
      'There was already a LOGO.png in assets, so this one is LOGO-3.png.',
    ]);
  });

  it('say the name a file is kept under when it is not the one it came with', async () => {
    const result = await addFiles([{ file: picked('Team Photo (final).png') }], null);
    expect(result.added[0].path).toBe('assets/Team-Photo-(final).png');
    expect(result.done!.notes).toEqual(['Team Photo (final).png is kept as Team-Photo-(final).png.']);
  });

  it('use the assets folder as the project spells it', async () => {
    vfs().reset();
    vfs().hydrateFiles([{ path: 'Assets/one.png', content: PNG }]);
    const result = await addFiles([{ file: picked('two.png') }], null);
    expect(result.added[0].path).toBe('Assets/two.png');
    expect(folderAsSpelled(vfs().files.keys(), [], 'assets/Icons')).toBe('Assets/Icons');
  });

  it('keep the folders a dropped folder came with', async () => {
    const result = await addFiles([{ file: picked('home.svg', '<svg/>'), within: 'icons/small' }, { file: picked('logo.png'), within: 'icons' }], 'assets');
    expect(result.added.map((a) => a.path)).toEqual(['assets/icons/small/home.svg', 'assets/icons/logo.png']);
  });

  it('leave out one that is too large, saying the limit, before reading it, and add the others', async () => {
    let read = false;
    const huge: PickedFile = { name: 'film.mp4', size: MAX_FILE_BYTES + 1, arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } };
    const result = await addFiles([{ file: huge }, { file: picked('photo.png') }], null);
    expect(read).toBe(false);
    expect(result.refused).toEqual(['film.mp4 is 51 MB, and one file of an app can be 50 MB at most.']);
    expect(result.added.map((a) => a.path)).toEqual(['assets/photo.png']);
  });

  it('leave out one that cannot be read', async () => {
    const broken: PickedFile = { name: 'gone.png', size: 4, arrayBuffer: async () => { throw new Error('the file was moved'); } };
    const result = await addFiles([{ file: broken }], null);
    expect(result.refused).toEqual(['gone.png could not be read: the file was moved']);
    expect(result.done).toBeNull();
    expect(unitCount()).toBe(0);
  });

  it('leave out what would take the app past the size of a bundle, saying the limit', async () => {
    // Four files of 45 MB are within the limit for one file, and 180 MB together; a fifth is past 200.
    const chunk = new Uint8Array(45 * 1024 * 1024);
    const big = (name: string): PickedFile => ({ name, size: chunk.byteLength, arrayBuffer: async () => chunk.buffer as ArrayBuffer });
    const result = await addFiles(['a', 'b', 'c', 'd', 'e'].map((n) => ({ file: big(`${n}.bin`) })), 'assets');
    expect(result.added).toHaveLength(4);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toMatch(/^e\.bin was left out\. That would make the app \d+ MB, and an app can be 200 MB at most\.$/);
    expect(MAX_APP_BYTES).toBe(200 * 1024 * 1024);
  });

  it('leave out what would be one file more than a bundle holds, saying the limit', async () => {
    vfs().reset();
    vfs().hydrateFiles(Array.from({ length: MAX_APP_FILES - 1 }, (_, i) => ({ path: `data/${i}.txt`, content: '' })));
    const result = await addFiles([{ file: picked('one.txt', 'a') }, { file: picked('two.txt', 'b') }], 'data');
    expect(result.added).toHaveLength(1);
    expect(result.refused).toEqual(['two.txt was left out. An app can hold 10,000 files at most, and this one has 10,000.']);
  });

  it('refuse a page that is not UTF-8 text', async () => {
    const result = await addFiles([{ file: picked('menu.html', new Uint8Array([0x63, 0x61, 0x66, 0xe9])) }], null);
    expect(result.added).toEqual([]);
    expect(result.refused[0]).toMatch(/menu\.html is not UTF-8 text/);
  });

  it('are refused among Studio’s notes', async () => {
    const result = await addFiles([{ file: picked('photo.png') }], 'builder');
    expect(result.added).toEqual([]);
    expect(result.refused[0]).toMatch(/Studio keeps its own notes/);
  });
});

describe('a rename', () => {
  it('is one unit named in plain words, and every file that names it follows in that unit', () => {
    const result = renameEntry('assets/logo.png', false, 'brand.png');
    expect(result).toMatchObject({ ok: true, label: 'Renamed logo.png to brand.png', focus: 'assets/brand.png', caution: false });
    expect(paths()).toContain('assets/brand.png');
    expect(paths()).not.toContain('assets/logo.png');
    expect(vfs().readFile('assets/brand.png')).toEqual(PNG);
    expect(text('index.html')).toBe('<img src="assets/brand.png"><script src="main.js"></script>');
    expect(text('main.js')).toBe('const logo = asset("assets/brand.png")');
    expect(JSON.parse(text('manifest.json')).icon).toBe('assets/brand.png');
    expect(result.ok && result.notes).toEqual(['index.html, main.js and manifest.json name it as assets/brand.png now.']);
    expect(unitCount()).toBe(1);
    expect(lastUnit().title).toBe('Renamed logo.png to brand.png');
  });

  it('is undone and redone whole: the name and every reference together', () => {
    const result = renameEntry('assets/logo.png', false, 'brand.png');
    expect(undoFileOp(result.ok ? result.transactionId! : '')).toBeNull();
    expect(paths()).toContain('assets/logo.png');
    expect(paths()).not.toContain('assets/brand.png');
    expect(text('main.js')).toBe('const logo = asset("assets/logo.png")');
    expect(JSON.parse(text('manifest.json')).icon).toBe('assets/logo.png');
    vfs().redoLast();
    expect(paths()).toContain('assets/brand.png');
    expect(text('main.js')).toBe('const logo = asset("assets/brand.png")');
    // Still named for what it was after the redo.
    expect(lastUnit().title).toBe('Renamed logo.png to brand.png');
  });

  it('of the main page takes the manifest’s main with it, so the app still opens', () => {
    const result = renameEntry('index.html', false, 'start.html');
    expect(result.ok).toBe(true);
    expect(JSON.parse(text('manifest.json')).main).toBe('start.html');
    expect(text('pages/about.html')).toBe('<a href="../start.html">Home</a>');
    expect(result.ok && result.caution).toBe(false);
  });

  it('of a main page the manifest does not name says which page the app opens on now', () => {
    vfs().updateFile('manifest.json', '{"name":"Club","version":"1.0.0"}');
    const result = renameEntry('index.html', false, 'start.html');
    expect(result.ok && result.caution).toBe(true);
    expect(result.ok && result.notes.join(' ')).toMatch(/The app opened on index\.html, which manifest\.json does not name\. It opens on pages\/about\.html now/);
  });

  it('keeps the canvas on the file it showed', () => {
    useWorkspaceStore.getState().setActiveFilePath('pages/about.html');
    renameEntry('pages/about.html', false, 'team.html');
    expect(useWorkspaceStore.getState().activeFilePath).toBe('pages/team.html');
  });

  it('to a name that is taken is refused, and nothing is written over', () => {
    expect(renameEntry('main.js', false, 'index.html')).toEqual({ ok: false, reason: 'There is already a index.html in the top of the project.' });
    expect(renameEntry('main.js', false, 'PAGES')).toMatchObject({ ok: false });
    expect(unitCount()).toBe(0);
  });

  it('that changes only the case of the name is a rename, not a clash with itself', () => {
    const result = renameEntry('assets/logo.png', false, 'Logo.PNG');
    expect(result.ok).toBe(true);
    expect(paths()).toContain('assets/Logo.PNG');
    expect(paths()).not.toContain('assets/logo.png');
  });

  it('to the name it has changes nothing and leaves no unit', () => {
    expect(renameEntry('main.js', false, 'main.js')).toMatchObject({ ok: true, transactionId: null });
    expect(unitCount()).toBe(0);
  });

  it('of a folder takes everything in it, and what names those files', () => {
    const result = renameEntry('assets', true, 'media');
    expect(result).toMatchObject({ ok: true, label: 'Renamed assets to media', focus: 'media' });
    expect(paths()).toContain('media/logo.png');
    expect(text('main.js')).toBe('const logo = asset("media/logo.png")');
    expect(unitCount()).toBe(1);
  });

  it('says what still names the old path where it could not be rewritten', () => {
    vfs().updateFile('index.html', '<!-- assets/logo.png --><img src=assets/logo.png>');
    const result = renameEntry('assets/logo.png', false, 'brand.png');
    expect(result.ok && result.caution).toBe(true);
    expect(result.ok && result.notes.join(' ')).toMatch(/index\.html still names assets\/logo\.png, in a way Studio does not rewrite\./);
  });

  it('is refused for the manifest and the permissions, which are found by their names', () => {
    expect(renameEntry('manifest.json', false, 'app.json')).toMatchObject({ ok: false, reason: expect.stringMatching(/keeps its name/) });
    expect(renameEntry('permission.json', false, 'perms.json')).toMatchObject({ ok: false });
    expect(moveEntry('manifest.json', false, 'assets')).toMatchObject({ ok: false });
  });

  it('is refused for Studio’s notes and for a migration its host has run', () => {
    expect(renameEntry('builder/requirements.md', false, 'brief.md')).toMatchObject({ ok: false, reason: expect.stringMatching(/not changed from here/) });
    expect(renameEntry('builder', true, 'notes')).toMatchObject({ ok: false });
    vfs().createFile('server/migrations/001.sql', 'CREATE TABLE a (id)');
    rememberAppliedMigrations(vfs().files);
    expect(renameEntry('server/migrations/001.sql', false, '002.sql')).toMatchObject({ ok: false, reason: expect.stringMatching(/has already run on this app’s database/) });
    expect(deleteEntry('server', true)).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot be deleted/) });
  });

  it('is refused for a file open in the editor with changes that are not saved', () => {
    useEditStore.getState().open({ path: 'main.js', text: 'changed', baseVersion: 1, baseText: 'const logo = asset("assets/logo.png")' });
    expect(renameEntry('main.js', false, 'app.js')).toMatchObject({ ok: false, reason: expect.stringMatching(/main\.js is open in the editor with changes you have not saved/) });
    expect(paths()).toContain('main.js');
  });
});

describe('a move', () => {
  it('into a folder is one unit, with what names the file following', () => {
    const result = moveEntry('assets/logo.png', false, 'pages');
    expect(result).toMatchObject({ ok: true, label: 'Moved logo.png to pages', focus: 'pages/logo.png' });
    expect(text('main.js')).toBe('const logo = asset("pages/logo.png")');
    expect(unitCount()).toBe(1);
  });

  it('to the top of the project says so', () => {
    expect(moveEntry('pages/about.html', false, '')).toMatchObject({ ok: true, label: 'Moved about.html to the top of the project', focus: 'about.html' });
    // Its own way to the main page is written from where it is now.
    expect(text('about.html')).toBe('<a href="./index.html">Home</a>');
  });

  it('where the name is taken gets a numbered name, which is said', () => {
    vfs().createFile('pages/logo.png', new Uint8Array([7]));
    const result = moveEntry('assets/logo.png', false, 'pages');
    expect(result.ok && result.focus).toBe('pages/logo-2.png');
    expect(result.ok && result.notes[0]).toBe('There was already a logo.png in pages, so it is logo-2.png there.');
    expect(vfs().readFile('pages/logo.png')).toEqual(new Uint8Array([7]));
  });

  it('of a folder into itself, or of anything to where it is, is refused', () => {
    vfs().createFile('assets/icons/home.svg', '<svg/>');
    expect(moveEntry('assets', true, 'assets/icons')).toEqual({ ok: false, reason: 'assets cannot be moved into itself.' });
    expect(moveEntry('assets/logo.png', false, 'assets')).toEqual({ ok: false, reason: 'logo.png is already in assets.' });
  });

  it('of a folder takes its files and has them name the rest of the project from the new place', () => {
    const result = moveEntry('pages', true, 'assets');
    expect(result.ok && result.focus).toBe('assets/pages');
    expect(text('assets/pages/about.html')).toBe('<a href="../../index.html">Home</a>');
  });
});

describe('a copy', () => {
  it('beside the file is a duplicate with a numbered name, one unit', () => {
    const result = copyEntry('assets/logo.png', false, 'assets', [], 'Duplicated');
    expect(result).toMatchObject({ ok: true, label: 'Duplicated logo.png', said: 'Duplicated logo.png: the copy is logo-2.png.', focus: 'assets/logo-2.png' });
    expect(vfs().readFile('assets/logo-2.png')).toEqual(PNG);
    // Its own bytes: neither file is the other's buffer.
    expect(vfs().readFile('assets/logo-2.png')).not.toBe(vfs().readFile('assets/logo.png'));
    expect(unitCount()).toBe(1);
    expect(lastUnit().title).toBe('Duplicated logo.png');
  });

  it('into another folder keeps its name where that is free', () => {
    expect(copyEntry('assets/logo.png', false, 'pages')).toMatchObject({ ok: true, label: 'Copied logo.png to pages', said: 'Copied logo.png to pages.', focus: 'pages/logo.png' });
  });

  it('of a folder copies every file in it', () => {
    const result = copyEntry('pages', true, '', [], 'Duplicated');
    expect(result.ok && result.focus).toBe('pages-2');
    expect(text('pages-2/about.html')).toBe('<a href="../index.html">Home</a>');
  });

  it('is refused past the size of a bundle, saying the limit', () => {
    const chunk = new Uint8Array(45 * 1024 * 1024);
    vfs().applyTransaction(['a', 'b', 'c', 'd'].map((n) => ({ op: 'create' as const, path: `assets/${n}.bin`, content: chunk })));
    expect(copyEntry('assets/a.bin', false, 'assets', [], 'Duplicated')).toMatchObject({ ok: false, reason: expect.stringMatching(/an app can be 200 MB at most/) });
  });
});

describe('a delete', () => {
  it('is one unit, undone whole', () => {
    const result = deleteEntry('pages', true);
    expect(result).toMatchObject({ ok: true, label: 'Deleted the folder pages', said: 'Deleted the folder pages and the file in it.' });
    expect(paths()).not.toContain('pages/about.html');
    expect(undoFileOp(result.ok ? result.transactionId! : '')).toBeNull();
    expect(paths()).toContain('pages/about.html');
  });

  it('says first what the app would lose: the manifest, the main page, what names the file', () => {
    expect(planDeletion('manifest.json', false)).toMatchObject({ ok: true, count: 1, warnings: [expect.stringMatching(/Without it the app cannot be run, published or exported/)] });
    const main = planDeletion('index.html', false);
    expect(main.ok && main.warnings).toEqual([
      'index.html is the app’s main page: the app opens on it.',
      'manifest.json and pages/about.html name it, and will be left asking for a file that is not there.',
    ]);
    const logo = planDeletion('assets/logo.png', false);
    expect(logo.ok && logo.warnings).toEqual(['index.html, main.js and manifest.json name it, and will be left asking for a file that is not there.']);
    expect(planDeletion('permission.json', false)).toMatchObject({ ok: true, warnings: [expect.stringMatching(/is allowed none of that/)] });
  });

  it('has nothing to warn of for a file nothing depends on', () => {
    vfs().createFile('assets/spare.png', PNG);
    expect(planDeletion('assets/spare.png', false)).toEqual({ ok: true, count: 1, warnings: [] });
  });

  it('is refused for Studio’s notes', () => {
    expect(deleteEntry('builder', true)).toMatchObject({ ok: false, reason: expect.stringMatching(/not changed from here/) });
    expect(paths()).toContain('builder/requirements.md');
  });

  it('can be taken back later, when nothing since has touched its files', () => {
    const first = deleteEntry('pages/about.html', false);
    createFile('', 'notes.txt');
    expect(undoFileOp(first.ok ? first.transactionId! : '')).toBeNull();
    expect(paths()).toContain('pages/about.html');
    expect(paths()).toContain('notes.txt');
  });
});

describe('what the AI finds at its next run', () => {
  it('is the project as the person left it: the file they added, under the name they gave it', async () => {
    await addFiles([{ file: picked('photo.png') }], null);
    renameEntry('assets/photo.png', false, 'team.png');
    const context = buildProjectContext();
    expect(context).toContain('assets/team.png  (asset, 12 B)');
    expect(context).not.toContain('assets/photo.png');
  });

  it('and a file it read before the person renamed it is no longer there for it to write over', async () => {
    const seen = new Map();
    const ctx = { seen, env: {} as never, blueprint: null, newTransactionId: () => 'ai-1' };
    const read = await executeTool({ id: '1', name: 'read_file', input: { path: 'main.js' } }, ctx);
    expect(read.isError).toBe(false);
    renameEntry('main.js', false, 'app.js');
    const edit = await executeTool({ id: '2', name: 'edit_file', input: { path: 'main.js', old_string: 'const', new_string: 'let' } }, ctx);
    expect(edit.isError).toBe(true);
    expect(edit.content).toMatch(/There is no file main\.js/);
    // The file under its new name has not been read: it is read before it is changed.
    const blind = await executeTool({ id: '3', name: 'write_file', input: { path: 'app.js', content: 'let x = 1' } }, ctx);
    expect(blind.isError).toBe(true);
    expect(text('app.js')).toBe('const logo = asset("assets/logo.png")');
  });
});

describe('while the AI is working', () => {
  beforeEach(() => useAIStore.getState().setAgentState('building'));

  it('nothing is written by hand, and each action says why', async () => {
    const why = /The AI is working, and may be reading or writing these files\. Changes wait until the run stops\./;
    expect(createFile('', 'notes.txt')).toMatchObject({ ok: false, reason: expect.stringMatching(why) });
    expect(renameEntry('main.js', false, 'app.js')).toMatchObject({ ok: false, reason: expect.stringMatching(why) });
    expect(moveEntry('main.js', false, 'pages')).toMatchObject({ ok: false, reason: expect.stringMatching(why) });
    expect(copyEntry('main.js', false, 'pages')).toMatchObject({ ok: false, reason: expect.stringMatching(why) });
    expect(deleteEntry('main.js', false)).toMatchObject({ ok: false, reason: expect.stringMatching(why) });
    const added = await addFiles([{ file: picked('photo.png') }], null);
    expect(added.added).toEqual([]);
    expect(added.refused[0]).toMatch(why);
    expect(unitCount()).toBe(0);
    expect(paths()).toHaveLength(7);
  });

  it('files that were being read when the run began are not added under it', async () => {
    useAIStore.getState().setAgentState('idle');
    const slow: PickedFile = {
      name: 'photo.png',
      size: PNG.byteLength,
      arrayBuffer: async () => {
        useAIStore.getState().setAgentState('building');
        return PNG.buffer.slice(0) as ArrayBuffer;
      },
    };
    const added = await addFiles([{ file: slow }], null);
    expect(added.added).toEqual([]);
    expect(added.refused).toHaveLength(1);
    expect(paths()).not.toContain('assets/photo.png');
  });

  it('an undo from the panel waits too', () => {
    useAIStore.getState().setAgentState('idle');
    const made = createFile('', 'notes.txt');
    useAIStore.getState().setAgentState('building');
    expect(undoFileOp(made.ok ? made.transactionId! : '')).toMatch(/The AI is working/);
    expect(paths()).toContain('notes.txt');
  });
});
