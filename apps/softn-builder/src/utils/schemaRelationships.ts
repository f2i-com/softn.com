import type { EntityDef, RelationshipDef, RelationshipDraft } from '../types/builder';

export const RELATIONSHIP_TYPES: readonly RelationshipDef['type'][] = [
  'one-to-one', 'one-to-many', 'many-to-one', 'many-to-many',
];

/** Validate before changing a field or marking the project dirty. Record values are never changed. */
export function prepareRelationship(
  entities: EntityDef[], relationships: RelationshipDef[], draft: RelationshipDraft,
  id: string, createFieldId: () => string,
  seedData: Map<string, Record<string, unknown>[]>,
): { error: string } | { entities: EntityDef[]; relationship: RelationshipDef } {
  const source = entities.find(entity => entity.id === draft.sourceEntityId);
  const target = entities.find(entity => entity.id === draft.targetEntityId);
  if (!source || !target) return { error: 'Choose two available collections.' };
  if (!RELATIONSHIP_TYPES.includes(draft.type)) return { error: 'Choose a relationship type.' };
  const newName = draft.newFieldName?.trim();
  if (draft.newFieldName !== undefined && !newName) return { error: 'Enter a reference field name.' };
  if (newName && draft.sourceFieldId) return { error: 'Choose an existing field or create a new field.' };
  const linked = Boolean(draft.sourceFieldId || newName);
  if (linked && draft.type !== 'many-to-one' && draft.type !== 'one-to-one') {
    return { error: 'A reference field supports many-to-one or one-to-one relationships.' };
  }
  let field = source.fields.find(item => item.id === draft.sourceFieldId);
  if (newName) {
    if (newName === 'id' || ['__proto__', 'constructor', 'prototype'].includes(newName)) {
      return { error: 'Choose another name for the reference field.' };
    }
    if (source.fields.some(item => item.name === newName)) return { error: `A field named "${newName}" already exists.` };
    if (seedData.get(source.id)?.some(row => Object.prototype.hasOwnProperty.call(row, newName))) {
      return { error: `Records already contain "${newName}". Choose another name to keep those values.` };
    }
    field = { id: createFieldId(), name: newName, type: 'reference', required: false, refEntity: target.id };
  } else if (draft.sourceFieldId) {
    if (!field) return { error: 'This field is no longer available.' };
    if (field.name === 'id' || (field.type !== 'string' && field.type !== 'reference')) {
      return { error: 'Choose a string or reference field other than id.' };
    }
    if (field.refEntity && field.refEntity !== target.id) return { error: 'This field already references another collection.' };
  }
  const sourceFieldId = linked ? field!.id : '';
  const duplicate = relationships.some(item => item.id !== id && item.sourceEntityId === source.id && (
    sourceFieldId ? item.sourceFieldId === sourceFieldId : !item.sourceFieldId && item.targetEntityId === target.id
  ));
  if (duplicate) return { error: sourceFieldId ? 'This field already has a relationship.' : 'These collections already have this diagram link.' };
  const relationship: RelationshipDef = { id, sourceEntityId: source.id, sourceFieldId, targetEntityId: target.id, type: draft.type };
  if (!linked || (!newName && field!.type === 'reference' && field!.refEntity === target.id)) return { entities, relationship };
  const referenceField = { ...field!, type: 'reference' as const, refEntity: target.id };
  return {
    entities: entities.map(entity => entity.id === source.id ? {
      ...entity, fields: newName ? [...entity.fields, referenceField] : entity.fields.map(item => item.id === sourceFieldId ? referenceField : item),
    } : entity),
    relationship,
  };
}

/** Keep edges consistent when fields are edited outside the relationship dialog. */
export function validRelationships(entities: EntityDef[], relationships: RelationshipDef[]): RelationshipDef[] {
  const seen = new Set<string>();
  return relationships.filter(relationship => {
    if (!relationship || typeof relationship.id !== 'string' || typeof relationship.sourceFieldId !== 'string') return false;
    const source = entities.find(entity => entity.id === relationship.sourceEntityId);
    const target = entities.find(entity => entity.id === relationship.targetEntityId);
    if (!source || !target || !RELATIONSHIP_TYPES.includes(relationship.type)) return false;
    if (relationship.sourceFieldId) {
      const field = source.fields.find(item => item.id === relationship.sourceFieldId);
      if (!field || field.name === 'id' || field.type !== 'reference' || field.refEntity !== target.id ||
        (relationship.type !== 'one-to-one' && relationship.type !== 'many-to-one')) return false;
    }
    const key = JSON.stringify([source.id, relationship.sourceFieldId || '', relationship.sourceFieldId ? '' : target.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function inferRelationships(entities: EntityDef[]): RelationshipDef[] {
  const ids = new Set(entities.map(entity => entity.id));
  return entities.flatMap(entity => entity.fields.flatMap(field =>
    field.name !== 'id' && field.type === 'reference' && field.refEntity && ids.has(field.refEntity)
      ? [{ id: `inferred:${entity.id}:${field.id}`, sourceEntityId: entity.id, sourceFieldId: field.id, targetEntityId: field.refEntity, type: 'many-to-one' as const }]
      : []));
}
