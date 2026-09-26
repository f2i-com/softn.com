/**
 * Toolbar - Main toolbar with actions
 */

import React from 'react';
import { useHostedSaveLabel } from '@softn/editor-shared/useHostedSaveLabel';
import { useCanvasStore } from '../../stores/canvasStore';
import { useProjectStore } from '../../stores/projectStore';
import { useHistoryStore } from '../../stores/historyStore';
import { useInstallPrompt } from './useInstallPrompt';
import { viewsFor } from '../../utils/workspaceViews';
import { withMod } from '../../utils/platformKeys';

// The controls are classes in styles/builder.css (.bl-tool, .bl-seg), which
// can draw hover and focus; these are only the row's own layout.
const styles: Record<string, React.CSSProperties> = {
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 12px',
    minHeight: 44,
    background: 'var(--ink-2)',
    borderBottom: '1px solid var(--line-soft)',
    gap: 4,
  },
  divider: {
    width: 1,
    height: 20,
    background: 'var(--line)',
    margin: '0 8px',
    flexShrink: 0,
  },
  spacer: {
    flex: 1,
  },
  projectName: {
    fontFamily: 'var(--display)',
    fontWeight: 700,
    fontSize: 15,
    letterSpacing: '-0.02em',
    color: 'var(--paper)',
    maxWidth: 240,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    padding: '0 4px',
  },
  dirty: {
    fontFamily: 'var(--body)',
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: 0,
    color: 'var(--dim)',
    marginLeft: 8,
  },
};

function IconNew() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 1.5H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15.5h8a1.5 1.5 0 0 0 1.5-1.5V6L9 1.5z"/>
      <polyline points="9 1.5 9 6 13.5 6"/>
      <line x1="8" y1="9" x2="8" y2="13"/>
      <line x1="6" y1="11" x2="10" y2="11"/>
    </svg>
  );
}

function IconOpen() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.5 12.5a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5V3.5A1.5 1.5 0 0 1 3 2h3.5L8 4h5a1.5 1.5 0 0 1 1.5 1.5v7z"/>
    </svg>
  );
}

function IconSave() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.5 14.5H3.5a1.5 1.5 0 0 1-1.5-1.5V3a1.5 1.5 0 0 1 1.5-1.5h7l3.5 3.5V13a1.5 1.5 0 0 1-1.5 1.5z"/>
      <polyline points="10.5 1.5 10.5 5 5.5 5 5.5 1.5"/>
      <rect x="5" y="9" width="6" height="4" rx="0.5"/>
    </svg>
  );
}

function IconExport() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 10.5V1.5" />
      <polyline points="4.5 5.5 8 1.5 11.5 5.5" />
      <path d="M2.5 10.5v2.5A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5v-2.5" />
    </svg>
  );
}

function IconInstall() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="8" y1="1.5" x2="8" y2="10" />
      <polyline points="4.5 6.5 8 10 11.5 6.5" />
      <path d="M2.5 11.5v1.5A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
    </svg>
  );
}

/** Sentence-case names for the workspace views, in the order Ctrl+1..4 reach them. */
const VIEW_LABELS: Record<'design' | 'preview' | 'code' | 'data', string> = {
  design: 'Design',
  data: 'Data',
  preview: 'Preview',
  code: 'Code',
};

/** The digit each view answers to; useWorkspaceShortcuts holds the same map. */
const VIEW_KEYS: Record<'design' | 'preview' | 'code' | 'data', number> = { design: 1, data: 2, preview: 3, code: 4 };

function IconUndo() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="5 3 2 6 5 9" />
      <path d="M2 6h7.5a4 4 0 0 1 0 8H7" />
    </svg>
  );
}

function IconRedo() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="11 3 14 6 11 9" />
      <path d="M14 6H6.5a4 4 0 0 0 0 8H9" />
    </svg>
  );
}

function IconKeyboard() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="4" width="13" height="8.5" rx="1.5" />
      <path d="M4 6.75h.01M6.5 6.75h.01M9 6.75h.01M11.5 6.75h.01M4.5 9.75h7" />
    </svg>
  );
}

