/**
 * Switch Component
 *
 * A toggle switch input with smooth animations.
 * Uses CSS variables for theming support.
 */

import React, { useState, useCallback } from 'react';

export interface SwitchProps {
  /** Input name */
  name?: string;
  /** Whether checked */
  checked?: boolean;
  /** Default checked state */
  defaultChecked?: boolean;
  /** Label text */
  label?: string;
  /** Description text below label */
  description?: string;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** Color when on */
  onColor?: string;
  /** Color when off */
  offColor?: string;
  /** Change handler */
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeValues: Record<
  string,
  {
    track: { width: string; height: string };
    thumb: string;
    thumbOffset: string;
    labelSize: string;
    descSize: string;
  }
> = {
  sm: {
    track: { width: '2.25rem', height: '1.25rem' },
    thumb: '0.875rem',
    thumbOffset: '0.1875rem',
    labelSize: '0.875rem',
    descSize: '0.75rem',
  },
  md: {
    track: { width: '2.75rem', height: '1.5rem' },
    thumb: '1.125rem',
    thumbOffset: '0.1875rem',
    labelSize: '0.875rem',
    descSize: '0.75rem',
  },
  lg: {
    track: { width: '3.5rem', height: '1.875rem' },
    thumb: '1.375rem',
    thumbOffset: '0.25rem',
    labelSize: '1rem',
    descSize: '0.875rem',
  },
};

export function Switch({
  name,
  checked,
  defaultChecked,
  label,
  description,
  disabled = false,
  size = 'md',
  onColor,
  offColor,
  onChange,
  className,
  style,
}: SwitchProps): React.ReactElement {
  const [isChecked, setIsChecked] = useState(defaultChecked ?? false);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const isControlled = checked !== undefined;
  const currentChecked = isControlled ? checked : isChecked;

  const sizes = sizeValues[size];

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (!isControlled) {
        setIsChecked(event.target.checked);
      }
      onChange?.(event);
    },
    [isControlled, onChange]
  );

  const handleMouseEnter = useCallback(() => !disabled && setIsHovered(true), [disabled]);
  const handleMouseLeave = useCallback(() => setIsHovered(false), []);
  const handleFocus = useCallback(() => !disabled && setIsFocused(true), [disabled]);
  const handleBlur = useCallback(() => setIsFocused(false), []);

  const getTrackBackground = () => {
    if (currentChecked) {
      if (disabled) return 'var(--color-primary-300, #93c5fd)';
      if (onColor) return onColor;
      // Gradient for "on" state
      return 'linear-gradient(135deg, var(--color-primary-400, #818cf8), var(--color-primary-500, #6366f1), var(--color-primary-600, #4f46e5))';
    }
    if (disabled) return 'var(--color-gray-200, #3f3f46)';
    if (isHovered) return offColor || 'var(--color-gray-300, #d1d5db)';
    return offColor || 'var(--color-gray-200, #3f3f46)';
  };

  const getTrackShadow = () => {
    if (disabled) return 'none';
    if (currentChecked) {
      // Glow effect when checked
      const glowShadow =
        '0 0 12px rgba(59, 130, 246, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.1)';
      if (isFocused) {
        return `0 0 0 3px rgba(59, 130, 246, 0.25), ${glowShadow}`;
      }
      return glowShadow;
    }
    if (isFocused) {
      return '0 0 0 3px rgba(107, 114, 128, 0.15), inset 0 1px 2px rgba(0, 0, 0, 0.1)';
    }
    return 'inset 0 1px 2px rgba(0, 0, 0, 0.1)';
  };

  const containerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'flex-start',
    gap: '0.75rem',
    cursor: disabled ? 'not-allowed' : 'pointer',
    ...style,
  };

  const trackWrapperStyle: React.CSSProperties = {
    position: 'relative',
    flexShrink: 0,
    marginTop: label ? '0.0625rem' : 0,
  };

  const trackStyle: React.CSSProperties = {
    position: 'relative',
    width: sizes.track.width,
    height: sizes.track.height,
    backgroundColor: getTrackBackground(),
    borderRadius: '9999px',
    transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
    boxShadow: getTrackShadow(),
  };

  const thumbStyle: React.CSSProperties = {
    position: 'absolute',
    top: '50%',
    left: currentChecked ? `calc(100% - ${sizes.thumb} - ${sizes.thumbOffset})` : sizes.thumbOffset,
    transform: `translateY(-50%) ${isHovered && !disabled ? 'scale(1.08)' : 'scale(1)'}`,
    width: sizes.thumb,
    height: sizes.thumb,
    background: 'linear-gradient(180deg, #e4e4e7 0%, #d4d4d8 100%)',
    borderRadius: '50%',
    boxShadow: currentChecked
      ? '0 2px 4px rgba(99, 102, 241, 0.25), 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 -1px 1px rgba(0, 0, 0, 0.04)'
      : '0 2px 4px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.08), inset 0 -1px 1px rgba(0, 0, 0, 0.04)',
    transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
  };

  const labelContainerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: sizes.labelSize,
    fontWeight: 500,
    color: disabled ? 'var(--color-text-disabled, #9ca3af)' : 'var(--color-text, #374151)',
    userSelect: 'none',
    lineHeight: 1.4,
  };

  const descriptionStyle: React.CSSProperties = {
    fontSize: sizes.descSize,
    color: 'var(--color-text-muted, #6b7280)',
    userSelect: 'none',
    lineHeight: 1.4,
  };

  const hiddenInputStyle: React.CSSProperties = {
    position: 'absolute',
    opacity: 0,
    width: '100%',
    height: '100%',
    margin: 0,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };

  return (
    <label
      className={className}
      style={containerStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div style={trackWrapperStyle}>
        <input
          type="checkbox"
          name={name}
          checked={currentChecked}
          disabled={disabled}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          style={hiddenInputStyle}
        />
        <div style={trackStyle}>
          <div style={thumbStyle} />
        </div>
      </div>
      {(label || description) && (
        <div style={labelContainerStyle}>
          {label && <span style={labelStyle}>{label}</span>}
          {description && <span style={descriptionStyle}>{description}</span>}
        </div>
      )}
    </label>
  );
}

export default Switch;
