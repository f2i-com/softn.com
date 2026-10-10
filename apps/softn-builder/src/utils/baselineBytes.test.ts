/**
 * Edit a page on the canvas, undo everything, and the file is what it was.
 *
 * The first canvas edit writes a page's template again from the visual
 * model: the same page to the engine, in the Builder's own layout. Blank
 * lines between elements go, and a `style={{ … }}` written over five lines
 * is one. Measured on three shipped demos: one word changed and a Divider
 * added, then Undo until there was nothing left to undo, and each file was
 * some hundreds of bytes shorter than it had been opened. Undo put the
 * elements back and not the text. An import whose last use was deleted and
 * brought back by Undo came back above `<logic src>`, where it had stood
 * below.
 *
 * A file keeps what it was read as: its text, and the elements and imports
 * that text was read into (from its bundle, or from what was last written
 * in Code). When the canvas is those elements and imports again, the file
 * is that text again, byte for byte. Nothing else changes: an edit that is
 * kept is still the Builder's writing of the page.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parse, readBundleEntries } from '@softn/core';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import { loadBundle } from './bundleLoader';
import { buildProjectBundle, flushCanvasToActiveFile } from './buildProjectBundle';
import { undoCanvas } from './canvasHistory';
import { captureSession, commitProjectSnapshot, prepareProjectSnapshot, prepareSessionSnapshot } from './openProject';
import { liveImports } from './pageImports';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
/** As the repository stores it, whatever the checkout wrote. */
const page = (...path: string[]) => readFileSync(join(...path), 'utf8').replace(/\r\n/g, '\n');

const MAIN = 'main_ui';
const files = () => useFilesStore.getState();
const canvas = () => useCanvasStore.getState();
const file = (id = MAIN) => files().uiFiles.get(id)!;
const sourceOf = (id = MAIN) => file(id).originalSource!;
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** Put the file on the canvas, as the app does when it is opened. */
function show(id = MAIN): void {
  files().setActiveFile(id);
  const opened = file(id);
  canvas().loadState(opened.elements, opened.rootId, opened.imports, opened.writtenImports);
  useHistoryStore.getState().clear();
}

/** Open `source` as the entry page, as writing it in Code does, and put it on the canvas. */
function open(source: string): void {
  files().updateUIFileSource(MAIN, source);
  files().markFileDirty(MAIN, false);
  show();
}

/** One step for Undo and then the change, as the canvas, the panel and the palette each make one. */
function step(change: () => void): void {
  useHistoryStore.getState().push(canvas().elements, canvas().rootId);
  change();
  // Preview, Code, the export's check and a change of tab each put the canvas into its file.
  flushCanvasToActiveFile();
}

/** Two edits a person makes: a word changed (or a property set, where the page has no words), and a Divider added. */
function editTwice(): void {
  const worded = [...canvas().elements.values()].find((element) => typeof element.props.children === 'string' && element.props.children.trim() !== '' && element.id !== canvas().rootId);
  const first = worded ?? [...canvas().elements.values()].find((element) => element.id !== canvas().rootId)!;
  step(() => canvas().updateElementProps(first.id, worded ? { children: `${String(worded.props.children)} (edited)` } : { title: 'edited' }));
  step(() => void canvas().addElement('Divider', canvas().rootId!, undefined, { starter: true }));
}

function undoAll(): number {
  let steps = 0;
  while (undoCanvas()) steps += 1;
  flushCanvasToActiveFile();
  return steps;
}

beforeEach(() => {
  useProjectStore.getState().reset();
  files().reset();
  canvas().reset();
  useSchemaStore.getState().reset();
  useHistoryStore.getState().clear();
});

// ---------------------------------------------------------------------------
// The pages it was measured on, and the CLI's worked example.
// ---------------------------------------------------------------------------

function pagesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...pagesUnder(path));
    else if (name.endsWith('.ui')) found.push(path);
  }
  return found;
}

// Each with its length in bytes and, as it was first measured, in characters.
const measured: Array<readonly [string, string, number, number]> = [
  // The entry pages of two demos, as their built archives have them (the demos' sources are kept in another repository).
  ['the Notes demo', join(here, '__fixtures__', 'demos', 'Notes.main.ui'), 9414, 9358],
  ['the Showcase demo', join(here, '__fixtures__', 'demos', 'Showcase.main.ui'), 4115, 4115],
  ['the GlamourStudio demo', join(here, '__fixtures__', 'GlamourStudio', 'ui', 'main.ui'), 14000, 13796],
];
const worked = pagesUnder(join(repo, 'packages', '@softn', 'core', 'demo-bundle')).map((path) => [relative(repo, path).replace(/\\/g, '/'), path] as const);

