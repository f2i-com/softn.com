/**
 * One .xdb serializer for both export paths, and stable record identity.
 *
 * The multi-file exporter wrote `{ collection, records }` with no schema
 * while the single-file one wrote the schema too, and both minted `seed-N`
 * ids and fresh timestamps for every record on every export. A project
 * with a UI file and a logic file — every normal project — took the
 * multi-file path, so its schema came back as the columns of the first
 * row and its records were re-identified by every save.
 *
 * Pinned: the two exporters write the same .xdb for the same collection;
 * an empty collection keeps its fields; aliases and reference targets
 * survive export → import → export; the record envelope the runtime reads
 * comes back unchanged; flat records are read as the runtime reads them.
 */

import { describe, expect, it } from 'vitest';
import { parseXDBFile, readBundleEntries } from '@softn/core';
import { exportBundle, exportMultiFileBundle } from './bundleExporter';
import { loadBundle } from './bundleLoader';
import { envelopeFor, identityOf, parseXdb, serializeXdb, type XdbRecordEnvelope } from './xdbFormat';
import type { CollectionDef, UIFileState, LogicFileState } from '../types/builder';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const json = (bytes: Uint8Array) => JSON.parse(decode(bytes));

const PEOPLE: CollectionDef = {
  name: 'people',
  alias: 'folk',
  fields: [
    { id: 'f_name', name: 'name', type: 'string', required: true },
    { id: 'f_role', name: 'role', type: 'select', required: false, options: ['admin', 'member'] },
  ],
  seedData: [{ name: 'Ada', role: 'admin' }],
};

// Empty: fields and an alias, no rows (F04).
const TAGS: CollectionDef = {
  name: 'tags',
  alias: 'labels',
  fields: [
    { id: 'f_label', name: 'label', type: 'string', required: true },
    { id: 'f_owner', name: 'owner', type: 'reference', required: false, refEntity: 'people' },
  ],
  seedData: [],
};

const RECORDS = new Map<string, XdbRecordEnvelope[]>([
  [
    'people',
    [
      {
        id: '11111111-1111-4111-8111-111111111111',
        collection: 'people',
        data: { name: 'Ada', role: 'admin' },
        created_at: '2024-02-03T04:05:06.000Z',
        updated_at: '2024-02-03T04:05:06.000Z',
        deleted: false,
      },
    ],
  ],
  ['tags', []],
]);

function emptyUi(path: string): UIFileState {
  const rootId = 'root';
  return {
    id: path,
    path,
    rootId,
    elements: new Map([[rootId, { id: rootId, componentType: 'App', props: {}, children: [], parentId: null }]]),
    imports: [],
    originalSource: '<App></App>\n',
  };
}

const LOGIC: LogicFileState = { id: 'l', path: 'logic/main.logic', content: 'let a = 1\n', imports: [], exports: ['a'] };

const shared = {
  name: 'X',
  version: '1.0.0',
  description: '',
  themeMode: 'light' as const,
  collections: [PEOPLE, TAGS],
  records: RECORDS,
  assets: [],
};

describe('the two export paths', () => {
  it('write the same .xdb entries for the same collections', async () => {
    const single = readBundleEntries(
      await exportBundle({ ...shared, elements: emptyUi('ui/main.ui').elements, rootId: 'root', logicSource: '' })
    );
    const multi = readBundleEntries(
      await exportMultiFileBundle({
        ...shared,
        uiFiles: new Map([['u', emptyUi('ui/main.ui')]]),
        logicFiles: new Map([['l', LOGIC]]),
        main: 'ui/main.ui',
      })
    );
    for (const path of ['xdb/people.xdb', 'xdb/tags.xdb']) {
      expect(multi.has(path), path).toBe(true);
      expect(decode(multi.get(path)!)).toBe(decode(single.get(path)!));
    }
    const tags = json(multi.get('xdb/tags.xdb')!);
    expect(tags.schema).toEqual({ alias: 'labels', fields: TAGS.fields });
    expect(tags.records).toEqual([]);
    const people = json(multi.get('xdb/people.xdb')!);
    expect(people.schema.alias).toBe('folk');
    expect(people.schema.fields[1].options).toEqual(['admin', 'member']);
    expect(people.records).toEqual(RECORDS.get('people'));
  });
});

