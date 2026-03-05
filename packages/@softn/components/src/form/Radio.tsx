/**
 * Radio Component
 *
 * A radio button group for selecting one option from multiple choices.
 */

import React from 'react';

export interface RadioOption {
  /** Option value */
  value: string;
  /** Display label */
  label: string;
  /** Whether this option is disabled */
  disabled?: boolean;
}

export interface RadioProps {
  /** Input name (required for grouping) */
  name: string;
  /** Available options */
  options: RadioOption[];
  /** Currently selected value */
  value?: string;
  /** Default selected value */
  defaultValue?: string;
  /** Layout direction */
  direction?: 'horizontal' | 'vertical';
  /** Whether the entire group is disabled */
  disabled?: boolean;
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** Error state */
  error?: boolean | string;
  /** Group label */
  label?: string;
  /** Change handler */
  onChange?: (value: string, event: React.ChangeEvent<HTMLInputElement>) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeValues: Record<string, { radio: string; text: string; gap: string }> = {
  sm: { radio: '0.875rem', text: '0.875rem', gap: '0.375rem' },
  md: { radio: '1rem', text: '0.875rem', gap: '0.5rem' },
  lg: { radio: '1.25rem', text: '1rem', gap: '0.625rem' },
};

export function Radio({
  name,
  options,
  value,
  defaultValue,
  direction = 'vertical',
  disabled = false,
  size = 'md',
  error = false,
  label,
  onChange,
  className,
  style,
}: RadioProps): React.ReactElement {
  const sizes = sizeValues[size];
  const hasError = Boolean(error);
  const errorMessage = typeof error === 'string' ? error : undefined;

  const [selectedValue, setSelectedValue] = React.useState(value ?? defaultValue ?? '');

  React.useEffect(() => {
    if (value !== undefined) {
      setSelectedValue(value);
    }
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setSelectedValue(newValue);
    onChange?.(newValue, e);
  };

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    ...style,
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: 500,
    color: 'var(--color-text, #ececf0)',
    marginBottom: '0.25rem',
  };

  const optionsContainerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: direction === 'horizontal' ? 'row' : 'column',
    gap: direction === 'horizontal' ? '1rem' : '0.5rem',
    flexWrap: direction === 'horizontal' ? 'wrap' : undefined,
  };

  const optionStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: sizes.gap,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };

  const radioStyle: React.CSSProperties = {
    width: sizes.radio,
    height: sizes.radio,
    margin: 0,
    cursor: disabled ? 'not-allowed' : 'pointer',
    accentColor: hasError ? 'var(--color-error-500, #ef4444)' : 'var(--color-primary-500, #6366f1)',
  };

  const optionLabelStyle: React.CSSProperties = {
    fontSize: sizes.text,
    color: 'var(--color-text, #ececf0)',
    userSelect: 'none',
    transition: 'color 180ms cubic-bezier(0.16, 1, 0.3, 1)',
  };

  const errorStyle: React.CSSProperties = {
    marginTop: '0.25rem',
    fontSize: '0.75rem',
    color: 'var(--color-error-500, #ef4444)',
  };

  return (
    <div className={className} style={containerStyle}>
      {label && <span style={labelStyle}>{label}</span>}
      <div style={optionsContainerStyle}>
        {options.map((option) => {
          const isDisabled = disabled || option.disabled;
          return (
            <label
              key={option.value}
              style={{
                ...optionStyle,
                opacity: isDisabled ? 0.6 : 1,
                cursor: isDisabled ? 'not-allowed' : 'pointer',
              }}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selectedValue === option.value}
                disabled={isDisabled}
                onChange={handleChange}
                style={radioStyle}
              />
              <span style={optionLabelStyle}>{option.label}</span>
            </label>
          );
        })}
      </div>
      {errorMessage && <div style={errorStyle}>{errorMessage}</div>}
    </div>
  );
}

export default Radio;
