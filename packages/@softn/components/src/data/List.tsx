/**
 * List Component
 *
 * A flexible list container for displaying items.
 */

import React from 'react';

export interface ListProps {
  /** List variant */
  variant?: 'default' | 'bordered' | 'divided';
  /** List spacing */
  spacing?: 'none' | 'sm' | 'md' | 'lg';
  /** Whether items are hoverable */
  hoverable?: boolean;
  /** Whether list is ordered */
  ordered?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** List items */
  children?: React.ReactNode;
}

export interface ListItemProps {
  /** Whether item is active */
  active?: boolean;
  /** Whether item is disabled */
  disabled?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Leading content (icon, avatar) */
  leading?: React.ReactNode;
  /** Trailing content (action, badge) */
  trailing?: React.ReactNode;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Item content */
  children?: React.ReactNode;
}

const spacingValues: Record<string, string> = {
  none: '0',
  sm: '0.5rem',
  md: '0.75rem',
  lg: '1rem',
};

/** What a List tells the items in it. */
const ListContext = React.createContext<{ padding?: string; hoverable: boolean }>({ hoverable: false });

export function List({
  variant = 'default',
  spacing = 'md',
  hoverable = false,
  ordered = false,
  className,
  style,
  children,
}: ListProps): React.ReactElement {
  const Tag = ordered ? 'ol' : 'ul';
  const listId = `softn-list-${React.useId().replace(/:/g, '')}`;
  const padding = spacingValues[spacing];
  const items = React.useMemo(() => ({ padding, hoverable }), [padding, hoverable]);

  const listStyle: React.CSSProperties = {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    ...(variant === 'bordered' && {
      border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
      borderRadius: '0.5rem',
      overflow: 'hidden',
    }),
    ...style,
  };

  // The items are told their spacing through context and given their lines
  // by a rule, not by cloning them. From a page each item arrives inside the
  // renderer's error boundary, so a style cloned onto it went to the
  // boundary: a divided list drew no lines and none of its spacing.
  const lines =
    variant === 'divided' || variant === 'bordered'
      ? `[data-softn-list="${listId}"] > li + li { border-top: 1px solid var(--color-border, rgba(255, 255, 255, 0.08)); }`
      : '';

  return (
    <>
      {lines && <style>{lines}</style>}
      <Tag data-softn-list={listId} className={className} style={listStyle}>
        <ListContext.Provider value={items}>{children}</ListContext.Provider>
      </Tag>
    </>
  );
}

export function ListItem({
  active = false,
  disabled = false,
  onClick,
  leading,
  trailing,
  className,
  style,
  children,
}: ListItemProps): React.ReactElement {
  const [isHovered, setIsHovered] = React.useState(false);
  const list = React.useContext(ListContext);

  const itemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: list.padding ?? '0.75rem',
    backgroundColor: active ? 'var(--color-primary-50, rgba(99, 102, 241, 0.1))' : isHovered && !disabled ? 'var(--color-gray-50, rgba(255, 255, 255, 0.03))' : 'transparent',
    color: disabled ? 'var(--color-text-disabled, #52525b)' : 'var(--color-text, #ececf0)',
    cursor: disabled ? 'not-allowed' : onClick || list.hoverable ? 'pointer' : 'default',
    transition: 'background-color 180ms cubic-bezier(0.16, 1, 0.3, 1)',
    opacity: disabled ? 0.6 : 1,
    ...style,
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
  };

  return (
    <li
      className={className}
      style={itemStyle}
      onClick={disabled ? undefined : onClick}
      // An <li> with an onClick is reachable by mouse and by nothing else. When
      // one is given a click handler it becomes a real control: focusable, named
      // as a button, and operable with Enter and Space — which the browser does
      // for a <button> and for no other element. Items without onClick stay
      // ordinary list items and gain nothing they should not have.
      {...(onClick && !disabled
        ? {
            role: 'button' as const,
            tabIndex: 0,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              if (event.target !== event.currentTarget) return;
              event.preventDefault();
              onClick();
            },
          }
        : {})}
      aria-disabled={onClick && disabled ? true : undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {leading && <span style={{ flexShrink: 0 }}>{leading}</span>}
      <div style={contentStyle}>{children}</div>
      {trailing && <span style={{ flexShrink: 0 }}>{trailing}</span>}
    </li>
  );
}

export default List;
