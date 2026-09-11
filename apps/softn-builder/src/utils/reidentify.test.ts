/**
 * "Import as new" is a deliberate operation, and the only way records are
 * re-identified (BLD-05).
 *
 * Since BLD-05 a record read from a bundle keeps its id and timestamps
 * through every save, so a bundle's data can be reused as the seed of a
 * new app only by hand-editing the .xdb. The audit asks for an explicit
 * migration instead: fresh ids and timestamps for every record of a
 * collection, with the references that pointed at the old ids rewritten.
 * Pinned here at the store and export level: after re-identify the ids
 * differ, references in other collections (and in the collection itself)
 * still resolve, an untouched collection keeps its ids, tombstones are
 * carried, the operation is undone in one step, and a no-edit round trip
 * is unchanged by the operation existing.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useSchemaStore } from '../stores/schemaStore';
import { useProjectStore } from '../stores/projectStore';
import { gatherRecords } from './buildProjectBundle';
import { reidentifyCollection, describeReidentify } from './reidentify';
import { identityOf, type XdbRecordEnvelope } from './xdbFormat';
import type { EntityDef } from '../types/builder';

const NOW = '2026-09-11T10:00:00.000Z';
const THEN = '2024-01-01T00:00:00.000Z';

function envelope(collection: string, id: string, data: Record<string, unknown>, deleted = false): XdbRecordEnvelope {
  return { id, collection, data, created_at: THEN, updated_at: THEN, deleted };
}

const clients: EntityDef = {
  id: 'ent_clients',
  name: 'clients',
  alias: 'clients',
  fields: [
    { id: 'f1', name: 'name', type: 'string', required: true },
    { id: 'f2', name: 'referredBy', type: 'reference', required: false, refEntity: 'ent_clients' },
  ],
  position: { x: 0, y: 0 },
};

const appointments: EntityDef = {
  id: 'ent_appts',
  name: 'appointments',
  alias: 'appointments',
  fields: [
    { id: 'f3', name: 'client', type: 'reference', required: true, refEntity: 'ent_clients' },
    { id: 'f4', name: 'staff', type: 'reference', required: false, refEntity: 'ent_staff' },
    { id: 'f5', name: 'guests', type: 'reference', required: false, refEntity: 'ent_clients' },
  ],
  position: { x: 0, y: 0 },
};

const staff: EntityDef = {
  id: 'ent_staff',
  name: 'staff',
  alias: 'staff',
  fields: [{ id: 'f6', name: 'name', type: 'string', required: true }],
  position: { x: 0, y: 0 },
};

const CLIENT_RECORDS = [
  envelope('clients', 'c-1', { name: 'Ada', referredBy: '' }),
  envelope('clients', 'c-2', { name: 'Bob', referredBy: 'c-1' }),
];
const CLIENT_TOMBSTONE = envelope('clients', 'c-9', { name: 'Gone', referredBy: 'c-1' }, true);
const APPT_RECORDS = [
  envelope('appointments', 'a-1', { client: 'c-1', staff: 's-1', guests: ['c-2'] }),
  envelope('appointments', 'a-2', { client: 'c-2', staff: 's-1', guests: [] }),
  envelope('appointments', 'a-3', { client: 'nobody', staff: 's-1', guests: [] }),
];
const STAFF_RECORDS = [envelope('staff', 's-1', { name: 'Sam' })];

/** Load the three collections the way the bundle loader hands them to the store. */
function open(): void {
  const schema = useSchemaStore.getState();
  schema.reset();
  useProjectStore.getState().reset();
  schema.loadEntities([clients, appointments, staff]);
  schema.loadSeedData(
    new Map([
      ['ent_clients', CLIENT_RECORDS.map((r) => ({ ...r.data }))],
      ['ent_appts', APPT_RECORDS.map((r) => ({ ...r.data }))],
      ['ent_staff', STAFF_RECORDS.map((r) => ({ ...r.data }))],
    ])
  );
  schema.loadRecords(
    new Map([
      ['ent_clients', CLIENT_RECORDS.map(identityOf)],
      ['ent_appts', APPT_RECORDS.map(identityOf)],
      ['ent_staff', STAFF_RECORDS.map(identityOf)],
    ]),
    new Map([['ent_clients', [CLIENT_TOMBSTONE]]])
  );
  useProjectStore.getState().markCleanIf(useProjectStore.getState().projectId, useProjectStore.getState().revision);
}

