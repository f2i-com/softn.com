/**
 * A picture added in the Builder is one of the project's assets.
 *
 * Nothing could add one: `projectStore.addAsset` had no caller, and the file
 * store, where the project's assets are, could rename and delete an asset
 * and not take one in. Held here: a file that is added is in Files, in what
 * a page is offered, in the export and what the export opens as, and in the
 * session a reload restores; one that is deleted is in none of them; and the
 * pages that name a picture are said before it is deleted.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import {
  ASSETS_FOLDER,
  MAX_ASSET_BYTES,
  addAssetFiles,
  assetKindWords,
  assetNameFor,
  freeAssetName,
  replaceAsset,
  replacedWords,
  replacementAccept,
  sizeWords,
  wrongKindReason,
  type PickedFile,
  type ReplaceQuestion,
} from './addAssets';
import { assetCall } from './assetSource';
import { buildProjectBundle, flushCanvasToActiveFile } from './buildProjectBundle';
import { loadBundle } from './bundleLoader';
import { answerConfirm, currentConfirm, useConfirmStore } from './confirm';
import { captureSession, commitProjectSnapshot, prepareProjectSnapshot, prepareSessionSnapshot } from './openProject';
import { assetPath, currentAssets } from './projectAssets';
import { keepSavedPoint } from './savedPoint';
import { captureAssets } from './storedAssets';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const OTHER = new Uint8Array([9, 8, 7, 6, 5]);

/** A file as a file picker hands it over. */
function picked(name: string, bytes: Uint8Array = PNG): PickedFile {
  return { name, size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
}

const files = () => useFilesStore.getState();

function assetPaths(): string[] {
  return currentAssets(files(), useProjectStore.getState()).map(assetPath).sort();
}

function idAt(path: string): string {
  const node = [...files().nodes.values()].find((n) => n.path === path);
  if (!node) throw new Error(`nothing at ${path}`);
  return node.id;
}

/** The paths the Files panel draws: each root, and all it holds. */
function drawnPaths(): string[] {
  const { nodes, rootFolders } = files();
  const out: string[] = [];
  const walk = (id: string) => {
    const node = nodes.get(id);
    if (!node) return;
    out.push(node.path);
    for (const child of node.children ?? []) walk(child);
  };
  rootFolders.forEach(walk);
  return out;
}

beforeEach(() => {
  useCanvasStore.getState().reset();
  useProjectStore.getState().reset();
  useHistoryStore.getState().clear();
  useSchemaStore.getState().reset();
  files().reset();
});

describe('the name a picked file is kept under', () => {
  it('is its own name, as one word a page can write', () => {
    expect(assetNameFor('logo.png')).toBe('logo.png');
    expect(assetNameFor('My Photo (1).PNG')).toBe('My-Photo-(1).PNG');
    expect(assetNameFor('C:\\fakepath\\hero.jpg')).toBe('hero.jpg');
    expect(assetNameFor('shots/team.webp')).toBe('team.webp');
  });

  it('has nothing a bundle drops or asset("…") cannot be read back with', () => {
    expect(assetNameFor('version..png')).toBe('version.png');
    expect(assetNameFor('say "cheese".png')).toBe('say-cheese.png');
    expect(assetNameFor("it's.png")).toBe('its.png');
    expect(assetNameFor('..')).toBe('file');
    expect(assetNameFor('   ')).toBe('file');
  });

  it('is numbered when the folder has that name already', () => {
    const nodes = new Map(files().nodes);
    expect(freeAssetName(nodes, 'assets', 'logo.png')).toBe('logo.png');
    nodes.set('a', { id: 'a', name: 'logo.png', path: 'assets/logo.png', type: 'file', fileType: 'asset', parentId: 'folder_assets' });
    expect(freeAssetName(nodes, 'assets', 'logo.png')).toBe('logo-2.png');
    nodes.set('b', { id: 'b', name: 'logo-2.png', path: 'assets/logo-2.png', type: 'file', fileType: 'asset', parentId: 'folder_assets' });
    expect(freeAssetName(nodes, 'assets', 'logo.png')).toBe('logo-3.png');
    nodes.set('c', { id: 'c', name: 'README', path: 'assets/README', type: 'file', fileType: 'asset', parentId: 'folder_assets' });
    expect(freeAssetName(nodes, 'assets', 'README')).toBe('README-2');
  });
});

describe('a picture added to the project', () => {
  it('is in Files under assets, in what a page is offered, and leaves the project unsaved and the open page open', async () => {
    const open = files().activeFileId;
    const { added, refused } = await addAssetFiles([picked('logo.png')]);
    expect(refused).toEqual([]);
    expect(added.map((a) => a.path)).toEqual(['assets/logo.png']);
    expect(drawnPaths()).toContain('assets/logo.png');
    expect(files().nodes.get(added[0].id)).toMatchObject({ fileType: 'asset', parentId: idAt(ASSETS_FOLDER) });
    expect(assetPaths()).toEqual(['assets/logo.png']);
    expect(files().assetFiles.get(added[0].id)).toMatchObject({ bundlePath: 'assets/logo.png', type: 'image/png' });
    expect(useProjectStore.getState().isDirty).toBe(true);
    expect(files().activeFileId).toBe(open);
  });

  it('is in the export, and in the project the export opens as', async () => {
    await addAssetFiles([picked('logo.png'), picked('notes.pdf', OTHER)]);
    const bundle = await buildProjectBundle();
    const entries = unzipSync(bundle);
    expect([...entries['assets/logo.png']]).toEqual([...PNG]);
    expect([...entries['assets/notes.pdf']]).toEqual([...OTHER]);
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    expect(manifest.files.assets).toEqual(['assets/logo.png', 'assets/notes.pdf']);

    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(bundle)));
    expect(assetPaths()).toEqual(['assets/logo.png', 'assets/notes.pdf']);
    expect([...files().assetFiles.get(idAt('assets/logo.png'))!.data]).toEqual([...PNG]);
  });

  it('is in the session a reload restores', async () => {
    await addAssetFiles([picked('logo.png')]);
    const raw = JSON.stringify(captureSession('design'));
    files().reset();
    useProjectStore.getState().reset();
    commitProjectSnapshot(prepareSessionSnapshot(raw));
    expect(drawnPaths()).toContain('assets/logo.png');
    expect([...files().assetFiles.get(idAt('assets/logo.png'))!.data]).toEqual([...PNG]);
  });

  it('does not take the place of one of the same name', async () => {
    await addAssetFiles([picked('logo.png')]);
    const { added } = await addAssetFiles([picked('logo.png', OTHER)]);
    expect(added.map((a) => a.path)).toEqual(['assets/logo-2.png']);
    expect([...files().assetFiles.get(idAt('assets/logo.png'))!.data]).toEqual([...PNG]);
    expect([...files().assetFiles.get(idAt('assets/logo-2.png'))!.data]).toEqual([...OTHER]);
  });

  it('is left out, with the reason, when it is too large or cannot be read, and the others are added', async () => {
    const huge: PickedFile = { name: 'film.mp4', size: MAX_ASSET_BYTES + 1, arrayBuffer: async () => { throw new Error('read although too large'); } };
    const broken: PickedFile = { name: 'gone.png', size: 10, arrayBuffer: async () => { throw new Error('The file is no longer there'); } };
    const { added, refused } = await addAssetFiles([huge, broken, picked('ok.png')]);
    expect(added.map((a) => a.path)).toEqual(['assets/ok.png']);
    expect(refused).toHaveLength(2);
    // One file's limit is the bundle reader's limit on one entry (50 MB), not the whole bundle's.
    expect(MAX_ASSET_BYTES).toBe(50 * 1024 * 1024);
    expect(refused[0]).toMatch(/^film\.mp4 is \d+ MB, and one file of an app can be 50 MB at most\.$/);
    expect(refused[1]).toBe('gone.png could not be read: The file is no longer there');
  });

  it('is gone from what a page is offered and from the export once it is deleted', async () => {
    const { added } = await addAssetFiles([picked('logo.png'), picked('hero.png')]);
    files().deleteFile(added[0].id);
    expect(assetPaths()).toEqual(['assets/hero.png']);
    const entries = unzipSync(await buildProjectBundle());
    expect(Object.keys(entries)).not.toContain('assets/logo.png');
    expect(JSON.parse(strFromU8(entries['manifest.json'])).files.assets).toEqual(['assets/hero.png']);
  });

  // A restored session fills the project's own list of assets as well as the files', and that
  // list is what a project with no asset among its files is taken to have (projectAssets.ts):
  // with its last picture deleted, a project made here was still drawn, previewed and exported
  // with it. Seen in a browser: the canvas went on drawing a picture Files no longer had.
  it('is gone for good when it was the last one, in a project restored after a reload', async () => {
    await addAssetFiles([picked('logo.png')]);
    const raw = JSON.stringify(captureSession('design'));
    files().reset();
    useProjectStore.getState().reset();
    commitProjectSnapshot(prepareSessionSnapshot(raw));
    expect(assetPaths()).toEqual(['assets/logo.png']);

    files().deleteFile(idAt('assets/logo.png'));
    expect(assetPaths()).toEqual([]);
    const entries = unzipSync(await buildProjectBundle());
    expect(Object.keys(entries).filter((path) => path.startsWith('assets/'))).toEqual([]);
  });

  it('is refused a name a bundle cannot hold, and a place that is taken', async () => {
    await addAssetFiles([picked('logo.png')]);
    expect(() => files().addAssetFile('assets', 'version..png', 'image/png', PNG)).toThrow(/two dots in a row/);
    expect(() => files().addAssetFile('assets', 'a/b.png', 'image/png', PNG)).toThrow(/cannot have "\/"/);
    expect(() => files().addAssetFile('assets', 'logo.png', 'image/png', PNG)).toThrow(/assets\/logo\.png already exists/);
    expect(assetPaths()).toEqual(['assets/logo.png']);
  });
});

