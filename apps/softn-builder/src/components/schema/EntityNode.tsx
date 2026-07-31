/**
 * EntityNode - Custom React Flow node for database entities
 */

import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import type { EntityDef, SchemaField } from '../../types/builder';

const styles: Record<string, React.CSSProperties> = {
  node: {
    background: '#fff',
    border: '2px solid #c2410c',
    borderRadius: 8,
    minWidth: 200,
    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
  },
  nodeSelected: {
    borderColor: '#7c2d12',
    boxShadow: '0 0 0 2px rgba(194, 65, 12, 0.3)',
  },
  header: {
    background: '#c2410c',
    color: '#fff',
    padding: '8px 12px',
    borderRadius: '6px 6px 0 0',
    fontWeight: 600,
    fontSize: 14,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  alias: {
    fontSize: 11,
    opacity: 0.8,
    fontWeight: 400,
  },
  fields: {
    padding: 8,
  },
  field: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 8px',
    fontSize: 12,
    borderBottom: '1px solid #eef1f6',
  },
  fieldLast: {
    borderBottom: 'none',
  },
  fieldName: {
    flex: 1,
    fontWeight: 500,
    color: '#14181d',
  },
  fieldType: {
    color: '#5a6472',
    fontSize: 11,
    background: '#eef1f6',
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
    width: 10,
    height: 10,
    background: '#c2410c',
    border: '2px solid #fff',
  },
  noFields: {
    padding: '12px 8px',
    color: '#656e7c',
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

  return (
    <div style={{ ...styles.node, ...(selected ? styles.nodeSelected : {}) }}>
      <Handle type="target" position={Position.Left} style={styles.handle} />

      <div style={styles.header}>
        <span>{entity.name}</span>
        <span style={styles.alias}>({entity.alias})</span>
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
            </div>
          ))
        ) : (
          <div style={styles.noFields}>No fields defined</div>
        )}
      </div>

      <Handle type="source" position={Position.Right} style={styles.handle} />
    </div>
  );
}

export const EntityNode = memo(EntityNodeComponent);
