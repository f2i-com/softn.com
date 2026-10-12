/**
 * A project edited and then undone to what it was kept as is not unsaved.
 *
 * Driven first, in the Builder: open a demo, duplicate an element on the
 * canvas, press Ctrl+Z. The page was the file it had been opened as, byte
 * for byte (baselineBytes.test.ts), and the toolbar still said "Unsaved".
 * Every edit set the mark and only a save took it off, and Undo is an edit
 * like any other, so leaving asked about changes there were none of.
 *
 * What the project is held against is what was last kept: the bundle it was
 * opened from, or what was last saved. Not what a page was read as, which
 * moves with what is written in Code and stays where it was through a save.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import { loadBundle } from './bundleLoader';
import { flushCanvasToActiveFile } from './buildProjectBundle';
import { redoCanvas, undoCanvas } from './canvasHistory';
import { captureSession, commitProjectSnapshot, prepareProjectSnapshot, prepareSessionSnapshot } from './openProject';
import { resetPersistedRevisions, saveProject } from './saveProject';
import { startNewProject } from './newProject';
import { forgetSavedPoint, markUnsaved } from './savedPoint';

const MAIN = '// The entry page.\n<logic src="../logic/main.logic" />\n\n<App>\n\n  <Heading level={1}>Notes</Heading>\n\n  <Text>First</Text>\n</App>\n';
const ABOUT = '<App>\n\n  <Text>About</Text>\n\n</App>\n';
const LOGIC = 'let count = 0;\n';

const files = () => useFilesStore.getState();
const canvas = () => useCanvasStore.getState();
const project = () => useProjectStore.getState();
const unsaved = () => project().isDirty;
const idOf = (path: string) => [...files().uiFiles.values(), ...files().logicFiles.values()].find((file) => file.path === path)!.id;
const marked = (path: string) => files().nodes.get(idOf(path))!.isDirty === true;
const element = (type: string) => [...canvas().elements.values()].find((each) => each.componentType === type)!;

async function openBundle(): Promise<void> {
  const manifest = { name: 'Kept', version: '1.0.0', description: '', main: 'ui/main.ui', files: { ui: ['ui/main.ui', 'ui/about.ui'], logic: ['logic/main.logic'], xdb: [], assets: [] } };
  const zip = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'ui/main.ui': strToU8(MAIN),
    'ui/about.ui': strToU8(ABOUT),
    'logic/main.logic': strToU8(LOGIC),
  });
  commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(zip)));
  useHistoryStore.getState().clear();
}

/** One step for Undo and then the change, as the canvas, the panel and the palette each make one. */
function step(change: () => void): void {
  useHistoryStore.getState().push(canvas().elements, canvas().rootId);
  change();
}

function undoAll(): void {
  while (undoCanvas());
}

/** Put the active page's tree on the canvas, as the app does when it is replaced under it (hooks/useActiveFileOnCanvas.ts). */
function reload(): void {
  const file = files().uiFiles.get(files().activeFileId!)!;
  canvas().loadState(file.elements, file.rootId, file.imports, file.writtenImports);
  useHistoryStore.getState().clear();
}

/** Show another page on the canvas, as a click on its tab does: the page left is flushed first. */
function show(path: string): void {
  flushCanvasToActiveFile();
  files().setActiveFile(idOf(path));
  reload();
}

const memoryStorage = () => {
  const items = new Map<string, string>();
  return { items, setItem: (key: string, value: string) => void items.set(key, value) };
};

beforeEach(() => {
  resetPersistedRevisions();
  project().reset();
  files().reset();
  canvas().reset();
  useSchemaStore.getState().reset();
  useHistoryStore.getState().clear();
});

