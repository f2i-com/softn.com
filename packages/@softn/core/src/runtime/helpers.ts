/**
 * SoftN Built-in Helpers
 *
 * Collection and utility functions available in all SoftN templates.
 * These make it easy to work with data without writing custom logic.
 */

import type { XDBRecord } from '../types';

// ============================================================================
// Collection Helpers
// ============================================================================

/**
 * Filter an array based on a predicate or key-value match
 *
 * Usage in templates:
 *   {filter(todos, t => t.data.completed)}
 *   {filter(todos, { completed: true })}
 */
export function filter<T>(
  items: T[],
  predicateOrMatch: ((item: T, index: number) => boolean) | Record<string, unknown>
): T[] {
  if (!Array.isArray(items)) return [];

  if (typeof predicateOrMatch === 'function') {
    return items.filter(predicateOrMatch);
  }

  // Object match
  return items.filter((item) => {
    const data = isXDBRecord(item) ? item.data : item;
    return Object.entries(predicateOrMatch).every(([key, value]) => {
      return (data as Record<string, unknown>)[key] === value;
    });
  });
}

/**
 * Sort an array by a key or comparator
 *
 * Usage in templates:
 *   {sort(todos, 'created_at')}
 *   {sort(todos, 'created_at', 'desc')}
 *   {sort(todos, (a, b) => a.data.priority - b.data.priority)}
 */
export function sort<T>(
  items: T[],
  keyOrComparator: string | ((a: T, b: T) => number),
  order: 'asc' | 'desc' = 'asc'
): T[] {
  if (!Array.isArray(items)) return [];

  const sorted = [...items];

  if (typeof keyOrComparator === 'function') {
    sorted.sort(keyOrComparator);
  } else {
    sorted.sort((a, b) => {
      const aData = isXDBRecord(a) ? a.data : a;
      const bData = isXDBRecord(b) ? b.data : b;
      const aVal = (aData as Record<string, unknown>)[keyOrComparator];
      const bVal = (bData as Record<string, unknown>)[keyOrComparator];

      if (aVal === bVal) return 0;
      if (aVal === undefined || aVal === null) return 1;
      if (bVal === undefined || bVal === null) return -1;

      return aVal < bVal ? -1 : 1;
    });
  }

  return order === 'desc' ? sorted.reverse() : sorted;
}

/**
 * Find a single item in an array
 *
 * Usage in templates:
 *   {find(todos, t => t.id === selectedId)}
 *   {find(todos, { id: selectedId })}
 */
export function find<T>(
  items: T[],
  predicateOrMatch: ((item: T, index: number) => boolean) | Record<string, unknown>
): T | undefined {
  if (!Array.isArray(items)) return undefined;

  if (typeof predicateOrMatch === 'function') {
    return items.find(predicateOrMatch);
  }

  return items.find((item) => {
    const data = isXDBRecord(item) ? { ...item, ...item.data } : item;
    return Object.entries(predicateOrMatch).every(([key, value]) => {
      return (data as Record<string, unknown>)[key] === value;
    });
  });
}

/**
 * Get the first item(s) from an array
 *
 * Usage in templates:
 *   {first(todos)}
 *   {first(todos, 3)}
 */
export function first<T>(items: T[], count?: number): T | T[] | undefined {
  if (!Array.isArray(items)) return undefined;

  if (count === undefined) {
    return items[0];
  }

  return items.slice(0, count);
}

/**
 * Get the last item(s) from an array
 *
 * Usage in templates:
 *   {last(todos)}
 *   {last(todos, 3)}
 */
export function last<T>(items: T[], count?: number): T | T[] | undefined {
  if (!Array.isArray(items)) return undefined;

  if (count === undefined) {
    return items[items.length - 1];
  }

  return items.slice(-count);
}

/**
 * Get the count of items (optionally filtered)
 *
 * Usage in templates:
 *   {count(todos)}
 *   {count(todos, t => t.data.completed)}
 */
export function count<T>(items: T[], predicate?: (item: T, index: number) => boolean): number {
  if (!Array.isArray(items)) return 0;

  if (predicate) {
    return items.filter(predicate).length;
  }

  return items.length;
}

/**
 * Check if any item matches the predicate
 *
 * Usage in templates:
 *   {some(todos, t => t.data.completed)}
 */
export function some<T>(items: T[], predicate: (item: T, index: number) => boolean): boolean {
  if (!Array.isArray(items)) return false;
  return items.some(predicate);
}

/**
 * Check if all items match the predicate
 *
 * Usage in templates:
 *   {every(todos, t => t.data.completed)}
 */
export function every<T>(items: T[], predicate: (item: T, index: number) => boolean): boolean {
  if (!Array.isArray(items)) return true;
  return items.every(predicate);
}

/**
 * Map items to a new array
 *
 * Usage in templates:
 *   {map(todos, t => t.data.title)}
 */