describe('a page edited on the canvas and then undone to the start', () => {
  it.each(measured)('%s: is the file it was opened as, byte for byte', (_name, path, size, characters) => {
    const source = page(path);
    expect(bytes(source)).toBe(size);
    expect(source.length).toBe(characters);
    open(source);
    editTwice();
    // The edits are the Builder's writing of the page: shorter, here, by the layout it does not keep.
    expect(sourceOf()).not.toBe(source);
    expect(undoAll()).toBe(2);
    expect(sourceOf()).toBe(source);
    expect(bytes(sourceOf())).toBe(size);
    expect(file().visualEditBlocked).toBeUndefined();
  });

  it.each(worked)('%s, of the CLI\'s worked example: is the file it was opened as', (_name, path) => {
    const source = page(path);
    open(source);
    editTwice();
    expect(sourceOf()).not.toBe(source);
    undoAll();
    expect(sourceOf()).toBe(source);
  });

  it('is so again after a second round of edits and undos, and for a property typed back by hand', () => {
    const source = page(measured[0][1]);
    open(source);
    editTwice();
    undoAll();
    editTwice();
    undoAll();
    expect(sourceOf()).toBe(source);
    // Not by Undo: the same value put back in the panel is the same page.
    const worded = [...canvas().elements.values()].find((element) => typeof element.props.children === 'string' && element.props.children.trim() !== '')!;
    const was = worded.props.children;
    step(() => canvas().updateElementProps(worded.id, { children: 'Something else' }));
    expect(sourceOf()).not.toBe(source);
    step(() => canvas().updateElementProps(worded.id, { children: was }));
    expect(sourceOf()).toBe(source);
  });
});

describe('the import of a page whose last use is deleted and brought back', () => {
  // Below the logic, as most pages write them. Undo wrote it back above.
  const PAGE = '// The shell.\n<logic src="../logic/main.logic" />\n\n<import Header from="./components/header.ui" />\n<import Footer from "./components/footer.ui" />\n\n<App>\n\n  <Header />\n\n  <Footer />\n</App>\n';

  it('lands where it was, in the spelling it had', () => {
    open(PAGE);
    const header = [...canvas().elements.values()].find((element) => element.componentType === 'Header')!;
    step(() => canvas().deleteElement(header.id));
    expect(sourceOf()).not.toContain('<import Header');
    undoAll();
    // What the canvas would write now is what it was read with.
    expect(liveImports(canvas().elements, canvas().imports, canvas().writtenImports).map((imp) => imp.name)).toEqual(['Header', 'Footer']);
    expect(sourceOf()).toBe(PAGE);
  });
});

describe('an edit that is kept', () => {
  it('is the Builder\'s writing of the page, as it was before: the limit of this', () => {
    const source = page(measured[1][1]);
    open(source);
    editTwice();
    const written = sourceOf();
    // The same page to the engine but for the two edits, and not the author's layout.
    expect(parse(written).diagnostics ?? []).toEqual([]);
    expect(bytes(written)).toBeLessThan(bytes(source) + 80);
    // One of the two undone: still the Builder's writing, and not the file as opened.
    expect(undoCanvas()).toBe(true);
    flushCanvasToActiveFile();
    expect(sourceOf()).not.toBe(source);
    expect(sourceOf()).not.toBe(written);
    expect(sourceOf()).toContain('(edited)');
  });
});

