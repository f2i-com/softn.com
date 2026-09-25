/**
 * The file tree keeps the project exportable.
 *
 * Four ways it did not, each silent until export or the running app:
 *
 * - Two files could share a path — create, rename and move never looked —
 *   and export, which writes one archive entry per path, kept one of them.
 * - A `.py` file could take a name Python cannot import (`my-helpers.py`) or
 *   one the runtime reserves (`json.py`, `softn.py`); the composer refused the
 *   whole app for it later, at preview or export.
 * - Moving a UI file, or renaming a folder, left `<logic src>` pointing where
 *   the file used to be relative to, because the reference is relative to the
 *   file that holds it and only renames of the logic file were followed; and
 *   the follow-up rewrite matched only a double-quoted tag, and only the first.
 * - The entry file was protected by the id a new project gives it, so an
 *   opened app's entry file — with a generated id — could be deleted, and
 *   export then refused the app.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { useFilesStore } from './filesStore';
import { useProjectStore } from './projectStore';
import { loadBundle } from '../utils/bundleLoader';
import { commitProjectSnapshot, prepareProjectSnapshot } from '../utils/openProject';
import { buildProjectBundle } from '../utils/buildProjectBundle';

function store() {
  return useFilesStore.getState();
}

function pathsOf(): string[] {
  return [...store().nodes.values()].map((node) => node.path).sort();
}

function resolvedLogicRef(id: string): string | undefined {
  const file = store().uiFiles.get(id);
  return file?.logicSrc ? store().resolveImportPath(file.path, file.logicSrc) : undefined;
}

/** The UI file carries an explicit tag, the way a bundle opened from disk does. */
function linkMainUI(source = '<logic src="../logic/main.logic" />\n<Stack></Stack>'): void {
  store().updateUIFileSource('main_ui', source);
}

beforeEach(() => {
  useProjectStore.getState().reset();
  store().reset();
  store().createFolder('ui', 'components');
  store().createFolder('ui', 'pages');
  store().createFolder('logic', 'utils');
});

describe('two files at one path', () => {
  it('refuses to create a file where one already is', () => {
    const before = pathsOf();
    expect(() => store().createFile('ui', 'main.ui', 'ui')).toThrow(/ui\/main\.ui already exists/);
    expect(() => store().createFile('logic', 'main.logic', 'logic')).toThrow(/already exists/);
    expect(pathsOf()).toEqual(before);
    expect(store().uiFiles.size).toBe(1);
  });

  it('refuses to rename a file onto another', () => {
    const extra = store().createFile('logic', 'extra.logic', 'logic');
    expect(() => store().renameFile(extra, 'main.logic')).toThrow(/already exists/);
    expect(store().logicFiles.get(extra)?.path).toBe('logic/extra.logic');
  });

  it('refuses to move a file onto another', () => {
    const page = store().createFile('ui/pages', 'main.ui', 'ui');
    expect(() => store().moveFile(page, 'ui')).toThrow(/ui\/main\.ui already exists/);
    expect(store().uiFiles.get(page)?.path).toBe('ui/pages/main.ui');
  });

  it('refuses to rename a folder onto another', () => {
    const pages = [...store().nodes.values()].find((node) => node.path === 'ui/pages')!;
    expect(() => store().renameFolder(pages.id, 'components')).toThrow(/ui\/components already exists/);
  });

  it('so export writes every file the tree shows', async () => {
    const { readBundleEntries } = await import('@softn/core');
    try {
      store().createFile('logic', 'main.logic', 'logic');
    } catch {
      // Refused, which is the point.
    }
    const logicPaths = [...store().logicFiles.values()].map((file) => file.path);
    const entries = readBundleEntries(await buildProjectBundle());
    const archived = [...entries.keys()].filter((path) => path.startsWith('logic/'));
    expect(archived.sort()).toEqual(logicPaths.sort());
  });
});

describe('Python module names', () => {
  it.each([
    ['json.py', /reserved module name json\.py/],
    ['math.py', /reserved module name math\.py/],
    ['softn.py', /reserved module name softn\.py/],
    ['my-helpers.py', /letters, digits and underscores/],
    ['2fast.py', /letters, digits and underscores/],
  ])('refuses to create %s, and says why', (name, reason) => {
    expect(() => store().createFile('logic', name, 'logic')).toThrow(reason);
    expect(pathsOf()).not.toContain(`logic/${name}`);
  });

  it('refuses to rename a logic file to one', () => {
    const helpers = store().createFile('logic', 'helpers.py', 'logic');
    expect(() => store().renameFile(helpers, 'json.py')).toThrow(/reserved/);
    expect(store().logicFiles.get(helpers)?.path).toBe('logic/helpers.py');
  });

  it('refuses a second module of the same name in another folder', () => {
    store().createFile('logic', 'helpers.py', 'logic');
    expect(() => store().createFile('logic/utils', 'helpers.py', 'logic')).toThrow(/already the Python module helpers/);
  });

  it('accepts a name Python can import, and does not police .logic names', () => {
    expect(() => store().createFile('logic', 'my_helpers.py', 'logic')).not.toThrow();
    expect(() => store().createFile('logic', 'my-helpers.logic', 'logic')).not.toThrow();
  });
});

