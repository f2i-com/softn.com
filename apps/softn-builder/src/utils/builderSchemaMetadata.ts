import type { EntityDef, RelationshipDef } from '../types/builder';
import { BUNDLE_FORMAT_VERSION } from './bundleExporter';
import { inferRelationships, RELATIONSHIP_TYPES, validRelationships } from './schemaRelationships';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function metadata(manifest: Record<string, unknown> | null): Record<string, unknown> | null {
  return object(object(manifest?.builder)?.schema);
}

function namedRelationships(entities: EntityDef[], relationships: RelationshipDef[]) {
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  return validRelationships(entities, relationships).map(relationship => {
    const source = byId.get(relationship.sourceEntityId)!;
    return {
      sourceCollection: source.name,
      sourceField: source.fields.find(field => field.id === relationship.sourceFieldId)?.name ?? '',
      targetCollection: byId.get(relationship.targetEntityId)!.name,
      type: relationship.type,
    };
  });
}

/** Editor IDs never leave this session: diagram metadata refers to collection and field names. */
export function withBuilderSchema(
  manifest: Record<string, unknown> | null, entities: EntityDef[], relationships: RelationshipDef[],
): Record<string, unknown> | null {
  const previous = metadata(manifest);
  const named = namedRelationships(entities, relationships);
  const implicit = namedRelationships(entities, inferRelationships(entities));
  const sorted = (items: typeof named) => items.map(item => JSON.stringify(item)).sort();
  const defaultDiagram = entities.every((entity, index) => entity.position.x === 100 + index * 300 && entity.position.y === 100)
    && JSON.stringify(sorted(named)) === JSON.stringify(sorted(implicit));
  // An untouched legacy bundle still has the same manifest after a no-edit save.
  // Explicit empty relationships are written after deleting an inferred edge.
  if (previous?.version !== 1 && defaultDiagram) return manifest;
  return {
    ...(manifest ?? { formatVersion: BUNDLE_FORMAT_VERSION }),
    builder: {
      ...object(manifest?.builder),
      schema: {
        ...previous,
        version: 1,
        collections: entities.map(entity => ({ name: entity.name, position: { ...entity.position } })),
        relationships: named,
      },
    },
  };
}

/** Invalid editor metadata cannot attach an edge to the wrong field or modify record values. */
export function readBuilderSchema(manifest: Record<string, unknown>, entities: EntityDef[]): {
  entities: EntityDef[]; relationships: RelationshipDef[];
} {
  const schema = metadata(manifest);
  if (schema?.version !== 1) return { entities, relationships: inferRelationships(entities) };
  const positions = new Map<string, { x: number; y: number }>();
  if (Array.isArray(schema.collections)) for (const entry of schema.collections) {
    const item = object(entry);
    const position = object(item?.position);
    if (typeof item?.name === 'string' && typeof position?.x === 'number' && Number.isFinite(position.x)
      && typeof position.y === 'number' && Number.isFinite(position.y)) positions.set(item.name, { x: position.x, y: position.y });
  }
  const positioned = entities.map(entity => positions.has(entity.name) ? { ...entity, position: positions.get(entity.name)! } : entity);
  if (!Array.isArray(schema.relationships)) return { entities: positioned, relationships: inferRelationships(positioned) };
  const byName = new Map(positioned.map(entity => [entity.name, entity]));
  const relationships: RelationshipDef[] = [];
  for (const entry of schema.relationships) {
    const item = object(entry);
    if (!item || typeof item.sourceCollection !== 'string' || typeof item.targetCollection !== 'string'
      || typeof item.sourceField !== 'string' || !RELATIONSHIP_TYPES.includes(item.type as RelationshipDef['type'])) continue;
    const source = byName.get(item.sourceCollection);
    const target = byName.get(item.targetCollection);
    const field = source?.fields.find(candidate => candidate.name === item.sourceField);
    if (!source || !target || (item.sourceField && !field)) continue;
    relationships.push({ id: `relationship:${source.id}:${relationships.length}`, sourceEntityId: source.id,
      sourceFieldId: item.sourceField ? field!.id : '', targetEntityId: target.id, type: item.type as RelationshipDef['type'] });
  }
  return { entities: positioned, relationships: validRelationships(positioned, relationships) };
}
