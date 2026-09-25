/**
 * Alert Component
 *
 * A dismissible alert message with various status variants.
 * Uses CSS variables for theming support.
 */

import React, { useState, useCallback } from 'react';

export interface AlertProps {
  /** Alert variant */
  variant?: 'info' | 'success' | 'warning' | 'error';
  /** Alert style */
  alertStyle?: 'filled' | 'light' | 'outline' | 'subtle';
  /** Alert title */
  title?: string;
  /** Whether the alert is dismissible */
  dismissible?: boolean;
  /** Callback when dismissed */
  onDismiss?: () => void;
  /** Show icon */
  showIcon?: boolean;
  /** Border radius */
  borderRadius?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
  /**
   * Announcement role. By default an error or a warning is an `alert` (read
   * out at once) and info or success a `status` (read when the reader is
   * free); `none` renders no live region, for an alert that is part of the
   * page from the start.
   */
  role?: 'alert' | 'status' | 'none';
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Alert content */
  children?: React.ReactNode;
}

interface VariantColors {
  bg: string;
  bgLight: string;
  border: string;
  text: string;
  textDark: string;
  icon: string;
}

/**
 * The colours for each status.
 *
 * The tinted styles (light, subtle, outline) mix their background and border
 * from the status colour itself and draw text in the page's text colour. They
 * used the -50/-200/-700 steps, which App's variables never define, so under
 * a dark theme -700 text sat dark on a dark surface and warning's -50
 * fallback painted a near-white box. A mix of the -500 step with transparent
 * reads on either surface.
 */
function statusColors(status: string, fallback: string): VariantColors {
  const base = `var(--color-${status}-500, ${fallback})`;
  return {
    bg: base,
    bgLight: `color-mix(in srgb, ${base} 12%, transparent)`,
    border: `color-mix(in srgb, ${base} 35%, transparent)`,
    text: 'var(--color-text, currentColor)',
    textDark: 'var(--color-white, white)',
    icon: base,
  };
}

const variantColors: Record<string, VariantColors> = {
  info: statusColors('info', '#3b82f6'),
  success: statusColors('success', '#22c55e'),
  warning: statusColors('warning', '#f59e0b'),
  error: statusColors('error', '#ef4444'),
};

const radiusValues: Record<string, string> = {
  none: '0',
  sm: 'var(--radius-sm, 0.25rem)',
  md: 'var(--radius-md, 0.375rem)',
  lg: 'var(--radius-lg, 0.5rem)',
  xl: 'var(--radius-xl, 0.75rem)',
};

const icons: Record<string, React.ReactNode> = {
  info: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  ),
  success: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  ),
  warning: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  error: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ),
};

function getAlertStyles(
  _variant: string,
  alertStyle: string,
  colors: VariantColors
): React.CSSProperties {
  switch (alertStyle) {
    case 'filled':
      return {
        backgroundColor: colors.bg,
        color: colors.textDark,
        border: 'none',
      };
    case 'outline':
      return {
        backgroundColor: 'transparent',
        color: colors.text,
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: colors.border,
      };
    case 'subtle':
      return {
        backgroundColor: colors.bgLight,
        color: colors.text,
        border: 'none',
      };
    case 'light':
    default:
      return {
        backgroundColor: colors.bgLight,
        color: colors.text,
        borderLeft: `4px solid ${colors.icon}`,
      };
  }
}

export function Alert({
  variant = 'info',
  alertStyle = 'light',
  title,
  dismissible = false,
  onDismiss,
  showIcon = true,
  borderRadius = 'md',
  role,
  className,
  style,
  children,
}: AlertProps): React.ReactElement {
  const [isVisible, setIsVisible] = useState(true);
  const [isHovered, setIsHovered] = useState(false);
  const colors = variantColors[variant];

  const handleDismiss = useCallback(() => {
    setIsVisible(false);
    onDismiss?.();
  }, [onDismiss]);

  if (!isVisible) {
    return <></>;
  }

  const alertStyles = getAlertStyles(variant, alertStyle, colors);
  // Every Alert used to be `role="alert"`, so an info note on a page was read
  // out assertively the moment the page loaded.
  const liveRole = role ?? (variant === 'error' || variant === 'warning' ? 'alert' : 'status');
  const isDark = alertStyle === 'filled';

  const getShadow = () => {
    if (alertStyle === 'filled') return '0 2px 4px rgba(0, 0, 0, 0.1)';
    if (alertStyle === 'subtle') return '0 1px 2px rgba(0, 0, 0, 0.05)';
    return 'none';
  };

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.875rem',
    padding: '1rem 1.125rem',
    borderRadius: radiusValues[borderRadius] ?? borderRadius,
    transition: 'all var(--duration-fast, 150ms) var(--easing-inOut, cubic-bezier(0.16, 1, 0.3, 1))',
    boxShadow: getShadow(),
    ...alertStyles,
    ...style,
  };

  const iconStyle: React.CSSProperties = {
    flexShrink: 0,
    color: isDark ? colors.textDark : colors.icon,
    marginTop: '0.125rem',
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    overflowWrap: 'anywhere',
  };

  const titleStyle: React.CSSProperties = {
    fontWeight: 600,
    marginBottom: children ? '0.25rem' : 0,
    fontSize: 'var(--text-sm, 0.875rem)',
    lineHeight: 1.5,
  };

  const messageStyle: React.CSSProperties = {
    fontSize: 'var(--text-sm, 0.875rem)',
    lineHeight: 1.5,
    opacity: 0.9,
  };

  const dismissStyle: React.CSSProperties = {
    flexShrink: 0,
    padding: '0.25rem',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: isDark ? colors.textDark : colors.text,
    opacity: isHovered ? 1 : 0.6,
    borderRadius: 'var(--radius-sm, 0.25rem)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'opacity var(--duration-fast, 150ms) var(--easing-inOut, cubic-bezier(0.16, 1, 0.3, 1))',
  };

  return (
    <div
      className={className}
      style={containerStyle}
      role={liveRole === 'none' ? undefined : liveRole}
    >
      {showIcon && (
        <span style={iconStyle} aria-hidden="true">
          {icons[variant]}
        </span>
      )}
      <div style={contentStyle}>
        {title && <div style={titleStyle}>{title}</div>}
        {children && <div style={messageStyle}>{children}</div>}
      </div>
      {dismissible && (
        <button
          type="button"
          onClick={handleDismiss}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          style={dismissStyle}
          aria-label="Dismiss"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}

export default Alert;
