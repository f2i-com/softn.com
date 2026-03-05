/**
 * Badge Component
 *
 * A small status indicator or count badge.
 * Uses CSS variables for theming support.
 */

import React from 'react';
import { getVariantColors, getStyleForVariantStyle } from '../theme/variants';
import { badgeSizeConfig } from '../theme/sizes';

export interface BadgeProps {
  /** Badge variant */
  variant?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'info';
  /** Badge style */
  badgeStyle?: 'solid' | 'subtle' | 'outline';
  /** Badge size */
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** Whether it's a pill shape */
  pill?: boolean;
  /** Whether it's just a dot */
  dot?: boolean;
  /** Content (number or text) */
  content?: string | number;
  /** Maximum count (for numbers) */
  max?: number;
  /** Left icon */
  leftIcon?: React.ReactNode;
  /** Right icon */
  rightIcon?: React.ReactNode;
  /** Pulse animation (for notifications) */
  pulse?: boolean;
  /** Glow effect */
  glow?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Children */
  children?: React.ReactNode;
}

export function Badge({
  variant = 'default',
  badgeStyle = 'solid',
  size = 'md',
  pill = false,
  dot = false,
  content,
  max,
  leftIcon,
  rightIcon,
  pulse = false,
  glow = false,
  className,
  style,
  children,
}: BadgeProps): React.ReactElement {
  let displayContent = content ?? children;
  // Fall back to 'default' if variant is invalid
  const colors = getVariantColors(variant);
  const sizeStyles = badgeSizeConfig[size] ?? badgeSizeConfig.md;

  if (typeof displayContent === 'number' && max !== undefined && displayContent > max) {
    displayContent = `${max}+`;
  }

  // Build glow shadow
  const getGlowShadow = () => {
    if (!glow || badgeStyle !== 'solid') return undefined;
    return `0 0 12px ${colors.glowColor}, 0 2px 4px rgba(0, 0, 0, 0.1)`;
  };

  if (dot) {
    return (
      <>
        {pulse && (
          <style>{`
            @keyframes softn-badge-pulse {
              0%, 100% { transform: scale(1); opacity: 1; }
              50% { transform: scale(1.2); opacity: 0.7; }
            }
          `}</style>
        )}
        <span
          className={className}
          style={{
            display: 'inline-block',
            width: sizeStyles.dotSize,
            height: sizeStyles.dotSize,
            borderRadius: '50%',
            backgroundColor: colors.bg,
            background: badgeStyle === 'solid' ? colors.gradient : colors.bg,
            boxShadow: glow ? `0 0 8px ${colors.glowColor}` : undefined,
            transition: 'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',
            animation: pulse ? 'softn-badge-pulse 1.5s ease-in-out infinite' : undefined,
            ...style,
          }}
        />
      </>
    );
  }

  const badgeStyleProps = getStyleForVariantStyle(badgeStyle, colors);

  // Override background with gradient for solid badges
  const backgroundOverride = badgeStyle === 'solid' ? { background: colors.gradient } : {};

  const computedStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.25rem',
    fontWeight: 600,
    lineHeight: 1,
    height: sizeStyles.height,
    padding: sizeStyles.padding,
    fontSize: sizeStyles.fontSize,
    borderRadius: pill ? 'var(--radius-full, 9999px)' : 'var(--radius-md, 0.375rem)',
    whiteSpace: 'nowrap',
    letterSpacing: '0.01em',
    transition: 'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',
    boxShadow:
      getGlowShadow() ??
      (badgeStyle === 'solid'
        ? '0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.15)'
        : undefined),
    textShadow: badgeStyle === 'solid' ? '0 1px 1px rgba(0, 0, 0, 0.1)' : undefined,
    ...badgeStyleProps,
    ...backgroundOverride,
    animation: pulse ? 'softn-badge-pulse 1.5s ease-in-out infinite' : undefined,
    ...style,
  };

  const iconStyle: React.CSSProperties = {
    display: 'flex',
    fontSize: sizeStyles.iconSize,
  };

  return (
    <>
      {pulse && (
        <style>{`
          @keyframes softn-badge-pulse {
            0%, 100% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.05); opacity: 0.85; }
          }
        `}</style>
      )}
      <span className={className} style={computedStyle}>
        {leftIcon && <span style={iconStyle}>{leftIcon}</span>}
        {displayContent}
        {rightIcon && <span style={iconStyle}>{rightIcon}</span>}
      </span>
    </>
  );
}

export default Badge;
