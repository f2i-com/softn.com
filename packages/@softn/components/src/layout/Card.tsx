/**
 * Card Component
 *
 * A styled container with optional header and footer.
 * Uses CSS variables for theming support.
 */

import React, { useState, useCallback } from 'react';

export interface CardProps {
  /** Card title (shown in header) */
  title?: string;
  /** Card subtitle */
  subtitle?: string;
  /** Card variant */
  variant?: 'default' | 'outlined' | 'elevated' | 'filled' | 'ghost' | 'glass' | 'gradient';
  /** Padding */
  padding?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Border radius */
  borderRadius?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Whether the card is interactive (hoverable) - shorthand for interactive */
  hover?: boolean;
  /** Whether the card is interactive (hoverable) */
  interactive?: boolean;
  /** Whether the card is selected */
  selected?: boolean;
  /** Gradient background colors (for gradient variant) */
  gradientFrom?: string;
  gradientTo?: string;
  /** Header content (replaces title) */
  header?: React.ReactNode;
  /** Footer content */
  footer?: React.ReactNode;
  /** Header actions (right side of header) */
  headerActions?: React.ReactNode;
  /** Whether to show dividers */
  dividers?: boolean;
  /** Click handler (makes card interactive) */
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Children */
  children?: React.ReactNode;
}

const paddingValues: Record<string, string> = {
  none: '0',
  sm: 'var(--spacing-3, 0.75rem)',
  md: 'var(--spacing-4, 1rem)',
  lg: 'var(--spacing-6, 1.5rem)',
  xl: 'var(--spacing-8, 2rem)',
};

const radiusValues: Record<string, string> = {
  none: '0',
  sm: 'var(--radius-sm, 0.25rem)',
  md: 'var(--radius-md, 0.375rem)',
  lg: 'var(--radius-lg, 0.5rem)',
  xl: 'var(--radius-xl, 0.75rem)',
};

interface VariantStyle {
  background: string;
  border: string;
  boxShadow?: string;
}

const variantStyles: Record<string, VariantStyle> = {
  default: {
    background: 'var(--color-surface, #16161a)',
    border: '1px solid var(--color-gray-700, #3f3f46)',
    boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.2)',
  },
  outlined: {
    background: 'transparent',
    border: '1px solid var(--color-gray-600, #52525b)',
  },
  elevated: {
    background: 'var(--color-surface, #16161a)',
    border: 'none',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -2px rgba(0, 0, 0, 0.2)',
  },
  filled: {
    background: 'var(--color-gray-800, #1e1e23)',
    border: '1px solid var(--color-gray-700, #3f3f46)',
  },
  ghost: {
    background: 'transparent',
    border: 'none',
  },
  glass: {
    background: 'rgba(255, 255, 255, 0.05)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
  },
  gradient: {
    background:
      'linear-gradient(135deg, var(--color-primary-500, #6366f1) 0%, var(--color-primary-600, #4f46e5) 100%)',
    border: 'none',
    boxShadow: '0 4px 14px rgba(99, 102, 241, 0.35)',
  },
};

const hoverStyles: Record<string, React.CSSProperties> = {
  default: {
    border: '1px solid var(--color-gray-500, #71717a)',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -1px rgba(0, 0, 0, 0.2)',
  },
  outlined: {
    border: '1px solid var(--color-primary-400, #818cf8)',
    boxShadow: '0 0 0 3px rgba(99, 102, 241, 0.15)',
  },
  elevated: {
    boxShadow: '0 10px 20px -5px rgba(0, 0, 0, 0.4), 0 6px 10px -5px rgba(0, 0, 0, 0.3)',
    transform: 'translateY(-2px)',
  },
  filled: {
    background: 'var(--color-gray-700, #3f3f46)',
    border: '1px solid var(--color-gray-600, #52525b)',
  },
  ghost: {
    background: 'var(--color-gray-800, #1e1e23)',
  },
  glass: {
    background: 'rgba(255, 255, 255, 0.08)',
    boxShadow: '0 12px 40px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.15)',
    transform: 'translateY(-2px)',
  },
  gradient: {
    boxShadow: '0 8px 20px rgba(99, 102, 241, 0.45)',
    transform: 'translateY(-2px)',
  },
};

