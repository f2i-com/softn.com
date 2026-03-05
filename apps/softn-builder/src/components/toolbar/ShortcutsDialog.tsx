/**
 * ShortcutsDialog - Displays keyboard shortcuts
 */

import React from 'react';

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  dialog: {
    background: '#fff',
    borderRadius: 12,
    width: 560,
    maxWidth: '90vw',
    maxHeight: '80vh',
    boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  header: {
    padding: '16px 24px',
    borderBottom: '1px solid #e2e8f0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 18,
    fontWeight: 600,
    color: '#1e293b',
  },
  closeButton: {
    background: 'transparent',
    border: 'none',
    fontSize: 24,
    color: '#94a3b8',
    cursor: 'pointer',
    padding: 4,
    lineHeight: 1,
  },
  content: {
    padding: 24,
    overflow: 'auto',
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: '#64748b',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: 8,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 0',
    borderBottom: '1px solid #f1f5f9',
  },
  action: {
    fontSize: 13,
    color: '#374151',
  },
  shortcut: {
    display: 'flex',
    gap: 4,
  },
  key: {
    display: 'inline-block',
    padding: '2px 8px',
    background: '#f1f5f9',
    border: '1px solid #e2e8f0',
    borderRadius: 4,
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#475569',
    minWidth: 24,
    textAlign: 'center' as const,
  },
  plus: {
    fontSize: 12,
    color: '#94a3b8',
    lineHeight: '24px',
  },
};

interface ShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutEntry {
  action: string;
  keys: string[][];  // Array of key combos, each combo is an array of keys
}

const shortcuts: { title: string; entries: ShortcutEntry[] }[] = [
  {
    title: 'General',
    entries: [
      { action: 'New project', keys: [['Ctrl', 'N']] },
      { action: 'Open bundle', keys: [['Ctrl', 'O']] },
      { action: 'Save', keys: [['Ctrl', 'S']] },
      { action: 'Export bundle', keys: [['Ctrl', 'Shift', 'E']] },
      { action: 'Show shortcuts', keys: [['?']] },
    ],
  },
  {
    title: 'Edit',
    entries: [
      { action: 'Undo', keys: [['Ctrl', 'Z']] },
      { action: 'Redo', keys: [['Ctrl', 'Shift', 'Z']] },
      { action: 'Copy', keys: [['Ctrl', 'C']] },
      { action: 'Cut', keys: [['Ctrl', 'X']] },
      { action: 'Paste', keys: [['Ctrl', 'V']] },
      { action: 'Duplicate', keys: [['Ctrl', 'D']] },
      { action: 'Delete selected', keys: [['Delete'], ['Backspace']] },
      { action: 'Select all', keys: [['Ctrl', 'A']] },
    ],
  },
  {
    title: 'View',
    entries: [
      { action: 'Design view', keys: [['Ctrl', '1']] },
      { action: 'Data view', keys: [['Ctrl', '2']] },
      { action: 'Preview', keys: [['Ctrl', '3']] },
      { action: 'Code view', keys: [['Ctrl', '4']] },
      { action: 'Logic files open in Design', keys: [['Click', 'logic tab']] },
    ],
  },
];

function ShortcutKeys({ keys }: { keys: string[][] }) {
  return (
    <div style={styles.shortcut}>
      {keys.map((combo, ci) => (
        <React.Fragment key={ci}>
          {ci > 0 && <span style={styles.plus}>/</span>}
          {combo.map((key, ki) => (
            <React.Fragment key={ki}>
              {ki > 0 && <span style={styles.plus}>+</span>}
              <span style={styles.key}>{key}</span>
            </React.Fragment>
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}

export function ShortcutsDialog({ isOpen, onClose }: ShortcutsDialogProps) {
  if (!isOpen) return null;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Keyboard Shortcuts</span>
          <button style={styles.closeButton} onClick={onClose}>
            {'\u00D7'}
          </button>
        </div>

        <div style={styles.content}>
          {shortcuts.map((section) => (
            <div key={section.title} style={styles.section}>
              <div style={styles.sectionTitle}>{section.title}</div>
              {section.entries.map((entry) => (
                <div key={entry.action} style={styles.row}>
                  <span style={styles.action}>{entry.action}</span>
                  <ShortcutKeys keys={entry.keys} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
