/**
 * A record's date, as the smart components show it.
 *
 * `new Date("2024-03-15")` is midnight in UTC, which west of UTC is the
 * evening before: a task due on the 15th showed as due on the 14th in Los
 * Angeles, and the timeline added an hour no one wrote ("Mar 14, 08:00 PM" in
 * New York). A date with no time is the day it names, wherever it is read, as
 * DatePicker already reads it.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `value` is a calendar day with no time: `2024-03-15`. */
export function isDateOnly(value: unknown): value is string {
  return typeof value === 'string' && DATE_ONLY.test(value.trim());
}

/** `value` as a Date: a day with no time at the local midnight of that day. */
export function recordDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const day = typeof value === 'string' ? DATE_ONLY.exec(value.trim()) : null;
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  return new Date(value as string | number);
}
