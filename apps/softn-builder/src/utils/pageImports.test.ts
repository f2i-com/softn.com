// @vitest-environment jsdom
/**
 * A page of the project can be put on another page from the palette.
 *
 * The only way to use one page inside another was to write its `<import>`
 * in Code and type its tag; the palette offered the library and nothing of
 * the project's own. A page dropped from the palette is an element whose
 * name the page's header imports, and the two are kept together: the import
 * is written when the element is, is not written twice, and goes when the
 * last use of it goes, by Undo or by Delete. What the Builder did not write
 * it does not take away.
 *
 * An imported page is not a component with properties: the composer puts
 * its content where the tag stands, in the importing page's own scope, and
 * drops what was written on the tag (core, source-composer.ts).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { composeBundleSource, parse } from '@softn/core';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useProjectStore } from '../stores/projectStore';
import { flushCanvasToActiveFile } from './buildProjectBundle';
import { canDropInto } from './blocks';
import { createComponentFile } from './componentFile';
import { redoCanvas, undoCanvas } from './canvasHistory';
import { importableFor, liveImports, pageDragType, pageName, withImportLines } from './pageImports';
import { insertFromPalette } from '../components/panels/ComponentPalette';
import { generateSource } from './sourceGenerator';
import { parseSource } from './sourceParser';

const MAIN = 'main_ui';
const files = () => useFilesStore.getState();
const canvas = () => useCanvasStore.getState();
const file = (id: string) => files().uiFiles.get(id)!;
const types = () => canvas().elements.get(canvas().rootId)!.children.map((id) => canvas().elements.get(id)!.componentType);
/** The imports the page being edited would be written with now. */
const live = () => liveImports(canvas().elements, canvas().imports, canvas().writtenImports).map((imp) => imp.name);
const importsOf = (id: string) => file(id).imports.map((imp) => `${imp.name} from ${imp.source}`);

/** Put the file on the canvas, as the app does when it is opened or its source is replaced. */
function show(id: string): void {
  files().setActiveFile(id);
  const opened = file(id);
  canvas().loadState(opened.elements, opened.rootId, opened.imports, opened.writtenImports);
}

/** Go to another file's tab: what is on the canvas is written to its file first. */
function edit(id: string): void {
  flushCanvasToActiveFile();
  show(id);
}

/** Replace a file's source, as writing it in Code does. */
function write(id: string, source: string): void {
  files().updateUIFileSource(id, source);
  if (files().activeFileId === id) show(id);
}

/** A component file as the project keeps one: a fragment, with no App around it. Made without leaving the page being edited. */
function component(folder: string, name: string, source = '<Stack>\n  <Text>A row</Text>\n</Stack>\n'): string {
  const editing = files().activeFileId;
  const id = files().createFile(folder, name, 'ui');
  files().updateUIFileSource(id, source);
  files().setActiveFile(editing);
  return id;
}

/** Drop the file on the page being edited, at the end, as the palette does. */
function drop(fileId: string): string | null {
  return insertFromPalette(pageDragType(fileId));
}

beforeEach(() => {
  useProjectStore.getState().reset();
  files().reset();
  canvas().reset();
  useHistoryStore.getState().clear();
  show(MAIN);
});

describe('the name a page is used by', () => {
  it('is its file name in the case a component is written in', () => {
    expect(pageName('task-row.ui')).toBe('TaskRow');
    expect(pageName('Sidebar.ui')).toBe('Sidebar');
    expect(pageName('about_us.ui')).toBe('AboutUs');
    expect(pageName('row2.ui')).toBe('Row2');
    // A name the composer's pattern can read has to begin with a letter.
    expect(pageName('2-columns.ui')).toBe('Page2Columns');
    expect(pageName('é.ui')).toBe('Page');
  });
});

