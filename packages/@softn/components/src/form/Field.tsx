/**
 * Field Component
 *
 * A label, a hint and an error around any control. Input, Select and
 * TextArea carry their own; a Slider, a Rating, a SegmentedControl, a group
 * of checkboxes or a control an app made itself do not, and get a Text
 * above and another below written by hand each time. This names what it
 * wraps for a screen reader as well as for the eye.
 * Uses CSS variables for theming support.
 */

import React from 'react';

export interface FieldProps {
  /** What the control is for */
  label?: React.ReactNode;
  /** A note under the control */
  hint?: React.ReactNode;
  /** What is wrong, shown in place of the hint. `true` marks the field without a message */
  error?: React.ReactNode | boolean;
  /** Mark the label as required */
  required?: boolean;
  /** Label above the control, or beside it */
  layout?: 'vertical' | 'horizontal';
  /** Width of the label in the horizontal layout, as CSS */
  labelWidth?: string;
  /** Dim the label and notes with the control */
  disabled?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** The control */
  children?: React.ReactNode;
}

/** Text to show, or null: an error of `true` or an empty note is no message. */
function message(value: unknown): React.ReactNode | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  return value as React.ReactNode;
}

export function Field({
  label,
  hint,
  error,
  required = false,
  layout = 'vertical',
  labelWidth = '9rem',
  disabled = false,
  className,
  style,
  children,
}: FieldProps): React.ReactElement {
  const labelId = React.useId();
  const noteId = React.useId();
  const horizontal = layout === 'horizontal';
  const labelText = message(label);
  const errorText = message(error);
  const hintText = message(hint);
  const invalid = error === true || errorText !== null;
  const note = errorText ?? hintText;

  const fieldStyle: React.CSSProperties = {
    display: horizontal ? 'grid' : 'flex',
    ...(horizontal
      ? { gridTemplateColumns: `minmax(0, ${labelWidth}) minmax(0, 1fr)`, columnGap: '1rem', alignItems: 'start' }
      : { flexDirection: 'column', gap: '0.375rem' }),
    minWidth: 0,
    ...style,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 'var(--text-sm, 0.875rem)',
    fontWeight: 500,
    lineHeight: 1.4,
    color: disabled ? 'var(--color-text-disabled, inherit)' : 'var(--color-text, inherit)',
    // Beside the control, sit level with its first line of text.
    paddingTop: horizontal ? '0.375rem' : undefined,
    overflowWrap: 'anywhere',
  };

  const requiredStyle: React.CSSProperties = {
    marginLeft: '0.25rem',
    color: 'var(--color-error-500, currentColor)',
  };

  const bodyStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    minWidth: 0,
  };

  const noteStyle: React.CSSProperties = {
    fontSize: 'var(--text-xs, 0.75rem)',
    lineHeight: 1.4,
    color: errorText !== null ? 'var(--color-error-500, inherit)' : 'var(--color-text-muted, inherit)',
    overflowWrap: 'anywhere',
  };

  return (
    <div
      role="group"
      aria-labelledby={labelText !== null ? labelId : undefined}
      aria-describedby={note !== null ? noteId : undefined}
      aria-invalid={invalid || undefined}
      aria-disabled={disabled || undefined}
      className={className}
      style={fieldStyle}
    >
      {labelText !== null && (
        <div id={labelId} style={labelStyle}>
          {labelText}
          {required && (
            <span aria-hidden="true" style={requiredStyle}>
              *
            </span>
          )}
        </div>
      )}
      <div style={bodyStyle}>
        {children}
        {note !== null && (
          // An error is announced when it appears; a hint is only there to be read.
          <div id={noteId} role={errorText !== null ? 'alert' : undefined} style={noteStyle}>
            {note}
          </div>
        )}
      </div>
    </div>
  );
}

export default Field;
