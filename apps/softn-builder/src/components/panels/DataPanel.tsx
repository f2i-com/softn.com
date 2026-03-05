/**
 * DataPanel - Simplified data panel pointing to Schema Designer
 */

import React from 'react';
import { useSchemaStore } from '../../stores/schemaStore';

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: '#fff',
    borderTop: '1px solid #e2e8f0',
    padding: 16,
  },
  header: {
    fontWeight: 600,
    fontSize: 12,
    color: '#64748b',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: 12,
  },
  content: {
    fontSize: 13,
    color: '#64748b',
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
    color: '#1e293b',
  },
  hint: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 8,
  },
  entityList: {
    marginTop: 8,
  },
  entityItem: {
    padding: '4px 8px',
    background: '#f8fafc',
    borderRadius: 4,
    marginBottom: 4,
    fontSize: 12,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  entityName: {
    fontWeight: 500,
    color: '#1e293b',
  },
  entityRecords: {
    fontSize: 11,
    color: '#64748b',
  },
};

export function DataPanel() {
  const { entities, seedData } = useSchemaStore();

  const totalRecords = Array.from(seedData.values()).reduce(
    (sum, records) => sum + records.length,
    0
  );

  return (
    <div style={styles.container}>
      <div style={styles.header}>Data Overview</div>

      <div style={styles.stats}>
        <div style={styles.stat}>
          <span style={styles.statValue}>{entities.length}</span>
          <span>entities</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statValue}>{totalRecords}</span>
          <span>records</span>
        </div>
      </div>

      {entities.length > 0 ? (
        <div style={styles.entityList}>
          {entities.map((entity) => {
            const records = seedData.get(entity.id) || [];
            return (
              <div key={entity.id} style={styles.entityItem}>
                <span style={styles.entityName}>{entity.name}</span>
                <span style={styles.entityRecords}>
                  {records.length} record{records.length !== 1 ? 's' : ''}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={styles.hint}>
          Use the &quot;Data&quot; view to design your database schema and add seed data.
        </div>
      )}
    </div>
  );
}
