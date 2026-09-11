/**
 * A no-edit round trip gives back the whole archive, not the parts the
 * Builder models.
 *
 * Opening a bundle and saving it without touching anything used to rebuild
 * the manifest from a handful of fields (choosing `main` by looking for a
 * filename containing "main.ui", resetting the window and dropping every
 * field it did not know), drop the `server/` files and anything else it
 * did not model, and rewrite every .xdb entry: the multi-file exporter wrote
 * no schema at all, and both exporters gave every record a fresh `seed-N`
 * id and a fresh timestamp, so references between records and the runtime's
 * own store of them were broken by a save that changed nothing.
 *
 * Pinned here on the audit's F06 fixture (non-default main, window and
 * runtime settings, unknown forward-compatible fields, a server logic file,
 * an .xdb with a schema and explicit record ids): the archive inventory and
 * the manifest of a no-edit export equal the input, and every difference
 * that is allowed is named in utils/migrations.ts with a reason. "The output
 * looks similar" is not the policy; the allowlist is.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseXDBFile, readBundleEntries } from '@softn/core';
import { loadBundle } from './bundleLoader';
import { buildProjectBundle } from './buildProjectBundle';
import { prepareProjectSnapshot, commitProjectSnapshot } from './openProject';
import { MIGRATIONS, isAllowedMigration } from './migrations';
import { useFilesStore } from '../stores/filesStore';
import { useCanvasStore } from '../stores/canvasStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';

const APP_UI = `<logic src="../logic/app.logic" />

<App theme="light" title="F06">
  <Stack direction="vertical" gap="md">
    <Heading level={1}>Explicit manifest</Heading>
  </Stack>
</App>
`;

// Named to trip the old heuristic: it contains "main.ui" but is not the entry.
const NOT_MAIN_UI = `<Stack><Text>Not the entry, despite the name</Text></Stack>
`;

const APP_LOGIC = `let greeting = 'hello'
`;

const SERVER_LOGIC = `// Runs on the server, never in Builder.
export function onRequest(req) { return { ok: true } }
`;

const TASKS_XDB = {
  collection: 'tasks',
  schema: {
    alias: 'tasks',
    fields: [
      { id: 'f_title', name: 'title', type: 'string', required: true },
      { id: 'f_status', name: 'status', type: 'select', required: false, options: ['open', 'done'] },
      { id: 'f_owner', name: 'owner', type: 'reference', required: false, refEntity: 'people' },
    ],
  },
  records: [
    {
      id: '0f3c0c4e-7f4a-4a2c-9a51-3a0f2e5b7d11',
      collection: 'tasks',
      data: { title: 'Write the fixture', status: 'open', owner: 'b6a7d9e2-1c3f-4d5e-8f90-1a2b3c4d5e6f' },
      created_at: '2024-01-02T03:04:05.000Z',
      updated_at: '2024-01-03T03:04:05.000Z',
      deleted: false,
    },
    {
      id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
      collection: 'tasks',
      data: { title: 'Gone', status: 'done', owner: '' },
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-05T00:00:00.000Z',
      deleted: true,
    },
  ],
};

const PEOPLE_XDB = {
  collection: 'people',
  schema: {
    alias: 'people',
    fields: [{ id: 'f_name', name: 'name', type: 'string', required: true }],
  },
  records: [
    {
      id: 'b6a7d9e2-1c3f-4d5e-8f90-1a2b3c4d5e6f',
      collection: 'people',
      data: { name: 'Ada' },
      created_at: '2023-12-31T23:59:59.000Z',
      updated_at: '2023-12-31T23:59:59.000Z',
      deleted: false,
    },
  ],
};

// An empty collection: fields but no rows (F04).
const TAGS_XDB = {
  collection: 'tags',
  schema: {
    alias: 'labels',
    fields: [
      { id: 'f_label', name: 'label', type: 'string', required: true },
      { id: 'f_colour', name: 'colour', type: 'select', required: false, options: ['red', 'blue'] },
    ],
  },
  records: [],
};

const MANIFEST = {
  formatVersion: '1.0',
  name: 'F06',
  version: '2.3.4',
  description: 'Explicit manifest fixture',
  main: 'ui/app.ui',
  icon: 'assets/icon.png',
  files: {
    ui: ['ui/app.ui', 'ui/not-main.ui'],
    logic: ['logic/app.logic'],
    server: ['server/api.logic'],
    xdb: ['xdb/tasks.xdb', 'xdb/people.xdb', 'xdb/tags.xdb'],
    assets: ['assets/icon.png', 'assets/notes.txt'],
  },
  config: {
    window: { title: 'A custom title', width: 640, height: 480, resizable: false },
    theme: { mode: 'light', accent: '#ff0000' },
    execution: 'worker',
    runtime: { minVersion: '0.9.0' },
  },
  publisher: { name: 'Fixture Co', url: 'https://example.invalid' },
  futureField: { nested: [1, 2, 3] },
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

const PERMISSION = JSON.stringify({ permissions: { storage: { enabled: true } } }, null, 2);

function entries(): Record<string, Uint8Array> {
  return {
    'manifest.json': strToU8(JSON.stringify(MANIFEST, null, 2)),
    'permission.json': strToU8(PERMISSION),
    'ui/app.ui': strToU8(APP_UI),
    'ui/not-main.ui': strToU8(NOT_MAIN_UI),
    'logic/app.logic': strToU8(APP_LOGIC),
    'server/api.logic': strToU8(SERVER_LOGIC),
    'xdb/tasks.xdb': strToU8(JSON.stringify(TASKS_XDB, null, 2)),
    'xdb/people.xdb': strToU8(JSON.stringify(PEOPLE_XDB, null, 2)),
    'xdb/tags.xdb': strToU8(JSON.stringify(TAGS_XDB, null, 2)),
    'assets/icon.png': PNG,
    'assets/notes.txt': strToU8('plain notes\n'),
    'README.md': strToU8('# Not a group the Builder knows\n'),
  };
}

function fixture(): Uint8Array {
  return zipSync(entries(), { level: 6 });
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const json = (bytes: Uint8Array) => JSON.parse(decode(bytes));

async function open(bytes: Uint8Array): Promise<void> {
  const bundle = await loadBundle(bytes);
  commitProjectSnapshot(prepareProjectSnapshot(bundle));
}

async function exported(): Promise<Map<string, Uint8Array>> {
  return readBundleEntries(await buildProjectBundle());
}

/**
 * The archive-inventory comparison the test plan asks for: every path of the
 * input is in the output and vice versa, and every entry is byte-identical
 * unless the allowlist names the entry and the difference is the one it
 * describes (checked semantically below).
 */