describe('the pages the palette offers for the page being edited', () => {
  it('are the other pages of the project, each under the name it would be used by', () => {
    const row = component('ui/components', 'task-row.ui');
    const about = files().createFile('ui', 'about.ui', 'ui');
    const offered = importableFor(MAIN, files().uiFiles, canvas().imports);
    expect(offered.map((entry) => [entry.file.id, entry.name, entry.refused ?? null])).toEqual([
      [about, 'About', null],
      [row, 'TaskRow', null],
    ]);
  });

  it('do not include a page that uses this one, directly or through another: it would be inside itself', () => {
    const outer = component('ui', 'outer.ui', '<import Inner from="./inner.ui" />\n<Stack>\n  <Inner />\n</Stack>\n');
    const inner = component('ui', 'inner.ui', '<import Main from="./main.ui" />\n<Stack>\n  <Main />\n</Stack>\n');
    const free = component('ui', 'free.ui');
    const offered = importableFor(MAIN, files().uiFiles, canvas().imports);
    expect(offered.find((entry) => entry.file.id === free)!.refused).toBeUndefined();
    expect(offered.find((entry) => entry.file.id === inner)!.refused).toContain('uses this page');
    expect(offered.find((entry) => entry.file.id === outer)!.refused).toContain('uses this page');
    // And a refused page is not put on the canvas.
    expect(drop(outer)).toBeNull();
    expect(types()).toEqual([]);
  });

  it('refuse a name the library has, and a name this page already gives another file', () => {
    const card = component('ui/components', 'Card.ui');
    const one = component('ui/a', 'row.ui');
    const other = component('ui/b', 'row.ui');
    expect(importableFor(MAIN, files().uiFiles, canvas().imports).find((entry) => entry.file.id === card)!.refused).toContain('Card is a component of the library');
    expect(drop(card)).toBeNull();
    expect(drop(one)).not.toBeNull();
    const offered = importableFor(MAIN, files().uiFiles, canvas().imports);
    expect(offered.find((entry) => entry.file.id === other)!.refused).toContain('Row is already the name of ui/a/row.ui');
    expect(drop(other)).toBeNull();
    expect(types()).toEqual(['Row']);
  });
});

describe('a page dropped from the palette', () => {
  it('is an element of its name, with the import written in the header of a page that has a source', () => {
    write(MAIN, '// The entry\n<logic src="../logic/main.logic" />\n\n<App theme="system">\n  <Heading>Tasks</Heading>\n</App>\n<style>\n  .x { color: red }\n</style>\n');
    const row = component('ui/components', 'task-row.ui');
    expect(drop(row)).not.toBeNull();
    expect(types()).toEqual(['Heading', 'TaskRow']);
    flushCanvasToActiveFile();
    // The line, before the logic the page links; and everything the author wrote as it was.
    expect(file(MAIN).originalSource).toBe(
      '// The entry\n<import TaskRow from="./components/task-row.ui" />\n<logic src="../logic/main.logic" />\n\n<App theme="system">\n  <Heading>Tasks</Heading>\n  <TaskRow />\n</App>\n<style>\n  .x { color: red }\n</style>\n'
    );
    expect(importsOf(MAIN)).toEqual(['TaskRow from ./components/task-row.ui']);
    // What was written is what the same file gives back.
    const again = parseSource(file(MAIN).originalSource!);
    expect(again.fidelity.reasons).toEqual([]);
    expect(again.imports).toEqual([{ name: 'TaskRow', source: './components/task-row.ui' }]);
  });

  it('is written with its import by a page made on the canvas too, wherever that page is written', () => {
    const row = component('ui/components', 'task-row.ui');
    drop(row);
    flushCanvasToActiveFile();
    expect(file(MAIN).originalSource).toBeUndefined();
    expect(importsOf(MAIN)).toEqual(['TaskRow from ./components/task-row.ui']);
    const written = generateSource(file(MAIN).elements, file(MAIN).rootId, '', [], { logicSrc: '../logic/main.logic', imports: file(MAIN).imports });
    expect(written.startsWith('<import TaskRow from="./components/task-row.ui" />\n<logic src="../logic/main.logic" />')).toBe(true);
    const again = parseSource(written);
    expect(again.fidelity.reasons).toEqual([]);
    expect(again.imports).toEqual([{ name: 'TaskRow', source: './components/task-row.ui' }]);
    expect(generateSource(again.elements, again.rootId, '', [], { logicSrc: '../logic/main.logic', imports: again.imports })).toBe(written);
  });

  it('is imported by the path from the page it is dropped on, which may be in another folder', () => {
    const row = component('ui/components', 'Row.ui');
    const page = files().createFile('ui/pages', 'A.ui', 'ui');
    edit(page);
    drop(row);
    flushCanvasToActiveFile();
    expect(importsOf(page)).toEqual(['Row from ../components/Row.ui']);
  });

  it('is not imported a second time by a page that already imports it, under whatever name', () => {
    const row = component('ui/components', 'task-row.ui');
    write(MAIN, '<import Line from "./components/task-row.ui" />\n<App>\n  <Line />\n</App>\n');
    drop(row);
    drop(row);
    // The name the page already had for it is the one used.
    expect(types()).toEqual(['Line', 'Line', 'Line']);
    flushCanvasToActiveFile();
    expect(file(MAIN).originalSource).toBe('<import Line from "./components/task-row.ui" />\n<App>\n  <Line />\n  <Line />\n  <Line />\n</App>\n');
    expect(importsOf(MAIN)).toEqual(['Line from ./components/task-row.ui']);
  });

  it('takes no children: what is written inside it is dropped when the app is put together', () => {
    const row = component('ui/components', 'task-row.ui');
    drop(row);
    const placed = [...canvas().elements.values()].find((element) => element.componentType === 'TaskRow')!;
    expect(canDropInto(placed, 'Text', { elements: canvas().elements })).toBe(false);
    expect(canDropInto(placed, 'Icon', { elements: canvas().elements })).toBe(false);
  });
});