export function map<T, U>(items: T[], mapper: (item: T, index: number) => U): U[] {
  if (!Array.isArray(items)) return [];
  return items.map(mapper);
}

/**
 * Group items by a key
 *
 * Usage in templates:
 *   {groupBy(todos, 'status')}
 *   {groupBy(todos, t => t.data.category)}
 */
export function groupBy<T>(
  items: T[],
  keyOrGetter: string | ((item: T) => string)
): Record<string, T[]> {
  if (!Array.isArray(items)) return {};

  return items.reduce(
    (groups, item) => {
      const key =
        typeof keyOrGetter === 'function'
          ? keyOrGetter(item)
          : String(
              (isXDBRecord(item) ? item.data : (item as Record<string, unknown>))[keyOrGetter] ??
                'undefined'
            );

      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(item);
      return groups;
    },
    {} as Record<string, T[]>
  );
}

/**
 * Get unique items (by key or identity)
 *
 * Usage in templates:
 *   {unique(tags)}
 *   {unique(todos, 'category')}
 */
export function unique<T>(items: T[], key?: string): T[] {
  if (!Array.isArray(items)) return [];

  if (key) {
    const seen = new Set<unknown>();
    return items.filter((item) => {
      const data = isXDBRecord(item) ? item.data : item;
      const val = (data as Record<string, unknown>)[key];
      if (seen.has(val)) return false;
      seen.add(val);
      return true;
    });
  }

  return [...new Set(items)];
}

/**
 * Pluck a key from each item
 *
 * Usage in templates:
 *   {pluck(todos, 'title')}
 */
export function pluck<T>(items: T[], key: string): unknown[] {
  if (!Array.isArray(items)) return [];

  return items.map((item) => {
    const data = isXDBRecord(item) ? item.data : item;
    return (data as Record<string, unknown>)[key];
  });
}

// ============================================================================
// String Helpers
// ============================================================================

/**
 * Truncate a string with ellipsis
 *
 * Usage in templates:
 *   {truncate(item.data.description, 100)}
 */
