/**
 * Button Component
 *
 * A clickable button with various styles and variants.
 * Uses CSS variables for theming support.
 */

import React, { useState, useCallback } from 'react';

export interface ButtonProps {
  /** Button type */
  type?: 'button' | 'submit' | 'reset';
  /** Button variant */
  variant?:
    | 'primary'
    | 'secondary'
    | 'outline'
    | 'danger'
    | 'success'
    | 'warning'
    | 'ghost'
    | 'link';
  /** Button size */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  /** Whether the button is disabled */
  disabled?: boolean;
  /** Whether the button is loading */
  loading?: boolean;
  /** Full width */
  fullWidth?: boolean;
  /** Rounded style (pill shape) */
  rounded?: boolean;
  /** Icon only button (square aspect ratio) */
  iconOnly?: boolean;
  /** Left icon */
  leftIcon?: React.ReactNode;
  /** Right icon */
  rightIcon?: React.ReactNode;
  /** Click handler */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Children */
  children?: React.ReactNode;
}

interface VariantStyle {
  base: React.CSSProperties;
  hover: React.CSSProperties;
  active: React.CSSProperties;
}

const sizeConfig: Record<
  string,
  { padding: string; fontSize: string; height: string; iconSize: string }
> = {
  xs: {
    padding: '0.25rem 0.5rem',
    fontSize: 'var(--text-xs, 0.75rem)',
    height: '1.75rem',
    iconSize: '0.875rem',
  },
  sm: {
    padding: '0.375rem 0.75rem',
    fontSize: 'var(--text-sm, 0.875rem)',
    height: '2rem',
    iconSize: '1rem',
  },
  md: {
    padding: '0.5rem 1rem',
    fontSize: 'var(--text-sm, 0.875rem)',
    height: '2.5rem',
    iconSize: '1.125rem',
  },
  lg: {
    padding: '0.625rem 1.5rem',
    fontSize: 'var(--text-base, 1rem)',
    height: '2.75rem',
    iconSize: '1.25rem',
  },
  xl: {
    padding: '0.75rem 2rem',
    fontSize: 'var(--text-lg, 1.125rem)',
    height: '3rem',
    iconSize: '1.5rem',
  },
};