describe('the import of a page the Builder put on the canvas', () => {
  let row = '';
  beforeEach(() => {
    write(MAIN, '<import Footer from="./footer.ui" />\n<App>\n  <Heading>Tasks</Heading>\n</App>\n');
    row = component('ui/components', 'task-row.ui');
  });

  it('goes with the element when the drop is undone, and comes back with it', () => {
    drop(row);
    expect(live()).toEqual(['Footer', 'TaskRow']);
    undoCanvas();
    expect(types()).toEqual(['Heading']);
    expect(live()).toEqual(['Footer']);
    flushCanvasToActiveFile();
    expect(file(MAIN).originalSource).toBe('<import Footer from="./footer.ui" />\n<App>\n  <Heading>Tasks</Heading>\n</App>\n');
    redoCanvas();
    expect(types()).toEqual(['Heading', 'TaskRow']);
    flushCanvasToActiveFile();
    expect(file(MAIN).originalSource).toBe('<import Footer from="./footer.ui" />\n<import TaskRow from="./components/task-row.ui" />\n<App>\n  <Heading>Tasks</Heading>\n  <TaskRow />\n</App>\n');
  });

  it('goes when the last use of it is deleted, and not while another is left', () => {
    drop(row);
    drop(row);
    const uses = () => [...canvas().elements.values()].filter((element) => element.componentType === 'TaskRow');
    canvas().deleteElement(uses()[0].id);
    expect(live()).toEqual(['Footer', 'TaskRow']);
    canvas().deleteElement(uses()[0].id);
    expect(live()).toEqual(['Footer']);
    flushCanvasToActiveFile();
    expect(file(MAIN).originalSource).toBe('<import Footer from="./footer.ui" />\n<App>\n  <Heading>Tasks</Heading>\n</App>\n');
  });

  it('is kept across a change of file and back, and is still the Builder\'s to take away', () => {
    drop(row);
    edit(row);
    edit(MAIN);
    expect(live()).toEqual(['Footer', 'TaskRow']);
    canvas().deleteElement([...canvas().elements.values()].find((element) => element.componentType === 'TaskRow')!.id);
    expect(live()).toEqual(['Footer']);
  });

  it('is never an import the author wrote: one that nothing on the page uses stays where it is', () => {
    // Footer is imported and not used. Deleting everything leaves it.
    canvas().deleteElement([...canvas().elements.values()].find((element) => element.componentType === 'Heading')!.id);
    expect(live()).toEqual(['Footer']);
    flushCanvasToActiveFile();
    expect(file(MAIN).originalSource).toContain('<import Footer from="./footer.ui" />');
  });
});

