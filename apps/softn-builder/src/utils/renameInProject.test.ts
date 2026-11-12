/**
 * A picture that is renamed takes the pages and the logic that name it along.
 *
 * A page's imports and its logic followed a rename; the path a page asks
 * `asset("…")` for did not. Renaming `logo.png` left every page that showed
 * it asking for a file that was no longer there, and the Files panel could
 * only say so afterwards. The path follows now: in each page's tree, in the
 * text a page keeps, in what the page was read as, in the logic, and on the
 * canvas; and the rename is one step of the history, because the steps
 * before it hold the canvas asking for the old name.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useProjectStore } from '../stores/projectStore';
import type { CanvasElement } from '../types/builder';
import { followInElements, followInText, type AssetMove } from './assetReferences';
import { flushCanvasToActiveFile } from './buildProjectBundle';
import { redoCanvas, undoCanvas } from './canvasHistory';
import { renameInProject } from './renameInProject';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const files = () => useFilesStore.getState();
const canvas = () => useCanvasStore.getState();
const history = () => useHistoryStore.getState();
const idAt = (path: string) => [...files().nodes.values()].find((node) => node.path === path)!.id;
const pathOf = (id: string) => files().nodes.get(id)?.path;
const said = () => useNotificationStore.getState().notifications.map((n) => `${n.type}: ${n.message}`);

const FILE: AssetMove = { from: 'assets/logo.png', to: 'assets/brand.png', folder: false };
const FOLDER: AssetMove = { from: 'assets', to: 'media', folder: true };

/** An Image on the canvas asking for `path`, with the step in the history as the panel records one. */
function addImage(path: string): string {
  history().push(canvas().elements, canvas().rootId);
  const id = canvas().addElement('Image', canvas().rootId);
  canvas().updateElement(id, { props: { src: `asset(${JSON.stringify(path)})`, alt: 'Logo' }, expressionProps: ['src'] });
  return id;
}

const srcOf = (elements: Map<string, CanvasElement>) => [...elements.values()].filter((el) => el.componentType === 'Image').map((el) => el.props.src);

beforeEach(() => {
  useCanvasStore.getState().reset();
  useHistoryStore.getState().clear();
  useProjectStore.getState().reset();
  useNotificationStore.getState().clearAll();
  files().reset();
  // The page the workspace opens with is on the canvas, as useActiveFileOnCanvas leaves it.
  const main = files().uiFiles.get('main_ui')!;
  canvas().loadState(main.elements, main.rootId, main.imports, [], 'main_ui');
  files().addAssetFile('assets', 'logo.png', 'image/png', PNG);
  files().addAssetFile('assets', 'spare.png', 'image/png', PNG);
  useHistoryStore.getState().clear();
});

describe('a path in a text', () => {
  it('follows a file where it is a whole quoted string, with any of the three quotes', () => {
    expect(followInText('asset("assets/logo.png")', FILE)).toBe('asset("assets/brand.png")');
    expect(followInText("let a = asset('assets/logo.png'); let b = `assets/logo.png`", FILE)).toBe("let a = asset('assets/brand.png'); let b = `assets/brand.png`");
    expect(followInText('<Image src="assets/logo.png" /> <Image src={asset("assets/logo.png")} />', FILE)).toBe('<Image src="assets/brand.png" /> <Image src={asset("assets/brand.png")} />');
  });

  it('leaves what only looks like it', () => {
    for (const text of ['asset("assets/logo.png.bak")', 'asset("my/assets/logo.png")', 'asset("assets/logoXpng")', 'assets/logo.png between tags', `asset("assets/logo.png')`]) {
      expect(followInText(text, FILE)).toBe(text);
    }
  });

  it('follows a folder where a quoted string starts with it, and takes a name with a dollar in it as it is', () => {
    expect(followInText('asset("assets/icons/add.svg") + asset("assets/" + name)', FOLDER)).toBe('asset("media/icons/add.svg") + asset("media/" + name)');
    expect(followInText('asset("assets") asset("assetsX/a.png") asset("x/assets/a.png")', FOLDER)).toBe('asset("assets") asset("assetsX/a.png") asset("x/assets/a.png")');
    expect(followInText('asset("assets/logo.png")', { ...FILE, to: 'assets/$&-$1.png' })).toBe('asset("assets/$&-$1.png")');
  });
});

