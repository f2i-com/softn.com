import React, { useState } from 'react';
import { useWorkspaceStore, useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';
import { Mark } from '../common/Mark';
import { HandoffReady } from '../common/HandoffReady';
import { exportAsBundle } from '../../lib/exportBundle';
import { prepareHandoff, type HandoffDestination, type ReadyHandoff } from '../../lib/handoff';

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
  const [preparing, setPreparing] = useState<HandoffDestination | null>(null);
  const [ready, setReady] = useState<ReadyHandoff | null>(null);

  /**
   * Stage the bundle for the runtime or the publish page, then offer the
   * link. The editor stays where it is: the opening is the person's own
   * click on that link, in a new tab or — if they choose — this one. See
   * lib/handoff.ts for why it is not a window.open here.
   */
  const handOff = async (to: HandoffDestination) => {
    if (!hasFiles || preparing) return;
    const log = useWorkspaceStore.getState().addConsoleOutput;
    setReady(null);
    setPreparing(to);
    try {
      const outcome = await prepareHandoff(to, files, projectName);
      if (!outcome.ok) {
        log(outcome.message);
        return;
      }
      setReady(outcome.ready);
      log(to === 'runtime' ? 'The bundle is staged for the runtime. Open it from the link in the bar.' : 'The bundle is staged for the publish page. Open it from the link in the bar.');
    } catch (err: unknown) {
      log(`Hand-off failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPreparing(null);
    }
  };

  const busyTitle = (to: HandoffDestination, idle: string) => (preparing === to ? 'Preparing the bundle…' : refused ? 'Fix what the validator found first' : hasFiles ? idle : 'No files');

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
          disabled={!hasFiles || refused || preparing !== null}
          aria-busy={preparing === 'runtime'}
          style={{ ...styles.exportBtn, opacity: hasFiles && !refused ? 1 : 0.4, cursor: hasFiles && !refused ? 'pointer' : 'not-allowed' }}
          title={busyTitle('runtime', 'Stage the bundle for the SoftN runtime')}
        >
          <Icon name="play" size={16} />
          <span>{preparing === 'runtime' ? 'Preparing…' : 'Run'}</span>
        </button>
        <button
          onClick={() => void handOff('publish')}
          disabled={!hasFiles || refused || preparing !== null}
          aria-busy={preparing === 'publish'}
          style={{ ...styles.exportBtn, opacity: hasFiles && !refused ? 1 : 0.4, cursor: hasFiles && !refused ? 'pointer' : 'not-allowed' }}
          title={busyTitle('publish', 'Stage the bundle for the directory’s publish page')}
        >
          <Icon name="upload" size={16} />
          <span>{preparing === 'publish' ? 'Preparing…' : 'Publish'}</span>
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
      {ready && (
        <div style={styles.readyDock}>
          <HandoffReady ready={ready} onDone={() => setReady(null)} />
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
