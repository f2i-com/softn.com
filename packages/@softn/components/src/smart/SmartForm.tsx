/**
 * SmartForm Component
 *
 * An opinionated form with automatic field generation, validation, and submission.
 * Just define fields and it handles everything - the power is in the engine, not the syntax.
 *
 * Usage:
 * <SmartForm fields="name, email:email, role:select" submit={handleSave} />
 */

import React, { useState, useCallback, useMemo } from 'react';

export interface FieldConfig {
  /** Field name (required) */
  name: string;
  /** Field type */
  type?:
    | 'text'
    | 'email'
    | 'password'
    | 'number'
    | 'date'
    | 'select'
    | 'checkbox'
    | 'textarea'
    | 'tel'
    | 'url';
  /** Field label (auto-generated from name if not provided) */
  label?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Whether field is required */
  required?: boolean;
  /** Minimum value (for number) or length (for text) */
  min?: number;
  /** Maximum value (for number) or length (for text) */
  max?: number;
  /** Regex pattern for validation */
  pattern?: string;
  /** Options for select field */
  options?: { value: string; label: string }[] | string[];
  /** Default value */
  defaultValue?: unknown;
  /** Custom validation function */
  validate?: (value: unknown, formData: Record<string, unknown>) => string | null;
  /** Disabled state */
  disabled?: boolean;
  /** Help text below field */
  helpText?: string;
}

export interface SmartFormProps {
  /** Field configurations - can be comma-separated string or array of FieldConfig */
  fields: string | FieldConfig[];
  /** Initial form data */
  data?: Record<string, unknown>;
  /** Submit handler */
  onSubmit?: (data: Record<string, unknown>) => void | Promise<void>;
  /** Change handler */
  onChange?: (data: Record<string, unknown>) => void;
  /** Cancel handler */
  onCancel?: () => void;
  /** Submit button text */
  submitText?: string;
  /** Cancel button text */
  cancelText?: string;
  /** Show cancel button */
  showCancel?: boolean;
  /** Layout style */
  layout?: 'vertical' | 'horizontal' | 'inline';
  /** Number of columns for grid layout */
  columns?: number;
  /** Form title */
  title?: string;
  /** Form description */
  description?: string;
  /** Loading state */
  loading?: boolean;
  /** Disabled state */
  disabled?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** XDB collection name - enables automatic persistence */
  collection?: string;
  /** Record ID for editing (used with collection) */
  recordId?: string;
  /** Called after successful save to XDB */
  onSaved?: (record: unknown) => void;
  /** Mode: 'create' or 'edit' (auto-detected from recordId if not specified) */
  mode?: 'create' | 'edit';
}

// Utility to capitalize and humanize field names
function humanize(str: string): string {
  return str
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

// Parse fields string into FieldConfig array
function parseFields(fieldsStr: string): FieldConfig[] {
  return fieldsStr.split(',').map((field) => {
    const trimmed = field.trim();
    const [nameWithType, ...rest] = trimmed.split(':');
    const name = nameWithType.trim();
    const type = (rest[0]?.trim() as FieldConfig['type']) || 'text';
    const required = rest.includes('required');

    return {
      name,
      type,
      required,
      label: humanize(name),
    };
  });
}

// Built-in validators
const validators: Record<string, (value: unknown, config: FieldConfig) => string | null> = {
  required: (value) => {
    if (
      value === null ||
      value === undefined ||
      value === '' ||
      (Array.isArray(value) && value.length === 0)
    ) {
      return 'This field is required';
    }
    return null;
  },
  email: (value) => {
    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) {
      return 'Please enter a valid email address';
    }
    return null;
  },
  url: (value) => {
    if (value && !/^https?:\/\/.+/.test(String(value))) {
      return 'Please enter a valid URL';
    }
    return null;
  },
  min: (value, config) => {
    if (config.min !== undefined) {
      if (config.type === 'number' && Number(value) < config.min) {
        return `Must be at least ${config.min}`;
      }
      if (typeof value === 'string' && value.length < config.min) {
        return `Must be at least ${config.min} characters`;
      }
    }
    return null;
  },
  max: (value, config) => {
    if (config.max !== undefined) {
      if (config.type === 'number' && Number(value) > config.max) {
        return `Must be at most ${config.max}`;
      }
      if (typeof value === 'string' && value.length > config.max) {
        return `Must be at most ${config.max} characters`;
      }
    }
    return null;
  },
  pattern: (value, config) => {
    if (config.pattern && value && !new RegExp(config.pattern).test(String(value))) {
      return 'Invalid format';
    }
    return null;
  },
};

