import React, { useMemo } from 'react';
import { useWorkspaceStore, useAIStore, useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';

export const StatusBar: React.FC = () => {
  const { mode, errors, blueprint } = useWorkspaceStore();
  const { agentState } = useAIStore();
  const { files } = useVFSStore();

  const target = blueprint?.target ?? 'web';
  const errorCount = errors.filter((e) => e.level === 'error').length;
  const warnCount = errors.filter((e) => e.level === 'warning').length;

  // Estimate bundle size (memoized — TextEncoder is expensive per-render)
  const sizeLabel = useMemo(() => {
    let bundleSize = 0;
    for (const f of files.values()) {
      if (typeof f.content === 'string') {
        bundleSize += new TextEncoder().encode(f.content).length;
      } else {
        bundleSize += f.content.length;
      }
    }
    return bundleSize < 1024
      ? `${bundleSize} B`
      : bundleSize < 1024 * 1024
      ? `${(bundleSize / 1024).toFixed(1)} KB`
      : `${(bundleSize / (1024 * 1024)).toFixed(1)} MB`;
  }, [files]);

  return (
    <div style={styles.bar}>
      <div style={styles.left}>
        <div style={styles.item}>
          <div style={{
            ...styles.statusDot,
            background: agentState === 'idle' ? 'var(--studio-text-dim)'
              : agentState === 'error' ? 'var(--studio-error)'
              : 'var(--studio-live)',
          }} />
          <span>Agent: {agentState}</span>
        </div>

        {errorCount > 0 && (
          <div style={{ ...styles.item, color: 'var(--studio-error)' }}>
            <Icon name="alert-circle" size={12} color="var(--studio-error)" />
            {errorCount} error{errorCount > 1 ? 's' : ''}
          </div>
        )}
        {warnCount > 0 && (
          <div style={{ ...styles.item, color: 'var(--studio-warning)' }}>
            <Icon name="warning" size={12} color="var(--studio-warning)" />
            {warnCount} warning{warnCount > 1 ? 's' : ''}
          </div>
        )}
      </div>

      <div style={styles.right}>
        <div style={styles.item}>
          <Icon name="file" size={12} />
          Files: {files.size}
        </div>
        <div style={styles.item}>
          <Icon name="download" size={12} />
          Bundle: {sizeLabel}
        </div>
        <div style={styles.item}>
          Target: {target.charAt(0).toUpperCase() + target.slice(1)}
        </div>
        <div style={styles.item}>
          Mode: {mode}
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  bar: {
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px',
    background: 'linear-gradient(180deg, var(--studio-bg-elevated) 0%, var(--studio-bg-muted) 100%)',
    borderTop: '1px solid var(--studio-border)',
    fontFamily: 'var(--studio-mono)',
    fontSize: 11,
    color: 'var(--studio-text-muted)',
    flexShrink: 0,
  },
  left: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 8px',
    borderRadius: 999,
    background: 'var(--studio-panel)',
    border: '1px solid var(--studio-border)',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
  },
};
