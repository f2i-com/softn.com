/**
 * Steps Component
 *
 * Where someone is in a sequence: the steps done, the one in progress and
 * the ones to come. With a change handler (or `:bind`) the steps are
 * buttons and choosing one moves there.
 * Uses CSS variables for theming support.
 */

import React from 'react';

export interface StepItem {
  /** What the step is called when chosen; its position is used when omitted */
  key?: string;
  /** The step's name */
  label: string;
  /** A line under the name */
  description?: string;
  /** Whether the step cannot be chosen */
  disabled?: boolean;
}

export interface StepsProps {
  /** The steps, in order: names, or { key?, label, description?, disabled? } */
  items?: Array<string | StepItem>;
  /** The step in progress: its position from zero, or its key */
  current?: number | string;
  /** The same as current, under the name `:bind` writes */
  value?: number | string;
  /** Lay the steps out in a row or a column */
  orientation?: 'horizontal' | 'vertical';
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** How the step in progress is shown */
  status?: 'process' | 'error';
  /** Accessible name for the list */
  ariaLabel?: string;
  /** Called with the chosen step's key, or its position when it has none */
  onChange?: (step: number | string) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeConfig: Record<string, { marker: string; font: string; label: string; description: string }> = {
  sm: { marker: '1.5rem', font: '0.75rem', label: '0.8125rem', description: '0.75rem' },
  md: { marker: '2rem', font: '0.875rem', label: '0.875rem', description: '0.8125rem' },
  lg: { marker: '2.5rem', font: '1rem', label: '1rem', description: '0.875rem' },
};

const primary = 'var(--color-primary-500, rgb(99, 102, 241))';
const danger = 'var(--color-error-500, rgb(239, 68, 68))';
const border = 'var(--color-border, currentColor)';

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

function normalise(items: Array<string | StepItem> | undefined): StepItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => typeof item === 'string' || (item !== null && typeof item === 'object'))
    .map((item) => (typeof item === 'string' ? { label: item } : { ...item, label: String(item.label ?? '') }));
}

/** The position of the step `current` names: by key first, then by number. */
function indexOfCurrent(steps: StepItem[], current: number | string | undefined): number {
  if (current === undefined || current === null || current === '') return 0;
  const byKey = steps.findIndex((step) => step.key !== undefined && step.key === current);
  if (byKey >= 0) return byKey;
  const position = typeof current === 'number' ? current : Number(current);
  if (!Number.isFinite(position)) return 0;
  return Math.max(0, Math.min(steps.length, Math.trunc(position)));
}

export function Steps({
  items,
  current,
  value,
  orientation = 'horizontal',
  size = 'md',
  status = 'process',
  ariaLabel = 'Progress',
  onChange,
  className,
  style,
}: StepsProps): React.ReactElement {
  const steps = normalise(items);
  const config = sizeConfig[size] ?? sizeConfig.md;
  const vertical = orientation === 'vertical';
  // `:bind` hands the state in as `value`; an unset one arrives as "".
  const active = indexOfCurrent(steps, value !== undefined && value !== '' ? value : current);
  const interactive = typeof onChange === 'function';

  const listStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: vertical ? 'column' : 'row',
    alignItems: vertical ? 'stretch' : 'flex-start',
    listStyle: 'none',
    margin: 0,
    padding: 0,
    width: '100%',
    ...style,
  };

  return (
    <ol className={className} style={listStyle} aria-label={ariaLabel}>
      {steps.map((step, index) => {
        const done = index < active;
        const isCurrent = index === active;
        const failed = isCurrent && status === 'error';
        const accent = failed ? danger : primary;
        const last = index === steps.length - 1;

        const itemStyle: React.CSSProperties = {
          display: 'flex',
          flexDirection: vertical ? 'row' : 'column',
          alignItems: vertical ? 'stretch' : 'flex-start',
          gap: vertical ? '0.75rem' : '0.5rem',
          flex: last && !vertical ? '0 0 auto' : '1 1 0',
          minWidth: 0,
        };

        const markerStyle: React.CSSProperties = {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          width: config.marker,
          height: config.marker,
          borderRadius: '50%',
          fontSize: config.font,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          border: `2px solid ${done || isCurrent ? accent : border}`,
          backgroundColor: done ? accent : 'transparent',
          color: done ? 'var(--color-white, white)' : isCurrent ? accent : 'var(--color-text-muted, inherit)',
          transition: 'background-color 180ms ease, border-color 180ms ease, color 180ms ease',
        };

        const railStyle: React.CSSProperties = vertical
          ? {
              flex: '1 1 auto',
              width: '2px',
              minHeight: '1.25rem',
              margin: '0.25rem auto',
              backgroundColor: done ? primary : border,
            }
          : {
              flex: '1 1 auto',
              height: '2px',
              margin: '0 0.5rem',
              backgroundColor: done ? primary : border,
            };

        const textStyle: React.CSSProperties = {
          display: 'flex',
          flexDirection: 'column',
          gap: '0.125rem',
          minWidth: 0,
          paddingBottom: vertical && !last ? '1rem' : 0,
          paddingRight: vertical ? 0 : '0.75rem',
          textAlign: 'left',
        };

        const labelStyle: React.CSSProperties = {
          fontSize: config.label,
          fontWeight: isCurrent ? 600 : 500,
          color: failed
            ? danger
            : done || isCurrent
              ? 'var(--color-text, inherit)'
              : 'var(--color-text-muted, inherit)',
          overflowWrap: 'anywhere',
        };

        const descriptionStyle: React.CSSProperties = {
          fontSize: config.description,
          color: 'var(--color-text-muted, inherit)',
          overflowWrap: 'anywhere',
        };

        const marker = (
          <span style={markerStyle} aria-hidden="true">
            {done ? '✓' : failed ? '!' : index + 1}
          </span>
        );

        const text = (
          <span style={textStyle}>
            <span style={labelStyle}>
              {/* What the tick, the ring and the colour say, in words. */}
              <span style={hiddenStyle}>
                {done ? 'Completed: ' : failed ? 'Error: ' : isCurrent ? 'Current: ' : ''}
              </span>
              {step.label}
            </span>
            {step.description && <span style={descriptionStyle}>{step.description}</span>}
          </span>
        );

        // The marker and the rail to the next step share a line, so the rail
        // starts where the marker ends whatever the label's length.
        const head = (
          <span
            style={{
              display: 'flex',
              flexDirection: vertical ? 'column' : 'row',
              alignItems: 'center',
              alignSelf: 'stretch',
            }}
          >
            {marker}
            {!last && <span style={railStyle} aria-hidden="true" />}
          </span>
        );

        const body = interactive ? (
          <button
            type="button"
            disabled={step.disabled}
            aria-current={isCurrent ? 'step' : undefined}
            onClick={() => onChange?.(step.key ?? index)}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              padding: 0,
              border: 'none',
              background: 'none',
              font: 'inherit',
              color: 'inherit',
              cursor: step.disabled ? 'not-allowed' : 'pointer',
              opacity: step.disabled ? 0.5 : 1,
              borderRadius: 'var(--radius-sm, 0.25rem)',
            }}
          >
            {text}
          </button>
        ) : (
          text
        );

        return (
          <li
            key={step.key ?? index}
            style={itemStyle}
            aria-current={!interactive && isCurrent ? 'step' : undefined}
          >
            {head}
            {body}
          </li>
        );
      })}
    </ol>
  );
}

export default Steps;
