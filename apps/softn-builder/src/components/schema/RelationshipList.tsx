import React from 'react';
import type { EntityDef, RelationshipDef } from '../../types/builder';

export const relationshipCardinality: Record<string, string> = {
  'one-to-one': '1:1', 'one-to-many': '1:N', 'many-to-one': 'N:1', 'many-to-many': 'N:N',
};

export function relationshipName(relationship: RelationshipDef, entities: EntityDef[]): string {
  const source = entities.find(entity => entity.id === relationship.sourceEntityId);
  const target = entities.find(entity => entity.id === relationship.targetEntityId);
  const field = source?.fields.find(candidate => candidate.id === relationship.sourceFieldId);
  return `${source?.name ?? 'Missing collection'}${field ? `.${field.name}` : ''} → ${target?.name ?? 'Missing collection'}`;
}

const button: React.CSSProperties = {
  border: '1px solid var(--line)', borderRadius: 5, padding: '6px 10px', minHeight: 32,
  background: 'var(--ink-3)', color: 'var(--paper)', cursor: 'pointer', fontSize: 12,
};

export function RelationshipList({ entities, relationships, selectedId, onSelect, onEdit, onRemove, onAdd }: {
  entities: EntityDef[];
  relationships: RelationshipDef[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div style={{ padding: 14, overflow: 'auto', width: '100%', boxSizing: 'border-box' }}>
      <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--dim)', margin: '0 0 12px' }}>
        Connect a field to store a record reference, or use a diagram link to describe your schema.
      </p>
      <button type="button" onClick={onAdd} disabled={!entities.length} style={{ ...button, width: '100%', opacity: entities.length ? 1 : 0.5 }}>
        Add relationship
      </button>
      {!relationships.length && <p style={{ fontSize: 13, color: 'var(--dim)', lineHeight: 1.5 }}>No relationships yet. Drag from a right-hand connector to a collection&apos;s left-hand connector, or use the button above.</p>}
      <ul aria-label="Relationships" style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 10 }}>
        {relationships.map(relationship => {
          const name = relationshipName(relationship, entities);
          return (
            <li key={relationship.id} style={{ border: `1px solid ${selectedId === relationship.id ? 'var(--coral)' : 'var(--line)'}`, borderRadius: 7, background: 'var(--ink)', padding: 10 }}>
              <button
                type="button" aria-pressed={selectedId === relationship.id} onClick={() => onSelect(relationship.id)}
                aria-label={`Select relationship ${name}`}
                style={{ border: 0, background: 'transparent', padding: 0, width: '100%', textAlign: 'left', color: 'var(--paper)', cursor: 'pointer', lineHeight: 1.5, overflowWrap: 'anywhere' }}
              >
                <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{name}</span>
                <span style={{ display: 'block', color: 'var(--dim)', fontSize: 12, marginTop: 3 }}>
                  {relationshipCardinality[relationship.type]} · {relationship.sourceFieldId ? 'Reference field' : 'Diagram only'}
                </span>
              </button>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button type="button" style={button} onClick={() => onEdit(relationship.id)} aria-label={`Edit relationship ${name}`}>Edit</button>
                <button type="button" style={{ ...button, color: 'var(--coral)' }} onClick={() => onRemove(relationship.id)} aria-label={`Remove relationship ${name}`}>Remove</button>
              </div>
            </li>
          );
        })}
      </ul>
      {!!relationships.length && <p style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--dimmer)', margin: '12px 0 0' }}>Removing a relationship keeps its field and existing values.</p>}
    </div>
  );
}