describe('the pages that use a picture', () => {
  it('are named for the picture, and for the folder it is in', async () => {
    const { added } = await addAssetFiles([picked('logo.png'), picked('unused.png')]);
    const canvas = useCanvasStore.getState();
    const image = canvas.addElement('Image', canvas.rootId);
    canvas.updateElement(image, { props: { src: assetCall('assets/logo.png') }, expressionProps: ['src'] });
    flushCanvasToActiveFile();
    files().updateLogicFile('main_logic', `let mark = asset('assets/logo.png')\n`);

    expect(files().usersOf(added[0].id)).toEqual(['logic/main.logic', 'ui/main.ui']);
    expect(files().usersOf(added[1].id)).toEqual([]);
    expect(files().usersOf(idAt(ASSETS_FOLDER))).toEqual(['logic/main.logic', 'ui/main.ui']);
    // And they follow it when it is renamed: the path was left as it was, and the page and
    // the logic went on asking for a file that was no longer there.
    expect(files().assetUsersOf(added[0].id)).toEqual(['logic/main.logic', 'ui/main.ui']);
    expect(files().assetUsersOf(idAt('ui/main.ui'))).toEqual([]);
    files().renameFile(added[0].id, 'brand.png');
    expect(files().assetUsersOf(added[0].id)).toEqual(['logic/main.logic', 'ui/main.ui']);
    expect(String(files().uiFiles.get('main_ui')!.elements.get(image)!.props.src)).toBe('asset("assets/brand.png")');
    expect(files().logicFiles.get('main_logic')!.content).toBe(`let mark = asset('assets/brand.png')\n`);
  });
});