describe('a path in a page’s tree', () => {
  const element = (over: Partial<CanvasElement>): CanvasElement => ({ id: 'a', componentType: 'Image', props: {}, children: [], parentId: null, ...over });
  const followed = (over: Partial<CanvasElement>, move = FILE) => followInElements(new Map([['a', element(over)]]), move).get('a')!;

  it('is followed in an expression, in an attribute given the path alone, and in a list given to one', () => {
    expect(followed({ props: { src: 'asset("assets/logo.png")' } }).props.src).toBe('asset("assets/brand.png")');
    expect(followed({ props: { src: 'assets/logo.png' } }).props.src).toBe('assets/brand.png');
    expect(followed({ props: { items: [{ image: 'assets/logo.png' }, { image: 'assets/spare.png' }] } }).props.items).toEqual([{ image: 'assets/brand.png' }, { image: 'assets/spare.png' }]);
    expect(followed({ props: { src: 'assets/icons/add.svg' } }, FOLDER).props.src).toBe('media/icons/add.svg');
  });

  it('is followed in a handler and in a block’s header, and not in the words between tags', () => {
    expect(followed({ events: { click: 'show(asset("assets/logo.png"))' } }).events).toEqual({ click: 'show(asset("assets/brand.png"))' });
    expect(followed({ componentType: '#if', block: { kind: 'if', condition: 'picture === "assets/logo.png"' } }).block?.condition).toBe('picture === "assets/brand.png"');
    // Words are not an attribute: the file keeps them without quotes, and they are left in both.
    expect(followed({ componentType: 'Text', props: { children: 'assets/logo.png' } }).props.children).toBe('assets/logo.png');
    expect(followed({ componentType: 'Text', props: { children: 'See {asset("assets/logo.png")}' } }).props.children).toBe('See {asset("assets/brand.png")}');
  });

  it('is the same tree when nothing in it names what moved', () => {
    const tree = new Map([['a', element({ props: { src: 'asset("assets/spare.png")' } })]]);
    expect(followInElements(tree, FILE)).toBe(tree);
  });
});

describe('renaming a picture the pages show', () => {
  it('takes the open page, a page that is not open and the logic along, each marked as changed', () => {
    addImage('assets/logo.png');
    const about = files().createFile('ui', 'about.ui', 'ui');
    files().updateUIFileSource(about, '<App>\n  <!-- the mark -->\n  <Image src={asset("assets/logo.png")} alt="Logo" />\n</App>');
    files().updateLogicFile('main_logic', `let mark = asset('assets/logo.png')\n`);
    files().openFile('main_ui');
    for (const id of ['main_ui', 'main_logic', about]) files().markFileDirty(id, false);

    const outcome = renameInProject(idAt('assets/logo.png'), 'brand.png');
    expect(outcome).toEqual({ from: 'assets/logo.png', to: 'assets/brand.png', followed: ['logic/main.logic', 'ui/about.ui', 'ui/main.ui'] });
    expect(srcOf(files().uiFiles.get('main_ui')!.elements)).toEqual(['asset("assets/brand.png")']);
    const other = files().uiFiles.get(about)!;
    expect(srcOf(other.elements)).toEqual(['asset("assets/brand.png")']);
    // The text it keeps says the same, and nothing else in it has moved.
    expect(other.originalSource).toBe('<App>\n  <!-- the mark -->\n  <Image src={asset("assets/brand.png")} alt="Logo" />\n</App>');
    // What it was read as follows too: a canvas that is that tree again is that text again.
    expect(other.baseline?.source).toBe(other.originalSource);
    expect(srcOf(other.baseline!.elements)).toEqual(['asset("assets/brand.png")']);
    expect(files().logicFiles.get('main_logic')!.content).toBe(`let mark = asset('assets/brand.png')\n`);
    expect(['main_ui', 'main_logic', about].map((id) => files().nodes.get(id)!.isDirty)).toEqual([true, true, true]);
    expect(useProjectStore.getState().isDirty).toBe(true);
  });

  it('writes the canvas into its file first, so an edit not yet flushed is not lost under the rewrite', () => {
    const image = addImage('assets/logo.png');
    // On the canvas only: the file has not been given the Image yet.
    expect(srcOf(files().uiFiles.get('main_ui')!.elements)).toEqual([]);
    renameInProject(idAt('assets/logo.png'), 'brand.png');
    expect(canvas().elements.get(image)!.props).toEqual({ src: 'asset("assets/brand.png")', alt: 'Logo' });
    // The canvas holds the page's own tree: nothing loads it again, so the selection stays.
    expect(canvas().elements).toBe(files().uiFiles.get('main_ui')!.elements);
    expect(canvas().selectedIds).toEqual([image]);
  });

  it('is one step: Undo gives the old name back everywhere, and the step before it is still right', () => {
    addImage('assets/logo.png');
    files().updateLogicFile('main_logic', `let mark = asset("assets/logo.png")\n`);
    const id = idAt('assets/logo.png');
    renameInProject(id, 'brand.png');
    expect(history().past).toHaveLength(2);

    expect(undoCanvas()).toBe(true);
    expect(pathOf(id)).toBe('assets/logo.png');
    expect(srcOf(canvas().elements)).toEqual(['asset("assets/logo.png")']);
    expect(srcOf(files().uiFiles.get('main_ui')!.elements)).toEqual(['asset("assets/logo.png")']);
    expect(canvas().elements).toBe(files().uiFiles.get('main_ui')!.elements);
    expect(files().logicFiles.get('main_logic')!.content).toBe(`let mark = asset("assets/logo.png")\n`);
    expect(said().at(-1)).toBe('info: assets/brand.png is assets/logo.png again.');

    // The step before the rename: the Image goes, as it would have with no rename at all.
    expect(undoCanvas()).toBe(true);
    expect(srcOf(canvas().elements)).toEqual([]);
    expect(redoCanvas()).toBe(true);
    expect(srcOf(canvas().elements)).toEqual(['asset("assets/logo.png")']);

    expect(redoCanvas()).toBe(true);
    expect(pathOf(id)).toBe('assets/brand.png');
    expect(srcOf(canvas().elements)).toEqual(['asset("assets/brand.png")']);
    expect(files().logicFiles.get('main_logic')!.content).toBe(`let mark = asset("assets/brand.png")\n`);
    expect(history().future).toHaveLength(0);
  });

  it('is a step for a picture nothing shows as well, so a step before it never brings back a name that is gone', () => {
    const image = addImage('assets/spare.png');
    history().push(canvas().elements, canvas().rootId);
    canvas().deleteElement(image);
    const id = idAt('assets/spare.png');
    expect(renameInProject(id, 'extra.png').followed).toEqual([]);
    // Back over the rename, then over the delete: the Image is back, and so is the name it asks for.
    undoCanvas();
    expect(pathOf(id)).toBe('assets/spare.png');
    undoCanvas();
    expect(srcOf(canvas().elements)).toEqual(['asset("assets/spare.png")']);
  });

  it('leaves the file its name, and reads the earlier steps through it, when the old name is another file’s now', () => {
    const image = addImage('assets/logo.png');
    const id = idAt('assets/logo.png');
    renameInProject(id, 'brand.png');
    files().addAssetFile('assets', 'logo.png', 'image/png', PNG);
    history().push(canvas().elements, canvas().rootId);
    canvas().updateElementProps(image, { alt: 'Brand' });

    undoCanvas();
    expect(undoCanvas()).toBe(true);
    expect(pathOf(id)).toBe('assets/brand.png');
    // The canvas does not go back to asking for a name that is another picture now.
    expect(srcOf(canvas().elements)).toEqual(['asset("assets/brand.png")']);
    expect(said().at(-1)).toBe('info: assets/brand.png keeps its name: it could not be given assets/logo.png again.');
    // And Redo does not rename anything: the step is the canvas alone from here on.
    expect(redoCanvas()).toBe(true);
    expect(pathOf(id)).toBe('assets/brand.png');
    expect(srcOf(canvas().elements)).toEqual(['asset("assets/brand.png")']);
  });

  it('steps over a rename of a picture that was deleted since without stopping', () => {
    addImage('assets/logo.png');
    const id = idAt('assets/logo.png');
    renameInProject(id, 'brand.png');
    files().deleteFile(id);
    expect(undoCanvas()).toBe(true);
    expect(undoCanvas()).toBe(true);
    expect(srcOf(canvas().elements)).toEqual([]);
  });

  it('is refused whole when the name is taken: no step, and nothing follows', () => {
    addImage('assets/logo.png');
    flushCanvasToActiveFile();
    const steps = history().past.length;
    expect(() => renameInProject(idAt('assets/logo.png'), 'spare.png')).toThrow(/already exists/);
    expect(history().past).toHaveLength(steps);
    expect(srcOf(canvas().elements)).toEqual(['asset("assets/logo.png")']);
  });
});

