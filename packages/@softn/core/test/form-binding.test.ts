/**
 * SoftN Form Binding Tests
 *
 * Tests for form binding utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  createFormState,
  validateForm,
  isFormValid,
  recordToFormValues,
  formValuesToRecord,
  getFieldError,
  hasFieldError,
  getFieldClass,
  FormFieldConfig,
} from '../src/runtime/form-binding';

const mockFields: FormFieldConfig[] = [
  { name: 'title', type: 'text', label: 'Title', required: true },
  { name: 'count', type: 'number', defaultValue: 10 },
  { name: 'active', type: 'boolean', defaultValue: false },
  {
    name: 'email',
    type: 'text',
    validate: (v) => {
      if (v && typeof v === 'string' && !v.includes('@')) {
        return 'Invalid email';
      }
      return null;
    },
  },
];

describe('createFormState', () => {
  it('should create form state with defaults', () => {
    const state = createFormState(mockFields);

    expect(state.values.title).toBe('');
    expect(state.values.count).toBe(10);
    expect(state.values.active).toBe(false);
    expect(state.isValid).toBe(true);
    expect(state.isDirty).toBe(false);
    expect(state.isSubmitting).toBe(false);
  });

  it('should use initial values when provided', () => {
    const state = createFormState(mockFields, {
      title: 'My Title',
      count: 5,
    });

    expect(state.values.title).toBe('My Title');
    expect(state.values.count).toBe(5);
    expect(state.values.active).toBe(false); // Uses default
  });

  it('should initialize errors and touched to null/false', () => {
    const state = createFormState(mockFields);

    expect(state.errors.title).toBeNull();
    expect(state.touched.title).toBe(false);
  });
});

describe('validateForm', () => {
  it('should validate required fields', () => {
    const state = createFormState(mockFields);
    const errors = validateForm(state, mockFields);

    expect(errors.title).toContain('required');
    expect(errors.count).toBeNull();
  });

  it('should run custom validation', () => {
    const state = createFormState(mockFields, {
      title: 'Test',
      email: 'invalid-email',
    });
    const errors = validateForm(state, mockFields);

    expect(errors.title).toBeNull();
    expect(errors.email).toBe('Invalid email');
  });

  it('should pass with valid values', () => {
    const state = createFormState(mockFields, {
      title: 'Valid Title',
      email: 'test@example.com',
    });
    const errors = validateForm(state, mockFields);

    expect(errors.title).toBeNull();
    expect(errors.email).toBeNull();
  });
});

describe('isFormValid', () => {
  it('should return true when all errors are null', () => {
    const errors = { title: null, count: null };
    expect(isFormValid(errors)).toBe(true);
  });

  it('should return false when any error exists', () => {
    const errors = { title: 'Required', count: null };
    expect(isFormValid(errors)).toBe(false);
  });
});

describe('recordToFormValues', () => {
  it('should extract data from XDB record', () => {
    const record = {
      id: '1',
      collection: 'test',
      data: { title: 'Test', count: 5 },
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
      deleted: false,
    };

    const values = recordToFormValues(record);

    expect(values).toEqual({ title: 'Test', count: 5 });
  });

  it('should return null for null input', () => {
    expect(recordToFormValues(null)).toBeNull();
  });
});

describe('formValuesToRecord', () => {
  it('should clean form values', () => {
    const values = {
      title: 'Test',
      description: '',
      count: 0,
      undef: undefined,
    };

    const result = formValuesToRecord(values);

    expect(result.title).toBe('Test');
    expect(result.description).toBeNull(); // Empty string -> null
    expect(result.count).toBe(0);
    expect('undef' in result).toBe(false); // Undefined removed
  });
});

describe('getFieldError', () => {
  it('should return error only if touched', () => {
    const state = createFormState(mockFields);
    state.errors.title = 'Required';

    // Not touched yet
    expect(getFieldError(state, 'title')).toBeNull();

    // After touching
    state.touched.title = true;
    expect(getFieldError(state, 'title')).toBe('Required');
  });
});

describe('hasFieldError', () => {
  it('should return true only if touched and has error', () => {
    const state = createFormState(mockFields);
    state.errors.title = 'Required';

    expect(hasFieldError(state, 'title')).toBe(false);

    state.touched.title = true;
    expect(hasFieldError(state, 'title')).toBe(true);
  });
});

describe('getFieldClass', () => {
  it('should return base class when not touched', () => {
    const state = createFormState(mockFields);
    expect(getFieldClass(state, 'title', 'input')).toBe('input');
  });

  it('should add error class when touched and has error', () => {
    const state = createFormState(mockFields);
    state.touched.title = true;
    state.errors.title = 'Required';

    expect(getFieldClass(state, 'title', 'input')).toBe('input field-error');
  });

  it('should add valid class when touched and no error', () => {
    const state = createFormState(mockFields);
    state.touched.title = true;
    state.errors.title = null;

    expect(getFieldClass(state, 'title', 'input')).toBe('input field-valid');
  });
});
