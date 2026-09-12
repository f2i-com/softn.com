/**
 * Schema Store - Manages database schema (entities, fields, relationships)
 */

import { create } from 'zustand';
import type { EntityDef, SchemaField, RelationshipDef, RelationshipDraft } from '../types/builder';
import { inferRelationships, prepareRelationship, validRelationships } from '../utils/schemaRelationships';
import { useProjectStore } from './projectStore';
import { ensureFieldIds } from '../utils/schemaFields';
import { freshIdentity, type RecordIdentity, type XdbRecordEnvelope } from '../utils/xdbFormat';
import { reidentifyCollection, type RecordsSnapshot, type ReidentifyOutcome } from '../utils/reidentify';

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

interface SchemaStore {
  entities: EntityDef[];
  relationships: RelationshipDef[];
  selectedEntityId: string | null;

  // Entity actions
  addEntity: (position: { x: number; y: number }) => string;
  updateEntity: (id: string, updates: Partial<Omit<EntityDef, 'id'>>) => string | null;
  deleteEntity: (id: string) => void;
  selectEntity: (id: string | null) => void;

  // Field actions
  addField: (entityId: string) => void;
  updateField: (entityId: string, fieldId: string, updates: Partial<SchemaField>) => string | null;
  deleteField: (entityId: string, fieldId: string) => void;

  // Relationship actions
  addRelationship: (relationship: RelationshipDraft) => string | null;
  updateRelationship: (id: string, relationship: RelationshipDraft) => string | null;
  deleteRelationship: (id: string) => void;

  // Seed data
  seedData: Map<string, Record<string, unknown>[]>;
  /**
   * The identity of each live seed row, by entity id, one entry per row in
   * the same order as `seedData`. The rows are what the Data view edits; this
   * is what the export writes them back under, so a record read from a bundle
   * keeps its id and timestamps — see utils/xdbFormat.ts. The two are kept
   * aligned by every action below; a row without an entry (a session written
   * before identity was kept) is minted at export.
   */
  recordIdentity: Map<string, RecordIdentity[]>;
  /** Records read with `deleted: true`, by entity id, kept verbatim and written back after the live rows. */
  tombstones: Map<string, XdbRecordEnvelope[]>;
  setSeedData: (entityId: string, data: Record<string, unknown>[]) => void;
  addSeedRecord: (entityId: string) => void;
  updateSeedRecord: (entityId: string, index: number, data: Record<string, unknown>) => void;
  deleteSeedRecord: (entityId: string, index: number) => void;

  // Bulk load (for opening bundles)
  loadEntities: (entities: EntityDef[]) => void;
  loadSeedData: (data: Map<string, Record<string, unknown>[]>) => void;
  /** The identities and tombstones read with the seed rows; not an edit. */
  loadRecords: (identity: Map<string, RecordIdentity[]>, tombstones: Map<string, XdbRecordEnvelope[]>) => void;

  /**
   * "Import as new" for one collection: every record gets a fresh id and
   * fresh timestamps, and every reference to an old id in any collection's
   * live rows is rewritten (utils/reidentify.ts). A deliberate migration,
   * never a side effect of a save; the caller confirms it first. Returns
   * what was done, or null for an unknown entity.
   */
  reidentifyRecords: (entityId: string, now?: string) => ReidentifyOutcome | null;
  /**
   * The record state as it stood before the last re-identify, kept until
   * the next data edit so the operation can be taken back in one step.
   * The saved recovery record (utils/openProject.ts, captureSession) is
   * the coarser way back once this is gone.
   */
  lastReidentify: { entityId: string; before: RecordsSnapshot } | null;
  /** Restore the record state from before the last re-identify. False when there is none to restore. */
  undoReidentify: () => boolean;

  // Reset
  reset: () => void;
}

const defaultField = (name: string = 'newField'): SchemaField => ({
  id: generateId(),
  name,
  type: 'string',
  required: false,
});