function compareInventories(input: Record<string, Uint8Array>, output: Map<string, Uint8Array>): string[] {
  const differences: string[] = [];
  for (const path of Object.keys(input)) {
    if (!output.has(path)) differences.push(`missing from export: ${path}`);
  }
  for (const path of output.keys()) {
    if (!(path in input)) differences.push(`added by export: ${path}`);
  }
  for (const path of Object.keys(input)) {
    const out = output.get(path);
    if (!out) continue;
    const same = out.length === input[path].length && out.every((b, i) => b === input[path][i]);
    if (!same && !isAllowedMigration(path)) differences.push(`bytes changed without an allowed migration: ${path}`);
  }
  return differences;
}

beforeEach(async () => {
  useCanvasStore.getState().reset();
  useProjectStore.getState().reset();
  useSchemaStore.getState().reset();
  useFilesStore.getState().reset();
  await open(fixture());
});

describe('the allowlist of deliberate migrations', () => {
  it('names every migration with a reason, and nothing else is allowed to change', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    for (const m of MIGRATIONS) {
      expect(m.reason.length, `${m.entry} has no reason`).toBeGreaterThan(20);
    }
    expect(isAllowedMigration('ui/app.ui')).toBe(false);
    expect(isAllowedMigration('server/api.logic')).toBe(false);
    expect(isAllowedMigration('assets/icon.png')).toBe(false);
    expect(isAllowedMigration('README.md')).toBe(false);
  });
});