const variantStyles: Record<string, VariantStyle> = {
  primary: {
    base: {
      background:
        'linear-gradient(to bottom, var(--color-primary-500, #6366f1), var(--color-primary-600, #4f46e5))',
      color: 'var(--color-primary-text, #ffffff)',
      border: 'none',
      boxShadow:
        '0 1px 3px 0 rgb(99 102 241 / 0.35), inset 0 1px 0 0 rgb(255 255 255 / 0.12)',
    },
    hover: {
      background:
        'linear-gradient(to bottom, var(--color-primary-600, #4f46e5), var(--color-primary-700, #4338ca))',
      boxShadow:
        '0 4px 12px -2px rgb(99 102 241 / 0.4), inset 0 1px 0 0 rgb(255 255 255 / 0.12)',
    },
    active: {
      background:
        'linear-gradient(to bottom, var(--color-primary-700, #4338ca), var(--color-primary-700, #4338ca))',
      boxShadow: '0 1px 2px 0 rgb(99 102 241 / 0.3), inset 0 1px 3px 0 rgb(0 0 0 / 0.15)',
    },
  },
  secondary: {
    base: {
      background: 'var(--btn-secondary-bg, linear-gradient(to bottom, #2a2a30, #1e1e23))',
      color: 'var(--btn-secondary-text, #f4f4f5)',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'var(--btn-secondary-border, #52525b)',
      boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.1)',
    },
    hover: {
      background: 'var(--btn-secondary-bg-hover, linear-gradient(to bottom, #52525b, #3f3f46))',
      borderColor: 'var(--btn-secondary-border-hover, #71717a)',
      boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.15)',
    },
    active: {
      background: 'var(--btn-secondary-bg-active, #3f3f46)',
      boxShadow: 'inset 0 1px 2px 0 rgb(0 0 0 / 0.1)',
    },
  },
  outline: {
    base: {
      background: 'transparent',
      color: 'var(--color-primary-500, #6366f1)',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'var(--color-primary-500, #6366f1)',
    },
    hover: {
      background: 'var(--color-primary-50, rgba(99, 102, 241, 0.08))',
      borderColor: 'var(--color-primary-600, #4f46e5)',
      boxShadow: '0 0 0 3px var(--color-primary-50, rgba(99, 102, 241, 0.08))',
    },
    active: {
      background: 'var(--color-primary-100, rgba(99, 102, 241, 0.14))',
      boxShadow: '0 0 0 2px var(--color-primary-50, rgba(99, 102, 241, 0.08))',
    },
  },
  danger: {
    base: {
      background:
        'linear-gradient(to bottom, var(--color-error-500, #ef4444), var(--color-error-600, #dc2626))',
      color: 'var(--color-white, #ffffff)',
      border: 'none',
      boxShadow:
        '0 1px 3px 0 rgb(220 38 38 / 0.4), 0 1px 2px -1px rgb(220 38 38 / 0.4), inset 0 1px 0 0 rgb(255 255 255 / 0.1)',
    },
    hover: {
      background:
        'linear-gradient(to bottom, var(--color-error-600, #dc2626), var(--color-error-700, #b91c1c))',
      boxShadow:
        '0 4px 6px -1px rgb(220 38 38 / 0.4), 0 2px 4px -2px rgb(220 38 38 / 0.4), inset 0 1px 0 0 rgb(255 255 255 / 0.1)',
    },
    active: {
      background:
        'linear-gradient(to bottom, var(--color-error-700, #b91c1c), var(--color-error-800, #991b1b))',
      boxShadow: '0 1px 2px 0 rgb(220 38 38 / 0.4), inset 0 1px 2px 0 rgb(0 0 0 / 0.1)',
    },
  },
  success: {
    base: {
      background:
        'linear-gradient(to bottom, var(--color-success-500, #22c55e), var(--color-success-600, #16a34a))',
      color: 'var(--color-white, #ffffff)',
      border: 'none',
      boxShadow:
        '0 1px 3px 0 rgb(22 163 74 / 0.4), 0 1px 2px -1px rgb(22 163 74 / 0.4), inset 0 1px 0 0 rgb(255 255 255 / 0.1)',
    },
    hover: {
      background:
        'linear-gradient(to bottom, var(--color-success-600, #16a34a), var(--color-success-700, #15803d))',
      boxShadow:
        '0 4px 6px -1px rgb(22 163 74 / 0.4), 0 2px 4px -2px rgb(22 163 74 / 0.4), inset 0 1px 0 0 rgb(255 255 255 / 0.1)',
    },
    active: {
      background:
        'linear-gradient(to bottom, var(--color-success-700, #15803d), var(--color-success-800, #166534))',
      boxShadow: '0 1px 2px 0 rgb(22 163 74 / 0.4), inset 0 1px 2px 0 rgb(0 0 0 / 0.1)',
    },
  },
  warning: {
    base: {
      background:
        'linear-gradient(to bottom, var(--color-warning-400, #fbbf24), var(--color-warning-500, #f59e0b))',
      color: 'var(--color-gray-900, #111827)',
      border: 'none',
      boxShadow:
        '0 1px 3px 0 rgb(245 158 11 / 0.4), 0 1px 2px -1px rgb(245 158 11 / 0.4), inset 0 1px 0 0 rgb(255 255 255 / 0.2)',
    },
    hover: {
      background:
        'linear-gradient(to bottom, var(--color-warning-500, #f59e0b), var(--color-warning-600, #d97706))',
      boxShadow:
        '0 4px 6px -1px rgb(245 158 11 / 0.4), 0 2px 4px -2px rgb(245 158 11 / 0.4), inset 0 1px 0 0 rgb(255 255 255 / 0.2)',
    },
    active: {
      background:
        'linear-gradient(to bottom, var(--color-warning-600, #d97706), var(--color-warning-700, #b45309))',
      boxShadow: '0 1px 2px 0 rgb(245 158 11 / 0.4), inset 0 1px 2px 0 rgb(0 0 0 / 0.1)',
    },
  },
  ghost: {
    base: {
      background: 'transparent',
      color: 'var(--btn-ghost-text, #d4d4d8)',
      border: 'none',
    },
    hover: {
      background: 'var(--btn-ghost-bg-hover, #1e1e23)',
    },
    active: {
      background: 'var(--btn-ghost-bg-active, #3f3f46)',
    },
  },
  link: {
    base: {
      background: 'transparent',
      color: 'var(--color-primary-500, #6366f1)',
      border: 'none',
      padding: '0',
    },
    hover: {
      color: 'var(--color-primary-600, #4f46e5)',
      textDecoration: 'underline',
    },
    active: {
      color: 'var(--color-primary-700, #4338ca)',
    },
  },
};

