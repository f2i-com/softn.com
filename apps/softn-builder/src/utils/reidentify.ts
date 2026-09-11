/**
 * "Import as new": give every record of one collection a fresh identity,
 * and follow the references.
 *
 * Since BLD-05 a record read from a bundle keeps its id and timestamps
 * (utils/xdbFormat.ts): a no-edit round trip writes the same envelopes
 * back, and nothing re-identifies records by accident. That left the
 * deliberate case with no operation at all: taking a bundle's data as the
 * seed of a NEW app, where the old ids must not collide with an install
 * that already holds them. Re-identification is a migration — every row
 * of the collection gets a new id and new timestamps, and every field
 * elsewhere that pointed at an old id is rewritten to the new one — so it
 * is done here in one pass, explicitly, and never as a side effect.
 *
 * Scope: the live rows and the tombstones of the chosen collection are
 * re-identified (a tombstone keeps its `deleted` flag and its data).
 * References are followed in the live rows of every collection, the
 * chosen one included (self-references), through fields whose `refEntity`
 * names it; a string value is one id, an array of strings is a list of
 * them. Tombstones of OTHER collections are left verbatim, as the Builder
 * never edits them. Nothing is dropped.
 */

import type { EntityDef } from '../types/builder';
import { freshIdentity, newRecordId, type RecordIdentity, type XdbRecordEnvelope } from './xdbFormat';

/** The record state of the schema store, as one value: what re-identify reads and replaces. */
export interface RecordsSnapshot {
  seedData: Map<string, Record<string, unknown>[]>;
  recordIdentity: Map<string, RecordIdentity[]>;
  tombstones: Map<string, XdbRecordEnvelope[]>;
}

export interface ReidentifyOutcome {
  entityId: string;
  /** Live rows given a new identity. */
  records: number;
  /** Tombstoned records given a new identity. */
  tombstones: number;
  /** Per collection whose rows pointed at the old ids: how many rows were rewritten. */
  remapped: { entityId: string; entityName: string; rows: number }[];
}

export interface ReidentifyResult {
  next: RecordsSnapshot;
  outcome: ReidentifyOutcome;
}

/** The fields of `entity` that reference `targetId`, by name. */
export function referencingFields(entity: EntityDef, targetId: string): string[] {
  return entity.fields.filter((f) => f.refEntity === targetId).map((f) => f.name);
}

/** `value` with every old id it holds replaced; unchanged (same reference) when it holds none. */
function remapValue(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value === 'string') return idMap.get(value) ?? value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = typeof item === 'string' ? (idMap.get(item) ?? item) : item;
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  return value;
}

/** The row with its referencing fields rewritten, or the same row when nothing pointed at an old id. */
function remapRow(row: Record<string, unknown>, fields: string[], idMap: Map<string, string>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const name of fields) {
    if (!(name in row)) continue;
    const next = remapValue(row[name], idMap);
    if (next !== row[name]) {
      out ??= { ...row };
      out[name] = next;
    }
  }
  return out ?? row;
}

/**
 * Re-identify the records of `entityId`. Returns null when the schema has
 * no such entity. Pure: the snapshot passed in is not touched, and the
 * maps of collections that did not change are the same objects.
 */
export function reidentifyCollection(
  entityId: string,
  entities: EntityDef[],
  snapshot: RecordsSnapshot,
  now = new Date().toISOString()
): ReidentifyResult | null {
  const target = entities.find((e) => e.id === entityId);
  if (!target) return null;

  const rows = snapshot.seedData.get(entityId) ?? [];
  const known = snapshot.recordIdentity.get(entityId) ?? [];
  const oldTombstones = snapshot.tombstones.get(entityId) ?? [];

  // Old id → new id, for every record that had an id. A row without
  // identity (a session written before identity was kept) never had an id
  // anything could point at; it simply gets one now.
  const idMap = new Map<string, string>();
  for (const identity of known) idMap.set(identity.id, newRecordId());
  for (const tombstone of oldTombstones) idMap.set(tombstone.id, newRecordId());

  // Follow the references, in the live rows of every collection. A rewritten
  // row is an edit made now: its identity's baseline moves to the rewritten
  // data and its updated_at to `now`, so the export is settled here rather
  // than re-stamped with a new time on every later export (envelopeFor
  // compares a row with its baseline to decide whether it changed).
  const seedData = new Map(snapshot.seedData);
  const recordIdentity = new Map(snapshot.recordIdentity);
  const remapped: ReidentifyOutcome['remapped'] = [];
  for (const entity of entities) {
    const fields = referencingFields(entity, entityId);
    if (fields.length === 0) continue;
    const entityRows = snapshot.seedData.get(entity.id) ?? [];
    const entityIdentity = snapshot.recordIdentity.get(entity.id) ?? [];
    let changed = 0;
    const nextIdentity = [...entityIdentity];
    const nextRows = entityRows.map((row, i) => {
      const next = remapRow(row, fields, idMap);
      if (next === row) return row;
      changed += 1;
      if (nextIdentity[i]) nextIdentity[i] = { ...nextIdentity[i], data: next, updated_at: now };
      return next;
    });
    if (changed > 0) {
      seedData.set(entity.id, nextRows);
      if (entity.id !== entityId) recordIdentity.set(entity.id, nextIdentity);
      remapped.push({ entityId: entity.id, entityName: entity.name, rows: changed });
    }
  }

  // Fresh identity for the collection's own rows — with the remapped data
  // as the baseline, so a self-reference rewritten here is not read as an
  // edit at export.
  const ownRows = seedData.get(entityId) ?? rows;
  recordIdentity.set(
    entityId,
    ownRows.map((row, i) => {
      const identity = freshIdentity(row, now);
      const previous = known[i];
      if (previous) identity.id = idMap.get(previous.id) ?? identity.id;
      return identity;
    })
  );

  const tombstones = new Map(snapshot.tombstones);
  if (oldTombstones.length > 0) {
    const selfFields = referencingFields(target, entityId);
    tombstones.set(
      entityId,
      oldTombstones.map((tombstone) => ({
        ...tombstone,
        id: idMap.get(tombstone.id) ?? newRecordId(),
        data: remapRow(tombstone.data, selfFields, idMap),
        created_at: now,
        updated_at: now,
      }))
    );
  }

  return {
    next: { seedData, recordIdentity, tombstones },
    outcome: { entityId, records: ownRows.length, tombstones: oldTombstones.length, remapped },
  };
}

/** The confirmation text for the operation, before it runs. */
export function describeReidentify(entity: EntityDef, entities: EntityDef[], snapshot: RecordsSnapshot): string {
  const rows = snapshot.seedData.get(entity.id)?.length ?? 0;
  const tombstones = snapshot.tombstones.get(entity.id)?.length ?? 0;
  const referrers = entities
    .filter((e) => referencingFields(e, entity.id).length > 0)
    .map((e) => (e.id === entity.id ? `${e.name} (itself)` : e.name));
  const lines = [
    `Re-identify the records of "${entity.name}"?`,
    '',
    `Every record (${rows} row${rows === 1 ? '' : 's'}${tombstones > 0 ? `, ${tombstones} deleted` : ''}) gets a new id and new created/updated timestamps, as if imported into a new app.`,
    referrers.length > 0
      ? `References in ${referrers.join(', ')} are rewritten to the new ids.`
      : 'No other collection references it.',
    '',
    'Undo is offered right after, until the next data edit. The last saved recovery copy keeps the old ids as well.',
  ];
  return lines.join('\n');
}
