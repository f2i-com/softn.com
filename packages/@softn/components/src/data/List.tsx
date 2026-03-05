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

  return (
    <Tag className={className} style={listStyle}>
      {React.Children.map(children, (child, index) => {
        if (React.isValidElement<ListItemProps>(child)) {
          return React.cloneElement(child, {
            ...child.props,
            style: {
              ...child.props.style,
              ...(variant === 'divided' &&
                index > 0 && {
                  borderTop: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
                }),
              ...(variant === 'bordered' &&
                index > 0 && {
                  borderTop: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
                }),
              padding: spacingValues[spacing],
              ...(hoverable && {
                cursor: 'pointer',
              }),
            },
          } as ListItemProps);
        }
        return child;
      })}
    </Tag>
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

  const itemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.75rem',
    backgroundColor: active ? 'var(--color-primary-50, rgba(99, 102, 241, 0.1))' : isHovered && !disabled ? 'var(--color-gray-50, rgba(255, 255, 255, 0.03))' : 'transparent',
    color: disabled ? 'var(--color-text-disabled, #52525b)' : 'var(--color-text, #ececf0)',
    cursor: disabled ? 'not-allowed' : onClick ? 'pointer' : 'default',
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
