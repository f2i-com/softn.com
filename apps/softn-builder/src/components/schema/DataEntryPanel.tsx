/**
 * DataEntryPanel - Dynamic form for entering seed data based on schema
 */

import React, { useState } from 'react';
import { useSchemaStore } from '../../stores/schemaStore';
import type { EntityDef, SchemaField } from '../../types/builder';

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: 'var(--ink-2)',
    borderTop: '1px solid var(--line-soft)',
    maxHeight: 300,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    padding: '10px 16px',
    borderBottom: '1px solid var(--line-soft)',
    fontWeight: 600,
    fontSize: 13,
    color: 'var(--paper)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    background: 'var(--ink)',
  },
  tabs: {
    display: 'flex',
    gap: 4,
    padding: '8px 16px',
    borderBottom: '1px solid var(--line-soft)',
    overflowX: 'auto',
  },
  tab: {
    padding: '6px 12px',
    background: 'var(--ink-3)',
    border: 'none',
    borderRadius: 4,
    fontSize: 12,
    color: 'var(--dim)',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },
  tabActive: {
    background: 'var(--coral)',
    color: '#fff',
  },
  content: {
    flex: 1,
    overflow: 'auto',
    padding: 16,
  },
  emptyState: {
    textAlign: 'center' as const,
    padding: 24,
    color: 'var(--dim)',
    fontSize: 13,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: 12,
  },
  th: {
    textAlign: 'left' as const,
    padding: '8px 10px',
    background: 'var(--ink)',
    borderBottom: '1px solid var(--line-soft)',
    fontWeight: 600,
    color: 'var(--dim)',
  },
  td: {
    padding: '6px 8px',
    borderBottom: '1px solid var(--ink-3)',
  },
  input: {
    width: '100%',
    padding: '6px 8px',
    border: '1px solid var(--line-soft)',
    borderRadius: 4,
    fontSize: 12,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  select: {
    width: '100%',
    padding: '6px 8px',
    border: '1px solid var(--line-soft)',
    borderRadius: 4,
    fontSize: 12,
    outline: 'none',
    background: 'var(--ink-2)',
  },
  checkbox: {
    width: 16,
    height: 16,
  },
  deleteBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: '#ef4444',
    fontSize: 16,
    padding: 4,
  },
  addBtn: {
    padding: '6px 12px',
    background: 'var(--coral)',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
  },
  recordCount: {
    fontSize: 11,
    color: 'var(--dim)',
    fontWeight: 400,
  },
};

interface FieldInputProps {
  field: SchemaField;
  value: unknown;
  onChange: (value: unknown) => void;
  entities: EntityDef[];
  seedData: Map<string, Record<string, unknown>[]>;
}

