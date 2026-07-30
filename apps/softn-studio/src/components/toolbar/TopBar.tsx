import React from 'react';
import { useWorkspaceStore, useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';
import { exportAsBundle } from '../../lib/exportBundle';
import { STUDIO_ICON } from '../../lib/assets';

interface TopBarProps {
  onBackToDashboard?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ onBackToDashboard }) => {
  const { projectName, themePreview, setThemePreview } = useWorkspaceStore();
  const { files } = useVFSStore();
  const hasFiles = files.size > 0;

  return (
    <div style={styles.bar}>
      <div style={styles.left}>
        <button onClick={onBackToDashboard} style={styles.homeBtn} title="Back to home">
          <div style={styles.logo}><img src={STUDIO_ICON} alt="SoftN Studio" style={styles.logoImage} /></div>
          <span>Home</span>
        </button>
        <div style={styles.projectMeta}>
          <span style={styles.projectEyebrow}>SoftN Studio</span>
          <span style={styles.projectName}>{projectName || 'Untitled app'}</span>
        </div>
      </div>

      <div style={styles.right}>
        <button
          onClick={() => setThemePreview(themePreview === 'light' ? 'dark' : 'light')}
          style={styles.iconBtn}
          title="Toggle theme"
        >
          <Icon name={themePreview === 'light' ? 'moon' : 'sun'} size={16} />
        </button>

        <button
          onClick={() => {
            if (!hasFiles) return;
            try {
              exportAsBundle(files, projectName);
              useWorkspaceStore.getState().addConsoleOutput(`Exported ${files.size} files as ${projectName || 'app'}.softn`);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              useWorkspaceStore.getState().addConsoleOutput(`Export failed: ${msg}`);
            }
          }}
          disabled={!hasFiles}
          style={{ ...styles.exportBtn, opacity: hasFiles ? 1 : 0.4, cursor: hasFiles ? 'pointer' : 'not-allowed' }}
          title={hasFiles ? 'Export .softn bundle' : 'No files to export'}
        >
          <Icon name="export" size={16} />
          <span>Export</span>
        </button>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 52,
    padding: '0 14px',
    gap: 14,
    background: 'var(--studio-bg-elevated)',
    borderBottom: '1px solid var(--studio-border)',
    flexShrink: 0,
  },
  left: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    minWidth: 0,
  },
  homeBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 10px',
    borderRadius: 999,
    border: '1px solid var(--studio-border)',
    background: 'var(--studio-panel)',
    color: 'var(--studio-text)',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  logo: {
    width: 26,
    height: 26,
    borderRadius: 8,
    overflow: 'hidden',
    flexShrink: 0,
  },
  logoImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
    display: 'block',
  },
  projectMeta: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  projectEyebrow: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
    color: 'var(--studio-accent)',
  },
  projectName: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--studio-text)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  iconBtn: {
    width: 34,
    height: 34,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    border: '1px solid var(--studio-border)',
    background: 'var(--studio-panel)',
    color: 'var(--studio-text)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  exportBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderRadius: 10,
    border: '1px solid var(--studio-border)',
    background: 'var(--studio-panel)',
    color: 'var(--studio-text)',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