describe('a no-edit round trip of the F06 fixture', () => {
  it('gives back the same archive inventory, byte for byte outside the allowlist', async () => {
    const out = await exported();
    expect(compareInventories(entries(), out)).toEqual([]);
  });

  it('keeps the manifest: declared main, window and runtime settings, unknown fields, the server group', async () => {
    const out = await exported();
    const manifest = json(out.get('manifest.json')!);
    // Not `ui/not-main.ui`, though that name contains "main.ui".
    expect(manifest.main).toBe('ui/app.ui');
    expect(manifest.files.ui).toEqual(['ui/app.ui', 'ui/not-main.ui']);
    expect(manifest.files.server).toEqual(['server/api.logic']);
    expect(manifest.config.window).toEqual(MANIFEST.config.window);
    expect(manifest.config.execution).toBe('worker');
    expect(manifest.config.runtime).toEqual({ minVersion: '0.9.0' });
    expect(manifest.config.theme).toEqual({ mode: 'light', accent: '#ff0000' });
    expect(manifest.publisher).toEqual(MANIFEST.publisher);
    expect(manifest.futureField).toEqual(MANIFEST.futureField);
    // The whole manifest, in fact.
    expect(manifest).toEqual(MANIFEST);
  });

  it('carries the server file through untouched and does not run or grant anything from it', async () => {
    const out = await exported();
    expect(decode(out.get('server/api.logic')!)).toBe(SERVER_LOGIC);
    // The declaration is what the project declared, not what a server file might ask for.
    expect(json(out.get('permission.json')!)).toEqual(JSON.parse(PERMISSION));
    // Nothing of the server file reached the Builder's own models.
    expect([...useFilesStore.getState().logicFiles.values()].some((f) => f.path.startsWith('server/'))).toBe(false);
  });

  it('keeps every .xdb entry: schema, aliases, field flags, references, record ids and timestamps, tombstones', async () => {
    const out = await exported();
    expect(json(out.get('xdb/tasks.xdb')!)).toEqual(TASKS_XDB);
    expect(json(out.get('xdb/people.xdb')!)).toEqual(PEOPLE_XDB);
    expect(json(out.get('xdb/tags.xdb')!)).toEqual(TAGS_XDB);
  });

  it('writes .xdb entries the runtime reads back as the same records', async () => {
    const out = await exported();
    const parsed = parseXDBFile('xdb/tasks.xdb', decode(out.get('xdb/tasks.xdb')!));
    expect(parsed.collection).toBe('tasks');
    expect(parsed.records.map((r) => r.id)).toEqual(TASKS_XDB.records.map((r) => r.id));
    expect(parsed.records[0].created_at).toBe('2024-01-02T03:04:05.000Z');
    expect(parsed.records[0].updated_at).toBe('2024-01-03T03:04:05.000Z');
  });

  it('is stable across a second open of its own export', async () => {
    const first = await exported();
    await open(zipSync(Object.fromEntries(first), { level: 6 }));
    const second = await exported();
    expect(compareInventories(Object.fromEntries(first), second)).toEqual([]);
    expect(json(second.get('manifest.json')!)).toEqual(MANIFEST);
    expect(json(second.get('xdb/tasks.xdb')!)).toEqual(TASKS_XDB);
  });

  it('leaves the project clean', () => {
    expect(useProjectStore.getState().isDirty).toBe(false);
  });
});

