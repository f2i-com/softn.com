/**
 * Toolbar - Main toolbar with actions
 */

import React from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useProjectStore } from '../../stores/projectStore';
import { useHistoryStore } from '../../stores/historyStore';

const styles: Record<string, React.CSSProperties> = {
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    padding: '10px 16px',
    background: 'linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)',
    borderBottom: '1px solid #e2e8f0',
    gap: 8,
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginRight: 16,
  },
  logoText: {
    fontWeight: 600,
    fontSize: 15,
    color: '#1e293b',
  },
  divider: {
    width: 1,
    height: 24,
    background: '#e2e8f0',
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
    color: '#64748b',
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
    color: '#64748b',
    marginLeft: 8,
    maxWidth: 220,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  viewToggle: {
    display: 'flex',
    background: '#e2e8f0',
    borderRadius: 8,
    padding: 2,
  },
  viewButton: {
    padding: '6px 12px',
    background: 'transparent',
    border: 'none',
    borderRadius: 4,
    fontSize: 12,
    color: '#64748b',
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  viewButtonActive: {
    background: '#fff',
    color: '#1e293b',
    boxShadow: '0 2px 6px rgba(15,23,42,0.12)',
  },
};

function SoftNLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="toolbar-logo-bg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#60a5fa"/>
          <stop offset="100%" stopColor="#2563eb"/>
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#toolbar-logo-bg)"/>
      <path d="M10.5 9C20 9 21 16 16 16S12 23 21.5 23" fill="none" stroke="#fff" strokeWidth="2.8" strokeLinecap="round"/>
      <circle cx="10.5" cy="9" r="2.5" fill="#fff"/>
      <circle cx="21.5" cy="23" r="2.5" fill="#fff"/>
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

interface ToolbarProps {
  view: 'design' | 'preview' | 'code' | 'data';
  onViewChange: (view: 'design' | 'preview' | 'code' | 'data') => void;
  onSave: () => void;
  onNew: () => void;
  onOpen: () => void;
  onShortcuts: () => void;
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
  activeFileType,
}: ToolbarProps) {
  const { name, isDirty } = useProjectStore();
  const { canUndo, canRedo, undo, redo } = useHistoryStore();

  const handleUndo = () => {
    const entry = undo();
    if (entry) {
      useCanvasStore.getState().loadState(entry.elements, entry.rootId);
    }
  };

  const handleRedo = () => {
    const entry = redo();
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

      <button style={styles.button} onClick={onShortcuts} title="Keyboard shortcuts">
        Shortcuts
      </button>
    </div>
  );
}
