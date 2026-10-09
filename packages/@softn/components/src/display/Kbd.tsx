/**
 * Kbd Component
 *
 * A keyboard key, or a combination of them: the way a shortcut is shown
 * next to the action it triggers.
 * Uses CSS variables for theming support.
 */

import React from 'react';
import { choice } from '../utils/choice';

export interface KbdProps {
  /** The key or combination: "Enter", "Ctrl+K", or a list of keys */
  keys?: string | string[];
  /** Text between the keys of a combination */
  separator?: string;
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** A single key, as content */
  children?: React.ReactNode;
}

const sizeConfig: Record<string, { fontSize: string; padding: string; minWidth: string }> = {
  sm: { fontSize: '0.6875rem', padding: '0.0625rem 0.3125rem', minWidth: '1.125rem' },
  md: { fontSize: '0.75rem', padding: '0.125rem 0.375rem', minWidth: '1.375rem' },
  lg: { fontSize: '0.875rem', padding: '0.1875rem 0.5rem', minWidth: '1.625rem' },
};

/** "Ctrl+K" as its keys. A plus that is itself the key ("Ctrl++") is kept. */
function splitKeys(keys: string | string[]): string[] {
  if (Array.isArray(keys)) return keys.map((key) => String(key)).filter((key) => key !== '');
  // A shortcut that has not loaded (`keys={command.shortcut}`) is no keys.
  if (typeof keys !== 'string') return [];
  const parts: string[] = [];
  let current = '';
  for (const ch of keys) {
    if (ch === '+' && current.trim() !== '') {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

export function Kbd({
  keys,
  separator = '+',
  size = 'md',
  className,
  style,
  children,
}: KbdProps): React.ReactElement {
  const config = choice(sizeConfig, size, 'md');

  const keyStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    minWidth: config.minWidth,
    padding: config.padding,
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    fontSize: config.fontSize,
    fontWeight: 500,
    lineHeight: 1.4,
    color: 'var(--color-text, inherit)',
    backgroundColor: 'var(--color-surface, transparent)',
    border: '1px solid var(--color-border, currentColor)',
    borderBottomWidth: '2px',
    borderRadius: 'var(--radius-sm, 0.25rem)',
    whiteSpace: 'nowrap',
  };

  const list = keys === undefined ? [] : splitKeys(keys);

  // One key: a single <kbd>. A combination: a <kbd> around the keys, which
  // is how HTML says "these are pressed together".
  if (list.length <= 1) {
    return (
      <kbd className={className} style={{ ...keyStyle, ...style }}>
        {list.length === 1 ? list[0] : children}
      </kbd>
    );
  }

  const groupStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    fontFamily: 'inherit',
    fontSize: config.fontSize,
    color: 'var(--color-text-muted, inherit)',
    whiteSpace: 'nowrap',
    ...style,
  };

  return (
    <kbd className={className} style={groupStyle}>
      {list.map((key, index) => (
        <React.Fragment key={`${index}-${key}`}>
          {index > 0 && <span>{separator}</span>}
          <kbd style={keyStyle}>{key}</kbd>
        </React.Fragment>
      ))}
    </kbd>
  );
}

export default Kbd;
