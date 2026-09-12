/**
 * EntityNode - Custom React Flow node for database entities
 */

import React, { memo, useEffect } from 'react';
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import type { EntityDef, SchemaField } from '../../types/builder';

const styles: Record<string, React.CSSProperties> = {
  node: {
    background: 'var(--ink-2)',
    border: '2px solid var(--coral)',
    borderRadius: 8,
    minWidth: 200,
    maxWidth: 320,
    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
  },
  nodeSelected: {
    boxShadow: '0 0 0 2px rgba(194, 65, 12, 0.3)',
  },
  header: {
    background: 'var(--coral)',
    color: '#fff',
    padding: '8px 12px',
    borderRadius: '6px 6px 0 0',
    fontWeight: 600,
    fontSize: 14,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  alias: {
    fontSize: 11,
    opacity: 0.8,
    fontWeight: 400,
    minWidth: 0,
    maxWidth: '45%',
    overflowWrap: 'anywhere',
    textAlign: 'right',
  },
  fields: {
    padding: 8,
  },
  field: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 14px 6px 8px',
    fontSize: 12,
    borderBottom: '1px solid var(--ink-3)',
  },
  fieldLast: {
    borderBottom: 'none',
  },
  fieldName: {
    flex: 1,
    overflowWrap: 'anywhere',
    fontWeight: 500,
    color: 'var(--paper)',
  },
  fieldType: {
    color: 'var(--dim)',
    fontSize: 11,
    background: 'var(--ink-3)',
    padding: '2px 6px',
    borderRadius: 4,
  },
  fieldRequired: {
    color: '#ef4444',
    fontSize: 10,
  },
  fieldKey: {
    color: '#f59e0b',
    fontSize: 10,
  },
  handle: {
    width: 16,
    height: 16,
    background: 'var(--coral)',
    border: '2px solid var(--ink-2)',
  },
  noFields: {
    padding: '12px 8px',
    color: 'var(--dimmer)',
    fontSize: 12,
    textAlign: 'center' as const,
  },
};

const fieldTypeIcons: Record<string, string> = {
  string: 'Aa',
  number: '#',
  boolean: 'OK',
  date: 'DT',
  email: '@',
  url: 'URL',
  select: 'SEL',
  reference: 'REF',
};

interface EntityNodeData extends Record<string, unknown> {
  entity: EntityDef;
  selected?: boolean;
}

export type EntityNodeType = Node<EntityNodeData>;

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

      <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', padding: '7px 12px', fontSize: 10, fontWeight: 600, color: 'var(--dim)', borderBottom: '1px solid var(--line)' }}>
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
                {field.name === 'id' && <span style={styles.fieldKey}>PK </span>}
                {field.name}
              </span>
              {field.required && field.name !== 'id' && <span style={styles.fieldRequired}>*</span>}
              <span style={styles.fieldType}>
                {fieldTypeIcons[field.type] || ''} {field.type}
              </span>
              {field.name !== 'id' && (field.type === 'reference' || field.type === 'string') && (
                <Handle
                  id={`field-${field.id}`} type="source" position={Position.Right}
                  style={{ ...styles.handle, right: -8, width: 14, height: 14, background: field.type === 'reference' ? 'var(--coral)' : 'var(--dim)' }}
                  title={`Connect ${entity.name}.${field.name} to a record`}
                  aria-label={`Connect ${entity.name}.${field.name} to a record`}
                />
              )}
            </div>
          ))
        ) : (
          <div style={styles.noFields}>No fields defined</div>
        )}
      </div>

    </div>
  );
}

export const EntityNode = memo(EntityNodeComponent);