// Spinner component
const Spinner = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    style={{ animation: 'spin 0.8s linear infinite' }}
  >
    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
  </svg>
);

export function SmartForm({
  fields: fieldsProp,
  data: initialData = {},
  onSubmit,
  onChange,
  onCancel,
  submitText = 'Submit',
  cancelText = 'Cancel',
  showCancel = false,
  layout = 'vertical',
  columns = 1,
  title,
  description,
  loading = false,
  disabled = false,
  className,
  style,
  collection,
  recordId,
  onSaved,
  mode: modeProp,
}: SmartFormProps): React.ReactElement {
  // Determine mode from recordId if not specified
  const mode = modeProp || (recordId ? 'edit' : 'create');
  // Parse fields if string
  const fields = useMemo(() => {
    if (typeof fieldsProp === 'string') {
      return parseFields(fieldsProp);
    }
    return fieldsProp;
  }, [fieldsProp]);

  // Form state
  const [formData, setFormData] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = { ...initialData };
    fields.forEach((field) => {
      if (initial[field.name] === undefined && field.defaultValue !== undefined) {
        initial[field.name] = field.defaultValue;
      }
    });
    return initial;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Validate single field
  const validateField = useCallback(
    (field: FieldConfig, value: unknown): string | null => {
      // Required check
      if (field.required) {
        const error = validators.required(value, field);
        if (error) return error;
      }

      // Type-specific validation
      if (field.type === 'email' && value) {
        const error = validators.email(value, field);
        if (error) return error;
      }
      if (field.type === 'url' && value) {
        const error = validators.url(value, field);
        if (error) return error;
      }

      // Min/max validation
      const minError = validators.min(value, field);
      if (minError) return minError;

      const maxError = validators.max(value, field);
      if (maxError) return maxError;

      // Pattern validation
      const patternError = validators.pattern(value, field);
      if (patternError) return patternError;

      // Custom validation
      if (field.validate) {
        return field.validate(value, formData);
      }

      return null;
    },
    [formData]
  );

  // Validate all fields
  const validateAll = useCallback((): boolean => {
    const newErrors: Record<string, string> = {};
    let isValid = true;

    fields.forEach((field) => {
      const error = validateField(field, formData[field.name]);
      if (error) {
        newErrors[field.name] = error;
        isValid = false;
      }
    });

    setErrors(newErrors);
    setTouched(Object.fromEntries(fields.map((f) => [f.name, true])));
    return isValid;
  }, [fields, formData, validateField]);

  // Handle field change
  const handleChange = useCallback(
    (name: string, value: unknown) => {
      setFormData((prev) => {
        const next = { ...prev, [name]: value };
        onChange?.(next);
        return next;
      });

      // Clear error on change
      if (errors[name]) {
        setErrors((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
      }
    },
    [errors, onChange]
  );

  // Handle field blur
  const handleBlur = useCallback(
    (field: FieldConfig) => {
      setTouched((prev) => ({ ...prev, [field.name]: true }));
      const error = validateField(field, formData[field.name]);
      if (error) {
        setErrors((prev) => ({ ...prev, [field.name]: error }));
      }
    },
    [formData, validateField]
  );

  // Handle submit - supports both custom onSubmit and XDB collection binding
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!validateAll()) return;

      setIsSubmitting(true);
      try {
        // If collection is specified, use XDB for persistence
        if (collection) {
          // Dynamically import XDB to avoid circular dependencies
          const { getXDB } = await import('@softn/core');
          const xdb = getXDB();

          let savedRecord;
          if (mode === 'edit' && recordId) {
            // Update existing record
            savedRecord = xdb.update(recordId, formData);
          } else {
            // Create new record
            savedRecord = xdb.create(collection, formData);
          }

          // Call onSaved callback if provided
          onSaved?.(savedRecord);

          // Also call onSubmit if provided (for additional handling)
          if (onSubmit) {
            await onSubmit(formData);
          }
        } else if (onSubmit) {
          // No collection specified, use custom submit handler
          await onSubmit(formData);
        }
      } catch (err) {
        console.error('[SmartForm] Submit error:', err);
      } finally {
        setIsSubmitting(false);
      }
    },
    [formData, onSubmit, validateAll, collection, mode, recordId, onSaved]
  );

  // Styles
  const containerStyle: React.CSSProperties = {
    width: '100%',
    ...style,
  };

  const formStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns:
      layout === 'inline' ? 'repeat(auto-fit, minmax(200px, 1fr))' : `repeat(${columns}, 1fr)`,
    gap: layout === 'inline' ? '0.75rem' : '1.25rem',
    alignItems: layout === 'horizontal' ? 'start' : undefined,
  };

  const fieldWrapperStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: layout === 'horizontal' ? 'row' : 'column',
    gap: layout === 'horizontal' ? '0.75rem' : '0.5rem',
    ...(layout === 'horizontal' && { alignItems: 'center' }),
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '0.875rem',
    fontWeight: 500,
    color: 'var(--color-text-muted, #a1a1aa)',
    ...(layout === 'horizontal' && { minWidth: '120px', flexShrink: 0 }),
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.625rem 0.875rem',
    borderRadius: 'var(--radius-md, 0.5rem)',
    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    fontSize: '0.875rem',
    outline: 'none',
    transition: 'border-color 0.2s, box-shadow 0.2s, background 0.2s',
    background: 'var(--color-surface, #16161a)',
    color: 'var(--color-text, #fafafa)',
  };

  const inputErrorStyle: React.CSSProperties = {
    ...inputStyle,
    borderColor: 'var(--color-error-500, #ef4444)',
    boxShadow: '0 0 0 3px rgba(239, 68, 68, 0.1)',
  };

  const errorStyle: React.CSSProperties = {
    fontSize: '0.75rem',
    color: 'var(--color-error-500, #ef4444)',
    marginTop: '0.25rem',
  };

  const helpTextStyle: React.CSSProperties = {
    fontSize: '0.75rem',
    color: 'var(--color-gray-500, #71717a)',
    marginTop: '0.25rem',
  };

  const buttonGroupStyle: React.CSSProperties = {
    display: 'flex',
    gap: '0.75rem',
    marginTop: '1.75rem',
    paddingTop: '1rem',
    borderTop: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    justifyContent: columns > 1 ? 'flex-end' : undefined,
    gridColumn: columns > 1 ? `span ${columns}` : undefined,
  };

  const buttonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    padding: '0.625rem 1.25rem',
    borderRadius: 'var(--radius-md, 0.5rem)',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: disabled || loading || isSubmitting ? 'not-allowed' : 'pointer',
    transition: 'all 0.15s',
    border: 'none',
  };

  const primaryButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    background:
      'linear-gradient(135deg, var(--color-primary-500, #6366f1), var(--color-primary-600, #4f46e5))',
    color: 'white',
    boxShadow: '0 2px 8px rgba(99, 102, 241, 0.3)',
    fontWeight: 600,
    opacity: disabled || isSubmitting ? 0.6 : 1,
  };

  const secondaryButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    background: 'var(--color-gray-700, #1e1e23)',
    color: 'var(--color-gray-100, #27272a)',
    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
  };

  // Render field input
  const renderField = (field: FieldConfig) => {
    const value = formData[field.name];
    const hasError = touched[field.name] && errors[field.name];
    const isDisabled = disabled || field.disabled || isSubmitting;
    const currentInputStyle = hasError ? inputErrorStyle : inputStyle;

    switch (field.type) {
      case 'textarea':
        return (
          <textarea
            value={String(value ?? '')}
            onChange={(e) => handleChange(field.name, e.target.value)}
            onBlur={() => handleBlur(field)}
            placeholder={field.placeholder}
            disabled={isDisabled}
            style={{ ...currentInputStyle, minHeight: '100px', resize: 'vertical' }}
          />
        );

      case 'select': {
        const options = field.options || [];
        const normalizedOptions = options.map((opt) =>
          typeof opt === 'string' ? { value: opt, label: humanize(opt) } : opt
        );
        return (
          <select
            value={String(value ?? '')}
            onChange={(e) => handleChange(field.name, e.target.value)}
            onBlur={() => handleBlur(field)}
            disabled={isDisabled}
            style={{ ...currentInputStyle, cursor: 'pointer' }}
          >
            <option value="">Select...</option>
            {normalizedOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        );
      }

      case 'checkbox':
        return (
          <label
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => handleChange(field.name, e.target.checked)}
              onBlur={() => handleBlur(field)}
              disabled={isDisabled}
              style={{
                width: '1rem',
                height: '1rem',
                accentColor: 'var(--color-primary-500, #6366f1)',
              }}
            />
            <span style={{ fontSize: '0.875rem', color: 'var(--color-gray-300, #d4d4d8)' }}>
              {value ? 'Yes' : 'No'}
            </span>
          </label>
        );

      default:
        return (
          <input
            type={field.type || 'text'}
            value={String(value ?? '')}
            onChange={(e) =>
              handleChange(
                field.name,
                field.type === 'number'
                  ? (e.target.value === '' ? '' : Number(e.target.value))
                  : e.target.value
              )
            }
            onBlur={() => handleBlur(field)}
            placeholder={field.placeholder}
            disabled={isDisabled}
            min={field.min}
            max={field.max}
            style={currentInputStyle}
          />
        );
    }
  };

  return (
    <div className={className} style={containerStyle}>
      {(title || description) && (
        <div style={{ marginBottom: '1.5rem' }}>
          {title && (
            <h3
              style={{
                margin: '0 0 0.25rem',
                fontSize: '1.125rem',
                fontWeight: 600,
                color: 'var(--color-text, #fafafa)',
              }}
            >
              {title}
            </h3>
          )}
          {description && (
            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--color-gray-400, #a1a1aa)' }}>
              {description}
            </p>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} style={formStyle}>
        {fields.map((field) => (
          <div key={field.name} style={fieldWrapperStyle}>
            {field.type !== 'checkbox' && (
              <label style={labelStyle}>
                {field.label || humanize(field.name)}
                {field.required && (
                  <span style={{ color: 'var(--color-error-500, #ef4444)' }}> *</span>
                )}
              </label>
            )}
            <div style={{ flex: 1 }}>
              {renderField(field)}
              {touched[field.name] && errors[field.name] && (
                <div style={errorStyle}>{errors[field.name]}</div>
              )}
              {field.helpText && !errors[field.name] && (
                <div style={helpTextStyle}>{field.helpText}</div>
              )}
            </div>
          </div>
        ))}

        <div style={buttonGroupStyle}>
          {showCancel && onCancel && (
            <button type="button" onClick={onCancel} style={secondaryButtonStyle}>
              {cancelText}
            </button>
          )}
          <button type="submit" disabled={disabled || isSubmitting} style={primaryButtonStyle}>
            {(loading || isSubmitting) && <Spinner />}
            {submitText}
          </button>
        </div>
      </form>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default SmartForm;