describe('what a file was read as', () => {
  const FIRST = '<App>\n\n  <Text>First</Text>\n\n</App>\n';
  const SECOND = '<App>\n\n\n  <Text>Second</Text>\n</App>\n';
  const edit = () => {
    const text = [...canvas().elements.values()].find((element) => element.componentType === 'Text')!;
    step(() => canvas().updateElementProps(text.id, { children: 'Changed' }));
  };

  it('is what was last written in Code, once something is', () => {
    open(FIRST);
    edit();
    files().updateUIFileSource(MAIN, SECOND);
    show();
    edit();
    undoAll();
    expect(sourceOf()).toBe(SECOND);
  });

  it('follows a page it imports that is renamed: Undo does not bring the old path back', () => {
    const row = files().createFile('ui/components', 'row.ui', 'ui');
    files().updateUIFileSource(row, '<Stack>\n  <Text>Row</Text>\n</Stack>\n');
    open('<import Row from="./components/row.ui" />\n\n<App>\n\n  <Row />\n  <Text>First</Text>\n</App>\n');
    edit();
    files().renameFile(row, 'line.ui');
    // What the page imports has changed under the canvas, which is told, as the app tells it.
    canvas().setImports(file().imports);
    undoAll();
    expect(sourceOf()).not.toContain('row.ui');
    expect(sourceOf()).toContain('<import Row from="./components/line.ui" />');
    // Renamed with nothing else changed, it is the text it was but for the path.
    open('<import Row from="./components/line.ui" />\n\n<App>\n\n  <Row />\n  <Text>First</Text>\n</App>\n');
    files().renameFile(row, 'entry.ui');
    canvas().setImports(file().imports);
    edit();
    undoAll();
    expect(sourceOf()).toBe('<import Row from="./components/entry.ui" />\n\n<App>\n\n  <Row />\n  <Text>First</Text>\n</App>\n');
  });

  it('follows a collection renamed in Data, which is written into the page', () => {
    open('<data>\n  <collection name="tasks" as="tasks" />\n</data>\n\n<App>\n\n  <Text>First</Text>\n</App>\n');
    edit();
    files().applyCollectionChange({ kind: 'rename', from: 'tasks', to: 'jobs' });
    undoAll();
    expect(sourceOf()).not.toContain('name="tasks"');
  });

  it('is the bundle\'s own text for a page opened from one, and what an untouched export writes', async () => {
    // A property an older Builder wrote is read as what the component takes;
    // the text is kept as it came until the page is really edited.
    const ui = '<App>\n\n  <Tag colorScheme="red">Old</Tag>\n\n  <Text>First</Text>\n</App>\n';
    const manifest = { name: 'Old', version: '1.0.0', description: '', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: [], xdb: [], assets: [] } };
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'ui/main.ui': strToU8(ui) }))));
    const id = files().activeFileId!;
    const untouched = new TextDecoder().decode(readBundleEntries(await buildProjectBundle()).get('ui/main.ui'));
    const text = [...canvas().elements.values()].find((element) => element.componentType === 'Text')!;
    step(() => canvas().updateElementProps(text.id, { children: 'Changed' }));
    expect(sourceOf(id)).not.toBe(untouched);
    undoAll();
    expect(sourceOf(id)).toBe(untouched);
  });

  it('is not kept in a saved session, and is the session\'s own text once that is restored', () => {
    open(FIRST);
    edit();
    const written = sourceOf();
    const stored = JSON.stringify(captureSession('design'));
    expect(stored).not.toContain('"baseline"');
    commitProjectSnapshot(prepareSessionSnapshot(stored));
    useHistoryStore.getState().clear();
    const text = [...canvas().elements.values()].find((element) => element.componentType === 'Text')!;
    step(() => canvas().updateElementProps(text.id, { children: 'Again' }));
    undoAll();
    // The text the session held, which was the Builder's writing: not the file of before that.
    expect(sourceOf(files().activeFileId!)).toBe(written);
  });

  it('is the text a restore leaves the page with, where the restore itself rewrites it', () => {
    // A session from before the Code view linked logic holds the entry's
    // logic inline, and restoring it moves the block into its file. What
    // the page is read as has to be the page after that: read as the text
    // before it, Undo wrote the inline block back and dropped the link.
    open('<logic>\nlet a = 1\n</logic>\n\n<App>\n\n  <Text>First</Text>\n</App>\n');
    const stored = JSON.stringify(captureSession('design'));
    const snapshot = prepareSessionSnapshot(stored);
    expect(snapshot.warnings.join(' ')).toContain('kept its logic inline');
    commitProjectSnapshot(snapshot);
    useHistoryStore.getState().clear();
    const id = files().activeFileId!;
    const restored = sourceOf(id);
    expect(restored).toContain('<logic src=');
    const text = [...canvas().elements.values()].find((element) => element.componentType === 'Text')!;
    step(() => canvas().updateElementProps(text.id, { children: 'Changed' }));
    undoAll();
    expect(sourceOf(id)).toBe(restored);
    expect(sourceOf(id)).not.toContain('let a = 1');
  });

  it('is nothing for a page made on the canvas, which has no text of its own', () => {
    expect(file().originalSource).toBeUndefined();
    expect(file().baseline).toBeUndefined();
    step(() => void canvas().addElement('Text', canvas().rootId!, undefined, { starter: true }));
    undoAll();
    expect(file().originalSource).toBeUndefined();
  });
});

// A check on this file's own corpus: the three measured pages are in the repository.
describe('the pages this is held on', () => {
  it('are there', () => {
    for (const [, path] of measured) expect(existsSync(path), path).toBe(true);
    expect(worked.length).toBeGreaterThanOrEqual(4);
  });
});