describe('record identity (F05)', () => {
  it('resolves references between records after reopening', () => {
    const schema = useSchemaStore.getState();
    const tasks = schema.entities.find((e) => e.name === 'tasks')!;
    const people = schema.entities.find((e) => e.name === 'people')!;
    const owner = tasks.fields.find((f) => f.name === 'owner')!;
    expect(owner.refEntity).toBe(people.id);
    const taskRows = schema.seedData.get(tasks.id)!;
    const peopleIds = schema.recordIdentity.get(people.id)!.map((r) => r.id);
    expect(peopleIds).toContain(taskRows[0].owner);
  });

  it('changing one record re-identifies neither it nor its siblings', async () => {
    const schema = useSchemaStore.getState();
    const tasks = schema.entities.find((e) => e.name === 'tasks')!;
    // Two live rows to have a sibling: add one, then edit the original.
    schema.addSeedRecord(tasks.id);
    const before = (await exported()).get('xdb/tasks.xdb')!;
    const beforeRecords = json(before).records as Array<{ id: string; created_at: string; updated_at: string; data: Record<string, unknown> }>;
    expect(beforeRecords).toHaveLength(3);
    const newId = beforeRecords[1].id;
    expect(newId).toMatch(/^[0-9a-f-]{36}$/);

    useSchemaStore.getState().updateSeedRecord(tasks.id, 0, { ...TASKS_XDB.records[0].data, title: 'Edited' });
    const afterRecords = json((await exported()).get('xdb/tasks.xdb')!).records as typeof beforeRecords;
    expect(afterRecords[0].id).toBe(TASKS_XDB.records[0].id);
    expect(afterRecords[0].created_at).toBe(TASKS_XDB.records[0].created_at);
    expect(afterRecords[0].updated_at).not.toBe(TASKS_XDB.records[0].updated_at);
    expect(afterRecords[0].data.title).toBe('Edited');
    // The sibling added a moment ago keeps the id it was given.
    expect(afterRecords[1].id).toBe(newId);
    // The tombstone is preserved as it was.
    expect(afterRecords[2]).toEqual(TASKS_XDB.records[1]);
  });

  it('a row deleted in the Data view is gone from the export rather than resurrected', async () => {
    const schema = useSchemaStore.getState();
    const people = schema.entities.find((e) => e.name === 'people')!;
    schema.deleteSeedRecord(people.id, 0);
    const out = json((await exported()).get('xdb/people.xdb')!);
    expect(out.records).toEqual([]);
    expect(useProjectStore.getState().isDirty).toBe(true);
  });
});

describe('an empty collection (F04)', () => {
  it('keeps its fields, alias and options after export and reopen', async () => {
    const out = await exported();
    await open(zipSync(Object.fromEntries(out), { level: 6 }));
    const tags = useSchemaStore.getState().entities.find((e) => e.name === 'tags')!;
    expect(tags.alias).toBe('labels');
    expect(tags.fields).toEqual(TAGS_XDB.schema.fields);
  });
});

describe('a legacy bundle whose manifest paths lack their folder', () => {
  it('opens, and its export names the files where the archive has them', async () => {
    const legacy = zipSync(
      {
        'manifest.json': strToU8(
          JSON.stringify({
            name: 'Legacy',
            version: '0.1.0',
            main: 'main.ui',
            files: { ui: ['main.ui'], logic: [], xdb: [], assets: [] },
          })
        ),
        'ui/main.ui': strToU8('<App><Text>legacy</Text></App>\n'),
      },
      { level: 6 }
    );
    await open(legacy);
    const out = await exported();
    const manifest = json(out.get('manifest.json')!);
    expect(manifest.main).toBe('ui/main.ui');
    expect(manifest.files.ui).toEqual(['ui/main.ui']);
    expect(out.has('ui/main.ui')).toBe(true);
    // A manifest that never had a formatVersion is not given one.
    expect(manifest.formatVersion).toBeUndefined();
  });
});

describe('dangling references', () => {
  it('refuse to open with an actionable error rather than a guessed replacement', async () => {
    const broken = zipSync(
      {
        'manifest.json': strToU8(JSON.stringify({ ...MANIFEST, files: { ...MANIFEST.files, server: ['server/missing.logic'] } })),
        ...Object.fromEntries(Object.entries(entries()).filter(([k]) => k !== 'manifest.json')),
      },
      { level: 6 }
    );
    await expect(loadBundle(broken)).rejects.toThrow(/server\/missing\.logic/);
  });

  it('refuse a main that is not in the archive', async () => {
    const broken = zipSync(
      {
        ...Object.fromEntries(Object.entries(entries()).filter(([k]) => k !== 'manifest.json')),
        'manifest.json': strToU8(JSON.stringify({ ...MANIFEST, main: 'ui/nowhere.ui' })),
      },
      { level: 6 }
    );
    await expect(loadBundle(broken)).rejects.toThrow(/ui\/nowhere\.ui/);
  });
});
