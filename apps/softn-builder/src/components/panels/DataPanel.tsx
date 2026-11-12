/**
 * DataPanel - A summary of the app's collections, pointing to the Data view
 */

import React from 'react';
import { useSchemaStore } from '../../stores/schemaStore';

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: 'var(--ink-2)',
    borderTop: '1px solid var(--line-soft)',
    padding: 16,
  },
  header: {
    fontWeight: 600,
    fontSize: 12,
    color: 'var(--dim)',
    marginBottom: 10,
  },
  content: {
    fontSize: 13,
    color: 'var(--dim)',
  },
  stats: {
    display: 'flex',
    gap: 16,
    marginBottom: 12,
  },
  stat: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  statValue: {
    fontWeight: 600,
    color: 'var(--paper)',
    fontVariantNumeric: 'tabular-nums',
  },
  hint: {
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--dim)',
    marginTop: 8,
  },
  entityList: {
    marginTop: 8,
  },
  entityItem: {
    padding: '4px 8px',
    background: 'var(--ink)',
    borderRadius: 4,
    marginBottom: 4,
    fontSize: 12,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  entityName: {
    fontWeight: 500,
    color: 'var(--paper)',
  },
  entityAlias: {
    fontWeight: 400,
    color: 'var(--dim)',
  },
  entityRecords: {
    fontSize: 11,
    color: 'var(--dim)',
    whiteSpace: 'nowrap',
  },
  usage: {
    fontFamily: 'var(--mono)',
    fontSize: 11.5,
    color: 'var(--paper)',
    overflowWrap: 'anywhere',
  },
};

interface DataPanelProps {
  /**
   * Under Properties this is a section that folds to its heading, which then
   * carries the two counts: given, the heading is the button that folds it.
   */
  collapsed?: boolean;
  onToggle?: () => void;
}

export function DataPanel({ collapsed = false, onToggle }: DataPanelProps) {
  const { entities, seedData } = useSchemaStore();

  const totalRecords = Array.from(seedData.values()).reduce(
    (sum, records) => sum + records.length,
    0
  );
  const collectionsWord = entities.length === 1 ? 'collection' : 'collections';
  const recordsWord = totalRecords === 1 ? 'record' : 'records';

  if (onToggle) {
    return (
      <div className="bl-section" style={{ borderTop: '1px solid var(--line-soft)' }}>
        <button type="button" className="bl-section-head" onClick={onToggle} aria-expanded={!collapsed} data-section="data">
          <span>Data</span>
          <span className="bl-section-count">
            {entities.length} {collectionsWord}, {totalRecords} {recordsWord}
          </span>
          <span className="bl-section-chevron" aria-hidden="true">›</span>
        </button>
        {!collapsed && <div style={{ padding: '2px 12px 12px', fontSize: 13, color: 'var(--dim)' }}>{collectionList(entities, seedData)}</div>}
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>Data</div>

      <div style={styles.stats}>
        <div style={styles.stat}>
          <span style={styles.statValue}>{entities.length}</span>
          <span>{collectionsWord}</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statValue}>{totalRecords}</span>
          <span>{recordsWord}</span>
        </div>
      </div>

      {collectionList(entities, seedData)}
    </div>
  );
}

type SchemaState = ReturnType<typeof useSchemaStore.getState>;

/** The collections by name, with what a page writes to read one; or where they are made. */
function collectionList(entities: SchemaState['entities'], seedData: SchemaState['seedData']) {
  return (
    <>

      {entities.length > 0 ? (
        <div style={styles.entityList}>
          {entities.map((entity) => {
            const records = seedData.get(entity.id) || [];
            return (
              <div key={entity.id} style={styles.entityItem} data-collection={entity.name}>
                <span style={styles.entityName}>
                  {entity.name}
                  {/* What a page writes, where that is not the name itself. */}
                  {entity.alias !== entity.name && (
                    <span style={styles.entityAlias}>
                      {' as '}
                      <code data-collection-alias>{entity.alias}</code>
                    </span>
                  )}
                </span>
                <span style={styles.entityRecords}>
                  {records.length} record{records.length !== 1 ? 's' : ''}
                </span>
              </div>
            );
          })}
          {/* How a page reads one: nothing on this side of the editor said,
              and a record's fields are under `data`, which nobody guesses. */}
          <div style={styles.hint} data-collection-usage>
            A page reads a collection as a list of records:{' '}
            <code style={styles.usage}>#each (item in {entities[0].alias})</code>, and a field as{' '}
            <code style={styles.usage}>{`{item.data.${entities[0].fields.find((field) => field.name !== 'id')?.name ?? 'id'}}`}</code>.
          </div>
        </div>
      ) : (
        <div style={styles.hint}>
          No collections yet. Design them and add sample records in the Data view.
        </div>
      )}
    </>
  );
}