export function truncate(str: string, maxLength: number, suffix = '...'): string {
  if (!str || typeof str !== 'string') return '';
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * Capitalize first letter
 *
 * Usage in templates:
 *   {capitalize(item.data.status)}
 */
export function capitalize(str: string): string {
  if (!str || typeof str !== 'string') return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Format as title case
 *
 * Usage in templates:
 *   {titleCase(item.data.name)}
 */
export function titleCase(str: string): string {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/\b\w/g, (char) => char.toUpperCase());
}

// ============================================================================
// Number Helpers
// ============================================================================

/**
 * Format a number with locale-specific separators
 *
 * Usage in templates:
 *   {formatNumber(1234567.89)}
 *   {formatNumber(price, { style: 'currency', currency: 'USD' })}
 */
export function formatNumber(num: number, options?: Intl.NumberFormatOptions): string {
  if (typeof num !== 'number' || isNaN(num)) return '';
  return new Intl.NumberFormat(undefined, options).format(num);
}

/**
 * Format as currency
 *
 * Usage in templates:
 *   {currency(price)}
 *   {currency(price, 'EUR')}
 */
export function currency(num: number, currencyCode = 'USD'): string {
  return formatNumber(num, { style: 'currency', currency: currencyCode });
}

/**
 * Format as percentage
 *
 * Usage in templates:
 *   {percent(0.75)}
 */
export function percent(num: number, decimals = 0): string {
  if (typeof num !== 'number' || isNaN(num)) return '';
  return formatNumber(num, {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// ============================================================================
// Date Helpers
// ============================================================================

/**
 * Format a date
 *
 * Usage in templates:
 *   {formatDate(item.created_at)}
 *   {formatDate(item.created_at, 'short')}
 *   {formatDate(item.created_at, { dateStyle: 'full' })}
 */
export function formatDate(
  date: string | Date | number,
  optionsOrStyle?: Intl.DateTimeFormatOptions | 'short' | 'medium' | 'long' | 'full'
): string {
  if (!date) return '';

  const dateObj = date instanceof Date ? date : new Date(date);
  if (isNaN(dateObj.getTime())) return '';

  let options: Intl.DateTimeFormatOptions;

  if (typeof optionsOrStyle === 'string') {
    options = { dateStyle: optionsOrStyle };
  } else {
    options = optionsOrStyle || { dateStyle: 'medium' };
  }

  return new Intl.DateTimeFormat(undefined, options).format(dateObj);
}

/**
 * Format a time
 *
 * Usage in templates:
 *   {formatTime(item.created_at)}
 */
export function formatTime(
  date: string | Date | number,
  style: 'short' | 'medium' | 'long' | 'full' = 'short'
): string {
  if (!date) return '';

  const dateObj = date instanceof Date ? date : new Date(date);
  if (isNaN(dateObj.getTime())) return '';

  return new Intl.DateTimeFormat(undefined, { timeStyle: style }).format(dateObj);
}

/**
 * Format relative time (e.g., "2 days ago")
 *
 * Usage in templates:
 *   {timeAgo(item.created_at)}
 */
export function timeAgo(date: string | Date | number): string {
  if (!date) return '';

  const dateObj = date instanceof Date ? date : new Date(date);
  if (isNaN(dateObj.getTime())) return '';

  const now = Date.now();
  const diff = now - dateObj.getTime();

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (years > 0) return rtf.format(-years, 'year');
  if (months > 0) return rtf.format(-months, 'month');
  if (weeks > 0) return rtf.format(-weeks, 'week');
  if (days > 0) return rtf.format(-days, 'day');
  if (hours > 0) return rtf.format(-hours, 'hour');
  if (minutes > 0) return rtf.format(-minutes, 'minute');
  return rtf.format(-seconds, 'second');
}

// ============================================================================
// Object Helpers
// ============================================================================

/**
 * Get a value from a nested path
 *
 * Usage in templates:
 *   {get(item, 'data.user.name')}
 *   {get(item, 'data.user.name', 'Unknown')}
 */
export function get<T = unknown>(obj: unknown, path: string, defaultValue?: T): T | undefined {
  if (!obj || typeof obj !== 'object') return defaultValue;

  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return defaultValue;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return (current as T) ?? defaultValue;
}

/**
 * Check if a value is empty (null, undefined, empty string, empty array, empty object)
 *
 * Usage in templates:
 *   {isEmpty(item.data.tags)}
 */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Check if a value is not empty
 *
 * Usage in templates:
 *   {isNotEmpty(item.data.tags)}
 */
export function isNotEmpty(value: unknown): boolean {
  return !isEmpty(value);
}

// ============================================================================
// XDB Shorthand Helpers (make XDB operations more concise)
// ============================================================================

/**
 * Extract the data property from an XDB record
 *
 * Usage in templates:
 *   {data(record).title}
 *   Instead of: {record.data.title}
 */
export function data(record: XDBRecord | unknown): Record<string, unknown> {
  if (isXDBRecord(record)) {
    return record.data;
  }
  return (record as Record<string, unknown>) ?? {};
}

/**
 * Get a field from an XDB record's data
 *
 * Usage in templates:
 *   {field(record, 'title')}
 *   Instead of: {record.data.title}
 */
export function field(record: XDBRecord | unknown, fieldName: string): unknown {
  if (isXDBRecord(record)) {
    return record.data[fieldName];
  }
  return (record as Record<string, unknown>)?.[fieldName];
}

// ============================================================================
// JSON Helpers
// ============================================================================

/**
 * Safely stringify to JSON
 *
 * Usage in templates:
 *   {json(item)}
 */
export function json(value: unknown, pretty = false): string {
  try {
    return JSON.stringify(value, null, pretty ? 2 : undefined);
  } catch {
    return '';
  }
}

// ============================================================================
// Conditional Helpers
// ============================================================================

/**
 * Return first value if condition is true, second otherwise
 *
 * Usage in templates:
 *   {when(isActive, 'active', 'inactive')}
 */
export function when<T, U>(condition: boolean, trueValue: T, falseValue: U): T | U {
  return condition ? trueValue : falseValue;
}

/**
 * Return value only if condition is true
 *
 * Usage in templates:
 *   {maybe(showBadge, '!')}
 */
export function maybe<T>(condition: boolean, value: T): T | '' {
  return condition ? value : '';
}

// ============================================================================
// Internal Helpers
// ============================================================================

function isXDBRecord(value: unknown): value is XDBRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'collection' in value &&
    'data' in value
  );
}

// ============================================================================
// Form Helpers (re-exported from form-binding)
// ============================================================================

import {
  createFormState,
  validateForm,
  isFormValid,
  recordToFormValues,
  formValuesToRecord,
  getFieldError,
  hasFieldError,
  getFieldClass,
} from './form-binding';

// ============================================================================
// Export all helpers as a single object for easy injection into context
// ============================================================================

export const builtinHelpers = {
  // Collection helpers
  filter,
  sort,
  find,
  first,
  last,
  count,
  some,
  every,
  map,
  groupBy,
  unique,
  pluck,

  // String helpers
  truncate,
  capitalize,
  titleCase,

  // Number helpers
  formatNumber,
  currency,
  percent,

  // Date helpers
  formatDate,
  formatTime,
  timeAgo,

  // Object helpers
  get,
  isEmpty,
  isNotEmpty,

  // XDB helpers
  data,
  field,

  // JSON helpers
  json,

  // Conditional helpers
  when,
  maybe,

  // Form helpers
  createFormState,
  validateForm,
  isFormValid,
  recordToFormValues,
  formValuesToRecord,
  getFieldError,
  hasFieldError,
  getFieldClass,
};
