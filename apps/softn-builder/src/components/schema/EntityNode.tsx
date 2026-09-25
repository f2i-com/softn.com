/**
 * EntityNode - Custom React Flow node for database entities
 */

import React, { memo, useEffect } from 'react';
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import type { EntityDef, SchemaField } from '../../types/builder';

// A collection card in graphite: its whole header used to be a slab of
// coral, the colour the brand keeps for the language, on every table.
const styles: Record<string, React.CSSProperties> = {
  node: {
    background: 'var(--ink-2)',
    border: '1px solid var(--line-strong)',
    borderRadius: 10,
    minWidth: 200,
    maxWidth: 320,
    boxShadow: '0 1px 2px rgba(0,0,0,0.12)',
  },
  nodeSelected: {
    borderColor: 'var(--paper)',
    boxShadow: '0 0 0 1px var(--paper)',
  },
  header: {
    background: 'var(--ink-3)',
    color: 'var(--paper)',
    padding: '8px 12px',
    borderRadius: '9px 9px 0 0',
    borderBottom: '1px solid var(--line)',
    fontFamily: 'var(--mono)',
    fontWeight: 500,
    fontSize: 13.5,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  alias: {
    fontSize: 11,
    color: 'var(--dim)',
    fontWeight: 400,
    minWidth: 0,
    maxWidth: '45%',
    overflowWrap: 'anywhere',
    textAlign: 'right',
  },
  fields: {
    padding: '4px 8px 8px',
  },
  field: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 14px 6px 4px',
    fontSize: 12,
    borderBottom: '1px solid var(--line-soft)',
  },
  fieldLast: {
    borderBottom: 'none',
  },
  fieldName: {
    flex: 1,
    overflowWrap: 'anywhere',
    fontFamily: 'var(--mono)',
    color: 'var(--paper)',
  },
  fieldType: {
    color: 'var(--dim)',
    fontSize: 11,
    background: 'var(--ink-3)',
    padding: '1px 6px',
    borderRadius: 4,
  },
  fieldRequired: {
    color: 'var(--danger)',
    fontSize: 11,
  },
  fieldKey: {
    fontFamily: 'var(--body)',
    fontSize: 9.5,
    fontWeight: 600,
    color: 'var(--dim)',
    border: '1px solid var(--line)',
    borderRadius: 3,
    padding: '0 3px',
    marginRight: 6,
  },
  handle: {
    width: 14,
    height: 14,
    background: 'var(--dim)',
    border: '2px solid var(--ink-2)',
  },
  noFields: {
    padding: '12px 8px',
    color: 'var(--dim)',
    fontSize: 12,
    textAlign: 'center' as const,
  },
};

/** What each field type is called on its card; the store's names, in words. */
const fieldTypeLabels: Record<string, string> = {
  string: 'text',
  number: 'number',
  boolean: 'yes / no',
  date: 'date',
  email: 'email',
  url: 'link',
  select: 'choice',
  reference: 'reference',
};

interface EntityNodeData extends Record<string, unknown> {
  entity: EntityDef;
  selected?: boolean;
}


interface EntityNodeProps {
  data: EntityNodeData;
  selected?: boolean;
}

function EntityNodeComponent({ data, selected }: EntityNodeProps) {
  const { entity } = data;
  const updateNodeInternals = useUpdateNodeInternals();
  // A type change or a newly added field moves/removes its connector.
  const handleLayout = entity.fields.map(field => `${field.id}:${field.type}:${field.name}`).join('|');
  useEffect(() => { updateNodeInternals(entity.id); }, [entity.id, handleLayout, updateNodeInternals]);

  return (
    <div style={{ ...styles.node, ...(selected ? styles.nodeSelected : {}) }}>
      <div style={styles.header}>
        <span style={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>{entity.name}</span>
        <span style={styles.alias}>({entity.alias})</span>
      </div>

      <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', padding: '6px 12px', fontSize: 10.5, color: 'var(--dim)', borderBottom: '1px solid var(--line-soft)' }}>
        <Handle id="collection-target" type="target" position={Position.Left} style={styles.handle} title={`Connect to ${entity.name}`} aria-label={`Connect to ${entity.name}`} />
        <span>Connect here</span><span>Link collection →</span>
        <Handle id="collection-source" type="source" position={Position.Right} style={styles.handle} title={`Link ${entity.name} to a collection`} aria-label={`Link ${entity.name} to a collection`} />
      </div>

      <div style={styles.fields}>
        {entity.fields.length > 0 ? (
          entity.fields.map((field: SchemaField, index: number) => (
            <div
              key={field.id}
              style={{
                ...styles.field,
                ...(index === entity.fields.length - 1 ? styles.fieldLast : {}),
              }}
            >
              <span style={styles.fieldName}>
                {field.name === 'id' && <span style={styles.fieldKey} title="Primary key">key</span>}
                {field.name}
              </span>
              {field.required && field.name !== 'id' && <span style={styles.fieldRequired} title="Required" aria-label="required">*</span>}
              <span style={styles.fieldType} title={field.type}>
                {fieldTypeLabels[field.type] ?? field.type}
              </span>
              {field.name !== 'id' && (field.type === 'reference' || field.type === 'string') && (
                <Handle
                  id={`field-${field.id}`} type="source" position={Position.Right}
                  style={{ ...styles.handle, right: -8, width: 14, height: 14, background: field.type === 'reference' ? 'var(--paper)' : 'var(--dim)' }}
                  title={`Connect ${entity.name}.${field.name} to a record`}
                  aria-label={`Connect ${entity.name}.${field.name} to a record`}
                />
              )}
            </div>
          ))
        ) : (
          <div style={styles.noFields}>No fields yet</div>
        )}
      </div>

    </div>
  );
}

export const EntityNode = memo(EntityNodeComponent);