interface ToolbarProps {
  view: 'design' | 'preview' | 'code' | 'data';
  onViewChange: (view: 'design' | 'preview' | 'code' | 'data') => void;
  onSave: () => void;
  isSaving?: boolean;
  onNew: () => void;
  onOpen: () => void;
  onShortcuts: () => void;
  onExport: () => void;
  activeFileType?: 'ui' | 'logic' | 'asset' | null;
}


export function Toolbar({
  view,
  onViewChange,
  onSave,
  isSaving = false,
  onNew,
  onOpen,
  onShortcuts,
  onExport,
  activeFileType,
}: ToolbarProps) {
  const { name, isDirty } = useProjectStore();
  const { canUndo, canRedo, undo, redo } = useHistoryStore();
  const { canInstall, promptInstall } = useInstallPrompt();
  // Hosted, the host's own name for saving back to it, so its button and this one agree.
  const saveLabel = useHostedSaveLabel() ?? 'Save';

  // The history store never holds the current canvas — callers push before
  // mutating — so stepping in either direction has to hand it over.
  const currentEntry = () => {
    const canvas = useCanvasStore.getState();
    return { elements: canvas.elements, rootId: canvas.rootId, timestamp: Date.now() };
  };

  const handleUndo = () => {
    const entry = undo(currentEntry());
    if (entry) {
      useCanvasStore.getState().loadState(entry.elements, entry.rootId);
    }
  };

  const handleRedo = () => {
    const entry = redo(currentEntry());
    if (entry) {
      useCanvasStore.getState().loadState(entry.elements, entry.rootId);
    }
  };

  const views = viewsFor(activeFileType);
  const undoable = canUndo();
  const redoable = canRedo();

  return (
    <div style={styles.toolbar} role="toolbar" aria-label="Project">
      {/* The product bar above already says this is Builder; this row is the
          project's. */}
      <span style={styles.projectName} title={isDirty ? `${name} — unsaved changes` : name}>
        {name}
      </span>
      {isDirty && (
        <span style={styles.dirty} data-dirty="true">
          Unsaved
        </span>
      )}

      <div style={styles.divider} />

      <button className="bl-tool" onClick={handleUndo} disabled={!undoable} title={`Undo (${withMod('Z')})`}>
        <IconUndo /> Undo
      </button>

      <button className="bl-tool" onClick={handleRedo} disabled={!redoable} title={`Redo (${withMod('Y')})`}>
        <IconRedo /> Redo
      </button>

      <div style={styles.spacer} />

      {views.length > 1 && (
        <div className="bl-seg" role="group" aria-label="Workspace view">
          {views.map((v) => (
            <button
              key={v}
              aria-pressed={view === v}
              onClick={() => onViewChange(v)}
              title={`${VIEW_LABELS[v]} (${withMod(String(VIEW_KEYS[v]))})`}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
      )}

      <div style={styles.spacer} />

      <button className="bl-tool" onClick={onNew} title={`New app (${withMod('N')})`}>
        <IconNew /> New
      </button>

      <button className="bl-tool" onClick={onOpen} title={`Open a .softn file (${withMod('O')})`}>
        <IconOpen /> Open
      </button>

      <button className="bl-tool" onClick={onSave} disabled={isSaving} aria-busy={isSaving} title={`Save (${withMod('S')})`}>
        <IconSave /> {isSaving ? 'Saving…' : saveLabel}
      </button>

      {/* Export had no control anywhere in the app. Its only route was
          Ctrl+Shift+E, a shortcut whose condition could never be true, so the
          feature was unreachable by any means. */}
      <button className="bl-tool" onClick={onExport} title={`Export, run or publish (${withMod('Shift+E')})`}>
        <IconExport /> Export
      </button>

      {canInstall && (
        <button className="bl-tool" onClick={promptInstall} title="Install SoftN Builder as an app">
          <IconInstall /> Install
        </button>
      )}

      <div style={styles.divider} />

      <button className="bl-tool" onClick={onShortcuts} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
        <IconKeyboard />
      </button>
    </div>
  );
}