const selectedStyles: React.CSSProperties = {
  border: '1px solid var(--color-primary-500, #6366f1)',
  boxShadow: '0 0 0 3px rgba(99, 102, 241, 0.15), 0 1px 3px 0 rgba(0, 0, 0, 0.05)',
};

export function Card({
  title,
  subtitle,
  variant = 'default',
  padding = 'md',
  borderRadius = 'lg',
  hover = false,
  interactive = false,
  selected = false,
  gradientFrom,
  gradientTo,
  header,
  footer,
  headerActions,
  dividers = true,
  onClick,
  className,
  style,
  children,
}: CardProps): React.ReactElement {
  const [isHovered, setIsHovered] = useState(false);
  const isInteractive = hover || interactive || onClick;
  const variantStyle = variantStyles[variant] || variantStyles.default;

  const handleMouseEnter = useCallback(() => isInteractive && setIsHovered(true), [isInteractive]);
  const handleMouseLeave = useCallback(() => setIsHovered(false), []);

  // Handle custom gradient colors
  const getBackground = () => {
    if (variant === 'gradient' && (gradientFrom || gradientTo)) {
      const from = gradientFrom || 'var(--color-primary-500, #6366f1)';
      const to = gradientTo || 'var(--color-primary-600, #4f46e5)';
      return `linear-gradient(135deg, ${from} 0%, ${to} 100%)`;
    }
    return variantStyle.background;
  };

  const baseStyle: React.CSSProperties = {
    background: getBackground(),
    border: variantStyle.border,
    boxShadow: variantStyle.boxShadow,
    borderRadius: radiusValues[borderRadius] ?? borderRadius,
    overflow: 'hidden',
    transition: 'all 220ms cubic-bezier(0.16, 1, 0.3, 1)',
    cursor: isInteractive ? 'pointer' : undefined,
    ...(variant === 'glass'
      ? { backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }
      : {}),
    ...(isHovered && isInteractive && hoverStyles[variant] ? hoverStyles[variant] : {}),
    ...(selected ? selectedStyles : {}),
    ...style,
  };

  const paddingValue = paddingValues[padding] ?? padding;

  const headerStyle: React.CSSProperties = {
    padding: paddingValue,
    borderBottom: dividers ? '1px solid var(--color-border, rgba(255, 255, 255, 0.08))' : undefined,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '1rem',
  };

  const titleContainerStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
  };

  const titleStyle: React.CSSProperties = {
    margin: 0,
    fontSize: 'var(--text-lg, 1.125rem)',
    fontWeight: 600,
    color: 'var(--color-text, #fafafa)',
    lineHeight: 1.4,
  };

  const subtitleStyle: React.CSSProperties = {
    margin: '0.25rem 0 0 0',
    fontSize: 'var(--text-sm, 0.875rem)',
    color: 'var(--color-text-muted, #a1a1aa)',
    lineHeight: 1.4,
  };

  const contentStyle: React.CSSProperties = {
    padding: paddingValue,
  };

  const footerStyle: React.CSSProperties = {
    padding: paddingValue,
    borderTop: dividers ? '1px solid var(--color-border, rgba(255, 255, 255, 0.08))' : undefined,
    background: 'var(--color-surface-hover, #1e1e23)',
  };

  const hasHeader = title || subtitle || header || headerActions;

  return (
    <div
      className={className}
      style={baseStyle}
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
    >
      {hasHeader && (
        <div style={headerStyle}>
          {header ?? (
            <div style={titleContainerStyle}>
              {title && <h3 style={titleStyle}>{title}</h3>}
              {subtitle && <p style={subtitleStyle}>{subtitle}</p>}
            </div>
          )}
          {headerActions && <div>{headerActions}</div>}
        </div>
      )}
      <div style={contentStyle}>{children}</div>
      {footer && <div style={footerStyle}>{footer}</div>}
    </div>
  );
}

export default Card;
