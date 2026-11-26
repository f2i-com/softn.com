/**
 * SoftN Built-in Helpers
 *
 * Collection and utility functions available in all SoftN templates.
 * These make it easy to work with data without writing custom logic.
 */

import type { XDBRecord } from '../types';
import { isBlockedFunction } from '../renderer/host-values';

const BLOCKED_HELPER_KEYS = new Set([
  'constructor',
  '__proto__',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

function safeOwnProp(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  if (typeof key !== 'string' || BLOCKED_HELPER_KEYS.has(key)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  return (obj as Record<string, unknown>)[key];
}

function safeRecordProp(item: unknown, key: string): unknown {
  if (typeof key !== 'string' || BLOCKED_HELPER_KEYS.has(key)) return undefined;
  if (isXDBRecord(item)) {
    if (item.data && typeof item.data === 'object' && Object.prototype.hasOwnProperty.call(item.data, key)) {
      return (item.data as Record<string, unknown>)[key];
    }
    return safeOwnProp(item, key);
  }
  return safeOwnProp(item, key);
}

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
    if (isBlockedFunction(predicateOrMatch)) return [];
    return items.filter(predicateOrMatch);
  }
  if (!predicateOrMatch || typeof predicateOrMatch !== 'object') return [];

  // Object match
  return items.filter((item) => {
    return Object.entries(predicateOrMatch).every(([key, value]) => {
      return safeRecordProp(item, key) === value;
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
    if (isBlockedFunction(keyOrComparator)) return sorted;
    sorted.sort(keyOrComparator);
  } else {
    sorted.sort((a, b) => {
      const aVal = safeRecordProp(a, keyOrComparator);
      const bVal = safeRecordProp(b, keyOrComparator);

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
    if (isBlockedFunction(predicateOrMatch)) return undefined;
    return items.find(predicateOrMatch);
  }
  if (!predicateOrMatch || typeof predicateOrMatch !== 'object') return undefined;

  return items.find((item) => {
    return Object.entries(predicateOrMatch).every(([key, value]) => {
      return safeRecordProp(item, key) === value;
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
    if (typeof predicate !== 'function' || isBlockedFunction(predicate)) return 0;
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
  if (!Array.isArray(items) || typeof predicate !== 'function' || isBlockedFunction(predicate)) return false;
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
  if (typeof predicate !== 'function' || isBlockedFunction(predicate)) return false;
  return items.every(predicate);
}

/**
 * Map items to a new array
 *
 * Usage in templates:
 *   {map(todos, t => t.data.title)}
 */
export function map<T, U>(items: T[], mapper: (item: T, index: number) => U): U[] {
  if (!Array.isArray(items) || typeof mapper !== 'function' || isBlockedFunction(mapper)) return [];
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
  if (typeof keyOrGetter === 'function' && isBlockedFunction(keyOrGetter)) return {};

  return items.reduce(
    (groups, item) => {
      const key =
        typeof keyOrGetter === 'function'
          ? String(keyOrGetter(item))
          : String(safeRecordProp(item, keyOrGetter) ?? 'undefined');

      if (BLOCKED_HELPER_KEYS.has(key)) return groups;
      if (!Object.prototype.hasOwnProperty.call(groups, key)) {
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
      const val = safeRecordProp(item, key);
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

  return items.map((item) => safeRecordProp(item, key));
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
  // Never below zero: `maxLength` under the suffix's length sliced from the
  // end, `truncate("Alexander", 2)` was "Alexande...". And not between the
  // two halves of a character written as a pair (most emoji), which left
  // half of one before the suffix.
  let end = Math.max(0, maxLength - suffix.length);
  const last = str.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return str.slice(0, end) + suffix;
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
  // The first letter of each word, a word being letters, marks, digits and
  // the apostrophes inside it. `\b\w` knew only ASCII and took an apostrophe
  // for the end of a word: "don't" was "Don'T", and "élan" was "éLan".
  return str.replace(/(^|[^\p{L}\p{M}\p{N}_'’])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());
}

// ============================================================================
// Number Helpers
// ============================================================================

/** How many formatters of one kind are kept (see keptFormatter). */
const FORMATTERS_KEPT = 64;
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
let relativeTimeFormat: Intl.RelativeTimeFormat | undefined;

/**
 * The formatter for `options`, made once and kept. A formatter costs tens of
 * microseconds to make, and a page asks for one for every value it draws: a
 * table of a thousand prices made a thousand on each drawing, which was most
 * of the time the drawing took. Options are a few plain values, so their JSON
 * is the key; ones that cannot be written so are given a formatter of their
 * own, as every call was. The oldest goes past FORMATTERS_KEPT.
 */
function keptFormatter<F>(kept: Map<string, F>, options: object | undefined, make: () => F, also = ''): F {
  let key: string;
  try {
    key = (options === undefined ? '' : JSON.stringify(options)) + also;
  } catch {
    return make();
  }
  let formatter = kept.get(key);
  if (formatter === undefined) {
    formatter = make();
    if (kept.size >= FORMATTERS_KEPT) kept.delete(kept.keys().next().value as string);
    kept.set(key, formatter);
  }
  return formatter;
}

/**
 * Format a number with locale-specific separators
 *
 * Usage in templates:
 *   {formatNumber(1234567.89)}
 *   {formatNumber(price, { style: 'currency', currency: 'USD' })}
 */
export function formatNumber(
  num: number | string,
  options?: Intl.NumberFormatOptions
): string {
  // Accept a numeric string. `:bind` on `<Input type="number">` stores exactly
  // that — the DOM hands back `target.value` — so a price entered through a
  // form arrived here as "19.99" and rendered as nothing: a blank cell where a
  // number should be, with no warning.
  //
  // A blank string is not zero, though `Number('')` is: an empty field must
  // stay empty rather than claim a value the user never entered.
  const value = typeof num === 'string' ? (num.trim() === '' ? NaN : Number(num)) : num;
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return keptFormatter(numberFormats, options, () => new Intl.NumberFormat(undefined, options)).format(value);
}

/**
 * Format as currency
 *
 * Usage in templates:
 *   {currency(price)}
 *   {currency(price, 'EUR')}
 */
export function currency(num: number | string, currencyCode = 'USD'): string {
  return formatNumber(num, { style: 'currency', currency: currencyCode });
}

/**
 * Format as percentage
 *
 * Usage in templates:
 *   {percent(0.75)}
 */
export function percent(num: number | string, decimals = 0): string {
  // `formatNumber` already rejects anything that is not a finite number, and
  // accepts the numeric strings that form binding produces — duplicating a
  // stricter guard here just made `percent` the odd one out.
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
 * Parse a date value, keeping a date-only string on the calendar day it names.
 *
 * `new Date('2026-07-27')` is UTC midnight by specification, and formatting
 * that in any zone west of UTC renders the day before — so a due date picked as
 * 27 July displayed as 26 July for every user in the Americas. `<input
 * type="date">` with `:bind` stores exactly this shape, so it was the common
 * case rather than an edge one. A value carrying a time is left alone: there
 * the instant is the point.
 */
function toDate(value: string | Date | number): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) {
      return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    }
  }
  return new Date(value);
}

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

  const dateObj = toDate(date);
  if (isNaN(dateObj.getTime())) return '';

  let options: Intl.DateTimeFormatOptions;

  if (typeof optionsOrStyle === 'string') {
    options = { dateStyle: optionsOrStyle };
  } else {
    options = optionsOrStyle || { dateStyle: 'medium' };
  }

  return keptFormatter(dateFormats, options, () => new Intl.DateTimeFormat(undefined, options), zoneKey()).format(dateObj);
}

/**
 * The device's offset from UTC now, beside a date formatter's options: a
 * formatter takes the time zone when it is made, and a device moved to
 * another zone is given new ones.
 */
function zoneKey(): string {
  return `@${new Date().getTimezoneOffset()}`;
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

  const dateObj = toDate(date);
  if (isNaN(dateObj.getTime())) return '';

  const options: Intl.DateTimeFormatOptions = { timeStyle: style };
  return keptFormatter(dateFormats, options, () => new Intl.DateTimeFormat(undefined, options), zoneKey()).format(dateObj);
}

/**
 * Format relative time (e.g., "2 days ago")
 *
 * Usage in templates:
 *   {timeAgo(item.created_at)}
 */
export function timeAgo(date: string | Date | number): string {
  if (!date) return '';

  const dateObj = toDate(date);
  if (isNaN(dateObj.getTime())) return '';

  const now = Date.now();
  const diff = now - dateObj.getTime();

  // Pick the unit from the magnitude and apply the direction at the end.
  // Every branch used to test `> 0`, so a future date fell past all of them to
  // the seconds case and reported "in 172,800 seconds" for something two days
  // out. A due date is as ordinary an input here as a created date.
  const sign = diff < 0 ? -1 : 1;
  const magnitude = Math.abs(diff);

  const seconds = Math.floor(magnitude / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  const rtf = (relativeTimeFormat ??= new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }));
  const ago = (value: number, unit: Intl.RelativeTimeFormatUnit) =>
    rtf.format(-sign * value, unit);

  if (years > 0) return ago(years, 'year');
  if (months > 0) return ago(months, 'month');
  if (weeks > 0) return ago(weeks, 'week');
  if (days > 0) return ago(days, 'day');
  if (hours > 0) return ago(hours, 'hour');
  if (minutes > 0) return ago(minutes, 'minute');
  return ago(seconds, 'second');
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
  if (!obj || typeof obj !== 'object' || typeof path !== 'string') return defaultValue;

  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return defaultValue;
    }
    if (BLOCKED_HELPER_KEYS.has(part)) {
      return defaultValue;
    }
    if (typeof current === 'string') {
      current = part === 'length' ? current.length : undefined;
    } else if (typeof current === 'object') {
      current = Object.prototype.hasOwnProperty.call(current, part)
        ? (current as Record<string, unknown>)[part]
        : undefined;
    } else {
      return defaultValue;
    }
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
  if (typeof fieldName !== 'string' || BLOCKED_HELPER_KEYS.has(fieldName)) return undefined;
  if (isXDBRecord(record)) {
    return safeOwnProp(record.data, fieldName);
  }
  return safeOwnProp(record, fieldName);
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
