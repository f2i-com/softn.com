/**
 * Schema Store - Manages database schema (entities, fields, relationships)
 */

import { create } from 'zustand';
import type { EntityDef, SchemaField, RelationshipDef } from '../types/builder';

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

export const useSchemaStore = create<SchemaStore>((set, get) => ({
  entities: [],
  relationships: [],
  selectedEntityId: null,
  seedData: new Map(),

  addEntity: (position) => {
    const id = generateId();
    const entityCount = get().entities.length;
    const entity: EntityDef = {
      id,
      name: `Entity${entityCount + 1}`,
      alias: `entity${entityCount + 1}`,
      fields: [{ id: generateId(), name: 'id', type: 'string', required: true }],
      position,
    };

    set((state) => ({
      entities: [...state.entities, entity],
      selectedEntityId: id,
    }));

    return id;
  },

  updateEntity: (id, updates) => {
    set((state) => ({
      entities: state.entities.map((e) => (e.id === id ? { ...e, ...updates } : e)),
    }));
  },

  deleteEntity: (id) => {
    set((state) => ({
      entities: state.entities.filter((e) => e.id !== id),
      relationships: state.relationships.filter(
        (r) => r.sourceEntityId !== id && r.targetEntityId !== id
      ),
      selectedEntityId: state.selectedEntityId === id ? null : state.selectedEntityId,
    }));
  },

  selectEntity: (id) => {
    set({ selectedEntityId: id });
  },

  addField: (entityId) => {
    set((state) => ({
      entities: state.entities.map((e) =>
        e.id === entityId ? { ...e, fields: [...e.fields, defaultField()] } : e
      ),
    }));
  },

  updateField: (entityId, fieldId, updates) => {
    set((state) => ({
      entities: state.entities.map((e) =>
        e.id === entityId
          ? {
              ...e,
              fields: e.fields.map((f) => (f.id === fieldId ? { ...f, ...updates } : f)),
            }
          : e
      ),
    }));
  },

  deleteField: (entityId, fieldId) => {
    set((state) => ({
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
    set((state) => ({
      relationships: [...state.relationships, { ...relationship, id }],
    }));
  },

  deleteRelationship: (id) => {
    set((state) => ({
      relationships: state.relationships.filter((r) => r.id !== id),
    }));
  },

  setSeedData: (entityId, data) => {
    set((state) => {
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

    set((state) => {
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
}));
