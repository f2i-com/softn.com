/**
 * Rating Component
 *
 * A score out of a few: stars to read, or to set. Each star is a radio in
 * a group, so the arrow keys move the score the way they move any choice
 * of one, and a read-only rating is announced as "3 out of 5".
 * Uses CSS variables for theming support.
 */

import React, { useEffect, useRef, useState } from 'react';
import { cssPaint } from '../utils/egress';
import { focusRing, isFocusVisible } from './focus';
import { choice } from '../utils/choice';

export interface RatingProps {
  /** The score */
  value?: number | string;
  /** Starting score, when the app does not hold it */
  defaultValue?: number;
  /** How many stars */
  max?: number;
  /** Show the score without letting it be changed */
  readOnly?: boolean;
  /** Whether the control is disabled */
  disabled?: boolean;
  /** Choosing the current score again clears it to zero */
  allowClear?: boolean;
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** The character drawn for each star */
  character?: string;
  /** Colour of the filled stars */
  color?: string;
  /** Accessible name for the group */
  ariaLabel?: string;
  /** Called with the new score */
  onChange?: (value: number) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeConfig: Record<string, { fontSize: string; gap: string }> = {
  sm: { fontSize: '1rem', gap: '0.0625rem' },
  md: { fontSize: '1.375rem', gap: '0.125rem' },
  lg: { fontSize: '1.875rem', gap: '0.1875rem' },
};

/** A whole score from 0 to `max`; anything that is not a number is 0. */
function clampScore(value: unknown, max: number): number {
  const score = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(max, Math.round(score)));
}

export function Rating({
  value,
  defaultValue = 0,
  max = 5,
  readOnly = false,
  disabled = false,
  allowClear = true,
  size = 'md',
  character = '★',
  color,
  ariaLabel = 'Rating',
  onChange,
  className,
  style,
}: RatingProps): React.ReactElement {
  const count = Number.isFinite(max) && max >= 1 ? Math.min(20, Math.floor(max)) : 5;
  // Any value at all is the app's to hold, an empty one included: `:bind`
  // hands an unset state in as "", and that is a score of nothing. Treating
  // "" as "not held by the app" let the control keep a score of its own, so
  // an app that set its state back to null still showed the old stars.
  const controlled = value !== undefined;
  const [internal, setInternal] = useState(() => clampScore(defaultValue, count));
  const [hovered, setHovered] = useState(0);
  const [focused, setFocused] = useState(0);
  const stars = useRef<Array<HTMLButtonElement | null>>([]);
  const config = choice(sizeConfig, size, 'md');

  const score = controlled ? clampScore(value, count) : Math.min(internal, count);

  useEffect(() => {
    // A shorter scale must not leave a score that is off its end.
    if (!controlled && internal > count) setInternal(count);
  }, [controlled, internal, count]);

  const filled = cssPaint(color) ?? 'var(--color-warning-500, rgb(245, 158, 11))';
  // A grey that is seen: an empty star is still a target. Not the border
  // colour, which is close to the page's on purpose.
  const empty = 'var(--color-gray-300, var(--color-border, currentColor))';

  const containerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: config.gap,
    fontSize: config.fontSize,
    lineHeight: 1,
    opacity: disabled ? 0.5 : 1,
    ...style,
  };

  if (readOnly) {
    return (
      <span
        className={className}
        style={containerStyle}
        role="img"
        aria-label={`${ariaLabel}: ${score} out of ${count}`}
      >
        {Array.from({ length: count }, (_, index) => (
          <span key={index} aria-hidden="true" style={{ color: index < score ? filled : empty }}>
            {character}
          </span>
        ))}
      </span>
    );
  }

  const choose = (next: number) => {
    if (disabled) return;
    const settled = allowClear && next === score ? 0 : next;
    if (!controlled) setInternal(settled);
    if (settled !== score) onChange?.(settled);
  };

  const move = (next: number) => {
    const settled = Math.max(allowClear ? 0 : 1, Math.min(count, next));
    if (!controlled) setInternal(settled);
    if (settled !== score) onChange?.(settled);
    // Focus follows the score, as it does in a native radio group.
    stars.current[Math.max(1, settled) - 1]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        event.preventDefault();
        move(score + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        event.preventDefault();
        move(score - 1);
        break;
      case 'Home':
        event.preventDefault();
        move(allowClear ? 0 : 1);
        break;
      case 'End':
        event.preventDefault();
        move(count);
        break;
      default:
        break;
    }
  };

  const shown = hovered > 0 ? hovered : score;
  // One tab stop: the chosen star, or the first when nothing is chosen.
  const tabStop = score > 0 ? score : 1;

  return (
    <span
      className={className}
      style={containerStyle}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      onMouseLeave={() => setHovered(0)}
    >
      {Array.from({ length: count }, (_, index) => {
        const position = index + 1;
        return (
          <button
            key={position}
            ref={(element) => {
              stars.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={position === score}
            aria-label={`${position} ${position === 1 ? 'star' : 'stars'}`}
            tabIndex={position === tabStop ? 0 : -1}
            disabled={disabled}
            onClick={() => choose(position)}
            onMouseEnter={() => !disabled && setHovered(position)}
            onFocus={(event) => setFocused(isFocusVisible(event.currentTarget) ? position : 0)}
            onBlur={() => setFocused(0)}
            style={{
              padding: 0,
              border: 'none',
              background: 'none',
              font: 'inherit',
              lineHeight: 1,
              color: position <= shown ? filled : empty,
              cursor: disabled ? 'not-allowed' : 'pointer',
              borderRadius: 'var(--radius-sm, 0.25rem)',
              outline: 'none',
              boxShadow: focused === position ? focusRing : 'none',
              transition: 'color 120ms ease, transform 120ms ease',
              transform: hovered === position ? 'scale(1.12)' : 'none',
            }}
          >
            <span aria-hidden="true">{character}</span>
          </button>
        );
      })}
    </span>
  );
}

export default Rating;
