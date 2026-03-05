/**
 * SoftN Form Binding Helpers
 *
 * Utilities for automatically binding form fields to XDB records.
 * These make it easy to create forms that work with XDB collections.
 */

import type { XDBRecord } from '../types';

// ============================================================================
// Types
// ============================================================================

/**
 * Form field configuration
 */
export interface FormFieldConfig {
  name: string;
  type?: 'text' | 'number' | 'boolean' | 'date' | 'email' | 'password' | 'textarea' | 'select';
  label?: string;
  placeholder?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string } | string>;
  defaultValue?: unknown;
  validate?: (value: unknown) => string | null;
}

/**
 * Form state object
 */
export interface FormState {
  values: Record<string, unknown>;
  errors: Record<string, string | null>;
  touched: Record<string, boolean>;
  isValid: boolean;
  isDirty: boolean;
  isSubmitting: boolean;
}

/**
 * Form binding result
 */
export interface FormBinding {
  state: FormState;
  getFieldProps: (name: string) => FieldProps;
  setFieldValue: (name: string, value: unknown) => void;
  setFieldError: (name: string, error: string | null) => void;
  setFieldTouched: (name: string, touched: boolean) => void;
  reset: (values?: Record<string, unknown>) => void;
  validate: () => boolean;
  handleSubmit: (
    onSubmit: (values: Record<string, unknown>) => void | Promise<void>
  ) => (e: Event) => void;
}

/**
 * Props for form field components
 */
export interface FieldProps {
  name: string;
  value: unknown;
  onChange: (e: Event | unknown) => void;
  onBlur: () => void;
  error: string | null;
  touched: boolean;
}

// ============================================================================
// Form Factory
// ============================================================================

/**
 * Create a form binding for easy form state management
 *
 * Usage in SoftN logic block:
 * ```
 * const form = createForm({
 *   fields: [
 *     { name: 'title', type: 'text', required: true },
 *     { name: 'description', type: 'textarea' },
 *     { name: 'priority', type: 'select', options: ['low', 'medium', 'high'] }
 *   ],
 *   initialValues: editing ? editing.data : null,
 *   onSubmit: async (values) => {
 *     if (editing) {
 *       await xdb.update(editing.id, values)
 *     } else {
 *       await xdb.create('tasks', values)
 *     }
 *   }
 * })
 * ```
 */
export function createFormState(
  fields: FormFieldConfig[],
  initialValues?: Record<string, unknown> | null
): FormState {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string | null> = {};
  const touched: Record<string, boolean> = {};

  for (const field of fields) {
    const initial = initialValues?.[field.name];
    values[field.name] =
      initial !== undefined ? initial : (field.defaultValue ?? getDefaultForType(field.type));
    errors[field.name] = null;
    touched[field.name] = false;
  }

  return {
    values,
    errors,
    touched,
    isValid: true,
    isDirty: false,
    isSubmitting: false,
  };
}

/**
 * Validate form values against field configs
 */
export function validateForm(
  state: FormState,
  fields: FormFieldConfig[]
): Record<string, string | null> {
  const errors: Record<string, string | null> = {};

  for (const field of fields) {
    const value = state.values[field.name];
    let error: string | null = null;

    // Required validation
    if (field.required && isEmpty(value)) {
      error = `${field.label || field.name} is required`;
    }

    // Custom validation
    if (!error && field.validate) {
      error = field.validate(value);
    }

    errors[field.name] = error;
  }

  return errors;
}

/**
 * Check if form is valid
 */
export function isFormValid(errors: Record<string, string | null>): boolean {
  return Object.values(errors).every((error) => error === null);
}

/**
 * Get values from an XDB record for form initialization
 */
export function recordToFormValues(record: XDBRecord | null): Record<string, unknown> | null {
  if (!record) return null;
  return { ...record.data };
}

/**
 * Prepare form values for XDB create/update
 */
export function formValuesToRecord(values: Record<string, unknown>): Record<string, unknown> {
  // Clone and clean values
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    // Skip undefined values
    if (value === undefined) continue;

    // Convert empty strings to null for optional fields
    if (value === '') {
      cleaned[key] = null;
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
}

// ============================================================================
// Field Helpers
// ============================================================================

/**
 * Get default value for a field type
 */
function getDefaultForType(type?: string): unknown {
  switch (type) {
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'date':
      return '';
    default:
      return '';
  }
}

/**
 * Check if a value is empty
 */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// ============================================================================
// State Update Helpers (for use in SoftN logic blocks)
// ============================================================================

/**
 * Create a field change handler
 *
 * Usage:
 * @input={handleFieldChange(state, 'title')}
 */
export function handleFieldChange(
  setState: (path: string, value: unknown) => void,
  formPath: string,
  fieldName: string
): (event: Event | unknown) => void {
  return (event: Event | unknown) => {
    let value: unknown;

    if (event && typeof event === 'object' && 'target' in event) {
      const target = (event as { target: HTMLInputElement }).target;
      value = target.type === 'checkbox' ? target.checked : target.value;
    } else {
      value = event;
    }

    setState(`${formPath}.values.${fieldName}`, value);
    setState(`${formPath}.isDirty`, true);
  };
}

/**
 * Create a field blur handler
 *
 * Usage:
 * @blur={handleFieldBlur(state, 'title')}
 */
export function handleFieldBlur(
  setState: (path: string, value: unknown) => void,
  formPath: string,
  fieldName: string
): () => void {
  return () => {
    setState(`${formPath}.touched.${fieldName}`, true);
  };
}

// ============================================================================
// Convenience Functions for Templates
// ============================================================================

/**
 * Get error message for a field if touched and has error
 */
export function getFieldError(state: FormState, fieldName: string): string | null {
  if (state.touched[fieldName] && state.errors[fieldName]) {
    return state.errors[fieldName];
  }
  return null;
}

/**
 * Check if a field has an error (for styling)
 */
export function hasFieldError(state: FormState, fieldName: string): boolean {
  return !!(state.touched[fieldName] && state.errors[fieldName]);
}

/**
 * Get CSS class based on field state
 */
export function getFieldClass(state: FormState, fieldName: string, baseClass = ''): string {
  const classes = [baseClass];

  if (state.touched[fieldName]) {
    if (state.errors[fieldName]) {
      classes.push('field-error');
    } else {
      classes.push('field-valid');
    }
  }

  return classes.filter(Boolean).join(' ');
}

// Export convenience form utilities
export const formUtils = {
  createState: createFormState,
  validate: validateForm,
  isValid: isFormValid,
  toFormValues: recordToFormValues,
  toRecord: formValuesToRecord,
  handleChange: handleFieldChange,
  handleBlur: handleFieldBlur,
  getError: getFieldError,
  hasError: hasFieldError,
  getClass: getFieldClass,
};
