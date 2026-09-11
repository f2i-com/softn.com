import React from 'react';
import { Icon } from '../common/Icon';
import { Mark } from '../common/Mark';
import { HandoffReady } from '../common/HandoffReady';
import { SaveStatusIndicator } from '../common/SaveStatus';
import { useProjectActions } from '../common/ProjectActions';

interface TopBarProps {
  onBackToDashboard?: () => void;
}

/**
 * The desktop bar: the project's name, whether it is saved, and its three
 * ways out. The actions come from `useProjectActions`, which the mobile
 * menu shares, so the two never disagree about when Run may go.
 */
export const TopBar: React.FC<TopBarProps> = ({ onBackToDashboard }) => {
  const actions = useProjectActions();
  const { projectName, hasFiles, refused, preparing, ready } = actions;

  const goStyle = (enabled: boolean): React.CSSProperties => ({
    ...styles.exportBtn,
    opacity: enabled ? 1 : 0.4,
    cursor: enabled ? 'pointer' : 'not-allowed',
  });

  return (
    <div style={styles.bar}>
      <div style={styles.left}>
        <button onClick={onBackToDashboard} style={styles.homeBtn} title="Back to home">
          {/* The mark keeps its size when the bar gets tight; a bare <svg> in a
              flex row is shrinkable and squashes before the label wraps. */}
          <span style={styles.logo}><Mark size={26} radius={8} /></span>
          <span>Home</span>
        </button>
        <div style={styles.projectMeta}>
          <span style={styles.projectEyebrow}>SoftN Studio</span>
          <span style={styles.projectName}>{projectName || 'Untitled app'}</span>
        </div>
      </div>

      <div style={styles.right}>
        {/* Save project: where the project stands in this browser's storage.
            It stays on screen in every state, and carries Export bundle when
            a save has failed. */}
        <SaveStatusIndicator />
        {/* The theme switch is in the product bar above, shared with every
            other SoftN app; a second one here would be a second opinion. */}
        <button
          onClick={actions.run}
          disabled={!actions.canRun}
          aria-busy={preparing === 'runtime'}
          style={goStyle(hasFiles && !refused)}
          title={actions.describe('runtime', 'Run: stage the bundle for the SoftN runtime')}
        >
          <Icon name="play" size={16} />
          <span>{preparing === 'runtime' ? 'Preparing…' : 'Run'}</span>
        </button>
        <button
          onClick={actions.publish}
          disabled={!actions.canPublish}
          aria-busy={preparing === 'publish'}
          style={goStyle(hasFiles && !refused)}
          title={actions.describe('publish', 'Publish: stage the bundle for the directory’s publish page')}
        >
          <Icon name="upload" size={16} />
          <span>{preparing === 'publish' ? 'Preparing…' : 'Publish'}</span>
        </button>
        <button
          onClick={actions.exportBundle}
          disabled={!actions.canExport}
          style={goStyle(hasFiles)}
          title={hasFiles ? 'Export bundle: download the project as a .softn file' : 'No files to export'}
        >
          <Icon name="export" size={16} />
          <span>Export bundle</span>
        </button>
      </div>
      {ready && (
        <div style={styles.readyDock}>
          <HandoffReady ready={ready} onDone={actions.dismissReady} />
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  bar: {
    position: 'relative',
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
  // The ready link hangs under the bar's right end, over the panels, so the
  // bar keeps its height and the link is next to the button that made it.
  readyDock: {
    position: 'absolute',
    top: '100%',
    right: 14,
    marginTop: 6,
    zIndex: 20,
    maxWidth: 'min(520px, calc(100vw - 28px))',
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
    display: 'flex',
    flexShrink: 0,
  },
  projectMeta: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  projectEyebrow: {
    fontFamily: 'var(--studio-mono)',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
    color: 'var(--studio-accent)',
  },
  projectName: {
    fontFamily: 'var(--studio-display)',
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: 'var(--studio-text)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
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
    flexShrink: 0,
  },
};
