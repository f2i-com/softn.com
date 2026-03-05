/**
 * TextArea Component
 *
 * A multi-line text input with focus states.
 * Uses CSS variables for theming support.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

export interface TextAreaProps {
  /** Input name */
  name?: string;
  /** Current value */
  value?: string;
  /** Default value */
  defaultValue?: string;
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
  /** Number of visible rows */
  rows?: number;
  /** Input size */
  size?: 'sm' | 'md' | 'lg';
  /** Full width */
  fullWidth?: boolean;
  /** Error state or error message */
  error?: boolean | string;
  /** Success state */
  success?: boolean;
  /** Allow resize */
  resize?: 'none' | 'vertical' | 'horizontal' | 'both';
  /** Auto-resize based on content */
  autoResize?: boolean;
  /** Minimum height for auto-resize */
  minHeight?: string;
  /** Maximum height for auto-resize */
  maxHeight?: string;
  /** Max length */
  maxLength?: number;
  /** Show character count */
  showCharCount?: boolean;
  /** Change handler */
  onChange?: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  /** Focus handler */
  onFocus?: (event: React.FocusEvent<HTMLTextAreaElement>) => void;
  /** Blur handler */
  onBlur?: (event: React.FocusEvent<HTMLTextAreaElement>) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeStyles: Record<string, { padding: string; fontSize: string }> = {
  sm: {
    padding: '0.5rem 0.75rem',
    fontSize: 'var(--text-sm, 0.875rem)',
  },
  md: {
    padding: '0.625rem 0.875rem',
    fontSize: 'var(--text-sm, 0.875rem)',
  },
  lg: {
    padding: '0.75rem 1rem',
    fontSize: 'var(--text-base, 1rem)',
  },
};

export function TextArea({
  name,
  value,
  defaultValue,
  placeholder,
  label,
  helperText,
  disabled = false,
  readOnly = false,
  required = false,
  rows = 3,
  size = 'md',
  fullWidth = false,
  error = false,
  success = false,
  resize = 'vertical',
  autoResize = false,
  minHeight,
  maxHeight,
  maxLength,
  showCharCount = false,
  onChange,
  onFocus,
  onBlur,
  className,
  style,
}: TextAreaProps): React.ReactElement {
  const [isFocused, setIsFocused] = useState(false);
  const [charCount, setCharCount] = useState((value || defaultValue || '').length);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasError = Boolean(error);
  const errorMessage = typeof error === 'string' ? error : undefined;
  const sizeStyle = sizeStyles[size];

  // Auto-resize function
  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || !autoResize) return;

    textarea.style.height = 'auto';
    const scrollHeight = textarea.scrollHeight;
    const min = minHeight ? parseInt(minHeight, 10) : 0;
    const max = maxHeight ? parseInt(maxHeight, 10) : Infinity;
    const newHeight = Math.min(Math.max(scrollHeight, min), max);
    textarea.style.height = `${newHeight}px`;
  }, [autoResize, minHeight, maxHeight]);

  // Adjust height on value change
  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  const handleFocus = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      setIsFocused(true);
      onFocus?.(e);
    },
    [onFocus]
  );

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      setIsFocused(false);
      onBlur?.(e);
    },
    [onBlur]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setCharCount(e.target.value.length);
      onChange?.(e);
      if (autoResize) {
        adjustHeight();
      }
    },
    [onChange, autoResize, adjustHeight]
  );

  const getBorderColor = () => {
    if (hasError) return 'var(--color-error-500, #ef4444)';
    if (success) return 'var(--color-success-500, #22c55e)';
    if (isFocused) return 'var(--color-primary-500, #6366f1)';
    return 'var(--color-gray-300, #d1d5db)';
  };

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
      return '0 0 0 3px rgba(59, 130, 246, 0.15), inset 0 1px 2px rgba(0, 0, 0, 0.05)';
    }
    return '0 1px 2px rgba(0, 0, 0, 0.05)';
  };

  const computedStyle: React.CSSProperties = {
    padding: sizeStyle.padding,
    fontSize: sizeStyle.fontSize,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: getBorderColor(),
    borderRadius: 'var(--radius-lg, 0.5rem)',
    background: disabled ? 'var(--color-gray-100, #27272a)' : 'var(--color-surface, #16161a)',
    color: disabled ? 'var(--color-text-disabled, #9ca3af)' : 'var(--color-text, #111827)',
    outline: 'none',
    width: fullWidth ? '100%' : undefined,
    resize: autoResize ? 'none' : resize,
    fontFamily: 'inherit',
    lineHeight: 1.5,
    transition:
      'border-color var(--duration-fast, 150ms) var(--easing-inOut, cubic-bezier(0.16, 1, 0.3, 1)), box-shadow var(--duration-fast, 150ms) var(--easing-inOut, cubic-bezier(0.16, 1, 0.3, 1))',
    boxShadow: getBoxShadow(),
    cursor: disabled ? 'not-allowed' : undefined,
    opacity: disabled ? 0.6 : 1,
    minHeight: minHeight,
    maxHeight: maxHeight,
    overflow: autoResize && maxHeight ? 'auto' : undefined,
    ...style,
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: '0.5rem',
    fontSize: 'var(--text-sm, 0.875rem)',
    fontWeight: 500,
    color: 'var(--color-text, #374151)',
  };

  const requiredStyle: React.CSSProperties = {
    color: 'var(--color-error-500, #ef4444)',
    marginLeft: '0.25rem',
  };

  const footerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: helperText || errorMessage ? 'space-between' : 'flex-end',
    marginTop: '0.375rem',
    gap: '0.5rem',
  };

  const helperStyle: React.CSSProperties = {
    fontSize: 'var(--text-xs, 0.75rem)',
    color: hasError
      ? 'var(--color-error-500, #ef4444)'
      : success
        ? 'var(--color-success-600, #16a34a)'
        : 'var(--color-text-muted, #6b7280)',
    flex: 1,
  };

  const charCountStyle: React.CSSProperties = {
    fontSize: 'var(--text-xs, 0.75rem)',
    color:
      maxLength && charCount >= maxLength
        ? 'var(--color-error-500, #ef4444)'
        : 'var(--color-text-muted, #6b7280)',
    flexShrink: 0,
  };

  const textareaElement = (
    <textarea
      ref={textareaRef}
      name={name}
      value={value}
      defaultValue={defaultValue}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      required={required}
      rows={autoResize ? 1 : rows}
      maxLength={maxLength}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={className}
      style={computedStyle}
      aria-invalid={hasError}
      aria-describedby={helperText || errorMessage ? `${name}-helper` : undefined}
    />
  );

  const showFooter = helperText || errorMessage || showCharCount;

  return (
    <div style={{ width: fullWidth ? '100%' : undefined }}>
      {label && (
        <label style={labelStyle}>
          {label}
          {required && <span style={requiredStyle}>*</span>}
        </label>
      )}
      {textareaElement}
      {showFooter && (
        <div id={`${name}-helper`} style={footerStyle}>
          {(helperText || errorMessage) && (
            <span style={helperStyle}>{errorMessage || helperText}</span>
          )}
          {showCharCount && (
            <span style={charCountStyle}>
              {maxLength ? `${charCount}/${maxLength}` : `${charCount} characters`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default TextArea;
