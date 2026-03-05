/**
 * Avatar Component
 *
 * A user avatar with image or initials fallback.
 * Supports status indicators, badges, and group stacking.
 */

import React from 'react';

export interface AvatarProps {
  /** Image source */
  src?: string;
  /** Alt text */
  alt?: string;
  /** User name (for initials fallback) */
  name?: string;
  /** Avatar size */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number;
  /** Avatar shape */
  shape?: 'circle' | 'square' | 'rounded';
  /** Border */
  border?: boolean;
  /** Border color */
  borderColor?: string;
  /** Background color (for initials) */
  backgroundColor?: string;
  /** Text color (for initials) */
  textColor?: string;
  /** Online status indicator */
  status?: 'online' | 'offline' | 'away' | 'busy' | 'none';
  /** Status position */
  statusPosition?: 'top-right' | 'bottom-right' | 'top-left' | 'bottom-left';
  /** Badge content (number or text) */
  badge?: string | number;
  /** Badge color */
  badgeColor?: string;
  /** Show ring on hover */
  ring?: boolean;
  /** Ring color */
  ringColor?: string;
  /** Click handler */
  onClick?: () => void;
  /** Keyboard handler */
  onKeyDown?: (event: React.KeyboardEvent) => void;
  /** Accessible label (for interactive avatars) */
  ariaLabel?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Children (for custom content) */
  children?: React.ReactNode;
}

export interface AvatarGroupProps {
  /** Maximum avatars to show */
  max?: number;
  /** Avatar size */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number;
  /** Spacing between avatars (negative for overlap) */
  spacing?: number;
  /** Border color for overlapping avatars */
  borderColor?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Children (Avatar components) */
  children: React.ReactNode;
}

const sizeValues: Record<string, number> = {
  xs: 24,
  sm: 32,
  md: 40,
  lg: 48,
  xl: 64,
};

const fontSizes: Record<string, string> = {
  xs: '0.625rem',
  sm: '0.75rem',
  md: '0.875rem',
  lg: '1rem',
  xl: '1.25rem',
};

interface StatusConfig {
  color: string;
  glow: string;
  pulse?: boolean;
}

const statusConfigs: Record<string, StatusConfig> = {
  online: {
    color: 'var(--color-success-500, #22c55e)',
    glow: 'rgba(34, 197, 94, 0.5)',
    pulse: true,
  },
  offline: {
    color: 'var(--color-gray-400, #9ca3af)',
    glow: 'rgba(156, 163, 175, 0.3)',
  },
  away: {
    color: 'var(--color-warning-500, #f59e0b)',
    glow: 'rgba(245, 158, 11, 0.4)',
  },
  busy: {
    color: 'var(--color-error-500, #ef4444)',
    glow: 'rgba(239, 68, 68, 0.4)',
  },
};

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].charAt(0).toUpperCase();
  }
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    '#ef4444',
    '#f97316',
    '#f59e0b',
    '#84cc16',
    '#22c55e',
    '#14b8a6',
    '#06b6d4',
    '#6366f1',
    '#6366f1',
    '#8b5cf6',
    '#a855f7',
    '#d946ef',
    '#ec4899',
    '#f43f5e',
  ];
  return colors[Math.abs(hash) % colors.length];
}

function getSizeValue(size: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number): number {
  return typeof size === 'number' ? size : sizeValues[size];
}

// Check for reduced motion preference
function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = React.useState(false);

  React.useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mediaQuery.matches);

    const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  return prefersReducedMotion;
}