function FieldInput({ field, value, onChange, entities, seedData }: FieldInputProps) {
  switch (field.type) {
    case 'boolean':
      return (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          style={styles.checkbox}
        />
      );

    case 'number': {
      // Text, not type=number, and the typed characters are kept as typed until
      // they parse. Round-tripping every keystroke through Number() meant a lone
      // "-" became NaN and the field snapped back, so a negative number could
      // not be typed at all; `|| 0` meant it could never be left blank either,
      // because an empty box immediately re-read as zero. On blur the value is
      // settled: a real number, or empty.
      const raw = value === null || value === undefined ? '' : String(value);
      const partial = (text: string) => text === '' || text === '-' || /[.eE+-]$/.test(text);
      return (
        <input
          type="text"
          inputMode="decimal"
          value={raw}
          onChange={(e) => {
            const text = e.target.value;
            const parsed = Number(text);
            onChange(partial(text) || !Number.isFinite(parsed) ? text : parsed);
          }}
          onBlur={(e) => {
            const text = e.target.value.trim();
            if (text === '') { onChange(''); return; }
            const parsed = Number(text);
            onChange(Number.isFinite(parsed) ? parsed : '');
          }}
          style={styles.input}
        />
      );
    }

    case 'date':
      return (
        <input
          type="date"
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
          style={styles.input}
        />
      );

    case 'select':
      return (
        <select
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
          style={styles.select}
        >
          <option value="">Select...</option>
          {field.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );

    case 'reference': {
      const refEntity = entities.find((e) => e.id === field.refEntity);
      const refRecords = refEntity ? seedData.get(refEntity.id) || [] : [];
      return (
        <select
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
          style={styles.select}
        >
          {/* Only rows that can actually be referenced. The index was offered as
              a fallback id, which matches no record anywhere — picking one wrote
              a reference that resolves to nothing, and looked like it had worked. */}
          <option value="">
            {refRecords.some((r) => r.id)
              ? `Select ${refEntity?.name || 'ref'}...`
              : `${refEntity?.name || 'That collection'} has no rows with an id yet`}
          </option>
          {refRecords.map((record, idx) => (record.id ? (
            <option key={idx} value={record.id as string}>
              {String(record.id)}
            </option>
          ) : null))}
        </select>
      );
    }

    case 'email':
      return (
        <input
          type="email"
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
          style={styles.input}
          placeholder="email@example.com"
        />
      );

    case 'url':
      return (
        <input
          type="url"
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
          style={styles.input}
          placeholder="https://..."
        />
      );

    default:
      return (
        <input
          type="text"
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
          style={styles.input}
        />
      );
  }
}

export function DataEntryPanel() {
  const { entities, seedData, addSeedRecord, updateSeedRecord, deleteSeedRecord } =
    useSchemaStore();
  const [activeEntityId, setActiveEntityId] = useState<string | null>(null);

  // Auto-select first entity if none selected
  React.useEffect(() => {
    if (!activeEntityId && entities.length > 0) {
      setActiveEntityId(entities[0].id);
    } else if (activeEntityId && !entities.find((e) => e.id === activeEntityId)) {
      setActiveEntityId(entities.length > 0 ? entities[0].id : null);
    }
  }, [entities, activeEntityId]);

  if (entities.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>Seed Data</div>
        <div style={styles.emptyState}>
          Create entities in the schema designer to add seed data.
        </div>
      </div>
    );
  }

  const activeEntity = entities.find((e) => e.id === activeEntityId);
  const records = activeEntity ? seedData.get(activeEntity.id) || [] : [];

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span>Seed Data</span>
        {activeEntity && (
          <span style={styles.recordCount}>
            {records.length} record{records.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div style={styles.tabs}>
        {entities.map((entity) => (
          <button
            key={entity.id}
            style={{
              ...styles.tab,
              ...(entity.id === activeEntityId ? styles.tabActive : {}),
            }}
            onClick={() => setActiveEntityId(entity.id)}
          >
            {entity.name}
            {(seedData.get(entity.id)?.length || 0) > 0 && (
              <span> ({seedData.get(entity.id)?.length})</span>
            )}
          </button>
        ))}
      </div>

      <div style={styles.content}>
        {activeEntity && (
          <>
            {records.length > 0 ? (
              <table style={styles.table}>
                <thead>
                  <tr>
                    {activeEntity.fields.map((field) => (
                      <th key={field.id} style={styles.th}>
                        {field.name}
                        {field.required && <span style={{ color: '#ef4444' }}> *</span>}
                      </th>
                    ))}
                    <th style={{ ...styles.th, width: 40 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record, idx) => (
                    <tr key={idx}>
                      {activeEntity.fields.map((field) => (
                        <td key={field.id} style={styles.td}>
                          <FieldInput
                            field={field}
                            value={record[field.name]}
                            onChange={(value) => {
                              updateSeedRecord(activeEntity.id, idx, {
                                ...record,
                                [field.name]: value,
                              });
                            }}
                            entities={entities}
                            seedData={seedData}
                          />
                        </td>
                      ))}
                      <td style={styles.td}>
                        <button
                          style={styles.deleteBtn}
                          onClick={() => deleteSeedRecord(activeEntity.id, idx)}
                          title="Delete record"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={styles.emptyState}>
                No seed data yet. Click the button below to add records.
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              <button style={styles.addBtn} onClick={() => addSeedRecord(activeEntity.id)}>
                + Add Record
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
