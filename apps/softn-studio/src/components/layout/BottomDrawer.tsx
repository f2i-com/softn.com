import React, { useEffect, useRef } from 'react';
import { useWorkspaceStore } from '../../stores';
import { Icon } from '../common/Icon';

export const BottomDrawer: React.FC = () => {
  const {
    bottomDrawerOpen, toggleBottomDrawer,
    consoleOutput, clearConsole,
  } = useWorkspaceStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new output arrives
  useEffect(() => {
    if (bottomDrawerOpen && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [bottomDrawerOpen, consoleOutput.length]);

  const logCount = consoleOutput.length;

  if (!bottomDrawerOpen) {
    return (
      <div style={s.collapsed}>
        <button onClick={toggleBottomDrawer} style={s.collapsedBtn}>
          <Icon name="terminal" size={13} />
          Log
          {logCount > 0 && <span style={s.badge}>{logCount}</span>}
        </button>
      </div>
    );
  }

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div style={s.headerLeft}>
          <Icon name="terminal" size={13} color="var(--studio-accent)" />
          <span style={s.title}>Log</span>
          <span style={s.count}>{logCount} entries</span>
        </div>
        <div style={s.headerRight}>
          {logCount > 0 && (
            <button onClick={clearConsole} style={s.clearBtn}>Clear</button>
          )}
          <button onClick={toggleBottomDrawer} style={s.closeBtn} title="Minimize">
            <Icon name="minimize" size={14} />
          </button>
        </div>
      </div>

      <div ref={scrollRef} style={s.content}>
        {logCount === 0 ? (
          <div style={s.empty}>
            <Icon name="terminal" size={18} color="var(--studio-text-dim)" />
            <span style={s.emptyLabel}>No log entries yet</span>
          </div>
        ) : (
          consoleOutput.map((line, i) => {
            const isAI = line.startsWith('[AI]') || line.startsWith('[Architect]') || line.startsWith('[Builder]');
            const isError = line.toLowerCase().includes('error') || line.toLowerCase().includes('failed');
            const isImport = line.startsWith('Imported') || line.startsWith('  +') || line.startsWith('  ...');
            const isExport = line.startsWith('Exported') || line.startsWith('[Export]');

            let iconName: Parameters<typeof Icon>[0]['name'] = 'terminal';
            let iconColor = 'var(--studio-text-dim)';
            if (isAI) { iconName = 'ai'; iconColor = 'var(--studio-accent)'; }
            else if (isError) { iconName = 'alert-circle'; iconColor = 'var(--studio-error)'; }
            else if (isImport) { iconName = 'upload'; iconColor = 'var(--studio-success)'; }
            else if (isExport) { iconName = 'export'; iconColor = 'var(--studio-success)'; }

            return (
              <div key={i} style={s.logLine}>
                <Icon name={iconName} size={12} color={iconColor} />
                <span style={{
                  ...s.logText,
                  color: isError ? 'var(--studio-error)' : isAI ? 'var(--studio-text)' : 'var(--studio-text-muted)',
                }}>{line}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  collapsed: {
    height: 32,
    borderTop: '1px solid var(--studio-border)',
    background: 'var(--studio-bg-elevated)',
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    padding: '0 8px',
  },
  collapsedBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '5px 10px',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--studio-text-muted)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  badge: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    background: 'var(--studio-accent-soft)',
    color: 'var(--studio-accent)',
    fontSize: 10,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 4px',
  },
  container: {
    height: 180,
    display: 'flex',
    flexDirection: 'column',
    borderTop: '1px solid var(--studio-border)',
    background: 'var(--studio-bg-elevated)',
    flexShrink: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 10px',
    borderBottom: '1px solid var(--studio-border)',
    flexShrink: 0,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  title: {
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--studio-text)',
  },
  count: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--studio-text-dim)',
    padding: '2px 6px',
    borderRadius: 999,
    background: 'var(--studio-surface)',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  clearBtn: {
    padding: '4px 8px',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--studio-text-muted)',
    background: 'var(--studio-surface)',
    border: '1px solid var(--studio-border)',
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  closeBtn: {
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: 'var(--studio-text-muted)',
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  content: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
  },
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: '100%',
  },
  emptyLabel: {
    fontSize: 12,
    color: 'var(--studio-text-dim)',
  },
  logLine: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '6px 12px',
    borderBottom: '1px solid var(--studio-border-subtle)',
  },
  logText: {
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    flex: 1,
    minWidth: 0,
  },
};
