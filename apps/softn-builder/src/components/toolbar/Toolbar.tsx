/**
 * Toolbar - Main toolbar with actions
 */

import React from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useProjectStore } from '../../stores/projectStore';
import { useHistoryStore } from '../../stores/historyStore';
import { useInstallPrompt } from './useInstallPrompt';

const styles: Record<string, React.CSSProperties> = {
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    padding: '10px 16px',
    background: 'linear-gradient(180deg, #ffffff 0%, #f4f6f9 100%)',
    borderBottom: '1px solid #e4e9f0',
    gap: 8,
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginRight: 16,
  },
  logoText: {
    fontFamily: 'var(--b-display)',
    fontWeight: 600,
    fontSize: 16,
    letterSpacing: '-0.02em',
    color: '#14181d',
  },
  divider: {
    width: 1,
    height: 24,
    background: '#e4e9f0',
    margin: '0 8px',
  },
  button: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: 6,
    fontSize: 13,
    color: '#5a6472',
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  buttonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  spacer: {
    flex: 1,
  },
  projectName: {
    fontSize: 13,
    color: '#5a6472',
    marginLeft: 8,
    maxWidth: 220,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  viewToggle: {
    display: 'flex',
    background: '#e4e9f0',
    borderRadius: 8,
    padding: 2,
  },
  viewButton: {
    padding: '6px 12px',
    background: 'transparent',
    border: 'none',
    borderRadius: 4,
    fontSize: 12,
    color: '#5a6472',
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  viewButtonActive: {
    background: '#fff',
    color: '#14181d',
    boxShadow: '0 2px 6px rgba(15,23,42,0.12)',
  },
};

/**
 * The SoftN mark, on the same 32-unit grid as the favicon and the PWA icons.
 *
 * This was a gradient tile with an S-curve through it — a different logo from
 * the one the site, the runtime and Studio all show, so the builder announced
 * itself as another product. The tile keeps the dark ground even here, where the
 * chrome is light, because that is what the mark is: coral brackets for the
 * language, a mint dot for the thing that runs.
 */
function SoftNLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="SoftN">
      <rect width="32" height="32" rx="7" fill="#101317" />
      <path d="M9 11.5 5.5 16 9 20.5" fill="none" stroke="#FF8A4C" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M23 11.5 26.5 16 23 20.5" fill="none" stroke="#FF8A4C" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="16" r="2.8" fill="#35E0C0" />
    </svg>
  );
}

function IconNew() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 1.5H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15.5h8a1.5 1.5 0 0 0 1.5-1.5V6L9 1.5z"/>
      <polyline points="9 1.5 9 6 13.5 6"/>
      <line x1="8" y1="9" x2="8" y2="13"/>
      <line x1="6" y1="11" x2="10" y2="11"/>
    </svg>
  );
}

function IconOpen() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 12.5a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5V3.5A1.5 1.5 0 0 1 3 2h3.5L8 4h5a1.5 1.5 0 0 1 1.5 1.5v7z"/>
    </svg>
  );
}

function IconSave() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.5 14.5H3.5a1.5 1.5 0 0 1-1.5-1.5V3a1.5 1.5 0 0 1 1.5-1.5h7l3.5 3.5V13a1.5 1.5 0 0 1-1.5 1.5z"/>
      <polyline points="10.5 1.5 10.5 5 5.5 5 5.5 1.5"/>
      <rect x="5" y="9" width="6" height="4" rx="0.5"/>
    </svg>
  );
}

function IconExport() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 10.5V1.5" />
      <polyline points="4.5 5.5 8 1.5 11.5 5.5" />
      <path d="M2.5 10.5v2.5A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5v-2.5" />
    </svg>
  );
}

function IconInstall() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="1.5" x2="8" y2="10" />
      <polyline points="4.5 6.5 8 10 11.5 6.5" />
      <path d="M2.5 11.5v1.5A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
    </svg>
  );
}

interface ToolbarProps {
  view: 'design' | 'preview' | 'code' | 'data';
  onViewChange: (view: 'design' | 'preview' | 'code' | 'data') => void;
  onSave: () => void;
  onNew: () => void;
  onOpen: () => void;
  onShortcuts: () => void;
  onExport: () => void;
  activeFileType?: 'ui' | 'logic' | 'asset' | null;
}

const ALL_TABS = ['design', 'data', 'preview', 'code'] as const;
const DESIGN_ONLY_TABS = ['design'] as const;

function getVisibleTabs(fileType?: 'ui' | 'logic' | 'asset' | null) {
  if (fileType === 'logic' || fileType === 'asset') return DESIGN_ONLY_TABS;
  return ALL_TABS;
}

export function Toolbar({
  view,
  onViewChange,
  onSave,
  onNew,
  onOpen,
  onShortcuts,
  onExport,
  activeFileType,
}: ToolbarProps) {
  const { name, isDirty } = useProjectStore();
  const { canUndo, canRedo, undo, redo } = useHistoryStore();
  const { canInstall, promptInstall } = useInstallPrompt();

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

  return (
    <div style={styles.toolbar}>
      <div style={styles.logo}>
        <SoftNLogo size={28} />
        <span style={styles.logoText}>SoftN Builder</span>
      </div>

      <span style={styles.projectName} title={name}>
        {name}
        {isDirty && ' *'}
      </span>

      <div style={styles.divider} />

      <button
        style={{
          ...styles.button,
          ...(canUndo() ? {} : styles.buttonDisabled),
        }}
        onClick={handleUndo}
        disabled={!canUndo()}
        title="Undo (Ctrl+Z)"
      >
        Undo
      </button>

      <button
        style={{
          ...styles.button,
          ...(canRedo() ? {} : styles.buttonDisabled),
        }}
        onClick={handleRedo}
        disabled={!canRedo()}
        title="Redo (Ctrl+Y)"
      >
        Redo
      </button>

      <div style={styles.spacer} />

      {getVisibleTabs(activeFileType).length > 1 && (
        <div style={styles.viewToggle}>
          {getVisibleTabs(activeFileType).map((v) => (
            <button
              key={v}
              style={{
                ...styles.viewButton,
                ...(view === v ? styles.viewButtonActive : {}),
              }}
              onClick={() => onViewChange(v)}
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      )}

      <div style={styles.divider} />

      <button style={styles.button} onClick={onNew} title="New Project (Ctrl+N)">
        <IconNew /> New
      </button>

      <button style={styles.button} onClick={onOpen} title="Open .softn file (Ctrl+O)">
        <IconOpen /> Open
      </button>

      <button style={styles.button} onClick={onSave} title="Save Project (Ctrl+S)">
        <IconSave /> Save
      </button>

      {/* Export had no control anywhere in the app. Its only route was
          Ctrl+Shift+E, a shortcut whose condition could never be true, so the
          feature was unreachable by any means. */}
      <button style={styles.button} onClick={onExport} title="Export .softn bundle (Ctrl+Shift+E)">
        <IconExport /> Export
      </button>

      <button style={styles.button} onClick={onShortcuts} title="Keyboard shortcuts">
        Shortcuts
      </button>

      {canInstall && (
        <button style={styles.button} onClick={promptInstall} title="Install SoftN Builder as an app">
          <IconInstall /> Install
        </button>
      )}
    </div>
  );
}