function exported(): Map<string, XdbRecordEnvelope[]> {
  return gatherRecords(NOW);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(open);

describe('a no-edit export', () => {
  it('still keeps every id and timestamp; the operation existing changes nothing', () => {
    const out = exported();
    expect(out.get('clients')!.map((r) => r.id)).toEqual(['c-1', 'c-2', 'c-9']);
    expect(out.get('appointments')!.map((r) => r.id)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(out.get('clients')!.every((r) => r.created_at === THEN && r.updated_at === THEN)).toBe(true);
    expect(useProjectStore.getState().isDirty).toBe(false);
    expect(useSchemaStore.getState().lastReidentify).toBeNull();
  });
});

describe('re-identifying a collection', () => {
  it('gives every record a fresh id and fresh timestamps, tombstones included, and marks the project dirty', () => {
    const outcome = useSchemaStore.getState().reidentifyRecords('ent_clients', NOW)!;
    expect(outcome).toMatchObject({ entityId: 'ent_clients', records: 2, tombstones: 1 });

    const out = exported().get('clients')!;
    const ids = out.map((r) => r.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(id).toMatch(UUID);
      expect(['c-1', 'c-2', 'c-9']).not.toContain(id);
    }
    expect(out.every((r) => r.created_at === NOW && r.updated_at === NOW)).toBe(true);
    expect(out[2].deleted).toBe(true);
    expect(out[2].data.name).toBe('Gone');
    expect(useProjectStore.getState().isDirty).toBe(true);
  });

  it('rewrites every reference that pointed at an old id, so they still resolve', () => {
    const outcome = useSchemaStore.getState().reidentifyRecords('ent_clients', NOW)!;
    expect(outcome.remapped).toEqual([
      { entityId: 'ent_clients', entityName: 'clients', rows: 1 },
      { entityId: 'ent_appts', entityName: 'appointments', rows: 2 },
    ]);

    const out = exported();
    const [ada, bob] = out.get('clients')!;
    const [a1, a2, a3] = out.get('appointments')!;
    expect(a1.data.client).toBe(ada.id);
    expect(a1.data.guests).toEqual([bob.id]);
    expect(a2.data.client).toBe(bob.id);
    // The self-reference in clients follows too, and the tombstone's.
    expect(bob.data.referredBy).toBe(ada.id);
    expect(out.get('clients')![2].data.referredBy).toBe(ada.id);
    // A reference that never resolved is left as it was, not invented.
    expect(a3.data.client).toBe('nobody');
    // A reference to another collection is not touched.
    expect(a1.data.staff).toBe('s-1');
  });

  it('leaves an untouched collection with its ids and timestamps', () => {
    useSchemaStore.getState().reidentifyRecords('ent_clients', NOW);
    const out = exported();
    expect(out.get('staff')!.map((r) => r.id)).toEqual(['s-1']);
    expect(out.get('staff')![0].updated_at).toBe(THEN);
    // The appointments keep their own identity; only their data moved, so
    // only their updated_at does.
    expect(out.get('appointments')!.map((r) => r.id)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(out.get('appointments')![0].created_at).toBe(THEN);
    expect(out.get('appointments')![0].updated_at).toBe(NOW);
    expect(out.get('appointments')![2].updated_at).toBe(THEN);
  });

  it('is a fresh baseline: a second export of the re-identified rows agrees with the first', () => {
    useSchemaStore.getState().reidentifyRecords('ent_clients', NOW);
    const first = exported();
    const second = gatherRecords('2030-01-01T00:00:00.000Z');
    expect(second.get('clients')).toEqual(first.get('clients'));
    expect(second.get('appointments')).toEqual(first.get('appointments'));
  });

  it('returns null for an entity the schema does not have', () => {
    expect(useSchemaStore.getState().reidentifyRecords('ent_nope', NOW)).toBeNull();
    expect(exported().get('clients')!.map((r) => r.id)).toEqual(['c-1', 'c-2', 'c-9']);
  });
});

describe('undoing a re-identify', () => {
  it('restores the previous ids, timestamps and references in one step', () => {
    const before = exported();
    useSchemaStore.getState().reidentifyRecords('ent_clients', NOW);
    expect(useSchemaStore.getState().lastReidentify?.entityId).toBe('ent_clients');
    expect(useSchemaStore.getState().undoReidentify()).toBe(true);
    expect(exported()).toEqual(before);
    expect(useSchemaStore.getState().lastReidentify).toBeNull();
    expect(useSchemaStore.getState().undoReidentify()).toBe(false);
  });

  it('is closed by the next data edit, which would otherwise be lost with it', () => {
    useSchemaStore.getState().reidentifyRecords('ent_clients', NOW);
    useSchemaStore.getState().addSeedRecord('ent_staff');
    expect(useSchemaStore.getState().lastReidentify).toBeNull();
    expect(useSchemaStore.getState().undoReidentify()).toBe(false);
    expect(useSchemaStore.getState().seedData.get('ent_staff')).toHaveLength(2);
  });

  it('is closed by reopening records, which is not an edit either', () => {
    useSchemaStore.getState().reidentifyRecords('ent_clients', NOW);
    useSchemaStore.getState().loadRecords(new Map(), new Map());
    expect(useSchemaStore.getState().lastReidentify).toBeNull();
  });
});

describe('the pure operation', () => {
  it('does not touch the snapshot it was given, and shares the maps of untouched collections', () => {
    const state = useSchemaStore.getState();
    const snapshot = { seedData: state.seedData, recordIdentity: state.recordIdentity, tombstones: state.tombstones };
    const staffRows = snapshot.seedData.get('ent_staff');
    const result = reidentifyCollection('ent_clients', state.entities, snapshot, NOW)!;
    expect(snapshot.recordIdentity.get('ent_clients')!.map((i) => i.id)).toEqual(['c-1', 'c-2']);
    expect(snapshot.seedData.get('ent_appts')![0].client).toBe('c-1');
    expect(result.next.seedData.get('ent_staff')).toBe(staffRows);
    expect(result.next.recordIdentity.get('ent_staff')).toBe(snapshot.recordIdentity.get('ent_staff'));
  });

  it('identifies a row that had no identity yet rather than skipping it', () => {
    const state = useSchemaStore.getState();
    const seedData = new Map(state.seedData);
    seedData.set('ent_clients', [...seedData.get('ent_clients')!, { name: 'Cy', referredBy: '' }]);
    const result = reidentifyCollection('ent_clients', state.entities, { ...state, seedData }, NOW)!;
    const identity = result.next.recordIdentity.get('ent_clients')!;
    expect(identity).toHaveLength(3);
    expect(identity[2].id).toMatch(UUID);
    expect(identity[2].data).toEqual({ name: 'Cy', referredBy: '' });
  });

  it('describes what will happen, naming the referencing collections, before it is confirmed', () => {
    const state = useSchemaStore.getState();
    const text = describeReidentify(clients, state.entities, state);
    expect(text).toContain('"clients"');
    expect(text).toContain('2 rows, 1 deleted');
    expect(text).toContain('References in clients (itself), appointments are rewritten');
    expect(describeReidentify(staff, state.entities, state)).toContain('References in appointments are rewritten');
    expect(describeReidentify(staff, [staff, clients], state)).toContain('No other collection references it');
  });
});
