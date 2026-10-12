/**
 * A bundle opened and exported with nothing touched leaves as it came.
 *
 * Driven first as a round trip between the two editors: an app made in
 * Studio, opened here, edited, exported and taken back into Studio. Four
 * things had changed that nobody changed:
 *
 *  - a record's field named `updatedAt` was gone, and the date column it
 *    filled came back blank. A seed record written flat (`{ id, ...fields }`)
 *    keeps every key but `id` and `collection` as a field when the runtime
 *    reads it; here six more names were taken for the record's own and
 *    dropped from its fields;
 *  - `permission.json` was gone where it declared nothing, and Studio then
 *    said the app had none;
 *  - the manifest had a `config.window` it did not come with;
 *  - the manifest's `pages` list still named a page that had been renamed.
 *
 * The first three are the same mistake as the theme mode the Builder used to
 * invent (themeModeUndeclared.test.ts): a setting a file does not have is
 * not one to write into it. The last is the other half of keeping a file
 * that is carried through: what in it names a file has to follow the file.
 * The principle is pinned at the end, over the bundles the repository
 * ships: untouched, the manifest that comes out is the one that went in.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseXDBFile, readBundleEntries } from '@softn/core';
import { loadBundle } from './bundleLoader';
import { buildProjectBundle } from './buildProjectBundle';
import { captureSession, commitProjectSnapshot, prepareProjectSnapshot, prepareSessionSnapshot } from './openProject';
import { parseXdb } from './xdbFormat';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const json = (bytes: Uint8Array | undefined) => JSON.parse(text(bytes)) as Record<string, unknown>;

/** An app as Studio scaffolds one: no window, a pages list, an empty declaration, flat seed records. */
const STUDIO_MANIFEST = {
  name: 'Reading List',
  version: '1.0.0',
  description: 'Books to read.',
  main: 'ui/main.ui',
  target: 'web',
  files: { ui: ['ui/main.ui', 'ui/pages/home.ui', 'ui/pages/books.ui'], logic: ['logic/main.logic'], xdb: ['xdb/books.xdb'], assets: [] },
  config: { theme: { mode: 'dark' } },
  pages: [
    { id: 'home-page', name: 'Home', path: 'ui/pages/home.ui', route: '/' },
    { id: 'books-page', name: 'Books', path: 'ui/pages/books.ui', route: '/books' },
  ],
};
const BOOKS_XDB = {
  collection: 'books',
  records: [
    // Flat, as Studio writes seed rows. Every key but `id` and `collection` is a field of the record.
    { id: 'b1', title: 'Middlemarch', updatedAt: '2026-03-01', createdAt: '2026-02-01', deleted: false, _id: 'legacy-1' },
    { id: 'b2', title: 'Emma', updated_at: '2026-03-02T10:00:00.000Z', created_at: '2026-02-02T10:00:00.000Z', deleted: true },
  ],
};

function studioBundle(overrides: { manifest?: Record<string, unknown>; permission?: string | null; xdb?: unknown } = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(overrides.manifest ?? STUDIO_MANIFEST, null, 2)),
    'ui/main.ui': strToU8('<logic src="../logic/main.logic" />\n<import Home from="./pages/home.ui" />\n<import Books from="./pages/books.ui" />\n<App>\n  <Home />\n  <Books />\n</App>\n'),
    'ui/pages/home.ui': strToU8('<Stack>\n  <Heading>Home</Heading>\n</Stack>\n'),
    'ui/pages/books.ui': strToU8('<Stack>\n  <Heading>Books</Heading>\n</Stack>\n'),
    'logic/main.logic': strToU8('let page = "home"\n'),
    'xdb/books.xdb': strToU8(JSON.stringify(overrides.xdb ?? BOOKS_XDB, null, 2)),
  };
  if (overrides.permission !== null) files['permission.json'] = strToU8(overrides.permission ?? JSON.stringify({ permissions: {} }, null, 2));
  return zipSync(files);
}

async function open(bytes: Uint8Array): Promise<void> {
  commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(bytes)));
}
const exported = async () => readBundleEntries(await buildProjectBundle());
const fileAt = (path: string) => [...useFilesStore.getState().uiFiles.values()].find((file) => file.path === path)!;

beforeEach(() => {
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
  useSchemaStore.getState().reset();
  useHistoryStore.getState().clear();
});

