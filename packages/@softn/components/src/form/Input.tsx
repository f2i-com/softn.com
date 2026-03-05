/**
 * Input Component
 *
 * A text input field with various types and styles.
 * Uses CSS variables for theming support.
 * Includes automatic search icon and clear button for search type.
 */

import React, { useState, useCallback } from 'react';

export interface InputProps {
  /** Input type */
  type?: 'text' | 'email' | 'password' | 'number' | 'tel' | 'url' | 'search';
  /** Input name */
  name?: string;
  /** Current value */
  value?: string | number;
  /** Default value */
  defaultValue?: string | number;
  /** Placeholder text */
  placeholder?: string;
  /** Label text */
  label?: string;
  /** Helper text below input */
  helperText?: string;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Whether the input is read-only */
  readOnly?: boolean;
  /** Whether the input is required */
  required?: boolean;
  /** Input size */
  size?: 'sm' | 'md' | 'lg';
  /** Input variant */
  variant?: 'outline' | 'filled' | 'flushed';
  /** Full width */
  fullWidth?: boolean;
  /** Flex */
  flex?: number | string;
  /** Error state or error message */
  error?: boolean | string;
  /** Success state */
  success?: boolean;
  /** Left element (icon or text) */
  leftElement?: React.ReactNode;
  /** Right element (icon or text) */
  rightElement?: React.ReactNode;
  /** Left addon (outside the input) */
  leftAddon?: React.ReactNode;
  /** Right addon (outside the input) */
  rightAddon?: React.ReactNode;
  /** Minimum value (for number) */
  min?: number;
  /** Maximum value (for number) */
  max?: number;
  /** Step (for number) */
  step?: number;
  /** Pattern for validation */
  pattern?: string;
  /** Auto complete */
  autoComplete?: string;
  /** Auto focus */
  autoFocus?: boolean;
  /** Show clear button when input has value (auto-enabled for search) */
  clearable?: boolean;
  /** Callback when clear button is clicked */
  onClear?: () => void;
  /** Hide the default search icon for type="search" */
  hideSearchIcon?: boolean;
  /** Change handler */
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  /** Focus handler */
  onFocus?: (event: React.FocusEvent<HTMLInputElement>) => void;
  /** Blur handler */
  onBlur?: (event: React.FocusEvent<HTMLInputElement>) => void;
  /** Key down handler */
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

// Search icon SVG
const SearchIcon = () => (
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
    <circle cx="11" cy="11" r="8" />
    <path d="M21 21l-4.35-4.35" />
  </svg>
);

// Clear/X icon SVG
const ClearIcon = () => (
  <svg
    width="14"
    height="14"
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
);

const sizeConfig: Record<string, { padding: string; fontSize: string; height: string }> = {
  sm: {
    padding: '0.375rem 0.75rem',
    fontSize: 'var(--text-sm, 0.875rem)',
    height: '2rem',
  },
  md: {
    padding: '0.5rem 0.875rem',
    fontSize: 'var(--text-sm, 0.875rem)',
    height: '2.5rem',
  },
  lg: {
    padding: '0.625rem 1rem',
    fontSize: 'var(--text-base, 1rem)',
    height: '2.75rem',
  },
};

export function Input({
  type = 'text',
  name,
  value,
  defaultValue,
  placeholder,
  label,
  helperText,
  disabled = false,
  readOnly = false,
  required = false,
  size = 'md',
  variant = 'outline',
  fullWidth = false,
  flex,
  error = false,
  success = false,
  leftElement,
  rightElement,
  leftAddon,
  rightAddon,
  min,
  max,
  step,
  pattern,
  autoComplete,
  autoFocus,
  clearable = false,
  onClear,
  hideSearchIcon = false,
  onChange,
  onFocus,
  onBlur,
  onKeyDown,
  className,
  style,
}: InputProps): React.ReactElement {
  const [isFocused, setIsFocused] = useState(false);
  const [internalValue, setInternalValue] = useState(value ?? defaultValue ?? '');
  const hasError = Boolean(error);
  const errorMessage = typeof error === 'string' ? error : undefined;
  const sizeStyle = sizeConfig[size];

  // Determine if this is a search input
  const isSearch = type === 'search';

  // Show search icon automatically for search type (unless disabled or custom left element)
  const showSearchIcon = isSearch && !hideSearchIcon && !leftElement;

  // Show clear button when there's a value and (clearable or search type)
  const currentValue = value !== undefined ? value : internalValue;
  const hasValue = currentValue !== '' && currentValue !== undefined && currentValue !== null;
  const showClearButton =
    hasValue && (clearable || isSearch) && !disabled && !readOnly && !rightElement;

  const handleFocus = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      setIsFocused(true);
      onFocus?.(e);
    },
    [onFocus]
  );

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      setIsFocused(false);
      onBlur?.(e);
    },
    [onBlur]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (value === undefined) {
        setInternalValue(e.target.value);
      }
      onChange?.(e);
    },
    [onChange, value]
  );

  const handleClear = useCallback(() => {
    if (value === undefined) {
      setInternalValue('');
    }
    onClear?.();
    // Create a synthetic event to notify parent
    const syntheticEvent = {
      target: { value: '', name },
      currentTarget: { value: '', name },
    } as React.ChangeEvent<HTMLInputElement>;
    onChange?.(syntheticEvent);
  }, [onClear, onChange, name, value]);

  // Get border color based on state
  const getBorderColor = () => {
    if (hasError) return 'var(--color-error-500, #ef4444)';
    if (success) return 'var(--color-success-500, #22c55e)';
    if (isFocused) return 'var(--color-primary-500, #6366f1)';
    return 'var(--color-gray-300, rgba(255, 255, 255, 0.12))';
  };

  // Get background based on variant and state
  const getBackground = () => {
    if (disabled) return 'var(--color-gray-100, #1e1e23)';
    if (variant === 'filled') {
      return isFocused ? 'var(--color-surface, #16161a)' : 'var(--color-gray-100, #1e1e23)';
    }
    return 'var(--color-surface, #16161a)';
  };

  // Get box shadow based on state
  const getBoxShadow = () => {
    if (disabled) return 'none';
    if (hasError) {
      return isFocused
        ? '0 0 0 3px rgba(239, 68, 68, 0.15), inset 0 1px 2px rgba(0, 0, 0, 0.05)'
        : 'inset 0 1px 2px rgba(0, 0, 0, 0.05)';
    }
    if (success) {
      return isFocused
        ? '0 0 0 3px rgba(34, 197, 94, 0.15), inset 0 1px 2px rgba(0, 0, 0, 0.05)'
        : 'inset 0 1px 2px rgba(0, 0, 0, 0.05)';
    }
    if (isFocused) {
      return '0 0 0 3px rgba(99, 102, 241, 0.15), inset 0 1px 2px rgba(0, 0, 0, 0.05)';
    }
    return '0 1px 2px rgba(0, 0, 0, 0.05)';
  };

  // Get border styles based on variant
  const getBorderStyles = (): React.CSSProperties => {
    const borderColor = getBorderColor();
    if (variant === 'flushed') {
      return {
        borderTop: 'none',
        borderLeft: 'none',
        borderRight: 'none',
        borderBottomWidth: '2px',
        borderBottomStyle: 'solid',
        borderBottomColor: borderColor,
      };
    }
    return {
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: borderColor,
    };
  };

  const inputWrapperStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    width: fullWidth ? '100%' : undefined,
    flex: flex ?? undefined,
  };

  const inputGroupStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'stretch',
    width: '100%',
  };

  const addonStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    padding: '0 0.75rem',
    background: 'var(--color-surface-hover, #1e1e23)',
    border: `1px solid ${getBorderColor()}`,
    color: 'var(--color-text-muted, #6b7280)',
    fontSize: sizeStyle.fontSize,
    whiteSpace: 'nowrap',
  };

  const leftAddonStyle: React.CSSProperties = {
    ...addonStyle,
    borderRight: 'none',
    borderRadius: 'var(--radius-lg, 0.5rem) 0 0 var(--radius-lg, 0.5rem)',
  };

  const rightAddonStyle: React.CSSProperties = {
    ...addonStyle,
    borderLeft: 'none',
    borderRadius: '0 var(--radius-lg, 0.5rem) var(--radius-lg, 0.5rem) 0',
  };

  const inputContainerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    flex: 1,
  };

  const elementStyle: React.CSSProperties = {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: 'var(--color-text-muted, #6b7280)',
    pointerEvents: 'none',
    fontSize: sizeStyle.fontSize,
  };

  const leftElementStyle: React.CSSProperties = {
    ...elementStyle,
    left: '0.75rem',
  };

  const rightElementStyle: React.CSSProperties = {
    ...elementStyle,
    right: '0.75rem',
  };

  const clearButtonStyle: React.CSSProperties = {
    position: 'absolute',
    right: '0.5rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.5rem',
    height: '1.5rem',
    padding: 0,
    background: 'var(--color-gray-100, rgba(255, 255, 255, 0.06))',
    border: 'none',
    borderRadius: 'var(--radius-full, 9999px)',
    cursor: 'pointer',
    color: 'var(--color-gray-500, #a1a1aa)',
    transition: 'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',
  };

  // Determine if we have left/right elements (including auto-added ones)
  const hasLeftElement = leftElement || showSearchIcon;
  const hasRightElement = rightElement || showClearButton;

  const computedStyle: React.CSSProperties = {
    width: '100%',
    height: sizeStyle.height,
    padding: sizeStyle.padding,
    paddingLeft: hasLeftElement ? '2.5rem' : sizeStyle.padding.split(' ')[1],
    paddingRight: hasRightElement ? '2.5rem' : sizeStyle.padding.split(' ')[1],
    fontSize: sizeStyle.fontSize,
    fontFamily: 'inherit',
    lineHeight: 1.5,
    color: disabled ? 'var(--color-text-disabled, #9ca3af)' : 'var(--color-text, #ececf0)',
    background: getBackground(),
    ...getBorderStyles(),
    borderRadius:
      variant === 'flushed'
        ? '0'
        : leftAddon && rightAddon
          ? '0'
          : leftAddon
            ? '0 var(--radius-lg, 0.5rem) var(--radius-lg, 0.5rem) 0'
            : rightAddon
              ? 'var(--radius-lg, 0.5rem) 0 0 var(--radius-lg, 0.5rem)'
              : 'var(--radius-lg, 0.5rem)',
    outline: 'none',
    transition: 'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',
    boxShadow: getBoxShadow(),
    cursor: disabled ? 'not-allowed' : undefined,
    opacity: disabled ? 0.6 : 1,
    ...style,
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: '0.5rem',
    fontSize: 'var(--text-sm, 0.875rem)',
    fontWeight: 500,
    color: 'var(--color-text, #ececf0)',
  };

  const requiredStyle: React.CSSProperties = {
    color: 'var(--color-error-500, #ef4444)',
    marginLeft: '0.25rem',
  };

  const helperStyle: React.CSSProperties = {
    marginTop: '0.375rem',
    fontSize: 'var(--text-xs, 0.75rem)',
    color: hasError
      ? 'var(--color-error-500, #ef4444)'
      : success
        ? 'var(--color-success-600, #16a34a)'
        : 'var(--color-text-muted, #6b7280)',
  };

  const inputElement = (
    <div style={inputGroupStyle}>
      {leftAddon && <div style={leftAddonStyle}>{leftAddon}</div>}
      <div style={inputContainerStyle}>
        {/* Search icon or custom left element */}
        {showSearchIcon && (
          <div style={leftElementStyle}>
            <SearchIcon />
          </div>
        )}
        {leftElement && !showSearchIcon && <div style={leftElementStyle}>{leftElement}</div>}
        <input
          type={type}
          name={name}
          value={value}
          defaultValue={defaultValue}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          min={min}
          max={max}
          step={step}
          pattern={pattern}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={onKeyDown}
          className={className}
          style={computedStyle}
          aria-invalid={hasError}
          aria-describedby={helperText || errorMessage ? `${name}-helper` : undefined}
        />
        {/* Clear button or custom right element */}
        {showClearButton && (
          <button
            type="button"
            className="softn-input-clear"
            onClick={handleClear}
            style={clearButtonStyle}
            aria-label="Clear input"
            tabIndex={-1}
          >
            <ClearIcon />
          </button>
        )}
        {rightElement && !showClearButton && <div style={rightElementStyle}>{rightElement}</div>}
      </div>
      {rightAddon && <div style={rightAddonStyle}>{rightAddon}</div>}
    </div>
  );

  return (
    <>
      <style>{`
        .softn-input-clear:hover {
          background: var(--color-gray-200, rgba(255, 255, 255, 0.1)) !important;
          color: var(--color-gray-200, #e4e4e7) !important;
        }
        .softn-input-clear:active {
          transform: scale(0.85);
        }
      `}</style>
      <div style={inputWrapperStyle}>
        <div style={{ width: '100%' }}>
          {label && (
            <label style={labelStyle}>
              {label}
              {required && <span style={requiredStyle}>*</span>}
            </label>
          )}
          {inputElement}
          {(helperText || errorMessage) && (
            <div id={`${name}-helper`} style={helperStyle}>
              {errorMessage || helperText}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default Input;