export function Avatar({
  src,
  alt,
  name,
  size = 'md',
  shape = 'circle',
  border = false,
  borderColor = 'var(--color-white, #ffffff)',
  backgroundColor,
  textColor = '#ffffff',
  status = 'none',
  statusPosition = 'bottom-right',
  badge,
  badgeColor = 'var(--color-error-500, #ef4444)',
  ring = false,
  ringColor = 'var(--color-primary-500, #6366f1)',
  onClick,
  onKeyDown,
  ariaLabel,
  className,
  style,
  children,
}: AvatarProps): React.ReactElement {
  const [imgError, setImgError] = React.useState(false);
  const [isHovered, setIsHovered] = React.useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();

  const sizeValue = getSizeValue(size);
  const fontSize = typeof size === 'number' ? `${size * 0.4}px` : fontSizes[size];
  const showInitials = !src || imgError;

  const borderRadius = shape === 'circle' ? '50%' : shape === 'rounded' ? '0.5rem' : '0.25rem';

  const computedStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    width: sizeValue,
    height: sizeValue,
    borderRadius,
    overflow: 'visible',
    backgroundColor: showInitials
      ? (backgroundColor ?? (name ? stringToColor(name) : 'var(--color-gray-400, #6b7280)'))
      : 'var(--color-gray-200, #3f3f46)',
    color: textColor,
    fontSize,
    fontWeight: 600,
    letterSpacing: '-0.025em',
    cursor: onClick ? 'pointer' : undefined,
    flexShrink: 0,
    transition: 'transform 150ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 150ms cubic-bezier(0.16, 1, 0.3, 1)',
    transform: isHovered && onClick ? 'scale(1.05)' : undefined,
    boxShadow:
      ring && isHovered
        ? `0 0 0 3px ${ringColor}`
        : border
          ? `0 0 0 2px ${borderColor}`
          : undefined,
    ...style,
  };

  const imgContainerStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    borderRadius,
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const imgStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  };

  // Status indicator positioning
  const statusSize = Math.max(sizeValue * 0.25, 8);
  const statusOffset = shape === 'circle' ? statusSize * 0.1 : 0;
  const statusPositions: Record<string, React.CSSProperties> = {
    'top-right': { top: statusOffset, right: statusOffset },
    'bottom-right': { bottom: statusOffset, right: statusOffset },
    'top-left': { top: statusOffset, left: statusOffset },
    'bottom-left': { bottom: statusOffset, left: statusOffset },
  };

  const statusConfig = statusConfigs[status];
  const statusStyle: React.CSSProperties = {
    position: 'absolute',
    width: statusSize,
    height: statusSize,
    borderRadius: '50%',
    backgroundColor: statusConfig?.color,
    border: `2px solid ${borderColor}`,
    boxShadow: statusConfig?.glow ? `0 0 6px ${statusConfig.glow}` : undefined,
    // Respect prefers-reduced-motion
    ...(statusConfig?.pulse &&
      !prefersReducedMotion && {
        animation: 'softn-avatar-pulse 2s ease-in-out infinite',
      }),
    ...statusPositions[statusPosition],
  };

  // Badge positioning (always top-right)
  const badgeSize = Math.max(sizeValue * 0.4, 16);
  const badgeStyle: React.CSSProperties = {
    position: 'absolute',
    top: -badgeSize / 4,
    right: -badgeSize / 4,
    minWidth: badgeSize,
    height: badgeSize,
    borderRadius: badgeSize / 2,
    background: `linear-gradient(135deg, ${badgeColor}, ${badgeColor})`,
    color: '#ffffff',
    fontSize: Math.max(badgeSize * 0.6, 10),
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 4px',
    border: `2px solid ${borderColor}`,
    boxShadow: '0 2px 4px rgba(239, 68, 68, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
  };

  const handleMouseEnter = () => setIsHovered(true);
  const handleMouseLeave = () => setIsHovered(false);

  // Keyboard handler for Enter/Space to trigger onClick
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (onKeyDown) {
      onKeyDown(e);
    }
    if (onClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onClick();
    }
  };

  const showPulseAnimation = status !== 'none' && statusConfig?.pulse && !prefersReducedMotion;

  return (
    <>
      {showPulseAnimation && (
        <style>{`
          @keyframes softn-avatar-pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.8; transform: scale(1.1); }
          }
        `}</style>
      )}
      <div
        className={className}
        style={computedStyle}
        onClick={onClick}
        onKeyDown={onClick ? handleKeyDown : undefined}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        aria-label={ariaLabel ?? (onClick ? (name ?? alt ?? 'Avatar') : undefined)}
      >
        <div style={imgContainerStyle}>
          {children ? (
            children
          ) : showInitials ? (
            name ? (
              getInitials(name)
            ) : (
              '?'
            )
          ) : (
            <img
              src={src}
              alt={alt ?? name ?? 'Avatar'}
              style={imgStyle}
              onError={() => setImgError(true)}
            />
          )}
        </div>
        {status !== 'none' && <span style={statusStyle} />}
        {badge !== undefined && (
          <span style={badgeStyle}>{typeof badge === 'number' && badge > 99 ? '99+' : badge}</span>
        )}
      </div>
    </>
  );
}

/**
 * AvatarGroup - Displays avatars in a stacked group
 */
export function AvatarGroup({
  max = 4,
  size = 'md',
  spacing = -8,
  borderColor = 'var(--color-white, #ffffff)',
  className,
  style,
  children,
}: AvatarGroupProps): React.ReactElement {
  const childArray = React.Children.toArray(children);
  const visibleChildren = childArray.slice(0, max);
  const remainingCount = childArray.length - max;

  const sizeValue = getSizeValue(size);

  const containerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    flexDirection: 'row-reverse',
    ...style,
  };

  const itemStyle: React.CSSProperties = {
    marginLeft: spacing,
  };

  const remainingStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: sizeValue,
    height: sizeValue,
    borderRadius: '50%',
    backgroundColor: 'var(--color-gray-200, #3f3f46)',
    color: 'var(--color-gray-600, #4b5563)',
    fontSize: typeof size === 'number' ? `${size * 0.35}px` : fontSizes[size],
    fontWeight: 600,
    border: `2px solid ${borderColor}`,
    marginLeft: spacing,
  };

  return (
    <div className={className} style={containerStyle}>
      {remainingCount > 0 && <span style={remainingStyle}>+{remainingCount}</span>}
      {visibleChildren.reverse().map((child, index) => (
        <div key={index} style={index > 0 ? itemStyle : undefined}>
          {React.isValidElement(child)
            ? React.cloneElement(child as React.ReactElement<AvatarProps>, {
                size,
                border: true,
                borderColor,
              })
            : child}
        </div>
      ))}
    </div>
  );
}

export default Avatar;