describe('a page opened from a bundle, edited on the canvas and undone to the start', () => {
  it('is saved again: the project is not unsaved and the page has no mark', async () => {
    await openBundle();
    expect(unsaved()).toBe(false);
    step(() => canvas().updateElementProps(element('Text').id, { children: 'Changed' }));
    step(() => void canvas().addElement('Divider', canvas().rootId, undefined, { starter: true }));
    expect(unsaved()).toBe(true);
    undoAll();
    expect(unsaved()).toBe(false);
  });

  it('is so when the edit had reached the file and its text was written again', async () => {
    await openBundle();
    step(() => canvas().updateElementProps(element('Text').id, { children: 'Changed' }));
    // A change of view, the preview or the export's check put the canvas into its file.
    flushCanvasToActiveFile();
    expect(files().uiFiles.get(idOf('ui/main.ui'))!.originalSource).not.toBe(MAIN);
    expect(marked('ui/main.ui')).toBe(true);
    undoAll();
    // Before the next flush: the canvas is what the page was kept as.
    expect(unsaved()).toBe(false);
    expect(marked('ui/main.ui')).toBe(false);
    flushCanvasToActiveFile();
    expect(files().uiFiles.get(idOf('ui/main.ui'))!.originalSource).toBe(MAIN);
    expect(unsaved()).toBe(false);
    expect(marked('ui/main.ui')).toBe(false);
  });

  it('is so for a property typed back to what it was, with no Undo', async () => {
    await openBundle();
    const text = element('Text').id;
    step(() => canvas().updateElementProps(text, { children: 'Something else' }));
    flushCanvasToActiveFile();
    expect(unsaved()).toBe(true);
    step(() => canvas().updateElementProps(text, { children: 'First' }));
    expect(unsaved()).toBe(false);
  });

  it('is unsaved again at a redo, and saved again at the undo after it', async () => {
    await openBundle();
    step(() => canvas().updateElementProps(element('Text').id, { children: 'Changed' }));
    undoAll();
    expect(unsaved()).toBe(false);
    expect(redoCanvas()).toBe(true);
    expect(unsaved()).toBe(true);
    undoAll();
    expect(unsaved()).toBe(false);
  });
});

describe('a project with more than one thing changed', () => {
  it('takes the mark off a page that is back, and stays unsaved while another is not', async () => {
    await openBundle();
    step(() => canvas().updateElementProps(element('Text').id, { children: 'Changed' }));
    show('ui/about.ui');
    expect(marked('ui/main.ui')).toBe(true);
    step(() => canvas().updateElementProps(element('Text').id, { children: 'About us' }));
    flushCanvasToActiveFile();
    expect(marked('ui/about.ui')).toBe(true);
    undoAll();
    expect(marked('ui/about.ui')).toBe(false);
    // The entry page is still changed: the project is unsaved, and that page keeps its mark.
    expect(marked('ui/main.ui')).toBe(true);
    expect(unsaved()).toBe(true);
  });

  it('is saved again when its name, its theme and a logic file are each put back as they were', async () => {
    await openBundle();
    const logic = idOf('logic/main.logic');
    const theme = project().themeMode;
    project().setName('Renamed');
    project().setThemeMode(theme === 'dark' ? 'light' : 'dark');
    files().updateLogicFile(logic, `${LOGIC}let more = 1;\n`);
    expect(unsaved()).toBe(true);
    project().setName('Kept');
    project().setThemeMode(theme);
    expect(unsaved()).toBe(true);
    files().updateLogicFile(logic, LOGIC);
    expect(marked('logic/main.logic')).toBe(false);
    expect(unsaved()).toBe(false);
  });

  it('is unsaved while a page made since is there, and saved again once it is deleted', async () => {
    await openBundle();
    const made = files().createFile('ui', 'extra.ui', 'ui');
    expect(unsaved()).toBe(true);
    files().deleteFile(made);
    expect(unsaved()).toBe(false);
  });
});

