/**
 * EmptyState Component
 *
 * A placeholder for empty content areas.
 * Displays an icon, title, description, and optional action.
 * Features entrance animations and optional floating icon effect.
 */

import React from 'react';

export interface EmptyStateProps {
  /** Icon to display */
  icon?: React.ReactNode;
  /** Icon size */
  iconSize?: number;
  /** Icon color */
  iconColor?: string;
  /** Title text */
  title?: string;
  /** Description text */
  description?: string;
  /** Primary action button */
  action?: React.ReactNode;
  /** Secondary action */
  secondaryAction?: React.ReactNode;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Variant */
  variant?: 'default' | 'card' | 'minimal';
  /** Enable floating animation on icon */
  animated?: boolean;
  /** Disable entrance animation */
  noEntranceAnimation?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Children (additional content) */
  children?: React.ReactNode;
}

const sizeConfig = {
  sm: { iconSize: 40, titleSize: '1rem', descSize: '0.8125rem', padding: '1.5rem', gap: '0.75rem' },
  md: { iconSize: 56, titleSize: '1.125rem', descSize: '0.875rem', padding: '2rem', gap: '1rem' },
  lg: { iconSize: 72, titleSize: '1.25rem', descSize: '1rem', padding: '3rem', gap: '1.25rem' },
};

// Default empty state icons
const DefaultIcons = {
  inbox: (size: number, color: string) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 12h-6l-2 3H10l-2-3H2" />
      <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
    </svg>
  ),
  search: (size: number, color: string) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  ),
  folder: (size: number, color: string) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  ),
  file: (size: number, color: string) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  ),
};

export function EmptyState({
  icon,
  iconSize,
  iconColor = 'var(--color-gray-400, #9ca3af)',
  title = 'No data',
  description,
  action,
  secondaryAction,
  size = 'md',
  variant = 'default',
  animated = false,
  noEntranceAnimation = false,
  className,
  style,
  children,
}: EmptyStateProps): React.ReactElement {
  const config = sizeConfig[size];
  const finalIconSize = iconSize ?? config.iconSize;

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: config.padding,
    gap: config.gap,
    animation: noEntranceAnimation
      ? 'none'
      : 'softn-empty-fade-in 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
    ...(variant === 'card' && {
      backgroundColor: 'var(--color-gray-50, #1a1a2e)',
      borderRadius: 'var(--radius-xl, 0.75rem)',
      border: '1px dashed var(--color-gray-300, #d1d5db)',
      boxShadow: '0 1px 3px rgba(0, 0, 0, 0.02)',
    }),
    ...(variant === 'minimal' && {
      padding: config.padding,
    }),
    ...style,
  };

  const iconContainerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: finalIconSize + 32,
    height: finalIconSize + 32,
    borderRadius: '50%',
    backgroundColor:
      variant === 'minimal'
        ? 'transparent'
        : 'linear-gradient(135deg, var(--color-gray-50, #1a1a2e) 0%, var(--color-gray-100, #27272a) 100%)',
    background:
      variant === 'minimal'
        ? 'transparent'
        : 'linear-gradient(135deg, var(--color-gray-50, #1a1a2e) 0%, var(--color-gray-100, #27272a) 100%)',
    boxShadow:
      variant === 'minimal'
        ? 'none'
        : 'inset 0 1px 2px rgba(255, 255, 255, 0.8), 0 2px 4px rgba(0, 0, 0, 0.04)',
    animation: animated ? 'softn-empty-float 3s ease-in-out infinite' : 'none',
    transition: 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
  };

  const titleStyle: React.CSSProperties = {
    fontSize: config.titleSize,
    fontWeight: 600,
    color: 'var(--color-text, #111827)',
    margin: 0,
    letterSpacing: '-0.01em',
  };

  const descriptionStyle: React.CSSProperties = {
    fontSize: config.descSize,
    color: 'var(--color-text-muted, #6b7280)',
    margin: 0,
    maxWidth: '24rem',
    lineHeight: 1.6,
  };

  const actionsStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    marginTop: '0.75rem',
  };

  // Render default icon if none provided
  const renderIcon = () => {
    if (icon) return icon;
    return DefaultIcons.inbox(finalIconSize, iconColor);
  };

  return (
    <>
      <style>{`
        @keyframes softn-empty-fade-in {
          from {
            opacity: 0;
            transform: translateY(10px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @keyframes softn-empty-float {
          0%, 100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-8px);
          }
        }
      `}</style>
      <div className={className} style={containerStyle}>
        <div style={iconContainerStyle}>{renderIcon()}</div>
        {title && <h3 style={titleStyle}>{title}</h3>}
        {description && <p style={descriptionStyle}>{description}</p>}
        {children}
        {(action || secondaryAction) && (
          <div style={actionsStyle}>
            {action}
            {secondaryAction}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Preset empty states for common use cases
 */
export function EmptySearch(props: Omit<EmptyStateProps, 'icon' | 'title'>): React.ReactElement {
  const config = sizeConfig[props.size ?? 'md'];
  return (
    <EmptyState
      icon={DefaultIcons.search(
        props.iconSize ?? config.iconSize,
        props.iconColor ?? 'var(--color-gray-400, #9ca3af)'
      )}
      title="No results found"
      description="Try adjusting your search or filter to find what you're looking for."
      {...props}
    />
  );
}

export function EmptyFolder(props: Omit<EmptyStateProps, 'icon' | 'title'>): React.ReactElement {
  const config = sizeConfig[props.size ?? 'md'];
  return (
    <EmptyState
      icon={DefaultIcons.folder(
        props.iconSize ?? config.iconSize,
        props.iconColor ?? 'var(--color-gray-400, #9ca3af)'
      )}
      title="No files yet"
      description="Upload a file to get started."
      {...props}
    />
  );
}

export function EmptyList(props: Omit<EmptyStateProps, 'icon' | 'title'>): React.ReactElement {
  const config = sizeConfig[props.size ?? 'md'];
  return (
    <EmptyState
      icon={DefaultIcons.file(
        props.iconSize ?? config.iconSize,
        props.iconColor ?? 'var(--color-gray-400, #9ca3af)'
      )}
      title="No items"
      description="There are no items to display."
      {...props}
    />
  );
}

export default EmptyState;
