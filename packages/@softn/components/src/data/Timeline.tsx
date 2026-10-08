/**
 * Timeline Component
 *
 * Things that happened, in order, each with a marker on a line. For a
 * list the app holds in state: activity, history, the stages of an order.
 * (SmartTimeline draws one straight from a collection.)
 * Uses CSS variables for theming support.
 */

import React from 'react';
import { getVariantColors } from '../theme/variants';

export interface TimelineItem {
  /** Identifies the entry when the list changes */
  key?: string;
  /** What happened */
  title: string;
  /** More about it */
  description?: string;
  /** When, as the text to show */
  time?: string;
  /** Colour of the marker */
  variant?: 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
}

export interface TimelineProps {
  /** The entries, in the order to show them: { title, description?, time?, variant?, key? } */
  items?: TimelineItem[];
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** Where the time is shown */
  timePosition?: 'inline' | 'above';
  /** Draw the line between markers */
  showLine?: boolean;
  /** Show the newest entry first by reversing the list */
  reverse?: boolean;
  /** Text shown when there are no entries */
  emptyText?: string;
  /** Accessible name for the list */
  ariaLabel?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeConfig: Record<string, { dot: string; title: string; text: string; gap: string }> = {
  sm: { dot: '0.5rem', title: '0.8125rem', text: '0.75rem', gap: '0.75rem' },
  md: { dot: '0.625rem', title: '0.875rem', text: '0.8125rem', gap: '1rem' },
  lg: { dot: '0.75rem', title: '1rem', text: '0.875rem', gap: '1.25rem' },
};

function normalise(items: TimelineItem[] | undefined): TimelineItem[] {
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is TimelineItem => item !== null && typeof item === 'object');
}

export function Timeline({
  items,
  size = 'md',
  timePosition = 'inline',
  showLine = true,
  reverse = false,
  emptyText,
  ariaLabel = 'Timeline',
  className,
  style,
}: TimelineProps): React.ReactElement | null {
  const config = sizeConfig[size] ?? sizeConfig.md;
  const entries = normalise(items);
  if (reverse) entries.reverse();

  if (entries.length === 0) {
    if (!emptyText) return null;
    return (
      <p
        className={className}
        style={{ margin: 0, fontSize: config.text, color: 'var(--color-text-muted, inherit)', ...style }}
      >
        {emptyText}
      </p>
    );
  }

  const listStyle: React.CSSProperties = {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    ...style,
  };

  const timeStyle: React.CSSProperties = {
    fontSize: config.text,
    color: 'var(--color-text-muted, inherit)',
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  };

  return (
    <ol className={className} style={listStyle} aria-label={ariaLabel}>
      {entries.map((entry, index) => {
        const last = index === entries.length - 1;
        const colors = getVariantColors(entry.variant ?? 'default');

        return (
          <li
            key={entry.key ?? index}
            style={{ display: 'flex', gap: '0.75rem', alignItems: 'stretch', minWidth: 0 }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                flexShrink: 0,
                width: config.dot,
                paddingTop: '0.3125rem',
              }}
            >
              <span
                style={{
                  width: config.dot,
                  height: config.dot,
                  borderRadius: '50%',
                  backgroundColor: colors.bg,
                  boxShadow: '0 0 0 3px var(--color-bg, transparent)',
                  flexShrink: 0,
                }}
              />
              {showLine && !last && (
                <span
                  style={{
                    flex: '1 1 auto',
                    width: '2px',
                    marginTop: '0.25rem',
                    backgroundColor: 'var(--color-border, currentColor)',
                    opacity: 0.7,
                  }}
                />
              )}
            </span>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.125rem',
                minWidth: 0,
                flex: '1 1 auto',
                paddingBottom: last ? 0 : config.gap,
              }}
            >
              {entry.time && timePosition === 'above' && <span style={timeStyle}>{entry.time}</span>}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                }}
              >
                <span
                  style={{
                    fontSize: config.title,
                    fontWeight: 600,
                    color: 'var(--color-text, inherit)',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {entry.title}
                </span>
                {entry.time && timePosition !== 'above' && <span style={timeStyle}>{entry.time}</span>}
              </div>
              {entry.description && (
                <span
                  style={{
                    fontSize: config.text,
                    lineHeight: 1.5,
                    color: 'var(--color-text-muted, inherit)',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {entry.description}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default Timeline;
