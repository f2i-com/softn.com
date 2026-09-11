/**
 * The runtime's own open path against the bundle it was given: PLT-01.
 *
 * packages/@softn/core/test/parity-run-paths.test.ts runs one fixture
 * through core's reader, Studio's preview assembly and Builder's preview
 * pipeline and holds them to the same permissions, records and first
 * screen. This is the fourth path — what apps/softn-web actually does when
 * a .softn arrives: bundleProcessor's `readZip`, `processBundle`,
 * `extractPermissions`, `loadXDBData` and `withheldPermissions`, over the
 * built @softn/core the app ships with — checked against what core reads
 * from the same bytes. The fixture is the same one, spelt out again here
 * because the two workspaces share no test helper and a test file must not
 * import another test file.
 *
 * Node environment: the runtime's static parts only. What renders is
 * covered in core's copy, where the engine is loaded for jsdom; the worker
 * path (`config.execution: 'worker'`) has no Worker to run in either.
 *
 * Which assertion catches which regression:
 *   - the source the runtime composes is the one core composes from the
 *     same archive, logic inlined and imports canonicalised;
 *   - the permission config the runtime extracts requests exactly what the
 *     file declares, and the withheld form of it requests nothing;
 *   - the records the runtime seeds into the app's own store are the
 *     file's, under the file's collection, and none go anywhere else.
 */
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { composeBundleSource, getXDB, inspectDeclaration, parseXDBFile, readBundle } from '@softn/core';
import { extractPermissions, loadXDBData, processBundle, readZip, requestedCapabilities, withheldPermissions, type BundleManifest } from '../src/lib/bundleProcessor';

const MANIFEST: BundleManifest = {
  name: 'Parity probe',
  version: '1.0.0',
  description: 'One bundle, every run path',
  main: 'ui/main.ui',
  files: {
    ui: ['ui/main.ui'],
    logic: ['logic/main.logic'],
    xdb: ['xdb/notes.xdb'],
    assets: ['assets/mark.png'],
  },
};

const MAIN_UI = `<logic src="../logic/main.logic" />

<data>
  <collection name="notes" as="notes" />
</data>

<App title="Parity probe">
  <Stack direction="vertical" gap="md">
    <Heading level={1}>Parity probe</Heading>
    <Text>{greeting}</Text>
    #each (note in notes)
      <Text>{note.data.title}</Text>
    #empty
      <Text>No notes</Text>
    #end
  </Stack>
</App>
`;

const MAIN_LOGIC = `let greeting = "Hello from logic"
`;

const NOTES_XDB = JSON.stringify(
  {
    collection: 'notes',
    schema: { alias: 'notes', fields: [{ id: 'field_title', name: 'title', type: 'string', required: true }] },
    records: [
      { id: 'n1', data: { title: 'First note' }, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
      { id: 'n2', data: { title: 'Second note' }, created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' },
    ],
  },
  null,
  2
);

const PERMISSION_JSON = JSON.stringify({ permissions: { storage: { enabled: true, collections: { notes: 'append-only' } } } }, null, 2);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

function bundleBytes(): Uint8Array {
  return zipSync(
    {
      'manifest.json': strToU8(JSON.stringify({ formatVersion: '1.0', ...MANIFEST }, null, 2)),
      'ui/main.ui': strToU8(MAIN_UI),
      'logic/main.logic': strToU8(MAIN_LOGIC),
      'xdb/notes.xdb': strToU8(NOTES_XDB),
      'permission.json': strToU8(PERMISSION_JSON),
      'assets/mark.png': PNG,
    },
    { level: 6 }
  );
}

/** A store per test, so a seed cannot be found by the next test. */
let appIds: string[] = [];
function freshAppId(): string {
  const id = `parity-web-${Date.now().toString(36)}-${appIds.length}`;
  appIds.push(id);
  return id;
}

afterEach(() => {
  for (const id of appIds) getXDB(id).clear('notes');
  appIds = [];
});

describe('the web runtime opens the bundle the way core reads it', () => {
  it('composes the same source, logic inlined, from the same bytes', async () => {
    const bytes = bundleBytes();
    const { textFiles, binaryFiles } = readZip(bytes);
    const runtime = processBundle(textFiles, MANIFEST);

    const bundle = await readBundle(bytes);
    const coreText = new Map<string, string>();
    for (const [path, file] of bundle.files) if (typeof file.content === 'string') coreText.set(path, file.content);
    const core = composeBundleSource(coreText, bundle.manifest.main, bundle.manifest.files.logic);

    expect(runtime.source).toBe(core.source);
    expect(runtime.preIncludedLogicPaths).toEqual(core.preIncludedLogicPaths);
    expect(runtime.source).toContain('let greeting = "Hello from logic"');
    expect(runtime.source).not.toMatch(/<logic\s+src=/);
    // Text and binary are told apart the same way: the asset is a binary
    // entry the runtime indexes, not text it decoded.
    expect([...textFiles.keys()].sort()).toEqual(['logic/main.logic', 'manifest.json', 'permission.json', 'ui/main.ui', 'xdb/notes.xdb']);
    expect([...binaryFiles.keys()]).toEqual(['assets/mark.png']);
    expect(binaryFiles.get('assets/mark.png')).toEqual(PNG);
    binaryFiles.release();
  });

  it('extracts exactly the declared permissions, and withholds all of them until consent', () => {
    const { textFiles } = readZip(bundleBytes());
    const config = extractPermissions(textFiles, MANIFEST);
    expect(config, 'a permission.json is read, not the manifest fallback').not.toBeNull();
    const declared = inspectDeclaration(JSON.parse(PERMISSION_JSON));
    const read = inspectDeclaration(config);
    expect(read.requested).toEqual(declared.requested);
    expect(read.requested).toEqual(['storage']);
    expect(read.storagePolicies).toEqual({ notes: 'append-only' });
    expect(read.unknown).toEqual([]);
    expect(read.malformed).toEqual([]);
    expect(requestedCapabilities(config!)).toEqual(['storage']);

    // While the consent bar is up the app runs with an empty declaration —
    // never a null one, which would read as "no permission.json".
    const withheld = withheldPermissions(config!);
    expect(withheld.permissions).toEqual({});
    expect(withheld.consentPending).toBe(true);
    expect(inspectDeclaration(withheld).requested).toEqual([]);
  });

  it('seeds the bundle records into the app’s own store, and only there', async () => {
    const { textFiles } = readZip(bundleBytes());
    const appId = freshAppId();
    const other = freshAppId();
    await loadXDBData(textFiles, MANIFEST, appId);

    const expected = parseXDBFile('xdb/notes.xdb', NOTES_XDB).records.map((r) => ({ id: r.id, data: r.data }));
    const seeded = getXDB(appId)
      .getAllRaw('notes')
      .map((r) => ({ id: r.id, data: r.data }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(seeded).toEqual(expected);
    expect(getXDB(other).getAllRaw('notes'), 'another app sees none of it').toEqual([]);

    // Seeding again is idempotent: the runtime reopening a bundle does not
    // duplicate what the author shipped.
    await loadXDBData(textFiles, MANIFEST, appId);
    expect(getXDB(appId).getAllRaw('notes')).toHaveLength(2);
  });
});