// The Files panel draws the project from its roots, and the list of them was set when a
// project was made or opened and by nothing after: a folder made at the top was in no list.
describe('a folder at the top of the project', () => {
  it('is drawn in Files when it is made by hand', () => {
    files().createFolder('', 'media');
    expect(drawnPaths()).toContain('media');
  });

  it('is drawn when it is made again for a picture, after assets was deleted', async () => {
    files().deleteFolder(idAt(ASSETS_FOLDER));
    expect(drawnPaths()).not.toContain('assets');
    await addAssetFiles([picked('logo.png')]);
    expect(drawnPaths()).toEqual(expect.arrayContaining(['assets', 'assets/logo.png']));
    expect(files().rootFolders).toHaveLength(3);
  });
});

// A newer picture under the same name was: delete the old one, add the new one, and see that
// its name came out the same, since every page asks for a picture by its path. Replacing keeps
// the path and the id and swaps the bytes.
describe('a file put in place of a picture', () => {
  const NEWER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9, 9, 9]);
  const yes = async () => true;

  /** A project with assets/logo.png in it, as a save leaves it: nothing in it unsaved. */
  async function savedWithLogo(): Promise<string> {
    const { added } = await addAssetFiles([picked('logo.png')]);
    files().markFileDirty(added[0].id, false);
    keepSavedPoint();
    useProjectStore.getState().markClean();
    return added[0].id;
  }

  it('keeps the path and the id, holds the new bytes, and leaves the project unsaved', async () => {
    const id = await savedWithLogo();
    const open = files().activeFileId;
    const before = files().assetFiles.get(id)!;
    expect(useProjectStore.getState().isDirty).toBe(false);

    const result = await replaceAsset(id, picked('newer photo.png', NEWER), yes);
    expect(result).toEqual({ outcome: 'replaced', path: 'assets/logo.png', users: [] });
    expect(replacedWords(result, 'newer photo.png')).toBe('Replaced assets/logo.png');
    expect(idAt('assets/logo.png')).toBe(id);
    expect(assetPaths()).toEqual(['assets/logo.png']);
    const now = files().assetFiles.get(id)!;
    expect([...now.data]).toEqual([...NEWER]);
    expect(now).toMatchObject({ bundlePath: 'assets/logo.png', name: 'assets/logo.png', type: 'image/png' });
    // A new record around a new array: what was last saved is known by the old one, which is not written into.
    expect(now).not.toBe(before);
    expect([...before.data]).toEqual([...PNG]);
    expect(files().nodes.get(id)!.isDirty).toBe(true);
    expect(useProjectStore.getState().isDirty).toBe(true);
    expect(files().activeFileId).toBe(open);
  });

  it('is what the export, a reopened export, a restored session and the recovery copy hold', async () => {
    const id = await savedWithLogo();
    const stored = captureAssets(files().assetFiles).signature;
    await replaceAsset(id, picked('logo.png', NEWER), yes);
    expect(captureAssets(files().assetFiles).signature).not.toBe(stored);

    const raw = JSON.stringify(captureSession('design'));
    const bundle = await buildProjectBundle();
    const entries = unzipSync(bundle);
    expect([...entries['assets/logo.png']]).toEqual([...NEWER]);
    expect(JSON.parse(strFromU8(entries['manifest.json'])).files.assets).toEqual(['assets/logo.png']);

    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(bundle)));
    expect([...files().assetFiles.get(idAt('assets/logo.png'))!.data]).toEqual([...NEWER]);

    files().reset();
    useProjectStore.getState().reset();
    commitProjectSnapshot(prepareSessionSnapshot(raw));
    expect([...files().assetFiles.get(idAt('assets/logo.png'))!.data]).toEqual([...NEWER]);
  });

  it('asks first, with the sizes and the pages that use it, and does nothing on a no', async () => {
    const id = await savedWithLogo();
    const canvas = useCanvasStore.getState();
    const image = canvas.addElement('Image', canvas.rootId);
    canvas.updateElement(image, { props: { src: assetCall('assets/logo.png') }, expressionProps: ['src'] });
    flushCanvasToActiveFile();
    keepSavedPoint();
    useProjectStore.getState().markClean();

    const asked: ReplaceQuestion[] = [];
    const no = async (question: ReplaceQuestion) => {
      asked.push(question);
      return false;
    };
    expect(await replaceAsset(id, picked('newer.png', NEWER), no)).toEqual({ outcome: 'cancelled' });
    expect(asked).toEqual([{ path: 'assets/logo.png', fileName: 'newer.png', oldBytes: PNG.byteLength, newBytes: NEWER.byteLength, users: ['ui/main.ui'] }]);
    expect([...files().assetFiles.get(id)!.data]).toEqual([...PNG]);
    expect(useProjectStore.getState().isDirty).toBe(false);

    // And the page goes on asking for it by the same path once it is replaced.
    expect(await replaceAsset(id, picked('newer.png', NEWER), yes)).toEqual({ outcome: 'replaced', path: 'assets/logo.png', users: ['ui/main.ui'] });
    expect(String(files().uiFiles.get('main_ui')!.elements.get(image)!.props.src)).toBe('asset("assets/logo.png")');
    expect(files().assetUsersOf(id)).toEqual(['ui/main.ui']);
  });

  it('asks in the dialog deleting a file asks in, and says what is lost', async () => {
    useConfirmStore.setState({ queue: [] });
    const id = await savedWithLogo();
    files().updateLogicFile('main_logic', `let mark = asset("assets/logo.png")\n`);
    const replacing = replaceAsset(id, picked('newer.png', NEWER));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(currentConfirm()).toMatchObject({
      title: 'Replace picture',
      confirmLabel: 'Replace',
      danger: true,
      message:
        'Put newer.png (14 bytes) in place of assets/logo.png (12 bytes)? The picture that is there now leaves the project, and Undo does not bring it back.\n\nlogic/main.logic uses it, and will get the new one.',
    });
    answerConfirm(currentConfirm()!.id, true);
    expect((await replacing).outcome).toBe('replaced');
    expect([...files().assetFiles.get(id)!.data]).toEqual([...NEWER]);
  });

  it('is refused what adding refuses: a file that is too large or cannot be read', async () => {
    const id = await savedWithLogo();
    const never = async () => {
      throw new Error('asked about a file that was refused');
    };
    const huge: PickedFile = { name: 'huge.png', size: MAX_ASSET_BYTES + 1, arrayBuffer: async () => { throw new Error('read although too large'); } };
    const broken: PickedFile = { name: 'gone.png', size: 10, arrayBuffer: async () => { throw new Error('The file is no longer there'); } };
    const tooLarge = await replaceAsset(id, huge, never);
    expect(tooLarge.outcome === 'refused' && tooLarge.reason).toMatch(/^huge\.png is \d+ MB, and one file of an app can be 50 MB at most\.$/);
    expect(await replaceAsset(id, broken, never)).toEqual({ outcome: 'refused', reason: 'gone.png could not be read: The file is no longer there' });
    expect([...files().assetFiles.get(id)!.data]).toEqual([...PNG]);
    expect(useProjectStore.getState().isDirty).toBe(false);
  });

  // The app is handed each file as the type its name says: a JPEG under `logo.png` would be
  // handed out as a PNG, and the name cannot follow without leaving the pages behind.
  it('is refused a file of another kind than the name says, with the two ways on', async () => {
    const id = await savedWithLogo();
    const never = async () => {
      throw new Error('asked about a file that was refused');
    };
    const unread: PickedFile = { name: 'Holiday.JPG', size: 10, arrayBuffer: async () => { throw new Error('read although it is the wrong kind'); } };
    expect(await replaceAsset(id, unread, never)).toEqual({
      outcome: 'refused',
      reason:
        'Holiday.JPG is a .jpg file, and assets/logo.png is a .png file. Replacing keeps the name, and the name tells the app what kind of file it is. Choose a .png file, or add Holiday.JPG as a new picture and choose it where this one is used.',
    });
    expect(wrongKindReason('assets/logo.png', 'notes')).toMatch(/^notes is a file with no type in its name, and assets\/logo\.png is a \.png file\. .* add notes as a new file and/);
    expect([...files().assetFiles.get(id)!.data]).toEqual([...PNG]);
    expect(useProjectStore.getState().isDirty).toBe(false);
  });

  it('takes the other spelling of the same kind, and no other ending of a shared type', async () => {
    expect(wrongKindReason('assets/logo.png', 'LOGO.PNG')).toBeNull();
    expect(wrongKindReason('assets/photo.jpg', 'photo.jpeg')).toBeNull();
    expect(wrongKindReason('assets/photo.jpeg', 'photo.JPG')).toBeNull();
    expect(wrongKindReason('assets/scan.tif', 'scan.tiff')).toBeNull();
    expect(wrongKindReason('assets/LICENSE', 'LICENSE')).toBeNull();
    // Both are handed out as plain text, and neither is the other.
    expect(wrongKindReason('assets/notes.txt', 'main.logic')).not.toBeNull();
    // Nor are two endings nobody knows, which are both handed out as bytes.
    expect(wrongKindReason('assets/data.abc', 'data.xyz')).not.toBeNull();
    expect(wrongKindReason('assets/data.abc', 'other.abc')).toBeNull();
    expect(wrongKindReason('assets/toString', 'toString.constructor')).not.toBeNull();

    expect(replacementAccept('assets/logo.png')).toBe('.png');
    expect(replacementAccept('assets/photo.jpeg')).toBe('.jpeg,.jpg');
    expect(replacementAccept('assets/LICENSE')).toBe('');
  });

  it('changes nothing for the file that is there already, and does not ask', async () => {
    const id = await savedWithLogo();
    const before = files().assetFiles.get(id)!;
    const revision = useProjectStore.getState().revision;
    const never = async () => {
      throw new Error('asked about a file that changes nothing');
    };
    const result = await replaceAsset(id, picked('copy of logo.png'), never);
    expect(result).toEqual({ outcome: 'same', path: 'assets/logo.png' });
    expect(replacedWords(result, 'copy of logo.png')).toBe('copy of logo.png is what assets/logo.png holds already. Nothing was changed.');
    expect(files().assetFiles.get(id)).toBe(before);
    expect(useProjectStore.getState().isDirty).toBe(false);
    expect(useProjectStore.getState().revision).toBe(revision);
  });

  it('is refused for a file that has gone, before the question and while it is asked', async () => {
    const id = await savedWithLogo();
    const gone = { outcome: 'refused', reason: 'That picture or file is no longer in the project.' };
    const deleting = async () => {
      files().deleteFile(id);
      return true;
    };
    expect(await replaceAsset(id, picked('newer.png', NEWER), deleting)).toEqual(gone);
    expect(await replaceAsset(id, picked('newer.png', NEWER), yes)).toEqual(gone);
    expect(await replaceAsset('main_ui', picked('newer.png', NEWER), yes)).toEqual(gone);
    expect(() => files().replaceAssetFile('main_ui', NEWER)).toThrow('That picture or file is no longer in the project.');
    expect(assetPaths()).toEqual([]);
  });

  it('follows the name the file has now', async () => {
    const id = await savedWithLogo();
    files().renameFile(id, 'brand.png');
    expect(await replaceAsset(id, picked('newer.png', NEWER), yes)).toEqual({ outcome: 'replaced', path: 'assets/brand.png', users: [] });
    expect(assetPaths()).toEqual(['assets/brand.png']);
    expect([...unzipSync(await buildProjectBundle())['assets/brand.png']]).toEqual([...NEWER]);
  });
});

describe('what is said of a file', () => {
  it('is its size in the unit that fits', () => {
    expect(sizeWords(1)).toBe('1 byte');
    expect(sizeWords(812)).toBe('812 bytes');
    expect(sizeWords(47514)).toBe('46.4 KB');
    expect(sizeWords(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  it('is its kind as its name says it', () => {
    expect(assetKindWords('assets/team-photo.png')).toBe('PNG picture');
    expect(assetKindWords('assets/hero.JPG')).toBe('JPEG picture');
    expect(assetKindWords('assets/chime.mp3')).toBe('MP3 sound');
    expect(assetKindWords('assets/notes.pdf')).toBe('PDF file');
    expect(assetKindWords('assets/data.json')).toBe('JSON file');
    expect(assetKindWords('assets/LICENSE')).toBe('File');
  });
});
