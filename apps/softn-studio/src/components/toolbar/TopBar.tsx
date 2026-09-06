import React from 'react';
import { useWorkspaceStore, useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';
import { Mark } from '../common/Mark';
import { buildBundle, exportAsBundle } from '../../lib/exportBundle';
import { RUNTIME_URL, SITE_URL } from '../../lib/siteUrls';
import { stageBundleHandoff, handoffUrl } from '@softn/core';

interface TopBarProps {
  onBackToDashboard?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ onBackToDashboard }) => {
  const { projectName, errors } = useWorkspaceStore();
  const { files } = useVFSStore();
  const hasFiles = files.size > 0;
  // The validator runs the inspector the directory runs; an error there is a
  // bundle the directory would refuse, so the two buttons that send it on
  // wait until it is fixed. Export stays: a file on disk can be looked at.
  const refused = errors.some((e) => e.level === 'error' && e.type === 'bundle-refused');

  /**
   * Stage the bundle for the runtime or the publish page and open it. Both
   * are pages of this origin in a deployment; in development they are other
   * ports, and the page opens without the bundle and says so.
   */
  const handOff = async (to: 'runtime' | 'publish') => {
    if (!hasFiles) return;
    const log = useWorkspaceStore.getState().addConsoleOutput;
    try {
      const bytes = buildBundle(files);
      const staged = await stageBundleHandoff(bytes, projectName || 'app', 'studio');
      if (!staged) {
        log('This browser could not hold the bundle for the next page. Export it and open the file there instead.');
        return;
      }
      const target = handoffUrl(to === 'runtime' ? RUNTIME_URL : SITE_URL, to);
      const opened = window.open(target, '_blank', 'noopener');
      if (!opened) window.location.assign(target);
      log(to === 'runtime' ? 'Opened the bundle in the runtime.' : 'Handed the bundle to the publish page.');
    } catch (err: unknown) {
      log(`Hand-off failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

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
        {/* The theme switch is in the product bar above, shared with every
            other SoftN app; a second one here would be a second opinion. */}
        <button
          onClick={() => void handOff('runtime')}
          disabled={!hasFiles || refused}
          style={{ ...styles.exportBtn, opacity: hasFiles && !refused ? 1 : 0.4, cursor: hasFiles && !refused ? 'pointer' : 'not-allowed' }}
          title={refused ? 'Fix what the validator found first' : hasFiles ? 'Open the bundle in the SoftN runtime' : 'No files to run'}
        >
          <Icon name="play" size={16} />
          <span>Run</span>
        </button>
        <button
          onClick={() => void handOff('publish')}
          disabled={!hasFiles || refused}
          style={{ ...styles.exportBtn, opacity: hasFiles && !refused ? 1 : 0.4, cursor: hasFiles && !refused ? 'pointer' : 'not-allowed' }}
          title={refused ? 'Fix what the validator found first' : hasFiles ? 'Hand the bundle to the directory’s publish page' : 'No files to publish'}
        >
          <Icon name="upload" size={16} />
          <span>Publish</span>
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
