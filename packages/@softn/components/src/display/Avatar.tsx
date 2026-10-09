/**
 * Avatar Component
 *
 * A user avatar with image or initials fallback.
 * Supports status indicators, badges, and group stacking.
 */

import React from 'react';
import { isSafeUrl } from '@softn/core';
import { cssPaint } from '../utils/egress';
import { usePrefersReducedMotion } from '../utils/motion';
import { named } from '../utils/choice';

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

function getInitials(given: string): string {
  // `name={user.id}` is a number for some stores; `.trim` of one threw.
  const parts = String(given).trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].charAt(0).toUpperCase();
  }
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function stringToColor(given: string): string {
  const str = String(given);
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
  // A size that is not one of the names, or not a size at all (state that
  // has not loaded), is the middle one: a group works its own width out of
  // this, and NaN is not a width.
  if (typeof size === 'number') return Number.isFinite(size) && size > 0 ? size : sizeValues.md;
  return sizeValues[size] ?? sizeValues.md;
}

const DEFAULT_BADGE_COLOR = 'var(--color-error-500, #ef4444)';

/**
 * What a group asks of the avatars in it: one size, and a border the colour
 * of the page so that each stands clear of the one it overlaps.
 *
 * Context, because a group cannot reach its avatars any other way once they
 * are drawn from a page: each arrives inside the renderer's error boundary,
 * and props cloned onto that land on the boundary.
 */
const AvatarGroupContext = React.createContext<{
  size: NonNullable<AvatarProps['size']>;
  borderColor: string;
} | null>(null);

export function Avatar(props: AvatarProps): React.ReactElement {
  const group = React.useContext(AvatarGroupContext);
  return group ? (
    <AvatarFace {...props} size={group.size} border borderColor={group.borderColor} />
  ) : (
    <AvatarFace {...props} />
  );
}

function AvatarFace({
  src,
  alt,
  name,
  size = 'md',
  shape = 'circle',
  border = false,
  borderColor = 'var(--color-bg, #ffffff)',
  backgroundColor,
  textColor = '#ffffff',
  status = 'none',
  statusPosition = 'bottom-right',
  badge,
  badgeColor = DEFAULT_BADGE_COLOR,
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
  // A profile picture URL usually arrives with the record it belongs to, so it
  // is bundle-supplied. Rejecting it here falls back to initials rather than
  // handing the scheme to the DOM.
  const imgSrc = src && isSafeUrl(src) ? src : undefined;
  const showInitials = !imgSrc || imgError;

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

  // A presence that has not loaded (`status={user.presence}`, null) or is
  // not one of the four is no presence: it used to be drawn as an empty
  // ring, and read out as "null".
  const statusConfig = named(statusConfigs, status);
  const hasStatus = statusConfig !== undefined;
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
  const badgePaint = cssPaint(badgeColor) ?? DEFAULT_BADGE_COLOR;
  const badgeStyle: React.CSSProperties = {
    position: 'absolute',
    top: -badgeSize / 4,
    right: -badgeSize / 4,
    minWidth: badgeSize,
    height: badgeSize,
    borderRadius: badgeSize / 2,
    // Interpolated into `background`, where a `url()` — or a value that
    // closes this gradient and opens an image layer — would be fetched.
    background: `linear-gradient(135deg, ${badgePaint}, ${badgePaint})`,
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

  const badgeText =
    badge === undefined || badge === null || badge === ''
      ? ''
      : typeof badge === 'number'
        ? `${badge > 99 ? '99+' : badge} ${badge === 1 ? 'notification' : 'notifications'}`
        : String(badge);
  const spokenName = [ariaLabel ?? name ?? alt ?? 'Avatar', hasStatus ? status : '', badgeText]
    .filter(Boolean)
    .join(', ');

  const showPulseAnimation = hasStatus && statusConfig.pulse && !prefersReducedMotion;

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
        // The status dot and the badge are colour and a number in a corner;
        // the name says them in words. An avatar with custom children leaves
        // them to speak for themselves.
        role={onClick ? 'button' : children ? undefined : 'img'}
        tabIndex={onClick ? 0 : undefined}
        aria-label={onClick || !children ? spokenName : ariaLabel}
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
              src={imgSrc}
              alt={alt ?? name ?? 'Avatar'}
              style={imgStyle}
              onError={() => setImgError(true)}
            />
          )}
        </div>
        {hasStatus && <span style={statusStyle} aria-hidden="true" />}
        {badge !== undefined && (
          <span style={badgeStyle} aria-hidden={onClick || !children ? true : undefined}>
            {typeof badge === 'number' && badge > 99 ? '99+' : badge}
          </span>
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
  borderColor = 'var(--color-bg, #ffffff)',
  className,
  style,
  children,
}: AvatarGroupProps): React.ReactElement {
  // A page's `#each` hands its rows over inside fragments; counted as one
  // child, a list of twenty people was one avatar to this and `max` did
  // nothing.
  const childArray = avatarsIn(children);
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : childArray.length;
  const visibleChildren = childArray.slice(0, limit);
  const remainingCount = childArray.length - limit;

  const sizeValue = getSizeValue(size);

  // Each avatar but the last is pulled left over its neighbour, the first
  // among them, which has no neighbour there: it stood that far outside the
  // group, over whatever was beside it. The group makes the room back.
  const overlap = Number.isFinite(spacing) && spacing < 0 ? -spacing : 0;

  const containerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    flexDirection: 'row-reverse',
    paddingLeft: overlap,
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
    fontSize: typeof size === 'number' ? `${sizeValue * 0.35}px` : (fontSizes[size] ?? fontSizes.md),
    fontWeight: 600,
    border: `2px solid ${borderColor}`,
    marginLeft: spacing,
  };

  return (
    <AvatarGroupContext.Provider value={{ size, borderColor }}>
      <div className={className} style={containerStyle}>
        {remainingCount > 0 && (
          <span style={remainingStyle} role="img" aria-label={`${remainingCount} more`}>
            +{remainingCount}
          </span>
        )}
        {visibleChildren.reverse().map((child, index) => (
          <div key={index} style={index > 0 ? itemStyle : undefined}>
            {child}
          </div>
        ))}
      </div>
    </AvatarGroupContext.Provider>
  );
}

/** The avatars among a group's children, out of whatever fragments a page's loops and conditions left them in. */
function avatarsIn(children: React.ReactNode): React.ReactNode[] {
  const found: React.ReactNode[] = [];
  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.type === React.Fragment) {
      found.push(...avatarsIn((child.props as { children?: React.ReactNode }).children));
    } else if (React.isValidElement(child)) {
      found.push(child);
    } else if ((typeof child === 'string' && child.trim() !== '') || typeof child === 'number') {
      found.push(child);
    }
  });
  return found;
}

export default Avatar;