/** `newField`, or `newField2`, `newField3`… so a new field never shares a name. */
function uniqueFieldName(fields: SchemaField[], base = 'newField'): string {
  const taken = new Set(fields.map((f) => f.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

export const useSchemaStore = create<SchemaStore>((set, get) => {
  /**
   * A schema edit is a change to the project.
   *
   * Not one action here told projectStore anything, so markDirty had no callers
   * at all and isDirty never became true for schema work. The unsaved-changes
   * guards on New and Open read that flag, so twenty minutes of entities, fields
   * and seed rows could be discarded without the prompt ever appearing, and the
   * title bar never showed the asterisk that would have warned anyone.
   *
   * Wrapping the setter rather than calling markDirty in twelve places means the
   * thirteenth action cannot forget.
   */
  const edit: typeof set = (...args) => {
    set(...(args as Parameters<typeof set>));
    // Any later data edit builds on the re-identified rows; restoring the
    // state from before would take that edit with it, so the way back is
    // closed here rather than left to surprise.
    if (get().lastReidentify) set({ lastReidentify: null });
    useProjectStore.getState().markDirty();
  };

  return {
  entities: [],
  relationships: [],
  selectedEntityId: null,
  lastReidentify: null,
  seedData: new Map(),
  recordIdentity: new Map(),
  tombstones: new Map(),

  addEntity: (position) => {
    const id = generateId();
    // Not `entities.length + 1`. Delete Entity1 of two and the count says 1, so
    // the next entity is called Entity2 as well — two collections with one name,
    // which the exporter then writes to one xdb file, silently discarding one of
    // them. Take the next number nothing is using instead.
    const taken = new Set(get().entities.map((e) => e.name));
    let n = get().entities.length + 1;
    while (taken.has(`Entity${n}`)) n += 1;

    const entity: EntityDef = {
      id,
      name: `Entity${n}`,
      alias: `entity${n}`,
      fields: [{ id: generateId(), name: 'id', type: 'string', required: true }],
      position,
    };

    edit((state) => ({
      entities: [...state.entities, entity],
      selectedEntityId: id,
    }));

    return id;
  },

  updateEntity: (id, updates) => {
    const entity = get().entities.find(e => e.id === id);
    if (!entity) return 'This collection is no longer available.';
    if (updates.name !== undefined) {
      const name = updates.name.trim();
      if (!name) return 'Enter a collection name.';
      if (name !== entity.name && get().entities.some(e => e.id !== id && e.name === name)) {
        return `A collection named "${name}" already exists.`;
      }
      updates = { ...updates, name };
    }
    if (updates.alias !== undefined) {
      const alias = updates.alias.trim();
      if (!alias) return 'Enter an alias.';
      if (alias !== entity.alias && get().entities.some(e => e.id !== id && e.alias === alias)) {
        return `The alias "${alias}" is already in use.`;
      }
      updates = { ...updates, alias };
    }
    if (Object.entries(updates).every(([key, value]) => entity[key as keyof EntityDef] === value)) return null;
    edit((state) => {
      const entities = state.entities.map((e) => (e.id === id ? { ...e, ...updates } : e));
      return { entities, relationships: validRelationships(entities, state.relationships) };
    });
    return null;
  },

  deleteEntity: (id) => {
    if (!get().entities.some(entity => entity.id === id)) return;
    edit((state) => {
      // Its seed rows went with it, and any field elsewhere pointing at it was
      // left pointing at nothing — a reference to a collection that no longer
      // exists, which the picker then renders as an empty dropdown with no
      // explanation. Both are cleaned up here.
      const seedData = new Map(state.seedData);
      seedData.delete(id);
      const recordIdentity = new Map(state.recordIdentity);
      recordIdentity.delete(id);
      const tombstones = new Map(state.tombstones);
      tombstones.delete(id);

      return {
        entities: state.entities
          .filter((e) => e.id !== id)
          .map((e) =>
            e.fields.some((f) => f.refEntity === id)
              ? {
                  ...e,
                  fields: e.fields.map((f) =>
                    f.refEntity === id ? { ...f, refEntity: undefined } : f
                  ),
                }
              : e
          ),
        relationships: state.relationships.filter(
          (r) => r.sourceEntityId !== id && r.targetEntityId !== id
        ),
        seedData,
        recordIdentity,
        tombstones,
        selectedEntityId: state.selectedEntityId === id ? null : state.selectedEntityId,
      };
    });
  },

  selectEntity: (id) => {
    set({ selectedEntityId: id });
  },

  addField: (entityId) => {
    if (!get().entities.some(entity => entity.id === entityId)) return;
    edit((state) => ({
      entities: state.entities.map((e) =>
        // Seed rows are keyed by field NAME, so two fields called newField are
        // one column with two headers: typing in either wrote to the same cell
        // and the second field could never hold a value of its own.
        e.id === entityId ? { ...e, fields: [...e.fields, defaultField(uniqueFieldName(e.fields))] } : e
      ),
    }));
  },

  updateField: (entityId, fieldId, updates) => {
    const current = get();
    const entity = current.entities.find(e => e.id === entityId);
    const field = entity?.fields.find(f => f.id === fieldId);
    if (!entity || !field) return 'This field is no longer available.';
    if (updates.name !== undefined) {
      const name = updates.name.trim();
      if (!name) return 'Enter a field name.';
      if (name !== field.name) {
        if (entity.fields.some(f => f.id !== fieldId && f.name === name)) {
          return `A field named "${name}" already exists.`;
        }
        if (current.seedData.get(entityId)?.some(row => Object.prototype.hasOwnProperty.call(row, name))) {
          return `Records already contain "${name}". Choose another name to keep those values.`;
        }
      }
      updates = { ...updates, name };
    }
    if (updates.type !== undefined && updates.type !== 'reference') updates = { ...updates, refEntity: undefined };
    if (updates.refEntity && !current.entities.some(item => item.id === updates.refEntity)) {
      return 'Choose an available reference collection.';
    }
    if (Object.entries(updates).every(([key, value]) => field[key as keyof SchemaField] === value)) return null;
    edit((state) => {
      const entity = state.entities.find((e) => e.id === entityId);
      const previousName = entity?.fields.find((f) => f.id === fieldId)?.name;
      const entities = state.entities.map((e) =>
        e.id === entityId
          ? { ...e, fields: e.fields.map((f) => (f.id === fieldId ? { ...f, ...updates } : f)) }
          : e
      );
      let relationships = validRelationships(entities, state.relationships);
      const nextField = entities.find(item => item.id === entityId)?.fields.find(item => item.id === fieldId);
      // Reference settings in the field editor should be visible immediately.
      // An unrelated rename must not resurrect an edge the user removed.
      if (nextField && (nextField.type !== field.type || nextField.refEntity !== field.refEntity)
        && !relationships.some(item => item.sourceEntityId === entityId && item.sourceFieldId === fieldId)) {
        const inferred = inferRelationships(entities).find(item => item.sourceEntityId === entityId && item.sourceFieldId === fieldId);
        if (inferred) relationships = [...relationships, { ...inferred, id: generateId() }];
      }

      // Carry the seed values over when a field is renamed. Rows are keyed by
      // the field's NAME, so a rename used to leave every value behind on the
      // dead key: the column blanked out on screen while the values were still
      // written into the saved bundle under the old name, where nothing would
      // ever read them again. It looked like deletion, and was worse — the data
      // was still there and unreachable.
      const nextName = updates.name;
      if (previousName === undefined || typeof nextName !== 'string' || nextName === previousName) {
        return { entities, relationships };
      }

      const rows = state.seedData.get(entityId);
      if (!rows) return { entities, relationships };

      const seedData = new Map(state.seedData);
      seedData.set(
        entityId,
        rows.map((record) => {
          if (!(previousName in record)) return record;
          const { [previousName]: carried, ...rest } = record;
          return { ...rest, [nextName]: carried };
        })
      );
      return { entities, relationships, seedData };
    });
    return null;
  },

  deleteField: (entityId, fieldId) => {
    if (!get().entities.find(entity => entity.id === entityId)?.fields.some(field => field.id === fieldId)) return;
    edit((state) => ({
      entities: state.entities.map((e) =>
        e.id === entityId ? { ...e, fields: e.fields.filter((f) => f.id !== fieldId) } : e
      ),
      // Also remove any relationships using this field
      relationships: state.relationships.filter(
        (r) => !(r.sourceEntityId === entityId && r.sourceFieldId === fieldId)
      ),
    }));
  },

  addRelationship: (relationship) => {
    const state = get();
    const prepared = prepareRelationship(state.entities, state.relationships, relationship, generateId(), generateId, state.seedData);
    if ('error' in prepared) return prepared.error;
    edit({ entities: prepared.entities, relationships: [...state.relationships, prepared.relationship] });
    return null;
  },

  updateRelationship: (id, relationship) => {
    const state = get();
    const existing = state.relationships.find(item => item.id === id);
    if (!existing) return 'This relationship is no longer available.';
    const prepared = prepareRelationship(state.entities, state.relationships, relationship, id, generateId, state.seedData);
    if ('error' in prepared) return prepared.error;
    if (prepared.entities === state.entities && Object.entries(prepared.relationship).every(([key, value]) => existing[key as keyof RelationshipDef] === value)) return null;
    edit({ entities: prepared.entities, relationships: state.relationships.map(item => item.id === id ? prepared.relationship : item) });
    return null;
  },

  deleteRelationship: (id) => {
    if (!get().relationships.some(relationship => relationship.id === id)) return;
    edit((state) => ({
      relationships: state.relationships.filter((r) => r.id !== id),
    }));
  },

  setSeedData: (entityId, data) => {
    edit((state) => {
      const newSeedData = new Map(state.seedData);
      newSeedData.set(entityId, data);
      // Rows keep the identity at their index; rows beyond the known ones
      // are new and are identified now, so two exports of them agree.
      const known = state.recordIdentity.get(entityId) || [];
      const identity = data.map((row, i) => known[i] ?? freshIdentity(row));
      const recordIdentity = new Map(state.recordIdentity);
      recordIdentity.set(entityId, identity);
      return { seedData: newSeedData, recordIdentity };
    });
  },

  addSeedRecord: (entityId) => {
    const entity = get().entities.find((e) => e.id === entityId);
    if (!entity) return;

    // Create empty record with default values
    const record: Record<string, unknown> = {};
    for (const field of entity.fields) {
      if (field.defaultValue !== undefined) {
        record[field.name] = field.defaultValue;
      } else {
        switch (field.type) {
          case 'string':
          case 'email':
          case 'url':
            record[field.name] = '';
            break;
          case 'number':
            record[field.name] = 0;
            break;
          case 'boolean':
            record[field.name] = false;
            break;
          case 'date':
            record[field.name] = new Date().toISOString().split('T')[0];
            break;
          case 'select':
            record[field.name] = field.options?.[0] || '';
            break;
          case 'reference':
            record[field.name] = '';
            break;
        }
      }
    }

    edit((state) => {
      const newSeedData = new Map(state.seedData);
      const existing = newSeedData.get(entityId) || [];
      newSeedData.set(entityId, [...existing, record]);
      // Identified when made, not at export: a new row gets one id and keeps
      // it through every export and save from here on.
      const recordIdentity = new Map(state.recordIdentity);
      const identity = [...(recordIdentity.get(entityId) || [])];
      while (identity.length < existing.length) identity.push(freshIdentity(existing[identity.length]));
      identity.push(freshIdentity(record));
      recordIdentity.set(entityId, identity);
      return { seedData: newSeedData, recordIdentity };
    });
  },

  // `edit`, not `set`: a row edited or deleted in the Data view is a change
  // to the project. These two were the exceptions to the rule above, so a
  // save that overlapped a row edit marked the project clean with the edit
  // unsaved, and New/Open never asked about it.
  updateSeedRecord: (entityId, index, data) => {
    edit((state) => {
      const newSeedData = new Map(state.seedData);
      const records = [...(newSeedData.get(entityId) || [])];
      records[index] = data;
      newSeedData.set(entityId, records);
      return { seedData: newSeedData };
    });
  },

  deleteSeedRecord: (entityId, index) => {
    edit((state) => {
      const newSeedData = new Map(state.seedData);
      const records = [...(newSeedData.get(entityId) || [])];
      records.splice(index, 1);
      newSeedData.set(entityId, records);
      // The identity goes with the row: the export drops the record rather
      // than writing a tombstone (utils/xdbFormat.ts says why).
      const recordIdentity = new Map(state.recordIdentity);
      const identity = [...(recordIdentity.get(entityId) || [])];
      if (index < identity.length) identity.splice(index, 1);
      recordIdentity.set(entityId, identity);
      return { seedData: newSeedData, recordIdentity };
    });
  },

  loadEntities: (entities) => {
    set({ entities: entities.map(entity => ({ ...entity, fields: ensureFieldIds(entity.fields) })), selectedEntityId: entities[0]?.id || null });
  },

  loadSeedData: (data) => {
    set({ seedData: data });
  },

  loadRecords: (identity, tombstones) => {
    set({ recordIdentity: identity, tombstones, lastReidentify: null });
  },

  reidentifyRecords: (entityId, now) => {
    const state = get();
    const before: RecordsSnapshot = {
      seedData: state.seedData,
      recordIdentity: state.recordIdentity,
      tombstones: state.tombstones,
    };
    const result = reidentifyCollection(entityId, state.entities, before, now);
    if (!result) return null;
    // `set`, then markDirty by hand: `edit` would clear the way back it is
    // recording. The maps of untouched collections are the same objects as
    // before, so keeping `before` costs only the re-identified entries.
    set({ ...result.next, lastReidentify: { entityId, before } });
    useProjectStore.getState().markDirty();
    return result.outcome;
  },

  undoReidentify: () => {
    const last = get().lastReidentify;
    if (!last) return false;
    set({ ...last.before, lastReidentify: null });
    useProjectStore.getState().markDirty();
    return true;
  },

  reset: () => {
    set({
      entities: [],
      relationships: [],
      selectedEntityId: null,
      seedData: new Map(),
      recordIdentity: new Map(),
      tombstones: new Map(),
      lastReidentify: null,
    });
  },
  };
});
