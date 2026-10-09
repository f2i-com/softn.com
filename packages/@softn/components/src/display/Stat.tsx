/**
 * Stat Component
 *
 * One figure and what it means: a label, the value, and optionally how it
 * moved. The tile a dashboard is made of when the numbers come from the
 * app's own state rather than from a collection (SmartStats reads those).
 * Uses CSS variables for theming support.
 */

import React from 'react';
import { getVariantColors } from '../theme/variants';
import { choice } from '../utils/choice';

export interface StatProps {
  /** What the figure is */
  label?: string;
  /** The figure */
  value?: string | number;
  /** Text before the value, such as a currency sign */
  prefix?: string;
  /** Text after the value, such as a unit */
  suffix?: string;
  /** How far it moved: a number is shown as a percentage, text as written */
  change?: number | string;
  /** What the change is measured against, such as "since last week" */
  changeLabel?: string;
  /** Direction of the change (worked out from a numeric change when omitted) */
  trend?: 'up' | 'down' | 'flat';
  /** Which direction is good news; the other is shown as a warning */
  positive?: 'up' | 'down';
  /** A line of explanation under the figure */
  helpText?: string;
  /** Icon shown beside the label */
  icon?: React.ReactNode;
  /** Appearance */
  variant?: 'plain' | 'card' | 'outlined';
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** Alignment of the content */
  align?: 'left' | 'center' | 'right';
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Content under the figure, such as a sparkline */
  children?: React.ReactNode;
}

const sizeConfig: Record<string, { value: string; label: string; meta: string; padding: string; gap: string }> = {
  sm: { value: '1.25rem', label: '0.75rem', meta: '0.75rem', padding: '0.75rem', gap: '0.25rem' },
  md: { value: '1.75rem', label: '0.8125rem', meta: '0.8125rem', padding: '1rem', gap: '0.375rem' },
  lg: { value: '2.25rem', label: '0.875rem', meta: '0.875rem', padding: '1.25rem', gap: '0.5rem' },
};

const alignItems: Record<string, React.CSSProperties['alignItems']> = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end',
};

const trendGlyph: Record<string, string> = { up: '↑', down: '↓', flat: '→' };
const trendWord: Record<string, string> = { up: 'Up', down: 'Down', flat: 'No change' };

/** The direction a change points: its sign when it is a number or begins with one. */
function directionOf(change: number | string | undefined): 'up' | 'down' | 'flat' | undefined {
  if (change === undefined || change === '') return undefined;
  const amount = typeof change === 'number' ? change : parseFloat(String(change).replace(/^\+/, ''));
  if (!Number.isFinite(amount)) return undefined;
  return amount > 0 ? 'up' : amount < 0 ? 'down' : 'flat';
}

/** A numeric change as a percentage without its sign; text as it was written. */
function changeText(change: number | string): string {
  if (typeof change !== 'number') return String(change);
  const magnitude = Math.abs(change);
  return `${Number.isInteger(magnitude) ? magnitude : magnitude.toFixed(1)}%`;
}

export function Stat({
  label,
  value,
  prefix,
  suffix,
  change,
  changeLabel,
  trend,
  positive = 'up',
  helpText,
  icon,
  variant = 'plain',
  size = 'md',
  align = 'left',
  className,
  style,
  children,
}: StatProps): React.ReactElement {
  const config = choice(sizeConfig, size, 'md');
  const direction = trend ?? directionOf(change);
  const hasChange = change !== undefined && change !== '';
  // Good news, bad news or neither: colour follows the meaning, not the arrow.
  const tone =
    direction === undefined || direction === 'flat'
      ? 'default'
      : direction === positive
        ? 'success'
        : 'danger';
  const toneColors = getVariantColors(tone);

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: choice(alignItems, align, 'left'),
    textAlign: align,
    gap: config.gap,
    minWidth: 0,
    ...(variant !== 'plain' && {
      padding: config.padding,
      borderRadius: 'var(--radius-lg, 0.5rem)',
      backgroundColor: 'var(--color-surface, transparent)',
      border: '1px solid var(--color-border, currentColor)',
    }),
    ...(variant === 'card' && {
      boxShadow: 'var(--shadow-sm, none)',
    }),
    ...style,
  };

  const labelStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    fontSize: config.label,
    fontWeight: 500,
    color: 'var(--color-text-muted, inherit)',
    overflowWrap: 'anywhere',
  };

  const valueStyle: React.CSSProperties = {
    fontSize: config.value,
    fontWeight: 700,
    lineHeight: 1.15,
    letterSpacing: '-0.02em',
    color: 'var(--color-text, inherit)',
    fontVariantNumeric: 'tabular-nums',
    overflowWrap: 'anywhere',
  };

  const affixStyle: React.CSSProperties = {
    fontSize: '0.6em',
    fontWeight: 600,
    color: 'var(--color-text-muted, inherit)',
  };

  const changeStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    fontSize: config.meta,
    fontWeight: 600,
    color: tone === 'default' ? 'var(--color-text-muted, inherit)' : toneColors.textSubtle,
    fontVariantNumeric: 'tabular-nums',
  };

  const metaStyle: React.CSSProperties = {
    fontSize: config.meta,
    color: 'var(--color-text-muted, inherit)',
    overflowWrap: 'anywhere',
  };

  const hiddenStyle: React.CSSProperties = {
    position: 'absolute',
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    border: 0,
  };

  return (
    <div className={className} style={containerStyle} role="group" aria-label={label}>
      {(label || icon) && (
        <div style={labelStyle}>
          {icon && (
            <span aria-hidden="true" style={{ display: 'inline-flex' }}>
              {icon}
            </span>
          )}
          {label && <span>{label}</span>}
        </div>
      )}
      <div style={valueStyle}>
        {prefix && <span style={affixStyle}>{prefix}</span>}
        {value ?? '—'}
        {suffix && <span style={{ ...affixStyle, marginLeft: '0.125em' }}>{suffix}</span>}
      </div>
      {(hasChange || changeLabel) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.375rem' }}>
          {hasChange && (
            <span style={changeStyle}>
              {direction && (
                <>
                  <span aria-hidden="true">{trendGlyph[direction]}</span>
                  {/* The direction in words: an arrow and a colour say nothing to a screen reader. */}
                  <span style={hiddenStyle}>{trendWord[direction]}</span>
                </>
              )}
              <span>{changeText(change as number | string)}</span>
            </span>
          )}
          {changeLabel && <span style={metaStyle}>{changeLabel}</span>}
        </div>
      )}
      {helpText && <div style={metaStyle}>{helpText}</div>}
      {children}
    </div>
  );
}

export default Stat;
