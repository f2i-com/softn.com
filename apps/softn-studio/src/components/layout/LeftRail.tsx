import React, { useState } from 'react';
import { useWorkspaceStore } from '../../stores';
import { Icon } from '../common/Icon';
import type { LeftPanel } from '../../types/studio';

const topPanels: { id: LeftPanel; icon: Parameters<typeof Icon>[0]['name']; label: string }[] = [
  { id: 'ai', icon: 'ai', label: 'AI' },
  { id: 'files', icon: 'folder', label: 'Files' },
  { id: 'pages', icon: 'pages', label: 'Pages' },
  { id: 'settings', icon: 'settings', label: 'Settings' },
];

const allPanels = [...topPanels, { id: 'history' as LeftPanel, icon: 'clock' as const, label: 'History' }];

export const LeftRail: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const { leftPanel, leftPanelExpanded, setLeftPanel } = useWorkspaceStore();
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);

  const toggle = (id: LeftPanel) =>
    setLeftPanel(leftPanel === id && leftPanelExpanded ? null : id);

  const renderBtn = (p: { id: LeftPanel; icon: Parameters<typeof Icon>[0]['name']; label: string }) => (
    <button
      key={p.id}
      onClick={() => toggle(p.id)}
      onMouseEnter={() => setHoveredBtn(p.id)}
      onMouseLeave={() => setHoveredBtn(null)}
      style={{
        ...styles.railBtn,
        ...(leftPanel === p.id && leftPanelExpanded ? styles.railBtnActive : {}),
        ...(hoveredBtn === p.id ? styles.railBtnHover : {}),
      }}
      title={p.label}
    >
      <div style={styles.railBtnGlow} />
      <Icon name={p.icon} size={20} />
      <span style={styles.railLabel}>{p.label}</span>
    </button>
  );

  return (
    <div style={styles.container}>
      {/* Icon rail */}
      <div style={styles.rail}>
        {topPanels.map(renderBtn)}
        <div style={styles.spacer} />
        {renderBtn({ id: 'history', icon: 'clock', label: 'History' })}
      </div>

      {/* Expanded panel */}
        {leftPanel && leftPanelExpanded && (
          <div style={{ ...styles.panel, ...(leftPanel === 'ai' ? styles.aiPanel : {}) }}>
            <div style={styles.panelHeader}>
              <div>
                <span style={styles.panelEyebrow}>Studio Panel</span>
                <div style={styles.panelTitleRow}>
                  <span style={styles.panelTitle}>
                    {allPanels.find((p) => p.id === leftPanel)?.label}
                  </span>
                  <span style={styles.panelCount}>{leftPanel.toUpperCase()}</span>
                </div>
              </div>
              <button onClick={() => setLeftPanel(null)} style={styles.closeBtn} title="Close panel">
                <Icon name="x" size={16} />
              </button>
            </div>
            <div style={styles.panelContent}>
              {children}
            </div>
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexShrink: 0,
    height: '100%',
  },
  rail: {
    width: 56,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '10px 0',
    gap: 4,
    background: 'var(--studio-bg-elevated)',
    borderRight: '1px solid var(--studio-border)',
    boxShadow: 'inset -1px 0 0 var(--studio-border-subtle)',
    flexShrink: 0,
  },
  railBtn: {
    width: 44,
    height: 44,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    border: 'none',
    background: 'transparent',
    color: 'var(--studio-text-muted)',
    borderRadius: 12,
    cursor: 'pointer',
    transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
    padding: 0,
    position: 'relative',
    overflow: 'hidden',
  },
  railBtnGlow: {
    position: 'absolute',
    inset: 0,
    background: 'radial-gradient(circle at top, rgba(56,189,248,0.18), transparent 70%)',
    opacity: 0,
    transition: 'opacity 0.2s ease',
    pointerEvents: 'none',
  },
  railBtnActive: {
    color: 'var(--studio-text)',
    background: 'linear-gradient(180deg, var(--studio-accent-soft), rgba(37,99,235,0.14))',
    boxShadow: '0 10px 20px rgba(2, 132, 199, 0.18), inset 0 1px 0 rgba(255,255,255,0.06)',
    transform: 'translateY(-1px)',
  },
  railBtnHover: {
    color: 'var(--studio-text)',
    background: 'var(--studio-panel)',
  },
  railLabel: {
    fontSize: 9,
    fontWeight: 700,
    lineHeight: 1,
    letterSpacing: '0.04em',
  },
  spacer: {
    flex: 1,
  },
  panel: {
    width: 300,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--studio-bg-muted)',
    borderRight: '1px solid var(--studio-border)',
    boxShadow: '12px 0 30px rgba(2, 6, 23, 0.28)',
    overflow: 'hidden',
  },
  aiPanel: {
    width: 380,
  },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 16px',
    borderBottom: '1px solid var(--studio-border)',
    background: 'linear-gradient(180deg, var(--studio-bg-elevated), var(--studio-panel))',
    flexShrink: 0,
  },
  panelEyebrow: {
    display: 'block',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.14em',
    textTransform: 'uppercase' as const,
    color: 'var(--studio-accent)',
    marginBottom: 4,
  },
  panelTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  panelTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--studio-text)',
  },
  panelCount: {
    padding: '2px 8px',
    borderRadius: 999,
    background: 'var(--studio-accent-soft)',
    color: 'var(--studio-accent)',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
  },
  closeBtn: {
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'var(--studio-panel)',
    color: 'var(--studio-text-muted)',
    borderRadius: 8,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  panelContent: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    minHeight: 0,
    background: 'var(--studio-surface)',
  },
};
