/**
 * EntityEditor - Panel for editing entity (collection) details
 */

import React, { useState } from 'react';
import { useSchemaStore } from '../../stores/schemaStore';
import type { EntityDef, SchemaField, FieldType } from '../../types/builder';

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: '#fff',
    borderLeft: '1px solid #e2e8f0',
    width: 300,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid #e2e8f0',
    fontWeight: 600,
    fontSize: 14,
    color: '#1e293b',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 18,
    color: '#64748b',
    padding: 4,
  },
  content: {
    flex: 1,
    overflow: 'auto',
    padding: 16,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: '#64748b',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: 8,
  },
  formGroup: {
    marginBottom: 12,
  },
  label: {
    display: 'block',
    fontSize: 12,
    fontWeight: 500,
    color: '#374151',
    marginBottom: 4,
  },
  input: {
    width: '100%',
    padding: '8px 10px',
    border: '1px solid #e2e8f0',
    borderRadius: 6,
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  fieldCard: {
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 6,
    padding: 12,
    marginBottom: 8,
  },
  fieldHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  fieldName: {
    fontWeight: 500,
    fontSize: 13,
  },
  deleteBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: '#ef4444',
    fontSize: 14,
    padding: 4,
  },
  fieldRow: {
    display: 'flex',
    gap: 8,
    marginBottom: 8,
  },
  select: {
    padding: '6px 8px',
    border: '1px solid #e2e8f0',
    borderRadius: 4,
    fontSize: 12,
    outline: 'none',
    background: '#fff',
  },
  checkbox: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: '#374151',
  },
  addBtn: {
    width: '100%',
    padding: '8px 12px',
    background: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  },
  dangerBtn: {
    width: '100%',
    padding: '8px 12px',
    background: '#fee2e2',
    color: '#dc2626',
    border: '1px solid #fecaca',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    marginTop: 16,
  },
  emptyState: {
    textAlign: 'center' as const,
    padding: 24,
    color: '#64748b',
    fontSize: 13,
  },
};

const fieldTypes: FieldType[] = [
  'string',
  'number',
  'boolean',
  'date',
  'email',
  'url',
  'select',
  'reference',
];

interface FieldEditorProps {
  field: SchemaField;
  entityId: string;
  entities: EntityDef[];
  onUpdate: (updates: Partial<SchemaField>) => void;
  onDelete: () => void;
  isIdField: boolean;
}

function FieldEditor({
  field,
  entityId,
  entities,
  onUpdate,
  onDelete,
  isIdField,
}: FieldEditorProps) {
  const [optionsText, setOptionsText] = useState(field.options?.join(', ') || '');

  return (
    <div style={styles.fieldCard}>
      <div style={styles.fieldHeader}>
        <span style={styles.fieldName}>
          {isIdField && '🔑 '}
          {field.name}
        </span>
        {!isIdField && (
          <button style={styles.deleteBtn} onClick={onDelete} title="Delete field">
            ×
          </button>
        )}
      </div>

      <div style={styles.fieldRow}>
        <input
          type="text"
          value={field.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          style={{ ...styles.input, flex: 1 }}
          placeholder="Field name"
          disabled={isIdField}
        />
        <select
          value={field.type}
          onChange={(e) => onUpdate({ type: e.target.value as FieldType })}
          style={styles.select}
          disabled={isIdField}
        >
          {fieldTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>

      {field.type === 'select' && (
        <div style={{ marginBottom: 8 }}>
          <input
            type="text"
            value={optionsText}
            onChange={(e) => {
              setOptionsText(e.target.value);
              onUpdate({
                options: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              });
            }}
            style={styles.input}
            placeholder="Options (comma-separated)"
          />
        </div>
      )}

      {field.type === 'reference' && (
        <div style={{ marginBottom: 8 }}>
          <select
            value={field.refEntity || ''}
            onChange={(e) => onUpdate({ refEntity: e.target.value })}
            style={{ ...styles.select, width: '100%' }}
          >
            <option value="">Select entity...</option>
            {entities
              .filter((e) => e.id !== entityId)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
          </select>
        </div>
      )}

      {!isIdField && (
        <label style={styles.checkbox}>
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e) => onUpdate({ required: e.target.checked })}
          />
          Required
        </label>
      )}
    </div>
  );
}

export function EntityEditor() {
  const {
    entities,
    selectedEntityId,
    updateEntity,
    addField,
    updateField,
    deleteField,
    deleteEntity,
    selectEntity,
  } = useSchemaStore();

  const entity = entities.find((e) => e.id === selectedEntityId);

  if (!entity) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>Entity Editor</div>
        <div style={styles.emptyState}>
          Select an entity to edit, or double-click the canvas to create one.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span>Edit Entity</span>
        <button style={styles.closeBtn} onClick={() => selectEntity(null)}>
          ×
        </button>
      </div>

      <div style={styles.content}>
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Basic Info</div>

          <div style={styles.formGroup}>
            <label style={styles.label}>Name</label>
            <input
              type="text"
              value={entity.name}
              onChange={(e) => updateEntity(entity.id, { name: e.target.value })}
              style={styles.input}
              placeholder="Entity name"
            />
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>Alias (for code)</label>
            <input
              type="text"
              value={entity.alias}
              onChange={(e) => updateEntity(entity.id, { alias: e.target.value })}
              style={styles.input}
              placeholder="entity_alias"
            />
          </div>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionTitle}>Fields</div>

          {entity.fields.map((field) => (
            <FieldEditor
              key={field.id}
              field={field}
              entityId={entity.id}
              entities={entities}
              onUpdate={(updates) => updateField(entity.id, field.id, updates)}
              onDelete={() => deleteField(entity.id, field.id)}
              isIdField={field.name === 'id'}
            />
          ))}

          <button style={styles.addBtn} onClick={() => addField(entity.id)}>
            + Add Field
          </button>
        </div>

        <button
          style={styles.dangerBtn}
          onClick={() => {
            if (window.confirm(`Delete entity "${entity.name}"?`)) {
              deleteEntity(entity.id);
            }
          }}
        >
          Delete Entity
        </button>
      </div>
    </div>
  );
}
