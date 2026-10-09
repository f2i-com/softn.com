/**
 * SegmentedControl Component
 *
 * A choice of one from a few, all in view: the options side by side in one
 * track, the chosen one raised. A radio group in behaviour — one tab stop,
 * arrow keys move the choice — where Tabs would be a change of page.
 * Uses CSS variables for theming support.
 */

import React, { useRef, useState } from 'react';
import { focusRing, isFocusVisible } from './focus';
import { choice } from '../utils/choice';

export interface SegmentedOption {
  /** What choosing the option gives */
  value: string | number;
  /** What the option shows; its value when omitted */
  label?: string;
  /** Whether the option cannot be chosen */
  disabled?: boolean;
}

export interface SegmentedControlProps {
  /** The options: values, or { value, label?, disabled? } */
  options?: Array<string | number | SegmentedOption>;
  /** The chosen option's value */
  value?: string | number;
  /** Starting choice, when the app does not hold it */
  defaultValue?: string | number;
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** Stretch to the width available, each option an equal share */
  fullWidth?: boolean;
  /** Whether the control is disabled */
  disabled?: boolean;
  /** Accessible name for the group */
  ariaLabel?: string;
  /** Called with the chosen option's value */
  onChange?: (value: string | number) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeConfig: Record<string, { fontSize: string; padding: string; minHeight: string }> = {
  sm: { fontSize: '0.8125rem', padding: '0.25rem 0.625rem', minHeight: '1.75rem' },
  md: { fontSize: '0.875rem', padding: '0.375rem 0.875rem', minHeight: '2.125rem' },
  lg: { fontSize: '1rem', padding: '0.5rem 1.125rem', minHeight: '2.5rem' },
};

function normalise(options: SegmentedControlProps['options']): SegmentedOption[] {
  if (!Array.isArray(options)) return [];
  const out: SegmentedOption[] = [];
  for (const option of options) {
    if (typeof option === 'string' || typeof option === 'number') {
      out.push({ value: option });
    } else if (option !== null && typeof option === 'object' && option.value !== undefined) {
      out.push(option);
    }
  }
  return out;
}

/** State and a select's option agree when they read the same: 2 and "2". */
function same(a: unknown, b: unknown): boolean {
  return a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);
}

export function SegmentedControl({
  options,
  value,
  defaultValue,
  size = 'md',
  fullWidth = false,
  disabled = false,
  ariaLabel,
  onChange,
  className,
  style,
}: SegmentedControlProps): React.ReactElement {
  const items = normalise(options);
  const config = choice(sizeConfig, size, 'md');
  // Any value at all is the app's to hold: `:bind` hands an unset state in
  // as "", which is nothing chosen, not leave to keep a choice of its own
  // (an app that cleared its state would go on seeing the old one chosen).
  const controlled = value !== undefined;
  const [internal, setInternal] = useState<string | number | undefined>(defaultValue);
  const [focused, setFocused] = useState(-1);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const current = controlled ? value : internal;
  const selectedIndex = items.findIndex((item) => same(item.value, current));

  const choose = (index: number) => {
    const item = items[index];
    if (!item || disabled || item.disabled) return;
    if (!controlled) setInternal(item.value);
    if (index !== selectedIndex) onChange?.(item.value);
  };

  /** The next option that can be chosen, going `step` from `from`, wrapping. */
  const enabledFrom = (from: number, step: number): number => {
    for (let hop = 1; hop <= items.length; hop++) {
      const index = (from + step * hop + items.length * hop) % items.length;
      if (!items[index].disabled) return index;
    }
    return -1;
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (disabled || items.length === 0) return;
    const from = selectedIndex >= 0 ? selectedIndex : 0;
    let target = -1;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        target = enabledFrom(selectedIndex >= 0 ? from : -1, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        target = enabledFrom(from, -1);
        break;
      case 'Home':
        target = enabledFrom(-1, 1);
        break;
      case 'End':
        target = enabledFrom(items.length, -1);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (target < 0) return;
    // As in a native radio group, the arrows choose as they move.
    choose(target);
    buttons.current[target]?.focus();
  };

  // One tab stop: the chosen option, or the first that can be chosen.
  const tabStop = selectedIndex >= 0 ? selectedIndex : items.findIndex((item) => !item.disabled);

  const trackStyle: React.CSSProperties = {
    display: fullWidth ? 'flex' : 'inline-flex',
    alignItems: 'stretch',
    gap: '0.125rem',
    padding: '0.1875rem',
    boxSizing: 'border-box',
    // Its own width unless asked to fill: as a flex item in a column it
    // would otherwise be stretched, a track far wider than its options.
    width: fullWidth ? '100%' : 'fit-content',
    maxWidth: '100%',
    borderRadius: 'var(--radius-lg, 0.5rem)',
    // The track and the raised option are the ones the default Tabs use.
    backgroundColor: 'var(--color-gray-100, var(--color-surface-hover, transparent))',
    border: '1px solid var(--color-border, currentColor)',
    opacity: disabled ? 0.5 : 1,
    ...style,
  };

  return (
    <div
      className={className}
      style={trackStyle}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) => {
        const selected = index === selectedIndex;
        const unavailable = disabled || item.disabled === true;
        return (
          <button
            key={`${index}-${String(item.value)}`}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={unavailable}
            onClick={() => choose(index)}
            onFocus={(event) => setFocused(isFocusVisible(event.currentTarget) ? index : -1)}
            onBlur={() => setFocused(-1)}
            style={{
              flex: fullWidth ? '1 1 0' : '0 0 auto',
              minWidth: 0,
              minHeight: config.minHeight,
              padding: config.padding,
              border: 'none',
              borderRadius: 'var(--radius-md, 0.375rem)',
              font: 'inherit',
              fontSize: config.fontSize,
              fontWeight: selected ? 600 : 500,
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: selected ? 'var(--color-text, inherit)' : 'var(--color-text-muted, inherit)',
              backgroundColor: selected ? 'var(--color-surface, Canvas)' : 'transparent',
              boxShadow:
                focused === index
                  ? focusRing
                  : selected
                    ? '0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.06)'
                    : 'none',
              cursor: unavailable ? 'not-allowed' : 'pointer',
              opacity: item.disabled && !disabled ? 0.5 : 1,
              outline: 'none',
              transition: 'background-color 150ms ease, color 150ms ease, box-shadow 150ms ease',
            }}
          >
            {item.label ?? String(item.value)}
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