describe('a component file made from the Files panel', () => {
  it('is a fragment with no App of its own, in ui/components, and is offered to the pages of the project by its name', () => {
    const id = createComponentFile('task-row');
    expect(file(id).path).toBe('ui/components/task-row.ui');
    expect(file(id).originalSource).toBe('<Stack>\n  <Text>TaskRow</Text>\n</Stack>\n');
    expect(importableFor(MAIN, files().uiFiles, []).map((entry) => `${entry.name} ${entry.source}`)).toEqual(['TaskRow ./components/task-row.ui']);
  });

  it('is written back as the fragment it is when it is edited on the canvas, with no App put around it', () => {
    const id = createComponentFile('task-row');
    show(id);
    const stack = [...canvas().elements.values()].find((element) => element.componentType === 'Stack')!;
    canvas().addElement('Badge', stack.id, undefined, { starter: true });
    flushCanvasToActiveFile();
    expect(file(id).visualEditBlocked).toBeUndefined();
    expect(file(id).originalSource).toBe('<Stack>\n  <Text>TaskRow</Text>\n  <Badge variant="default">Badge</Badge>\n</Stack>\n');
    // And another element beside the Stack is a second thing in the fragment, still with no App.
    canvas().addElement('Divider', canvas().rootId, undefined, { starter: true });
    flushCanvasToActiveFile();
    expect(file(id).originalSource).not.toContain('<App');
    expect(file(id).originalSource).toContain('</Stack>\n<Divider');
  });
});

describe('a page whose imports the author wrote, in whichever way the language reads them', () => {
  it('is given no second line for one of them when it is edited on the canvas', () => {
    // `<import { Row } from=… />` is read as an import of Row, and is not
    // the one spelling the Builder writes. Looked for by that spelling
    // alone it was not found, and the first edit on the canvas wrote a
    // second import of the same name above the template.
    write(MAIN, "<import { Row } from='./components/row.ui' />\n<import Footer from \"./footer.ui\" />\n<App>\n  <Row />\n</App>\n");
    expect(importsOf(MAIN)).toEqual(['Row from ./components/row.ui', 'Footer from ./footer.ui']);
    canvas().addElement('Divider', canvas().rootId, undefined, { starter: true });
    flushCanvasToActiveFile();
    expect(file(MAIN).visualEditBlocked).toBeUndefined();
    expect(file(MAIN).originalSource!.match(/<import\b/g)).toHaveLength(2);
    expect(file(MAIN).originalSource!.startsWith("<import { Row } from='./components/row.ui' />\n<import Footer from \"./footer.ui\" />\n<App>")).toBe(true);
  });
});

