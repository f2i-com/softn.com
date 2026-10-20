/**
 * What the Builder's dialogs (Export, New app, Keyboard shortcuts) draw
 * alike. The overlay, the frame, the title, the close button and the buttons
 * are classes in styles/builder.css; these are the inline parts the dialogs
 * had each written out the same, kept here once. A dialog that differs
 * spreads one and changes what differs.
 */

import type React from 'react';

export const dialogStyles = {
  /** The title row: the title, and the close button at its end. */
  header: {
    padding: '14px 12px 14px 24px',
    borderBottom: '1px solid var(--line-soft)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  /** A field's name, above it. */
  label: {
    display: 'block',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--paper)',
    marginBottom: 6,
  },
  input: {
    width: '100%',
    padding: '9px 12px',
    borderRadius: 8,
    fontSize: 14,
  },
  textarea: {
    width: '100%',
    padding: '9px 12px',
    borderRadius: 8,
    fontSize: 14,
    lineHeight: 1.5,
    minHeight: 64,
    resize: 'vertical',
  },
  /** The row of buttons at the foot, to the right; each dialog gives its own padding. */
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    borderTop: '1px solid var(--line-soft)',
    background: 'var(--ink)',
  },
} satisfies Record<string, React.CSSProperties>;
