/**
 * EntityEditor - Panel for editing entity (collection) details
 */

import React, { useEffect, useId, useState } from 'react';
import { useSchemaStore } from '../../stores/schemaStore';
import type { EntityDef, SchemaField, FieldType } from '../../types/builder';

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: 'var(--ink-2)',
    borderLeft: '1px solid var(--line-soft)',
    width: 300,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--line-soft)',
    fontWeight: 600,
    fontSize: 14,
    color: 'var(--paper)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 18,
    color: 'var(--dim)',
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
    color: 'var(--dim)',
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
    color: 'var(--dim)',
    marginBottom: 4,
  },
  input: {
    width: '100%',
    padding: '8px 10px',
    border: '1px solid var(--line-soft)',
    borderRadius: 6,
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  fieldCard: {
    background: 'var(--ink)',
    border: '1px solid var(--line-soft)',
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
    border: '1px solid var(--line-soft)',
    borderRadius: 4,
    fontSize: 12,
    outline: 'none',
    background: 'var(--ink-2)',
  },
  checkbox: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: 'var(--dim)',
  },
  addBtn: {
    width: '100%',
    padding: '8px 12px',
    background: 'var(--coral)',
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
    color: 'var(--dim)',
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

/** Commit a complete name so intermediate typing cannot move or overwrite data. */
function SchemaNameInput({ value, label, placeholder, disabled, onCommit }: {
  value: string;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  onCommit: (value: string) => string | null;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  useEffect(() => { setDraft(value); setError(null); }, [value]);
  const commit = () => {
    const next = draft.trim();
    if (next === value) { setDraft(value); return; }
    const failure = onCommit(next);
    setError(failure);
    // Invalid text never becomes a pending, unsaved schema: restore the old
    // name and explain why it could not be applied.
    setDraft(failure ? value : next);
  };
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <input
        type="text"
        value={draft}
        aria-label={label}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={!!error}
        data-schema-name="true"
        onChange={event => { setDraft(event.target.value); setError(null); }}
        onBlur={commit}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation(); setDraft(value); setError(null);
          }
        }}
        style={{ ...styles.input, borderColor: error ? '#ef4444' : undefined }}
        placeholder={placeholder}
        disabled={disabled}
      />
      {error && <div id={errorId} role="alert" style={{ fontSize: 12, color: '#ef4444', marginTop: 6 }}>{error}</div>}
    </div>
  );
}

interface FieldEditorProps {
  field: SchemaField;
  entityId: string;
  entities: EntityDef[];
  onUpdate: (updates: Partial<SchemaField>) => string | null;
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
        <SchemaNameInput
          value={field.name}
          label={`Field name: ${field.name}`}
          onCommit={name => onUpdate({ name })}
          placeholder="Field name"
          disabled={isIdField}
        />
        <select
          value={field.type}
          aria-label={`Type for ${field.name}`}
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
  const keyFieldId = entity?.fields.find((f) => f.name === 'id')?.id;

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
        <button style={styles.closeBtn} onClick={() => selectEntity(null)} aria-label="Close entity editor">
          ×
        </button>
      </div>

      <div style={styles.content}>
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Basic Info</div>

          <div style={styles.formGroup}>
            <div style={styles.label}>Name</div>
            <SchemaNameInput
              key={`${entity.id}:name`}
              value={entity.name}
              label="Collection name"
              onCommit={name => updateEntity(entity.id, { name })}
              placeholder="Entity name"
            />
          </div>

          <div style={styles.formGroup}>
            <div style={styles.label}>Alias (for code)</div>
            <SchemaNameInput
              key={`${entity.id}:alias`}
              value={entity.alias}
              label="Alias (for code)"
              onCommit={alias => updateEntity(entity.id, { alias })}
              placeholder="entity_alias"
            />
          </div>
          <p style={{ fontSize: 12, color: 'var(--dim)', margin: 0, lineHeight: 1.5 }}>
            Press Enter or leave a name to apply it. Escape cancels. Renaming does not update references in your code.
          </p>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionTitle}>Fields</div>

          {/* The entity's key field, decided once by identity. If a schema has
              somehow ended up with two fields called "id", only the first is
              protected — the duplicate stays editable so it can be fixed. */}
          {entity.fields.map((field) => (
            <FieldEditor
              key={`${entity.id}:${field.id}`}
              field={field}
              entityId={entity.id}
              entities={entities}
              onUpdate={(updates) => updateField(entity.id, field.id, updates)}
              onDelete={() => deleteField(entity.id, field.id)}
              // By identity, not by the text currently in the box. Deriving this
              // from `field.name === 'id'` meant a field became the protected key
              // field mid-keystroke: renaming `uid` to `identifier` passed through
              // "id" on the way, at which point the input disabled itself, the
              // browser blurred it, and the rest of the word went nowhere. The
              // field was then stuck — a second field called "id" that could not
              // be renamed back, retyped, or deleted, because its delete button
              // is hidden too. The only way out was deleting the whole entity.
              isIdField={keyFieldId !== undefined && field.id === keyFieldId}
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
