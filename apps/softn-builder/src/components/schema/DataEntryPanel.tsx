/**
 * DataEntryPanel - Dynamic form for entering seed data based on schema
 */

import React, { useState } from 'react';
import { useSchemaStore } from '../../stores/schemaStore';
import { toast, useNotificationStore } from '../../stores/notificationStore';
import { describeReidentify } from '../../utils/reidentify';
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
  footer: {
    marginTop: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap' as const,
  },
  secondaryBtn: {
    padding: '6px 12px',
    background: 'var(--ink)',
    color: 'var(--dim)',
    border: '1px solid var(--line)',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
  },
  footerHint: {
    fontSize: 11,
    color: 'var(--dimmer)',
  },
};

interface FieldInputProps {
  field: SchemaField;
  value: unknown;
  onChange: (value: unknown) => void;
  entities: EntityDef[];
  seedData: Map<string, Record<string, unknown>[]>;
  /** The id each row is written under (utils/xdbFormat.ts); what a reference points at. */
  recordIdentity: Map<string, { id: string }[]>;
}

function FieldInput({ field, value, onChange, entities, seedData, recordIdentity }: FieldInputProps) {
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
      const refIdentity = refEntity ? recordIdentity.get(refEntity.id) || [] : [];
      // What a reference points at is the record's id — the one the row is
      // written under and the runtime looks records up by — not a column
      // that happens to be called `id`. Rows read from a bundle keep that id
      // across saves, so a reference picked here still resolves after the
      // app is reopened. A row without identity yet (a session written before
      // identity was kept) falls back to its `id` column, as before.
      const choices = refRecords.map((record, idx) => {
        const id = refIdentity[idx]?.id ?? (typeof record.id === 'string' ? record.id : null);
        const label = refEntity?.fields.map((f) => f.name).find((name) => name !== 'id' && typeof record[name] === 'string' && record[name]);
        return id ? { id, text: label ? `${String(record[label])} (${id.slice(0, 8)}…)` : id } : null;
      });
      const current = (value as string) || '';
      return (
        <select
          value={current}
          onChange={(e) => onChange(e.target.value)}
          style={styles.select}
        >
          {/* Only rows that can actually be referenced. The index was offered as
              a fallback id, which matches no record anywhere — picking one wrote
              a reference that resolves to nothing, and looked like it had worked. */}
          <option value="">
            {choices.some((c) => c)
              ? `Select ${refEntity?.name || 'ref'}...`
              : `${refEntity?.name || 'That collection'} has no rows yet`}
          </option>
          {/* A value that names no row (a record since deleted) is still shown, so it is not silently blanked. */}
          {current && !choices.some((c) => c?.id === current) && (
            <option value={current}>{current} (no such record)</option>
          )}
          {choices.map((choice, idx) => (choice ? (
            <option key={idx} value={choice.id}>
              {choice.text}
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
  const { entities, seedData, recordIdentity, addSeedRecord, updateSeedRecord, deleteSeedRecord } =
    useSchemaStore();
  const lastReidentify = useSchemaStore((s) => s.lastReidentify);
  // Render the first collection immediately so the table has its final
  // height before the schema diagram measures its available viewport.
  const [activeEntityId, setActiveEntityId] = useState<string | null>(() => entities[0]?.id ?? null);

  // "Import as new": the one deliberate way to give a collection's records
  // fresh ids (utils/reidentify.ts). Confirmed first, with what will
  // happen spelled out; taken back in one step from the toast or the
  // footer until the next data edit.
  const handleReidentify = (entity: EntityDef) => {
    const store = useSchemaStore.getState();
    const message = describeReidentify(entity, store.entities, {
      seedData: store.seedData,
      recordIdentity: store.recordIdentity,
      tombstones: store.tombstones,
    });
    if (!window.confirm(message)) return;
    const outcome = store.reidentifyRecords(entity.id);
    if (!outcome) return;
    const remapped = outcome.remapped.map((r) => `${r.rows} in ${r.entityName}`).join(', ');
    useNotificationStore.getState().addNotification({
      type: 'success',
      duration: 8000,
      message:
        `${outcome.records} record${outcome.records === 1 ? '' : 's'} of ${entity.name} re-identified` +
        (remapped ? `; references updated: ${remapped}` : ''),
      action: {
        label: 'Undo',
        onClick: () => {
          if (useSchemaStore.getState().undoReidentify()) toast.info(`Restored the previous ids of ${entity.name}`);
          else toast.warning('The data has been edited since; the previous ids are in the last saved recovery copy.');
        },
      },
    });
  };

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
                            recordIdentity={recordIdentity}
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

            <div style={styles.footer}>
              <button style={styles.addBtn} onClick={() => addSeedRecord(activeEntity.id)}>
                + Add Record
              </button>
              {records.length > 0 && (
                <button
                  style={styles.secondaryBtn}
                  onClick={() => handleReidentify(activeEntity)}
                  title="Give every record of this collection a new id and new timestamps, as if imported into a new app, and update the references that point at them"
                  data-action="reidentify"
                >
                  Re-identify records…
                </button>
              )}
              {lastReidentify?.entityId === activeEntity.id && (
                <button
                  style={styles.secondaryBtn}
                  onClick={() => {
                    if (useSchemaStore.getState().undoReidentify()) toast.info(`Restored the previous ids of ${activeEntity.name}`);
                  }}
                  data-action="undo-reidentify"
                >
                  Undo re-identify
                </button>
              )}
              <span style={styles.footerHint}>
                Records keep the ids they were imported with; re-identify only to seed a new app from this data.
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