describe('export → import → export', () => {
  it('keeps aliases, field flags, relationship targets and an empty collection\'s fields', async () => {
    const first = await exportMultiFileBundle({
      ...shared,
      uiFiles: new Map([['u', emptyUi('ui/main.ui')]]),
      logicFiles: new Map([['l', LOGIC]]),
      main: 'ui/main.ui',
    });
    const loaded = await loadBundle(first);
    const tags = loaded.entities.find((e) => e.name === 'tags')!;
    const people = loaded.entities.find((e) => e.name === 'people')!;
    expect(tags.alias).toBe('labels');
    expect(tags.fields.map((f) => f.name)).toEqual(['label', 'owner']);
    // The reference is resolved to this session's entity id on import…
    expect(tags.fields[1].refEntity).toBe(people.id);
    expect(people.fields[0].required).toBe(true);
    expect(people.fields[1].options).toEqual(['admin', 'member']);

    // …and written back by name on export, as gatherCollections does.
    const nameById = new Map(loaded.entities.map((e) => [e.id, e.name]));
    const again = readBundleEntries(
      await exportMultiFileBundle({
        ...shared,
        collections: loaded.entities.map((e) => ({
          name: e.name,
          alias: e.alias,
          fields: e.fields.map((f) => (f.refEntity ? { ...f, refEntity: nameById.get(f.refEntity) } : f)),
          seedData: loaded.seedData.get(e.id) || [],
        })),
        records: new Map(
          loaded.entities.map((e) => [
            e.name,
            (loaded.seedData.get(e.id) || []).map((row, i) => envelopeFor(e.name, row, loaded.recordIdentity.get(e.id)![i])),
          ])
        ),
        uiFiles: loaded.uiFiles,
        logicFiles: loaded.logicFiles,
        main: 'ui/main.ui',
        source: { manifest: loaded.rawManifest, extraEntries: loaded.extraEntries, iconPath: null, xdbPaths: loaded.xdbPaths },
      })
    );
    const firstEntries = readBundleEntries(first);
    expect(json(again.get('xdb/tags.xdb')!)).toEqual(json(firstEntries.get('xdb/tags.xdb')!));
    expect(json(again.get('xdb/people.xdb')!)).toEqual(json(firstEntries.get('xdb/people.xdb')!));
  });
});

describe('the runtime reads what is written', () => {
  it('as the same records, ids and timestamps', () => {
    const text = serializeXdb({ name: 'people', schema: { alias: 'folk', fields: PEOPLE.fields }, records: RECORDS.get('people')! });
    const parsed = parseXDBFile('xdb/people.xdb', text);
    expect(parsed.collection).toBe('people');
    expect(parsed.records).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        data: { name: 'Ada', role: 'admin' },
        created_at: '2024-02-03T04:05:06.000Z',
        updated_at: '2024-02-03T04:05:06.000Z',
      },
    ]);
  });
});

describe('parseXdb', () => {
  it('reads flat records the way the runtime does, and keeps unknown envelope keys', () => {
    const parsed = parseXdb(
      JSON.stringify({
        collection: 'notes',
        records: [
          { id: 'n1', title: 'flat', createdAt: '2024-01-01T00:00:00.000Z' },
          { id: 'n2', data: { title: 'nested' }, created_at: '2024-01-02T00:00:00.000Z', updated_at: '2024-01-03T00:00:00.000Z', origin: 'import' },
          { id: 'n3', data: { title: 'gone' }, created_at: '2024-01-02T00:00:00.000Z', updated_at: '2024-01-02T00:00:00.000Z', deleted: true },
          { notAnId: true },
        ],
      }),
      'notes'
    );
    expect(parsed.records.map((r) => r.id)).toEqual(['n1', 'n2']);
    expect(parsed.records[0].data).toEqual({ title: 'flat' });
    expect(parsed.records[0].created_at).toBe('2024-01-01T00:00:00.000Z');
    expect(parsed.records[0].updated_at).toBe('2024-01-01T00:00:00.000Z');
    expect(parsed.records[1].origin).toBe('import');
    expect(parsed.tombstones.map((r) => r.id)).toEqual(['n3']);
    expect(parsed.skipped).toBe(1);
    expect(parsed.schema).toBeNull();

    // The unknown key travels with the identity and is written back.
    const identity = identityOf(parsed.records[1]);
    expect(identity.extra).toEqual({ origin: 'import' });
    const written = envelopeFor('notes', { title: 'nested' }, identity, '2030-01-01T00:00:00.000Z');
    expect(written.origin).toBe('import');
    expect(written.updated_at).toBe('2024-01-03T00:00:00.000Z');
    const edited = envelopeFor('notes', { title: 'changed' }, identity, '2030-01-01T00:00:00.000Z');
    expect(edited.id).toBe('n2');
    expect(edited.created_at).toBe('2024-01-02T00:00:00.000Z');
    expect(edited.updated_at).toBe('2030-01-01T00:00:00.000Z');
  });

  it('rejects text that is not a JSON object', () => {
    expect(() => parseXdb('[]', 'x')).toThrow();
    expect(() => parseXdb('nope', 'x')).toThrow();
  });
});