describe('the pages this repository ships', () => {
  // The demo bundle the CLI's worked example builds, and every example: real
  // pages that use one another, written by hand.
  const repo = (() => {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, 'packages/@softn/core/demo-bundle'))) return dir;
      dir = dirname(dir);
    }
    throw new Error('the repository root was not found');
  })();
  const pagesUnder = (dir: string): string[] =>
    !existsSync(dir)
      ? []
      : readdirSync(dir).flatMap((name) => {
          const path = join(dir, name);
          if (name === 'node_modules' || name === 'dist') return [];
          return statSync(path).isDirectory() ? pagesUnder(path) : name.endsWith('.ui') ? [path] : [];
        });
  const onDisk = [join(repo, 'packages/@softn/core/demo-bundle'), join(repo, 'examples'), join(repo, 'docs/examples')]
    .flatMap(pagesUnder)
    .map((path) => [relative(repo, path).replace(/\\/g, '/'), readFileSync(path, 'utf8')] as const);
  // And any more that are handed over: the pages of the directory's apps are
  // inside their bundles, not files of the repository. A list of
  // `{ path, text }`, named by SOFTN_PAGE_CORPUS.
  const handedOver = process.env.SOFTN_PAGE_CORPUS
    ? (JSON.parse(readFileSync(process.env.SOFTN_PAGE_CORPUS, 'utf8')) as Array<{ path: string; text: string }>).map((page) => [page.path.replace(/\\/g, '/').split('/').slice(-4).join('/'), page.text] as const)
    : [];
  const shipped = [...onDisk, ...handedOver];

  it('are found', () => {
    expect(shipped.length).toBeGreaterThan(5);
    expect(shipped.some(([, written]) => /<import\b/.test(written))).toBe(true);
  });

  it.each(shipped)('%s is left as it is by a flush with no edit, and keeps its import lines through one', (_name, written) => {
    const source = written.replace(/\r\n/g, '\n');
    write(MAIN, source);
    useProjectStore.getState().markClean();
    const lines = (text: string) => (text.match(/<import\b[^>]*>/g) ?? []).join('\n');
    // Nothing was done: the file is the bytes it was, and the project has nothing to save.
    flushCanvasToActiveFile();
    expect(file(MAIN).originalSource).toBe(source);
    expect(useProjectStore.getState().isDirty).toBe(false);
    // The header taken alone: with what the page imports and nothing the Builder wrote, it is unchanged.
    expect(withImportLines(source, file(MAIN).imports, [])).toBe(source);
    // One element more on the canvas: where the page can be written back, its import lines are the ones it had.
    canvas().addElement('Divider', canvas().rootId, undefined, { starter: true });
    flushCanvasToActiveFile();
    expect(lines(file(MAIN).originalSource ?? '')).toBe(lines(source));
  });
});

describe('the import lines of a page', () => {
  it('are added after the ones it has, in the spelling a page is written in, and keep the file\'s line endings', () => {
    const source = '<import A from "./a.ui" />\r\n<logic src="../logic/main.logic" />\r\n<App>\r\n</App>\r\n';
    expect(withImportLines(source, [{ name: 'A', source: './a.ui' }, { name: 'B', source: './b.ui' }], ['B'])).toBe(
      '<import A from "./a.ui" />\r\n<import B from="./b.ui" />\r\n<logic src="../logic/main.logic" />\r\n<App>\r\n</App>\r\n'
    );
  });

  it('are taken away only where the Builder wrote them', () => {
    const source = '<import A from="./a.ui" />\n<import B from="./b.ui" />\n<App>\n</App>\n';
    expect(withImportLines(source, [], ['B'])).toBe('<import A from="./a.ui" />\n<App>\n</App>\n');
    expect(withImportLines(source, [{ name: 'A', source: './a.ui' }, { name: 'B', source: './b.ui' }], ['B'])).toBe(source);
  });
});

describe('the app put together from a page that uses another', () => {
  it('has the used page\'s content in place, its logic once, and nothing the parser does not read', () => {
    write(MAIN, '<logic src="../logic/main.logic" />\n<App>\n  <Heading>Tasks</Heading>\n</App>\n');
    const row = component('ui/components', 'task-row.ui', '<logic src="../../logic/main.logic" />\n<Stack>\n  <Text>A row</Text>\n</Stack>\n');
    drop(row);
    flushCanvasToActiveFile();
    const text = new Map<string, string>([...files().uiFiles.values()].map((entry) => [entry.path, entry.originalSource!]));
    for (const logic of files().logicFiles.values()) text.set(logic.path, logic.content);
    const composed = composeBundleSource(text, 'ui/main.ui', [...files().logicFiles.values()].map((logic) => logic.path));
    expect(composed.source).toContain('<Text>A row</Text>');
    expect(composed.source).not.toContain('<TaskRow');
    expect(composed.source).not.toContain('<import');
    expect(composed.source.match(/<App/g)).toHaveLength(1);
    expect((parse(composed.source).diagnostics ?? []).map((diagnostic) => diagnostic.message)).toEqual([]);
    expect(composed.preIncludedLogicPaths.filter((path) => path === 'logic/main.logic').length).toBeLessThanOrEqual(1);
  });
});