const LoadingSpinner = ({ size }: { size: string }) => (
  <svg
    style={{
      width: size,
      height: size,
      animation: 'softn-spin 1s linear infinite',
    }}
    fill="none"
    viewBox="0 0 24 24"
  >
    <circle
      style={{ opacity: 0.25 }}
      cx="12"
      cy="12"
      r="10"
      stroke="currentColor"
      strokeWidth="4"
    />
    <path
      style={{ opacity: 0.75 }}
      fill="currentColor"
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
    />
  </svg>
);

export function Button({
  type = 'button',
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  fullWidth = false,
  rounded = false,
  iconOnly = false,
  leftIcon,
  rightIcon,
  onClick,
  className,
  style,
  children,
}: ButtonProps): React.ReactElement {
  const [isHovered, setIsHovered] = useState(false);
  const [isActive, setIsActive] = useState(false);

  const sizeStyle = sizeConfig[size];
  const variantStyle = variantStyles[variant];

  const handleMouseEnter = useCallback(
    () => !disabled && !loading && setIsHovered(true),
    [disabled, loading]
  );
  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    setIsActive(false);
  }, []);
  const handleMouseDown = useCallback(
    () => !disabled && !loading && setIsActive(true),
    [disabled, loading]
  );
  const handleMouseUp = useCallback(() => setIsActive(false), []);

  // Compute transform based on state
  const getTransform = () => {
    if (disabled || loading) return 'none';
    if (isActive) return 'scale(0.97) translateY(0.5px)';
    if (isHovered) return 'translateY(-1.5px)';
    return 'none';
  };

  const computedStyle: React.CSSProperties = {
    // Base styles
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    fontWeight: 500,
    lineHeight: 1,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    outline: 'none',
    transition:
      'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',

    // Size styles
    padding: iconOnly ? '0' : sizeStyle.padding,
    fontSize: sizeStyle.fontSize,
    height: sizeStyle.height,
    minWidth: iconOnly ? sizeStyle.height : undefined,

    // Border radius - slightly more rounded for modern look
    borderRadius: rounded ? 'var(--radius-full, 9999px)' : 'var(--radius-lg, 0.5rem)',

    // Variant base styles
    ...variantStyle.base,

    // Hover state
    ...(isHovered && !disabled && !loading ? variantStyle.hover : {}),

    // Active state
    ...(isActive && !disabled && !loading ? variantStyle.active : {}),

    // Transform for hover/active feedback
    transform: getTransform(),

    // Disabled/loading state
    cursor: disabled || loading ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : loading ? 0.7 : 1,
    pointerEvents: disabled ? 'none' : undefined,

    // Full width
    width: fullWidth ? '100%' : undefined,

    // User overrides
    ...style,
  };

  return (
    <>
      <style>{`
        @keyframes softn-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      <button
        type={type}
        disabled={disabled || loading}
        onClick={onClick}
        className={className}
        style={computedStyle}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
      >
        {loading ? (
          <LoadingSpinner size={sizeStyle.iconSize} />
        ) : leftIcon ? (
          <span style={{ display: 'flex', fontSize: sizeStyle.iconSize }}>{leftIcon}</span>
        ) : null}
        {!iconOnly && children}
        {!loading && rightIcon && (
          <span style={{ display: 'flex', fontSize: sizeStyle.iconSize }}>{rightIcon}</span>
        )}
      </button>
    </>
  );
}

export default Button;
