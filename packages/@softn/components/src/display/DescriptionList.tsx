/**
 * DescriptionList Component
 *
 * The facts about one thing, each a label and its value: the detail side of
 * a list, an order summary, a settings read-out. Apps write this by hand as
 * a row of two Texts for every field; this takes the fields as a list, or
 * as the record itself, and lays them out as a description list.
 * Uses CSS variables for theming support.
 */

import React from 'react';
import { choice } from '../utils/choice';

export interface DescriptionItem {
  /** What the value is */
  label: React.ReactNode;
  /** The value. Nothing, an empty text or an empty list is shown as `emptyText` */
  value?: React.ReactNode;
  /** A note under the value */
  hint?: React.ReactNode;
}

export interface DescriptionListProps {
  /** The fields: a list of { label, value, hint? }, or a record whose keys are the labels */
  items?: DescriptionItem[] | Record<string, unknown>;
  /** Fields side by side, 1 to 4. They fall to fewer where there is not the room */
  columns?: number;
  /** Label above its value, or beside it */
  layout?: 'stacked' | 'inline';
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** A line between one field and the next */
  dividers?: boolean;
  /** What stands in for a value that is not there */
  emptyText?: string;
  /** Width of the label column in the inline layout, as CSS */
  labelWidth?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeConfig: Record<string, { label: string; value: string; gap: string; row: string }> = {
  sm: { label: '0.6875rem', value: '0.8125rem', gap: '0.125rem', row: '0.5rem' },
  md: { label: '0.75rem', value: '0.875rem', gap: '0.1875rem', row: '0.75rem' },
  lg: { label: '0.8125rem', value: '1rem', gap: '0.25rem', row: '1rem' },
};

/** The narrowest a field is drawn before the list takes fewer columns. */
const MIN_FIELD_WIDTH = '11rem';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !React.isValidElement(value);
}

/** The fields to draw, from either form `items` takes. A hole in the list is not a field. */
function fieldsOf(items: DescriptionListProps['items']): DescriptionItem[] {
  if (Array.isArray(items)) {
    return items.filter(isRecord).map((item) => ({
      label: item.label as React.ReactNode,
      value: item.value as React.ReactNode,
      hint: item.hint as React.ReactNode,
    }));
  }
  if (isRecord(items)) {
    return Object.keys(items).map((key) => ({ label: key, value: items[key] as React.ReactNode }));
  }
  return [];
}

/** A value as something to draw, or null when there is nothing to show. */
function shown(value: unknown): React.ReactNode | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isNaN(value) ? null : String(value);
  if (typeof value === 'string' || React.isValidElement(value)) return value;
  if (Array.isArray(value)) {
    const parts = value.map(shown).filter((part) => part !== null);
    if (parts.length === 0) return null;
    return parts.every((part) => typeof part === 'string') ? parts.join(', ') : parts;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toLocaleString();
  // A record has no one way to be written; say what is in it rather than "[object Object]".
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function DescriptionList({
  items,
  columns = 1,
  layout = 'stacked',
  size = 'md',
  dividers = false,
  emptyText = '—',
  labelWidth = '9rem',
  className,
  style,
}: DescriptionListProps): React.ReactElement {
  const config = choice(sizeConfig, size, 'md');
  const fields = fieldsOf(items);
  const count = Number.isFinite(columns) ? Math.min(4, Math.max(1, Math.round(Number(columns)))) : 1;
  const inline = layout === 'inline';

  const listStyle: React.CSSProperties = {
    display: 'grid',
    // At most `count` columns, and fewer where each would be narrower than a
    // field can be read in: a phone gets one without being asked.
    gridTemplateColumns:
      count === 1
        ? 'minmax(0, 1fr)'
        : `repeat(auto-fill, minmax(max(${MIN_FIELD_WIDTH}, calc((100% - ${count - 1} * 1.5rem) / ${count})), 1fr))`,
    columnGap: '1.5rem',
    rowGap: dividers ? 0 : config.row,
    margin: 0,
    padding: 0,
    minWidth: 0,
    ...style,
  };

  const fieldStyle: React.CSSProperties = {
    display: inline ? 'grid' : 'flex',
    ...(inline
      ? { gridTemplateColumns: `minmax(0, ${labelWidth}) minmax(0, 1fr)`, columnGap: '1rem', alignItems: 'baseline' }
      : { flexDirection: 'column', gap: config.gap }),
    minWidth: 0,
    ...(dividers && {
      padding: `${config.row} 0`,
      borderBottom: '1px solid var(--color-border, currentColor)',
    }),
  };

  const labelStyle: React.CSSProperties = {
    margin: 0,
    fontSize: config.label,
    fontWeight: 500,
    color: 'var(--color-text-muted, inherit)',
    overflowWrap: 'anywhere',
  };

  const valueStyle: React.CSSProperties = {
    margin: 0,
    fontSize: config.value,
    color: 'var(--color-text, inherit)',
    overflowWrap: 'anywhere',
    minWidth: 0,
  };

  const emptyStyle: React.CSSProperties = {
    color: 'var(--color-text-disabled, inherit)',
  };

  const hintStyle: React.CSSProperties = {
    display: 'block',
    marginTop: '0.125rem',
    fontSize: config.label,
    color: 'var(--color-text-muted, inherit)',
  };

  return (
    <dl className={className} style={listStyle}>
      {fields.map((field, index) => {
        const value = shown(field.value);
        const hint = shown(field.hint);
        return (
          <div key={index} style={fieldStyle}>
            <dt style={labelStyle}>{shown(field.label)}</dt>
            <dd style={valueStyle}>
              {value === null ? <span style={emptyStyle}>{emptyText}</span> : value}
              {hint !== null && <span style={hintStyle}>{hint}</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export default DescriptionList;