describe('what the project is held against', () => {
  it('is not what was written in Code: undone back to that text, the page is still unsaved', async () => {
    await openBundle();
    files().updateUIFileSource(idOf('ui/main.ui'), MAIN.replace('First', 'Typed in Code'));
    reload();
    step(() => canvas().updateElementProps(element('Text').id, { children: 'Then on the canvas' }));
    undoAll();
    flushCanvasToActiveFile();
    expect(files().uiFiles.get(idOf('ui/main.ui'))!.originalSource).toContain('Typed in Code');
    expect(unsaved()).toBe(true);
  });

  it('is what was saved: undone past the save is unsaved, and redone to it is saved', async () => {
    await openBundle();
    step(() => canvas().updateElementProps(element('Text').id, { children: 'Saved words' }));
    const outcome = await saveProject({ view: 'design', existingHandle: null, storage: memoryStorage(), writeFile: async () => null });
    expect(outcome.kind).toBe('saved');
    expect(unsaved()).toBe(false);
    undoAll();
    // The file holds the edit; the page as opened is not in it any more.
    expect(unsaved()).toBe(true);
    expect(redoCanvas()).toBe(true);
    expect(unsaved()).toBe(false);
  });

  it('is the revision a save wrote, even when the work moved on while it was being written', async () => {
    await openBundle();
    step(() => canvas().updateElementProps(element('Text').id, { children: 'Saved words' }));
    const write: { finish?: (handle: null) => void } = {};
    const saving = saveProject({
      view: 'design', existingHandle: null, storage: memoryStorage(),
      writeFile: () => new Promise((resolve) => { write.finish = resolve; }),
    });
    while (!write.finish) await new Promise((resolve) => setTimeout(resolve, 0));
    // While the file is being written: back to the page as it was opened.
    undoAll();
    expect(unsaved()).toBe(false);
    write.finish(null);
    const outcome = await saving;
    expect(outcome).toMatchObject({ kind: 'saved', stale: true });
    // The file now holds the edit: the page as it was opened is not saved anywhere.
    expect(unsaved()).toBe(true);
    expect(redoCanvas()).toBe(true);
    expect(unsaved()).toBe(false);
  });

  it('is nothing for a copy of unsaved work brought back, which is in no file', async () => {
    await openBundle();
    step(() => canvas().updateElementProps(element('Text').id, { children: 'Not saved' }));
    flushCanvasToActiveFile();
    const copy = JSON.stringify({ ...captureSession('design'), recovery: { tab: 'a-tab', unsaved: true, assets: 'kept' } });
    commitProjectSnapshot(prepareSessionSnapshot(copy));
    // As the app restores it (App.tsx).
    markUnsaved();
    useHistoryStore.getState().clear();
    expect(unsaved()).toBe(true);
    step(() => canvas().updateElementProps(element('Text').id, { children: 'Then this' }));
    undoAll();
    expect(unsaved()).toBe(true);
  });

  it('is nothing once a draft has been sent to FormLogic, which keeps whatever revision it took', async () => {
    await openBundle();
    forgetSavedPoint();
    // Nothing is made unsaved by it.
    expect(unsaved()).toBe(false);
    step(() => canvas().updateElementProps(element('Text').id, { children: 'Sent' }));
    undoAll();
    expect(unsaved()).toBe(true);
  });

  it('is nothing for a new project, which is in no file: an edit undone leaves it unsaved', () => {
    startNewProject({ name: 'Fresh', description: '', theme: 'light', template: 'blank', language: 'javascript', pythonPackages: [] });
    expect(unsaved()).toBe(true);
    step(() => void canvas().addElement('Text', canvas().rootId, undefined, { starter: true }));
    undoAll();
    expect(unsaved()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The other way: a project said to be saved has nothing unsaved. Leaving,
// New and Open ask nothing of a clean project, so an edit the comparison
// missed would be lost without a word.
// ---------------------------------------------------------------------------

const TASKS = {
  collection: 'tasks',
  schema: { alias: 'tasks', fields: [{ id: 'f_title', name: 'title', type: 'string', required: true }] },
  records: [
    { id: '0f3c0c4e-7f4a-4a2c-9a51-3a0f2e5b7d11', collection: 'tasks', data: { title: 'Write it' }, created_at: '2024-01-02T03:04:05.000Z', updated_at: '2024-01-03T03:04:05.000Z', deleted: false },
  ],
};
const RICH_MAIN = '<logic src="../logic/main.logic" />\n\n<data>\n  <collection name="tasks" as="tasks" />\n</data>\n\n<App>\n\n  <Text>First</Text>\n\n  <Button>Go</Button>\n</App>\n';
const RICH_ABOUT = '<logic>\nlet about = 1;\n</logic>\n\n<App>\n\n  <Text>About</Text>\n</App>\n';

/** Two pages, one with its logic inline, a logic file, a collection with a record, and an asset. */
async function openRich(): Promise<void> {
  const manifest = {
    name: 'Rich', version: '1.0.0', description: 'Everything a save writes', main: 'ui/main.ui',
    files: { ui: ['ui/main.ui', 'ui/pages/about.ui'], logic: ['logic/main.logic'], xdb: ['xdb/tasks.xdb'], assets: ['assets/notes.txt'] },
  };
  const zip = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'ui/main.ui': strToU8(RICH_MAIN),
    'ui/pages/about.ui': strToU8(RICH_ABOUT),
    'logic/main.logic': strToU8(LOGIC),
    'xdb/tasks.xdb': strToU8(JSON.stringify(TASKS)),
    'assets/notes.txt': strToU8('plain notes\n'),
  });
  commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(zip)));
  useHistoryStore.getState().clear();
  expect(unsaved()).toBe(false);
}

const schema = () => useSchemaStore.getState();
const entity = () => schema().entities[0].id;
const nodeAt = (path: string) => [...files().nodes.values()].find((node) => node.path === path)!.id;

describe('an edit that is not put back', () => {
  const edits: Array<[string, () => void]> = [
    ['the version', () => project().setVersion('9.9.9')],
    ['the description', () => project().setDescription('Changed')],
    ['the icon', () => project().setIcon('data:image/png;base64,iVBORw0KGgo=')],
    ['the permissions', () => project().setPermissions({ ...project().permissions, allowHttp: true })],
    ['the Python packages', () => project().setPythonPackages(['torch'])],
    ['the project\'s own logic', () => project().setLogicSource('let other = 2;\n')],
    ['a collection added by hand', () => project().addCollection('notes')],
    ['an entity added', () => void schema().addEntity({ x: 10, y: 10 })],
    ['an entity renamed', () => void schema().updateEntity(entity(), { name: 'jobs' })],
    ['a field added', () => schema().addField(entity())],
    ['a record added', () => schema().addSeedRecord(entity())],
    ['a record changed', () => schema().updateSeedRecord(entity(), 0, { title: 'Changed' })],
    ['a record given a new id', () => void schema().reidentifyRecords(entity(), '2025-01-01T00:00:00.000Z')],
    ['an asset deleted', () => files().deleteFile(nodeAt('assets/notes.txt'))],
    ['an asset renamed', () => files().renameFile(nodeAt('assets/notes.txt'), 'renamed.txt')],
    ['a folder made', () => void files().createFolder('ui', 'more')],
    ['a folder renamed', () => files().renameFolder(nodeAt('ui/pages'), 'screens')],
    ['a page moved', () => files().moveFile(idOf('ui/pages/about.ui'), 'ui')],
    ['a page linked to a logic file', () => files().updateUIFileLogicSrc(idOf('ui/pages/about.ui'), '../../logic/main.logic')],
    ['a collection renamed in Data, into the page that declares it', () => files().applyCollectionChange({ kind: 'rename', from: 'tasks', to: 'jobs' })],
    ['a page\'s inline logic moved to a file', () => void files().moveInlineLogicToFile(idOf('ui/pages/about.ui'))],
    ['a page written in Code', () => files().updateUIFileSource(idOf('ui/main.ui'), RICH_MAIN.replace('First', 'Typed'))],
    ['a logic file written', () => files().updateLogicFile(idOf('logic/main.logic'), 'let changed = true;\n')],
    ['an element pasted', () => {
      canvas().selectElement(element('Text').id);
      canvas().copySelected();
      canvas().paste(canvas().rootId);
    }],
    ['an element wrapped in a block', () => void canvas().wrapElement(element('Button').id, 'if')],
    ['an element moved', () => canvas().moveElement(element('Button').id, canvas().rootId, 0)],
  ];

  it.each(edits)('%s: the project is unsaved', async (_name, change) => {
    await openRich();
    change();
    expect(unsaved()).toBe(true);
    // And still once what the canvas holds has gone into its file.
    flushCanvasToActiveFile();
    expect(unsaved()).toBe(true);
  });
});

describe('a project that is saved again', () => {
  const entriesOf = async () => {
    const { readBundleEntries } = await import('@softn/core');
    const { buildProjectBundle } = await import('./buildProjectBundle');
    return new Map([...readBundleEntries(await buildProjectBundle())].map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]));
  };

  it('is one whose save writes, entry for entry, what it was opened as', async () => {
    await openRich();
    const opened = await entriesOf();
    expect(unsaved()).toBe(false);
    const ways: Array<[string, () => void]> = [
      ['a canvas edit undone', () => {
        step(() => canvas().updateElementProps(element('Text').id, { children: 'Changed' }));
        flushCanvasToActiveFile();
        undoAll();
      }],
      ['a name typed and put back', () => {
        project().setName('Other');
        project().setName('Rich');
      }],
      ['a logic file written and put back', () => {
        files().updateLogicFile(idOf('logic/main.logic'), 'let changed = true;\n');
        files().updateLogicFile(idOf('logic/main.logic'), LOGIC);
      }],
      ['a page made and deleted', () => files().deleteFile(files().createFile('ui', 'extra.ui', 'ui'))],
      ['a record given a new id, and that undone', () => {
        schema().reidentifyRecords(entity(), '2025-01-01T00:00:00.000Z');
        schema().undoReidentify();
      }],
      ['a page renamed and named back', () => {
        files().renameFile(idOf('ui/pages/about.ui'), 'other.ui');
        files().renameFile(idOf('ui/pages/other.ui'), 'about.ui');
      }],
    ];
    for (const [name, putBack] of ways) {
      putBack();
      expect(unsaved(), name).toBe(false);
      expect(await entriesOf(), name).toEqual(opened);
      expect(unsaved(), `${name}, after the save's flush`).toBe(false);
    }
  });
});
