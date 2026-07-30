import React from 'react';
import { useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';

export const HistoryPanel: React.FC = () => {
  const { history, revertAIChanges, undoLast } = useVFSStore();

  const aiChanges = history.filter((e) => e.source === 'ai');

  return (
    <div style={styles.container}>
      {history.length === 0 ? (
        <div style={styles.empty}>
          <Icon name="clock" size={24} color="var(--studio-text-dim)" />
          <p style={styles.emptyText}>No history</p>
          <p style={styles.emptyHint}>
            File changes will be recorded here for undo/redo.
          </p>
        </div>
      ) : (
        <>
          {/* Actions */}
          <div style={styles.actions}>
            <button onClick={undoLast} style={styles.actionBtn}>
              <Icon name="undo" size={14} />
              Undo Last
            </button>
            {aiChanges.length > 0 && (
              <button onClick={revertAIChanges} style={{ ...styles.actionBtn, color: 'var(--studio-error)' }}>
                <Icon name="undo" size={14} color="var(--studio-error)" />
                Revert AI Changes
              </button>
            )}
          </div>

          {/* Timeline */}
          <div style={styles.timeline}>
            {[...history].reverse().slice(0, 50).map((event) => (
              <div key={`${event.path}:${event.timestamp}`} style={styles.timelineItem}>
                <div style={{
                  ...styles.dot,
                  background: event.source === 'ai' ? 'var(--studio-accent)' : 'var(--studio-text-dim)',
                }} />
                <div style={styles.eventInfo}>
                  <span style={styles.eventType}>{event.type}</span>
                  <span style={styles.eventPath}>{event.path}</span>
                </div>
                <span style={styles.eventTime}>
                  {new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  empty: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    padding: 24, textAlign: 'center', gap: 4,
  },
  emptyText: { fontSize: 13, color: 'var(--studio-text-dim)', margin: '8px 0 0' },
  emptyHint: { fontSize: 11, color: 'var(--studio-text-dim)', lineHeight: 1.4, margin: '4px 0 12px' },
  actions: {
    display: 'flex', gap: 6, padding: '8px 12px',
    borderBottom: '1px solid var(--studio-border)',
    flexShrink: 0,
  },
  actionBtn: {
    display: 'flex', alignItems: 'center', gap: 5,
    padding: '6px 10px', border: '1px solid var(--studio-border)',
    borderRadius: 6, background: 'transparent',
    color: 'var(--studio-text-muted)', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
  },
  timeline: {
    flex: 1, overflow: 'auto', minHeight: 0, padding: '8px 12px',
  },
  timelineItem: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 0', borderBottom: '1px solid var(--studio-border-subtle)',
  },
  dot: {
    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
  },
  eventInfo: {
    flex: 1, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0,
  },
  eventType: {
    fontFamily: 'var(--studio-mono)',
    fontSize: 11, fontWeight: 600, color: 'var(--studio-text-muted)', textTransform: 'capitalize' as const,
  },
  eventPath: {
    fontSize: 10, color: 'var(--studio-text-dim)', fontFamily: 'var(--studio-mono)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  eventTime: {
    fontFamily: 'var(--studio-mono)',
    fontSize: 10, color: 'var(--studio-text-dim)', flexShrink: 0,
  },
};
