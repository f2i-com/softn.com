import { isHostedEditor } from '@softn/editor-shared/hostedEditor';
import { useHostedSaveLabel } from '@softn/editor-shared/useHostedSaveLabel';
import React from 'react';
import { Icon } from '../common/Icon';
import { Mark } from '../common/Mark';
import { HandoffReady } from '../common/HandoffReady';
import { ProjectActionError } from '../common/ProjectActionError';
import { SaveStatusIndicator } from '../common/SaveStatus';
import { useProjectActions } from '../common/ProjectActions';
import { AIStatusPill } from '../ai/AIStatusPill';

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
  const { projectName, hasFiles, preparing, ready } = actions;

  const hosted = isHostedEditor();
  // The host's own name for saving back to it, so the two buttons agree.
  const saveLabel = useHostedSaveLabel() ?? 'Review changes';

  return (
    <div className="st-topbar">
      <div className="st-topbar-left">
        {!hosted && <button type="button" onClick={onBackToDashboard} className="st-home-btn" title="Back to home" aria-label="Home">
          {/* The mark keeps its size when the bar gets tight; a bare <svg> in a
              flex row is shrinkable and squashes before the label wraps. */}
          <span style={styles.logo}><Mark size={24} radius={7} /></span>
          <span>Home</span>
        </button>}
        {!hosted && <span className="st-topbar-divider" aria-hidden="true" />}
        <div className="st-project">
          {/* The product bar above already says Studio; only a hosted editor,
              which has no product bar, needs to say whose editor this is. */}
          {hosted && <span className="st-project-eyebrow">AI Studio</span>}
          <span className="st-project-name">{projectName || 'Untitled app'}</span>
        </div>
      </div>

      <div className="st-topbar-right">
        {/* Which provider and model the AI uses, or what it is missing —
            always a button to the setup. A hosted editor's AI is its host's. */}
        {!hosted && <AIStatusPill />}
        {/* Save project: where the project stands in this browser's storage.
            It stays on screen in every state, and carries Export bundle when
            a save has failed. */}
        <SaveStatusIndicator />
        {/* The theme switch is in the product bar above, shared with every
            other SoftN app; a second one here would be a second opinion. */}
        <button
          type="button"
          onClick={actions.exportBundle}
          disabled={!actions.canExport}
          className="st-btn st-btn-sm"
          title={hasFiles ? 'Export bundle: download the project as a .softn file' : 'No files to export'}
        >
          <Icon name="export" size={15} />
          <span>Export bundle</span>
        </button>
        <button
          type="button"
          onClick={actions.publish}
          disabled={!actions.canPublish}
          aria-busy={preparing === 'publish'}
          className={hosted ? 'st-btn st-btn-sm st-btn-primary' : 'st-btn st-btn-sm'}
          title={actions.describe('publish', hosted ? 'Return your changes to FormLogic' : 'Publish: stage the bundle for the directory’s publish page')}
        >
          <Icon name="upload" size={15} />
          <span>{preparing === 'publish' ? 'Preparing…' : hosted ? saveLabel : 'Publish'}</span>
        </button>
        {/* Run is the one to press first: it is the only way to see the app
            with the capabilities the preview does not grant. */}
        {!hosted && <button
          type="button"
          onClick={actions.run}
          disabled={!actions.canRun}
          aria-busy={preparing === 'runtime'}
          className="st-btn st-btn-sm st-btn-primary"
          title={actions.describe('runtime', 'Run: stage the bundle for the SoftN runtime')}
        >
          <Icon name="play" size={15} />
          <span>{preparing === 'runtime' ? 'Preparing…' : 'Run'}</span>
        </button>}
      </div>
      {(ready || actions.error) && (
        <div style={styles.readyDock}>
          {actions.error ? <ProjectActionError message={actions.error} onDismiss={actions.dismissError} />
            : ready && <HandoffReady ready={ready} onDone={actions.dismissReady} />}
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
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
  logo: {
    display: 'flex',
    flexShrink: 0,
  },
};
