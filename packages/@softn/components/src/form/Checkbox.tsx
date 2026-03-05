/**
 * Checkbox Component
 *
 * A checkbox input with label and custom styling.
 * Uses CSS variables for theming support.
 */

import React, { useState, useCallback } from 'react';

export interface CheckboxProps {
  /** Input name */
  name?: string;
  /** Whether checked */
  checked?: boolean;
  /** Default checked state */
  defaultChecked?: boolean;
  /** Indeterminate state */
  indeterminate?: boolean;
  /** Label text */
  label?: string;
  /** Description text below label */
  description?: string;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** Error state */
  error?: boolean;
  /** Change handler */
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeValues: Record<
  string,
  { box: string; text: string; descText: string; iconSize: string }
> = {
  sm: { box: '1rem', text: '0.875rem', descText: '0.75rem', iconSize: '0.625rem' },
  md: { box: '1.125rem', text: '0.875rem', descText: '0.75rem', iconSize: '0.75rem' },
  lg: { box: '1.375rem', text: '1rem', descText: '0.875rem', iconSize: '0.875rem' },
};

export function Checkbox({
  name,
  checked,
  defaultChecked,
  indeterminate,
  label,
  description,
  disabled = false,
  size = 'md',
  error = false,
  onChange,
  className,
  style,
}: CheckboxProps): React.ReactElement {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [internalChecked, setInternalChecked] = useState(defaultChecked ?? false);

  const isControlled = checked !== undefined;
  const isChecked = isControlled ? checked : internalChecked;

  React.useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate ?? false;
    }
  }, [indeterminate]);

  const sizes = sizeValues[size];

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!isControlled) {
        setInternalChecked(e.target.checked);
      }
      onChange?.(e);
    },
    [isControlled, onChange]
  );

  const handleMouseEnter = useCallback(() => !disabled && setIsHovered(true), [disabled]);
  const handleMouseLeave = useCallback(() => setIsHovered(false), []);
  const handleFocus = useCallback(() => !disabled && setIsFocused(true), [disabled]);
  const handleBlur = useCallback(() => setIsFocused(false), []);

  const getBoxShadow = () => {
    if (disabled) return 'none';
    if (isFocused) {
      return error ? '0 0 0 3px rgba(239, 68, 68, 0.15)' : '0 0 0 3px rgba(99, 102, 241, 0.15)';
    }
    return '0 1px 2px rgba(0, 0, 0, 0.05)';
  };

  const getBorderColor = () => {
    if (error) return 'var(--color-error-500, #ef4444)';
    if (isChecked || indeterminate) return 'var(--color-primary-500, #6366f1)';
    if (isFocused) return 'var(--color-primary-500, #6366f1)';
    if (isHovered) return 'var(--color-gray-400, rgba(255, 255, 255, 0.2))';
    return 'var(--color-gray-300, rgba(255, 255, 255, 0.12))';
  };

  const getBackground = () => {
    if (isChecked || indeterminate) {
      if (disabled) return 'var(--color-primary-300, #93c5fd)';
      return error ? 'var(--color-error-500, #ef4444)' : 'var(--color-primary-500, #6366f1)';
    }
    if (disabled) return 'var(--color-gray-100, #1e1e23)';
    return 'var(--color-surface, #16161a)';
  };

  const containerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'flex-start',
    gap: '0.625rem',
    cursor: disabled ? 'not-allowed' : 'pointer',
    ...style,
  };

  const checkboxWrapperStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: sizes.box,
    height: sizes.box,
    flexShrink: 0,
    marginTop: '0.125rem',
  };

  const checkboxStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    background: getBackground(),
    borderWidth: '1.5px',
    borderStyle: 'solid',
    borderColor: getBorderColor(),
    borderRadius: 'var(--radius-sm, 0.25rem)',
    transition: 'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',
    boxShadow: getBoxShadow(),
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const iconStyle: React.CSSProperties = {
    width: sizes.iconSize,
    height: sizes.iconSize,
    color: 'white',
    opacity: isChecked || indeterminate ? 1 : 0,
    transform: isChecked || indeterminate ? 'scale(1)' : 'scale(0.5)',
    transition: 'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',
  };

  const labelContainerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: sizes.text,
    fontWeight: 500,
    color: disabled ? 'var(--color-text-disabled, #9ca3af)' : 'var(--color-text, #ececf0)',
    userSelect: 'none',
    lineHeight: 1.4,
  };

  const descriptionStyle: React.CSSProperties = {
    fontSize: sizes.descText,
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
      <div style={checkboxWrapperStyle}>
        <input
          ref={inputRef}
          type="checkbox"
          name={name}
          checked={isChecked}
          disabled={disabled}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          style={hiddenInputStyle}
        />
        <div style={checkboxStyle}>
          {indeterminate ? (
            <svg style={iconStyle} viewBox="0 0 12 12" fill="none">
              <path d="M2.5 6H9.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          ) : (
            <svg style={iconStyle} viewBox="0 0 12 12" fill="none">
              <path
                d="M2 6L4.5 8.5L10 3"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
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

export default Checkbox;
