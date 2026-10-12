/**
 * NumberInput Component
 *
 * A number to type or to step: a field with a button either side. What
 * the app receives is a number (or null for an empty field), never the
 * text, and the text being typed is left alone until it is a number.
 * Uses CSS variables for theming support.
 */

import React, { useEffect, useRef, useState } from 'react';
import { choice } from '../utils/choice';
import { controlAttributes, givenLabel } from '../utils/domAttributes';

export interface NumberInputProps {
  /** The number */
  value?: number | string | null;
  /** Starting number, when the app does not hold it */
  defaultValue?: number;
  /** Smallest number allowed */
  min?: number;
  /** Largest number allowed */
  max?: number;
  /** How much one step changes it */
  step?: number;
  /** Decimal places kept; worked out from the step when omitted */
  precision?: number;
  /** Input name */
  name?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Whether the number can be read but not changed */
  readOnly?: boolean;
  /** Error state */
  error?: boolean;
  /** Hide the step buttons */
  hideControls?: boolean;
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** Stretch to the width available */
  fullWidth?: boolean;
  /** Accessible name, when no visible label names the field */
  ariaLabel?: string;
  /** Called with the new number, or null when the field is emptied */
  onChange?: (value: number | null) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeConfig: Record<string, { height: string; fontSize: string; button: string }> = {
  sm: { height: '1.75rem', fontSize: '0.8125rem', button: '1.5rem' },
  md: { height: '2.25rem', fontSize: '0.875rem', button: '2rem' },
  lg: { height: '2.75rem', fontSize: '1rem', button: '2.5rem' },
};

function decimalsOf(value: number): number {
  const text = String(value).toLowerCase();
  if (text.includes('e-')) {
    const [coefficient, exponent] = text.split('e-');
    return Number(exponent) + (coefficient.split('.')[1]?.length ?? 0);
  }
  return text.split('.')[1]?.length ?? 0;
}

/** The number a prop or typed text stands for, or null when it is not one. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function NumberInput({
  value,
  defaultValue,
  min,
  max,
  step = 1,
  precision,
  name,
  placeholder,
  disabled = false,
  readOnly = false,
  error = false,
  hideControls = false,
  size = 'md',
  fullWidth = false,
  ariaLabel,
  onChange,
  className,
  style,
  ...rest
}: NumberInputProps): React.ReactElement {
  const config = choice(sizeConfig, size, 'md');
  // The page's `id` and `aria-…` on the field, its `data-…` with the class
  // (see controlAttributes).
  const { control: attributes, styled } = controlAttributes(rest);
  const safeStep = Number.isFinite(step) && step > 0 ? step : 1;
  const low = Number.isFinite(min as number) ? (min as number) : undefined;
  const high = Number.isFinite(max as number) ? (max as number) : undefined;
  const places = Math.min(
    20,
    Number.isFinite(precision as number) && (precision as number) >= 0
      ? Math.floor(precision as number)
      : Math.max(decimalsOf(safeStep), low === undefined ? 0 : decimalsOf(low))
  );

  // `:bind` hands an unset state in as "": an empty field the app holds.
  const controlled = value !== undefined;
  const [internal, setInternal] = useState<number | null>(() => toNumber(defaultValue));
  const current = controlled ? toNumber(value) : internal;

  // What is in the field while it is being edited. "1." and "-" are on the
  // way to a number; rewriting them from the number would fight the typing.
  const [draft, setDraft] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const lastSent = useRef<number | null>(current);

  useEffect(() => {
    // The app changed the number to something this field did not just send:
    // show that, not the text left over from typing.
    if (draft !== null && current !== lastSent.current) setDraft(null);
    lastSent.current = current;
  }, [current, draft]);

  const settle = (next: number): number => {
    let settled = next;
    if (low !== undefined && settled < low) settled = low;
    if (high !== undefined && settled > high) settled = high;
    return Number(settled.toFixed(places));
  };

  const commit = (next: number | null) => {
    lastSent.current = next;
    if (!controlled) setInternal(next);
    if (next !== current) onChange?.(next);
  };

  const stepBy = (steps: number) => {
    if (disabled || readOnly) return;
    setDraft(null);
    // From an empty field a step starts at the minimum, or counts from zero.
    if (current === null) {
      commit(settle(low !== undefined ? low : steps * safeStep));
      return;
    }
    commit(settle(current + steps * safeStep));
  };

  const onInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const text = event.target.value;
    setDraft(text);
    if (text.trim() === '') {
      commit(null);
      return;
    }
    const parsed = toNumber(text);
    // Text that is not a number yet is kept as typed and not sent.
    if (parsed === null) return;
    // Out of range is sent when the field is left, settled into range; while
    // typing, "1" on the way to "15" must not be dragged up to a minimum of 10.
    if ((low !== undefined && parsed < low) || (high !== undefined && parsed > high)) return;
    commit(parsed);
  };

  const onBlur = () => {
    setFocused(false);
    if (draft === null) return;
    const parsed = toNumber(draft);
    setDraft(null);
    if (draft.trim() === '') commit(null);
    else if (parsed !== null) commit(settle(parsed));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled || readOnly) return;
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        stepBy(1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        stepBy(-1);
        break;
      case 'PageUp':
        event.preventDefault();
        stepBy(10);
        break;
      case 'PageDown':
        event.preventDefault();
        stepBy(-10);
        break;
      case 'Home':
        if (low !== undefined) {
          event.preventDefault();
          setDraft(null);
          commit(low);
        }
        break;
      case 'End':
        if (high !== undefined) {
          event.preventDefault();
          setDraft(null);
          commit(high);
        }
        break;
      default:
        break;
    }
  };

  const text = draft ?? (current === null ? '' : String(current));
  const atLow = low !== undefined && current !== null && current <= low;
  const atHigh = high !== undefined && current !== null && current >= high;
  const borderColor = error
    ? 'var(--color-error-500, rgb(239, 68, 68))'
    : focused
      ? 'var(--color-primary-500, rgb(99, 102, 241))'
      : 'var(--color-border, currentColor)';

  const wrapperStyle: React.CSSProperties = {
    display: fullWidth ? 'flex' : 'inline-flex',
    alignItems: 'stretch',
    boxSizing: 'border-box',
    width: fullWidth ? '100%' : undefined,
    height: config.height,
    borderRadius: 'var(--radius-md, 0.375rem)',
    border: `1px solid ${borderColor}`,
    backgroundColor: 'var(--color-surface, transparent)',
    opacity: disabled ? 0.5 : 1,
    overflow: 'hidden',
    transition: 'border-color 150ms ease',
    ...style,
  };

  const buttonStyle = (unavailable: boolean): React.CSSProperties => ({
    flex: '0 0 auto',
    width: config.button,
    padding: 0,
    border: 'none',
    background: 'none',
    font: 'inherit',
    fontSize: config.fontSize,
    fontWeight: 600,
    lineHeight: 1,
    color: 'var(--color-text-muted, inherit)',
    cursor: unavailable ? 'not-allowed' : 'pointer',
    opacity: unavailable ? 0.4 : 1,
  });

  const inputStyle: React.CSSProperties = {
    flex: '1 1 auto',
    minWidth: 0,
    width: fullWidth ? '100%' : '4.5rem',
    padding: hideControls ? '0 0.75rem' : '0 0.25rem',
    border: 'none',
    outline: 'none',
    background: 'none',
    font: 'inherit',
    fontSize: config.fontSize,
    fontVariantNumeric: 'tabular-nums',
    textAlign: hideControls ? 'left' : 'center',
    color: 'var(--color-text, inherit)',
  };

  const stepDisabled = disabled || readOnly;

  return (
    <div {...styled} className={className} style={wrapperStyle}>
      {!hideControls && (
        <button
          type="button"
          // The field itself steps with the arrow keys; the buttons are for a pointer.
          tabIndex={-1}
          aria-label="Decrease"
          disabled={stepDisabled || atLow}
          onClick={() => stepBy(-1)}
          style={buttonStyle(stepDisabled || atLow)}
        >
          <span aria-hidden="true">{'−'}</span>
        </button>
      )}
      <input
        {...attributes}
        type="text"
        inputMode={places > 0 ? 'decimal' : 'numeric'}
        role="spinbutton"
        name={name}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        autoComplete="off"
        aria-label={ariaLabel ?? givenLabel(attributes)}
        aria-valuenow={current ?? undefined}
        aria-valuemin={low}
        aria-valuemax={high}
        aria-invalid={error || undefined}
        onChange={onInput}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={onBlur}
        style={inputStyle}
      />
      {!hideControls && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Increase"
          disabled={stepDisabled || atHigh}
          onClick={() => stepBy(1)}
          style={buttonStyle(stepDisabled || atHigh)}
        >
          <span aria-hidden="true">+</span>
        </button>
      )}
    </div>
  );
}

export default NumberInput;
