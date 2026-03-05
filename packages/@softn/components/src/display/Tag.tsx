/**
 * Tag Component
 *
 * A compact label element for categorization or metadata.
 * Supports removable tags and various styles.
 */

import React from 'react';
import { getVariantColors, getStyleForVariantStyle } from '../theme/variants';
import { tagSizeConfig, getGapValue } from '../theme/sizes';

export interface TagProps {
  /** Tag variant */
  variant?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'info';
  /** Tag style */
  tagStyle?: 'solid' | 'subtle' | 'outline';
  /** Tag size */
  size?: 'sm' | 'md' | 'lg';
  /** Left icon/element */
  leftIcon?: React.ReactNode;
  /** Right icon/element */
  rightIcon?: React.ReactNode;
  /** Show remove button */
  removable?: boolean;
  /** Remove handler */
  onRemove?: () => void;
  /** Click handler */
  onClick?: () => void;
  /** Disabled state */
  disabled?: boolean;
  /** Border radius */
  rounded?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Tag content */
  children: React.ReactNode;
}

export function Tag({
  variant = 'default',
  tagStyle = 'subtle',
  size = 'md',
  leftIcon,
  rightIcon,
  removable = false,
  onRemove,
  onClick,
  disabled = false,
  rounded = true,
  className,
  style,
  children,
}: TagProps): React.ReactElement {
  // Fall back to 'default' if variant is invalid
  const colors = getVariantColors(variant);
  const config = tagSizeConfig[size] ?? tagSizeConfig.md;
  const styleProps = getStyleForVariantStyle(tagStyle, colors);

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!disabled) {
      onRemove?.();
    }
  };

  const computedStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: config.gap,
    padding: config.padding,
    fontSize: config.fontSize,
    fontWeight: 500,
    lineHeight: 1.4,
    borderRadius: rounded ? 'var(--radius-full, 9999px)' : 'var(--radius-sm, 0.25rem)',
    whiteSpace: 'nowrap',
    cursor: onClick && !disabled ? 'pointer' : 'default',
    opacity: disabled ? 0.5 : 1,
    transition: 'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',
    ...styleProps,
    ...style,
  };

  const iconStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: config.iconSize,
    height: config.iconSize,
    flexShrink: 0,
  };

  const removeButtonStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: config.iconSize,
    height: config.iconSize,
    marginLeft: '0.125rem',
    marginRight: '-0.25rem',
    borderRadius: '50%',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: 0.7,
    transition: 'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',
  };

  const RemoveIcon = () => (
    <svg
      width={config.iconSize - 4}
      height={config.iconSize - 4}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  );

  return (
    <span
      className={className}
      style={computedStyle}
      onClick={onClick && !disabled ? onClick : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick && !disabled ? 0 : undefined}
    >
      {leftIcon && <span style={iconStyle}>{leftIcon}</span>}
      {children}
      {rightIcon && <span style={iconStyle}>{rightIcon}</span>}
      {removable && (
        <span
          style={removeButtonStyle}
          onClick={handleRemove}
          role="button"
          aria-label="Remove"
          tabIndex={!disabled ? 0 : undefined}
        >
          <RemoveIcon />
        </span>
      )}
    </span>
  );
}

/**
 * TagGroup - Container for multiple tags
 */
export interface TagGroupProps {
  /** Gap between tags */
  gap?: 'sm' | 'md' | 'lg' | string;
  /** Wrap tags */
  wrap?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Tag children */
  children: React.ReactNode;
}

export function TagGroup({
  gap = 'sm',
  wrap = true,
  className,
  style,
  children,
}: TagGroupProps): React.ReactElement {
  const gapValue = getGapValue(gap);

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: wrap ? 'wrap' : 'nowrap',
    gap: gapValue,
    alignItems: 'center',
    ...style,
  };

  return (
    <div className={className} style={containerStyle}>
      {children}
    </div>
  );
}

export default Tag;