describe('a seed record written flat', () => {
  const asRuntime = (xdb: string) => parseXDBFile('xdb/books.xdb', xdb).records;

  it('is read with the fields the runtime reads: every key but its id and its collection', () => {
    const source = JSON.stringify(BOOKS_XDB);
    const here = parseXdb(source, 'books');
    const runtime = asRuntime(source);
    // `updatedAt`, `createdAt`, `created_at`, `updated_at` and `deleted` are
    // fields of a flat record to the runtime, and were dropped from it here.
    expect(here.records.map((record) => record.data)).toEqual(runtime.map((record) => record.data));
    expect(here.records[0].data).toEqual({ title: 'Middlemarch', updatedAt: '2026-03-01', createdAt: '2026-02-01', deleted: false, _id: 'legacy-1' });
    // Its own times are the ones the runtime gives it from the same keys.
    expect(here.records.map((record) => [record.id, record.created_at, record.updated_at])).toEqual(
      runtime.map((record) => [record.id, record.created_at, record.updated_at])
    );
    // `deleted: true` in a flat record is a field that says so, and the row is a row: nothing is set aside.
    expect(here.tombstones).toEqual([]);
    expect(here.skipped).toBe(0);
  });

  it('comes out of an untouched export as the same records to the runtime: the same fields and the same values', async () => {
    await open(studioBundle());
    const out = await exported();
    expect(asRuntime(text(out.get('xdb/books.xdb')))).toEqual(asRuntime(JSON.stringify(BOOKS_XDB)));
    // And it is there for the Data view: the column is not blank.
    const books = useSchemaStore.getState().entities.find((entity) => entity.name === 'books')!;
    expect(useSchemaStore.getState().seedData.get(books.id)![0].updatedAt).toBe('2026-03-01');
  });

  it('is still set aside, as before, where it is nested and marked deleted', () => {
    // The envelope's own flag, which the runtime does not read: kept as it came, and not a row to edit.
    const nested = parseXdb(JSON.stringify({ collection: 'books', records: [{ id: 'b3', data: { title: 'Gone', updatedAt: 'x' }, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', deleted: true }] }), 'books');
    expect(nested.records).toEqual([]);
    expect(nested.tombstones.map((record) => record.id)).toEqual(['b3']);
  });
});

describe('a file the Builder writes again only once it is changed', () => {
  const BOM = [0xef, 0xbb, 0xbf];
  const withBom = (body: string) => Uint8Array.from([...BOM, ...new TextEncoder().encode(body)]);
  const bytesOf = (bytes: Uint8Array | undefined) => [...(bytes ?? [])];
  const books = () => useSchemaStore.getState().entities.find((entity) => entity.name === 'books')!;
  const XDB = JSON.stringify(BOOKS_XDB, null, 2);

  it('is an .xdb whose records are edited: written with the edit', async () => {
    await open(studioBundle());
    expect(text((await exported()).get('xdb/books.xdb'))).toBe(XDB);
    useSchemaStore.getState().updateSeedRecord(books().id, 0, { ...useSchemaStore.getState().seedData.get(books().id)![0], title: 'Persuasion' });
    const out = text((await exported()).get('xdb/books.xdb'));
    expect(out).not.toBe(XDB);
    expect(asRuntimeTitles(out)).toEqual(['Persuasion', 'Emma']);
  });

  it('is an .xdb whose fields are changed, which the runtime does not read and the Builder does', async () => {
    await open(studioBundle());
    const title = books().fields.find((field) => field.name === 'title')!;
    useSchemaStore.getState().updateField(books().id, title.id, { required: !title.required });
    const out = JSON.parse(text((await exported()).get('xdb/books.xdb'))) as { schema?: { fields: Array<{ name: string; required: boolean }> } };
    expect(out.schema?.fields.find((field) => field.name === 'title')?.required).toBe(!title.required);
  });

  it('is not kept in a saved session, which is written again and again and has a few megabytes to hold the work in', async () => {
    // A collection of a few thousand records, as a data-heavy app has.
    const rows = Array.from({ length: 3000 }, (_, at) => ({ id: `b${at}`, title: `Book ${at}`, note: 'x'.repeat(40) }));
    const heavy = JSON.stringify({ collection: 'books', records: rows }, null, 2);
    await open(studioBundle({ xdb: JSON.parse(heavy) }));
    expect(text((await exported()).get('xdb/books.xdb'))).toBe(heavy);
    const session = JSON.stringify(captureSession('design'));
    // The size it had before the file was kept: the same project, holding nothing of the file as it came.
    const project = useProjectStore.getState();
    project.setSource({ ...project.source, xdbFiles: undefined });
    expect(session.length).toBe(JSON.stringify(captureSession('design')).length);
    expect(session).not.toContain('xdbFiles');
  });

  it('is, after a saved session is restored, written again, with the edit where something was changed', async () => {
    await open(studioBundle());
    commitProjectSnapshot(prepareSessionSnapshot(JSON.stringify(captureSession('design'))));
    // The file as it came is not in the session: the Builder's writing of the same records.
    expect(asRuntimeTitles(text((await exported()).get('xdb/books.xdb')))).toEqual(['Middlemarch', 'Emma']);
    // Edited, kept in a session, and restored: the session's records, not the file the project was opened from.
    useSchemaStore.getState().updateSeedRecord(books().id, 1, { ...useSchemaStore.getState().seedData.get(books().id)![1], title: 'Sanditon' });
    commitProjectSnapshot(prepareSessionSnapshot(JSON.stringify(captureSession('design'))));
    expect(asRuntimeTitles(text((await exported()).get('xdb/books.xdb')))).toEqual(['Middlemarch', 'Sanditon']);
  });

  it('is a manifest written another way than the Builder writes one: as it came, until it is changed', async () => {
    const manifest = JSON.stringify({ name: 'Packed', version: '1.0.0', description: '', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: [], xdb: [], assets: [] } });
    await open(zipSync({ 'manifest.json': strToU8(manifest), 'ui/main.ui': strToU8('<App>\n  <Text>Hi</Text>\n</App>\n') }));
    expect(text((await exported()).get('manifest.json'))).toBe(manifest);
    useProjectStore.getState().setDescription('Now with words');
    expect(json((await exported()).get('manifest.json')).description).toBe('Now with words');
  });

  it('is a page or a logic file that began with a byte-order mark, which it keeps when it is edited', async () => {
    const manifest = { name: 'Marked', version: '1.0.0', description: '', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'], xdb: [], assets: [] } };
    const page = withBom('<logic src="../logic/main.logic" />\n<App>\n  <Text>Hi</Text>\n</App>\n');
    const logic = withBom('let count = 0\n');
    await open(zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)), 'ui/main.ui': page, 'logic/main.logic': logic }));
    let out = await exported();
    expect(bytesOf(out.get('ui/main.ui'))).toEqual(bytesOf(page));
    expect(bytesOf(out.get('logic/main.logic'))).toEqual(bytesOf(logic));

    const files = useFilesStore.getState();
    const logicId = [...files.logicFiles.values()][0].id;
    files.updateLogicFile(logicId, 'let count = 1\n');
    files.updateUIFileSource(files.activeFileId!, '<logic src="../logic/main.logic" />\n<App>\n  <Text>Hello</Text>\n</App>\n');
    // The canvas is given what was written in Code, as the app gives it.
    const written = useFilesStore.getState().uiFiles.get(files.activeFileId!)!;
    useCanvasStore.getState().loadState(written.elements, written.rootId, written.imports);
    out = await exported();
    expect(bytesOf(out.get('logic/main.logic')).slice(0, 3)).toEqual(BOM);
    expect(text(out.get('logic/main.logic'))).toBe('let count = 1\n');
    expect(bytesOf(out.get('ui/main.ui')).slice(0, 3)).toEqual(BOM);
    expect(text(out.get('ui/main.ui'))).toContain('Hello');
    // And through a saved session.
    commitProjectSnapshot(prepareSessionSnapshot(JSON.stringify(captureSession('design'))));
    expect(bytesOf((await exported()).get('logic/main.logic')).slice(0, 3)).toEqual(BOM);
  });
});

/** The titles of a .xdb's records, as the runtime reads them. */
function asRuntimeTitles(xdb: string): unknown[] {
  return parseXDBFile('xdb/books.xdb', xdb).records.map((record) => record.data.title);
}

describe('a permission.json that declares nothing', () => {
  it('is written back: the file the bundle came with is in what leaves', async () => {
    await open(studioBundle());
    const out = await exported();
    expect(out.has('permission.json')).toBe(true);
    expect(json(out.get('permission.json'))).toEqual({ permissions: {} });
  });

  it('is kept through a saved session, and is not made for a bundle that had no file', async () => {
    await open(studioBundle());
    commitProjectSnapshot(prepareSessionSnapshot(JSON.stringify(captureSession('design'))));
    expect((await exported()).has('permission.json')).toBe(true);

    await open(studioBundle({ permission: null }));
    expect((await exported()).has('permission.json')).toBe(false);
  });

  it('leaves as the file it came as, however it spells nothing', async () => {
    // "Empty" is a file in which nothing is enabled: no `permissions`, an
    // empty one, or entries that are each switched off. Each was written
    // as `{ "permissions": {} }`, which declares the same; it is not
    // rewritten now that the file is kept as it came.
    for (const written of ['{}', '{ "permissions": { "net": { "enabled": false } } }', '{ "permissions": {} }']) {
      await open(studioBundle({ permission: written }));
      expect(text((await exported()).get('permission.json')), written).toBe(written);
    }
  });

  it('stays the file it is when something is declared and then taken away again', async () => {
    await open(studioBundle());
    const project = useProjectStore.getState();
    project.setPermissions({ ...project.permissions, capabilities: ['net'] });
    expect(json((await exported()).get('permission.json'))).toEqual({ permissions: { net: { enabled: true } } });
    useProjectStore.getState().setPermissions({ ...useProjectStore.getState().permissions, capabilities: [] });
    expect(json((await exported()).get('permission.json'))).toEqual({ permissions: {} });
  });
});

describe('a permission.json with more in it than the Builder shows', () => {
  // As the demos and FormLogic's exports write them. `app.id` is what an
  // app's sync rooms are scoped by (core, sync-room-security.ts); the limits
  // are read by the runtime (`ai.allowedSources` keeps a model to the
  // sources named, `mic.maxSeconds` caps a recording). The Builder models the
  // capabilities, `net`'s hosts and `storage`'s policies, and wrote only
  // those: every demo that declared more lost it in an untouched export, and
  // a FormLogic app saved back from the Visual Builder lost its `app.id`.
  const WRITTEN = `{
  "app": { "id": "com.example.chat", "name": "Chat", "version": "1.0.0" },
  "permissions": {
    "ai": { "enabled": true, "maxModelSizeMB": 600, "allowedSources": ["bundle", "huggingface"] },
    "net": { "enabled": true, "allowed_hosts": ["huggingface.co"], "allow_http": false },
    "mic": { "enabled": true, "maxSeconds": 20 },
    "hologram": { "enabled": true }
  }
}
`;
  const permission = async () => json((await exported()).get('permission.json')) as { app?: unknown; permissions: Record<string, Record<string, unknown>> };

  it('leaves untouched as it came, byte for byte', async () => {
    await open(studioBundle({ permission: WRITTEN }));
    expect(text((await exported()).get('permission.json'))).toBe(WRITTEN);
  });

  it('keeps what the Builder does not show when what it does show is changed', async () => {
    await open(studioBundle({ permission: WRITTEN }));
    const project = useProjectStore.getState();
    project.setPermissions({ ...project.permissions, capabilities: ['net', 'mic', 'storage'], allowedHosts: ['huggingface.co', 'cdn.example.com'], storagePolicies: { books: 'private' } });
    const out = await permission();
    expect(out.app).toEqual({ id: 'com.example.chat', name: 'Chat', version: '1.0.0' });
    expect(out.permissions).toEqual({
      // Turned off in the Builder: gone, as the Builder writes a capability it does not ask for.
      net: { enabled: true, allowed_hosts: ['huggingface.co', 'cdn.example.com'], allow_http: false },
      mic: { enabled: true, maxSeconds: 20 },
      // A capability this Builder does not know is not its to take away.
      hologram: { enabled: true },
      storage: { enabled: true, collections: { books: 'private' } },
    });
  });

  it('keeps it through a saved session', async () => {
    await open(studioBundle({ permission: WRITTEN }));
    commitProjectSnapshot(prepareSessionSnapshot(JSON.stringify(captureSession('design'))));
    expect(text((await exported()).get('permission.json'))).toBe(WRITTEN);
    const project = useProjectStore.getState();
    project.setPermissions({ ...project.permissions, allowHttp: true });
    const out = await permission();
    expect(out.app).toEqual({ id: 'com.example.chat', name: 'Chat', version: '1.0.0' });
    expect(out.permissions.ai).toEqual({ enabled: true, maxModelSizeMB: 600, allowedSources: ['bundle', 'huggingface'] });
    expect(out.permissions.net).toEqual({ enabled: true, allowed_hosts: ['huggingface.co'], allow_http: true });
  });
});

describe('a manifest with no window settings', () => {
  it('leaves with none', async () => {
    await open(studioBundle());
    const config = json((await exported()).get('manifest.json')).config as Record<string, unknown>;
    expect('window' in config).toBe(false);
    expect(config).toEqual({ theme: { mode: 'dark' } });
  });

  it('leaves with no config at all where it came with none', async () => {
    const { config: _config, ...bare } = STUDIO_MANIFEST;
    await open(studioBundle({ manifest: bare }));
    expect('config' in json((await exported()).get('manifest.json'))).toBe(false);
  });

  it('keeps the window it came with, its title following the app\'s name as before', async () => {
    await open(studioBundle({ manifest: { ...STUDIO_MANIFEST, config: { window: { title: 'Reading List', width: 640, height: 480, resizable: false } } } }));
    useProjectStore.getState().setName('Books');
    expect((json((await exported()).get('manifest.json')).config as Record<string, unknown>).window).toEqual({ title: 'Books', width: 640, height: 480, resizable: false });
  });

  it('is still given one in a project made here, as the Builder\'s own projects always were', async () => {
    useProjectStore.getState().setName('Made here');
    expect((json((await exported()).get('manifest.json')).config as Record<string, unknown>).window).toEqual({ title: 'Made here', width: 1200, height: 800 });
  });
});

describe('the list of pages a manifest carries', () => {
  const pages = async () => json((await exported()).get('manifest.json')).pages;

  it('follows a page that is renamed or moved, and a folder of them that is', async () => {
    await open(studioBundle());
    useFilesStore.getState().renameFile(fileAt('ui/pages/books.ui').id, 'library.ui');
    expect(await pages()).toEqual([
      { id: 'home-page', name: 'Home', path: 'ui/pages/home.ui', route: '/' },
      { id: 'books-page', name: 'Books', path: 'ui/pages/library.ui', route: '/books' },
    ]);
    const folder = [...useFilesStore.getState().nodes.values()].find((node) => node.type === 'folder' && node.path === 'ui/pages')!;
    useFilesStore.getState().renameFolder(folder.id, 'screens');
    expect(((await pages()) as Array<{ path: string }>).map((page) => page.path)).toEqual(['ui/screens/home.ui', 'ui/screens/library.ui']);
  });

  it('loses a page that is deleted, and keeps the rest as they were', async () => {
    await open(studioBundle());
    // Nothing imports it any more, so it can go.
    useFilesStore.getState().updateUIFileSource(fileAt('ui/main.ui').id, '<App>\n  <Text>Only this</Text>\n</App>\n');
    useFilesStore.getState().deleteFile(fileAt('ui/pages/books.ui').id);
    expect(await pages()).toEqual([{ id: 'home-page', name: 'Home', path: 'ui/pages/home.ui', route: '/' }]);
  });

  it('is not added to for a new file: the list is the app\'s routes, and a file made here has none', async () => {
    await open(studioBundle());
    useFilesStore.getState().createFile('ui/pages', 'about.ui', 'ui');
    expect(await pages()).toEqual(STUDIO_MANIFEST.pages);
    expect((json((await exported()).get('manifest.json')).files as { ui: string[] }).ui).toContain('ui/pages/about.ui');
  });

  it('follows through a saved session, and is not made for a bundle that had none', async () => {
    await open(studioBundle());
    useFilesStore.getState().renameFile(fileAt('ui/pages/books.ui').id, 'library.ui');
    commitProjectSnapshot(prepareSessionSnapshot(JSON.stringify(captureSession('design'))));
    expect(((await pages()) as Array<{ path: string }>)[1].path).toBe('ui/pages/library.ui');

    const { pages: _pages, ...unlisted } = STUDIO_MANIFEST;
    await open(studioBundle({ manifest: unlisted }));
    useFilesStore.getState().renameFile(fileAt('ui/pages/books.ui').id, 'library.ui');
    expect('pages' in json((await exported()).get('manifest.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The principle, over the bundles the repository ships.
// ---------------------------------------------------------------------------

/** Every file under a directory, as the entries of an archive of it. */
function archiveOf(dir: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(dir, path).replace(/\\/g, '/')] = new Uint8Array(readFileSync(path));
    }
  };
  walk(dir);
  return zipSync(files);
}

const demos = join(repo, 'apps', 'softn-web', 'public', 'demos');
const shipped: Array<readonly [string, () => Uint8Array]> = [
  ['an app as Studio makes one', () => studioBundle()],
  ['packages/@softn/core/demo-bundle', () => archiveOf(join(repo, 'packages', '@softn', 'core', 'demo-bundle'))],
  ['apps/softn-site/public/examples/Fieldnotes.softn', () => new Uint8Array(readFileSync(join(repo, 'apps', 'softn-site', 'public', 'examples', 'Fieldnotes.softn')))],
  // The demos are built, not kept in the repository: held where a build has left them.
  ...(existsSync(demos) ? readdirSync(demos).filter((name) => name.endsWith('.softn')).sort() : []).map(
    (name) => [`apps/softn-web/public/demos/${name}`, () => new Uint8Array(readFileSync(join(demos, name)))] as const
  ),
];

/**
 * What an untouched export may still change in a manifest, each with its
 * reason. Anything not here is a difference nobody asked for.
 */
function deliberately(manifest: Record<string, unknown>, entries: ReadonlyMap<string, Uint8Array>): Record<string, unknown> {
  const expected = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  // 1. A path the manifest writes without its folder (`main.ui` for
  //    `ui/main.ui`, an older layout the loader still finds) is written as
  //    the path the file is at in the archive, so the next open does not
  //    lean on the fallback (utils/migrations.ts, manifest.json).
  const located = (path: unknown): unknown => {
    if (typeof path !== 'string' || entries.has(path)) return path;
    const found = [...entries.keys()].filter((entry) => entry.endsWith(`/${path}`));
    return found.length === 1 ? found[0] : path;
  };
  expected.main = located(expected.main);
  const files = expected.files as Record<string, unknown> | undefined;
  if (files) for (const group of ['ui', 'logic', 'xdb', 'assets']) if (Array.isArray(files[group])) files[group] = (files[group] as unknown[]).map(located);
  return expected;
}

describe('opened and exported with nothing touched', () => {
  it('the repository has bundles to hold to it', () => {
    expect(shipped.length).toBeGreaterThanOrEqual(3);
  });

  it.each(shipped)('%s leaves with the manifest it came with, key for key', async (_name, read) => {
    const input = readBundleEntries(read());
    await open(read());
    const output = await exported();
    const before = json(input.get('manifest.json'));
    const after = json(output.get('manifest.json'));
    expect(after).toEqual(deliberately(before, output));
    // Key for key, in the order they were written: nothing is moved either.
    expect(Object.keys(after)).toEqual(Object.keys(before));
    // And no file is added to the archive or left out of it.
    expect([...output.keys()].sort()).toEqual([...input.keys()].sort());
    // What the app declares it needs is the file it came with.
    expect(text(output.get('permission.json'))).toBe(text(input.get('permission.json')));
  });

  // Driven first over the demos: an untouched export rewrote the .xdb files
  // of four (each given a `schema` the file did not have, and its records
  // the Builder's spelling of their times and a `deleted: false`), and
  // took the byte-order mark off the front of a logic file. Each is read
  // the same by the runtime, and is still a change to a file nobody touched.
  it.each(shipped)('%s leaves with every file as it came, byte for byte', async (_name, read) => {
    const input = readBundleEntries(read());
    await open(read());
    const output = await exported();
    const changed: string[] = [];
    for (const [path, bytes] of input) {
      // A manifest path given without its folder is written where the file is (`deliberately`, above).
      if (path === 'manifest.json' && JSON.stringify(deliberately(json(bytes), output)) !== JSON.stringify(json(bytes))) continue;
      const out = output.get(path);
      if (!out || out.length !== bytes.length || out.some((byte, at) => byte !== bytes[at])) changed.push(path);
    }
    expect(changed).toEqual([]);
  });
});
