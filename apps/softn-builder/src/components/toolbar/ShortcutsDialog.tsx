/**
 * ShortcutsDialog - Displays keyboard shortcuts
 */

import React, { useId } from 'react';
import { useModalFocus } from '@softn/editor-shared/useModalFocus';
import { modKeyLabel } from '../../utils/platformKeys';

// The overlay, frame, title and close button are classes in styles/builder.css.
const styles: Record<string, React.CSSProperties> = {
  dialog: {
    width: 600,
  },
  header: {
    padding: '14px 12px 14px 24px',
    borderBottom: '1px solid var(--line-soft)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  content: {
    padding: '8px 24px 24px',
    overflow: 'auto',
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    columnGap: 32,
  },
  section: {
    marginTop: 16,
  },
  sectionTitle: {
    fontFamily: 'var(--display)',
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: '-0.01em',
    color: 'var(--paper)',
    margin: '0 0 6px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '6px 0',
    borderBottom: '1px solid var(--line-soft)',
  },
  action: {
    fontSize: 13,
    color: 'var(--dim)',
  },
  shortcut: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    flexShrink: 0,
  },
  key: {
    display: 'inline-block',
    padding: '1px 6px',
    background: 'var(--ink-3)',
    border: '1px solid var(--line)',
    borderBottomWidth: 2,
    borderRadius: 5,
    fontSize: 11.5,
    fontFamily: 'var(--mono)',
    color: 'var(--paper)',
    minWidth: 22,
    textAlign: 'center' as const,
  },
  plus: {
    fontSize: 11,
    color: 'var(--dimmer)',
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

const MOD = modKeyLabel();
/** The code editor's own key for handing Tab back (platformKeys.ts, tabFocusKeyLabel), as keys. */
const TAB_LEAVES = ['Esc'];

const shortcuts: { title: string; entries: ShortcutEntry[] }[] = [
  {
    title: 'General',
    entries: [
      { action: 'New app', keys: [[MOD, 'N']] },
      { action: 'Open a .softn file', keys: [[MOD, 'O']] },
      { action: 'Save', keys: [[MOD, 'S']] },
      { action: 'Export, run or publish', keys: [[MOD, 'Shift', 'E']] },
      { action: 'These shortcuts', keys: [['?']] },
    ],
  },
  {
    title: 'Edit',
    entries: [
      { action: 'Undo', keys: [[MOD, 'Z']] },
      { action: 'Redo', keys: [[MOD, 'Shift', 'Z'], [MOD, 'Y']] },
      { action: 'Copy', keys: [[MOD, 'C']] },
      { action: 'Cut', keys: [[MOD, 'X']] },
      { action: 'Paste', keys: [[MOD, 'V']] },
      { action: 'Duplicate', keys: [[MOD, 'D']] },
      { action: 'Delete selected', keys: [['Delete'], ['Backspace']] },
      { action: 'Select all', keys: [[MOD, 'A']] },
    ],
  },
  {
    title: 'View',
    entries: [
      { action: 'Design view', keys: [[MOD, '1']] },
      { action: 'Data view', keys: [[MOD, '2']] },
      { action: 'Preview', keys: [[MOD, '3']] },
      { action: 'Code view', keys: [[MOD, '4']] },
      // Tab stops in a code editor, where it indents: these are the ways on.
      { action: 'Next / previous panel', keys: [['F6'], ['Shift', 'F6']] },
      { action: 'Let Tab leave a code editor', keys: [TAB_LEAVES] },
    ],
  },
  {
    // The canvas and the hierarchy beneath it are one tree, walked like any
    // other: these were there, and listed nowhere.
    title: 'Hierarchy',
    entries: [
      { action: 'Next / previous element', keys: [['↓'], ['↑']] },
      { action: 'First child / parent', keys: [['→'], ['←']] },
      { action: 'First / last element', keys: [['Home'], ['End']] },
      { action: 'Select (add to selection)', keys: [['Enter'], ['Shift', 'Enter']] },
    ],
  },
  {
    // Nothing but a drag moved an element. What is added goes where the
    // selection is, and these move what is selected.
    title: 'Move the selected element',
    entries: [
      { action: 'Up / down among its siblings', keys: [['Alt', 'Shift', '↑'], ['Alt', 'Shift', '↓']] },
      { action: 'Into the container before it', keys: [['Alt', 'Shift', '→']] },
      { action: 'Out of what holds it', keys: [['Alt', 'Shift', '←']] },
      { action: 'Add from the palette at the selection', keys: [['Enter']] },
      // The palette is one stop for Tab: these move through its rows.
      { action: 'Next / previous in the palette', keys: [['↓'], ['↑']] },
    ],
  },
];

function ShortcutKeys({ keys }: { keys: string[][] }) {
  return (
    <div style={styles.shortcut}>
      {keys.map((combo, ci) => (
        <React.Fragment key={ci}>
          {ci > 0 && <span style={styles.plus}>or</span>}
          {combo.map((key, ki) => (
            <React.Fragment key={ki}>
              {ki > 0 && <span style={styles.plus}>+</span>}
              <kbd style={styles.key}>{key}</kbd>
            </React.Fragment>
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}

export function ShortcutsDialog({ isOpen, onClose }: ShortcutsDialogProps) {
  const dialogRef = useModalFocus(isOpen, onClose);
  const titleId = useId();
  if (!isOpen) return null;

  return (
    <div className="bl-overlay" style={{ zIndex: 1000 }} onClick={onClose}>
      <div ref={dialogRef} className="bl-dialog" style={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <h2 id={titleId} className="bl-dialog-title">Keyboard shortcuts</h2>
          <button type="button" aria-label="Close keyboard shortcuts" className="bl-close" onClick={onClose}>
            {'\u00D7'}
          </button>
        </div>

        <div style={styles.content}>
          {shortcuts.map((section) => (
            <section key={section.title} style={styles.section} aria-label={section.title}>
              <h3 style={styles.sectionTitle}>{section.title}</h3>
              {section.entries.map((entry) => (
                <div key={entry.action} style={styles.row}>
                  <span style={styles.action}>{entry.action}</span>
                  <ShortcutKeys keys={entry.keys} />
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
