/**
 * Schema Store - Manages database schema (entities, fields, relationships)
 */

import { create } from 'zustand';
import type { EntityDef, SchemaField, RelationshipDef } from '../types/builder';
import { useProjectStore } from './projectStore';

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

interface SchemaStore {
  entities: EntityDef[];
  relationships: RelationshipDef[];
  selectedEntityId: string | null;

  // Entity actions
  addEntity: (position: { x: number; y: number }) => string;
  updateEntity: (id: string, updates: Partial<Omit<EntityDef, 'id'>>) => void;
  deleteEntity: (id: string) => void;
  selectEntity: (id: string | null) => void;

  // Field actions
  addField: (entityId: string) => void;
  updateField: (entityId: string, fieldId: string, updates: Partial<SchemaField>) => void;
  deleteField: (entityId: string, fieldId: string) => void;

  // Relationship actions
  addRelationship: (relationship: Omit<RelationshipDef, 'id'>) => void;
  deleteRelationship: (id: string) => void;

  // Seed data
  seedData: Map<string, Record<string, unknown>[]>;
  setSeedData: (entityId: string, data: Record<string, unknown>[]) => void;
  addSeedRecord: (entityId: string) => void;
  updateSeedRecord: (entityId: string, index: number, data: Record<string, unknown>) => void;
  deleteSeedRecord: (entityId: string, index: number) => void;

  // Bulk load (for opening bundles)
  loadEntities: (entities: EntityDef[]) => void;
  loadSeedData: (data: Map<string, Record<string, unknown>[]>) => void;

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
    useProjectStore.getState().markDirty();
  };

  return {
  entities: [],
  relationships: [],
  selectedEntityId: null,
  seedData: new Map(),

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
    edit((state) => ({
      entities: state.entities.map((e) => (e.id === id ? { ...e, ...updates } : e)),
    }));
  },

  deleteEntity: (id) => {
    edit((state) => {
      // Its seed rows went with it, and any field elsewhere pointing at it was
      // left pointing at nothing — a reference to a collection that no longer
      // exists, which the picker then renders as an empty dropdown with no
      // explanation. Both are cleaned up here.
      const seedData = new Map(state.seedData);
      seedData.delete(id);

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
        selectedEntityId: state.selectedEntityId === id ? null : state.selectedEntityId,
      };
    });
  },

  selectEntity: (id) => {
    set({ selectedEntityId: id });
  },

  addField: (entityId) => {
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
    edit((state) => {
      const entity = state.entities.find((e) => e.id === entityId);
      const previousName = entity?.fields.find((f) => f.id === fieldId)?.name;
      const entities = state.entities.map((e) =>
        e.id === entityId
          ? { ...e, fields: e.fields.map((f) => (f.id === fieldId ? { ...f, ...updates } : f)) }
          : e
      );

      // Carry the seed values over when a field is renamed. Rows are keyed by
      // the field's NAME, so a rename used to leave every value behind on the
      // dead key: the column blanked out on screen while the values were still
      // written into the saved bundle under the old name, where nothing would
      // ever read them again. It looked like deletion, and was worse — the data
      // was still there and unreachable.
      const nextName = updates.name;
      if (previousName === undefined || typeof nextName !== 'string' || nextName === previousName) {
        return { entities };
      }

      const rows = state.seedData.get(entityId);
      if (!rows) return { entities };

      const seedData = new Map(state.seedData);
      seedData.set(
        entityId,
        rows.map((record) => {
          if (!(previousName in record)) return record;
          const { [previousName]: carried, ...rest } = record;
          return { ...rest, [nextName]: carried };
        })
      );
      return { entities, seedData };
    });
  },

  deleteField: (entityId, fieldId) => {
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
    const id = generateId();
    edit((state) => ({
      relationships: [...state.relationships, { ...relationship, id }],
    }));
  },

  deleteRelationship: (id) => {
    edit((state) => ({
      relationships: state.relationships.filter((r) => r.id !== id),
    }));
  },

  setSeedData: (entityId, data) => {
    edit((state) => {
      const newSeedData = new Map(state.seedData);
      newSeedData.set(entityId, data);
      return { seedData: newSeedData };
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
      return { seedData: newSeedData };
    });
  },

  updateSeedRecord: (entityId, index, data) => {
    set((state) => {
      const newSeedData = new Map(state.seedData);
      const records = [...(newSeedData.get(entityId) || [])];
      records[index] = data;
      newSeedData.set(entityId, records);
      return { seedData: newSeedData };
    });
  },

  deleteSeedRecord: (entityId, index) => {
    set((state) => {
      const newSeedData = new Map(state.seedData);
      const records = [...(newSeedData.get(entityId) || [])];
      records.splice(index, 1);
      newSeedData.set(entityId, records);
      return { seedData: newSeedData };
    });
  },

  loadEntities: (entities) => {
    set({ entities, selectedEntityId: entities[0]?.id || null });
  },

  loadSeedData: (data) => {
    set({ seedData: data });
  },

  reset: () => {
    set({
      entities: [],
      relationships: [],
      selectedEntityId: null,
      seedData: new Map(),
    });
  },
  };
});