describe('<logic src> follows every move', () => {
  it('follows a UI file moved to another folder', () => {
    linkMainUI();
    store().moveFile('main_ui', 'ui/pages');

    expect(store().uiFiles.get('main_ui')?.path).toBe('ui/pages/main.ui');
    expect(resolvedLogicRef('main_ui')).toBe('logic/main.logic');
    expect(store().uiFiles.get('main_ui')?.originalSource).toContain('<logic src="../../logic/main.logic" />');
  });

  it('follows a renamed folder holding the logic', () => {
    linkMainUI();
    store().renameFolder('folder_logic', 'scripts');

    expect(store().logicFiles.get('main_logic')?.path).toBe('scripts/main.logic');
    expect(resolvedLogicRef('main_ui')).toBe('scripts/main.logic');
    expect(store().uiFiles.get('main_ui')?.originalSource).toContain('<logic src="../scripts/main.logic" />');
  });

  it('follows a renamed folder holding the UI file', () => {
    linkMainUI();
    const page = store().createFile('ui/pages', 'Home.ui', 'ui');
    store().updateUIFileSource(page, '<logic src="../../logic/main.logic" />\n<Stack></Stack>');
    const pages = [...store().nodes.values()].find((node) => node.path === 'ui/pages')!;
    store().renameFolder(pages.id, 'screens');

    expect(store().uiFiles.get(page)?.path).toBe('ui/screens/Home.ui');
    expect(resolvedLogicRef(page)).toBe('logic/main.logic');
  });

  it('rewrites a single-quoted tag, and every tag that pointed there', () => {
    linkMainUI("<logic src='../logic/main.logic' />\n<Stack></Stack>\n<logic src=\"../logic/main.logic\" />");
    store().renameFile('main_logic', 'app.logic');

    const source = store().uiFiles.get('main_ui')?.originalSource ?? '';
    expect(source).toContain("<logic src='../logic/app.logic' />");
    expect(source).toContain('<logic src="../logic/app.logic" />');
    expect(source).not.toContain('main.logic');
  });

  it('leaves a reference that still resolves as the author wrote it', () => {
    linkMainUI('<logic src="./../logic/main.logic" />\n<Stack></Stack>');
    store().renameFile('main_ui', 'home.ui');
    expect(store().uiFiles.get('main_ui')?.originalSource).toContain('<logic src="./../logic/main.logic" />');
  });
});

describe('the entry file of an opened app', () => {
  let entryId: string;
  let logicId: string;

  beforeEach(async () => {
    const bundle = zipSync({
      'manifest.json': strToU8(JSON.stringify({
        name: 'Opened', version: '1.0.0', description: '', main: 'ui/main.ui',
        files: { ui: ['ui/main.ui', 'ui/other.ui'], logic: ['logic/main.logic', 'logic/spare.logic'], xdb: [], assets: [] },
      })),
      'ui/main.ui': strToU8('<logic src="../logic/main.logic" />\n<App>\n  <Text>{count}</Text>\n</App>\n'),
      'ui/other.ui': strToU8('<App>\n  <Text>other</Text>\n</App>\n'),
      'logic/main.logic': strToU8('let count = 0\n'),
      'logic/spare.logic': strToU8('let spare = 1\n'),
    });
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(bundle)));
    entryId = useProjectStore.getState().source.mainFileId!;
    logicId = [...store().logicFiles.values()].find((file) => file.path === 'logic/main.logic')!.id;
  });

  it('has a generated id, which is why protecting `main_ui` protected nothing', () => {
    expect(entryId).not.toBe('main_ui');
  });

  it('cannot be deleted, and export still works', async () => {
    expect(store().deletionRefusedReason(entryId)).toMatch(/entry file/);
    expect(() => store().deleteFile(entryId)).toThrow(/ui\/main\.ui is the app's entry file/);
    expect(store().uiFiles.has(entryId)).toBe(true);
    await expect(buildProjectBundle()).resolves.toBeInstanceOf(Uint8Array);
  });

  it('cannot be deleted with its folder', () => {
    const uiFolder = [...store().nodes.values()].find((node) => node.path === 'ui')!;
    expect(() => store().deleteFolder(uiFolder.id)).toThrow(/The folder ui cannot be deleted/);
    expect(store().uiFiles.has(entryId)).toBe(true);
  });

  it('protects the logic it links until it links another', () => {
    expect(() => store().deleteFile(logicId)).toThrow(/links with <logic src>/);
    store().updateUIFileSource(entryId, '<logic src="../logic/spare.logic" />\n<App></App>\n');
    expect(() => store().deleteFile(logicId)).not.toThrow();
    expect(store().logicFiles.has(logicId)).toBe(false);
  });

  it('leaves every other file deletable', () => {
    const other = [...store().uiFiles.values()].find((file) => file.path === 'ui/other.ui')!.id;
    expect(store().deletionRefusedReason(other)).toBeNull();
    store().deleteFile(other);
    expect(store().uiFiles.has(other)).toBe(false);
  });
});