describe('renaming a folder with pictures in it', () => {
  it('takes along every path under it, a path put together from it too, and goes back on Undo', () => {
    addImage('assets/logo.png');
    files().updateLogicFile('main_logic', `function picture(name) {\n  return asset("assets/" + name)\n}\n`);
    const folder = idAt('assets');
    const outcome = renameInProject(folder, 'media');
    expect(outcome.followed).toEqual(['logic/main.logic', 'ui/main.ui']);
    expect(srcOf(canvas().elements)).toEqual(['asset("media/logo.png")']);
    expect(files().logicFiles.get('main_logic')!.content).toContain('asset("media/" + name)');
    expect([...files().assetFiles.values()].map((asset) => asset.name).sort()).toEqual(['media/logo.png', 'media/spare.png']);

    undoCanvas();
    expect(pathOf(folder)).toBe('assets');
    expect(pathOf(idAt('assets/logo.png'))).toBe('assets/logo.png');
    expect(srcOf(canvas().elements)).toEqual(['asset("assets/logo.png")']);
    expect(files().logicFiles.get('main_logic')!.content).toContain('asset("assets/" + name)');
  });

  it('is no step for a folder with no picture in it, as before', () => {
    const steps = history().past.length;
    expect(renameInProject(idAt('logic'), 'scripts')).toEqual({ from: 'logic', to: 'scripts', followed: [] });
    expect(history().past).toHaveLength(steps);
    expect(files().uiFiles.get('main_ui')!.logicSrc).toBe('../scripts/main.logic');
  });
});
