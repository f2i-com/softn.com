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

/**
 * `value` as a Date: a day with no time at the local midnight of that day. A
 * day that is not on the calendar (`2024-02-30`, `2024-13-45`) is no date: it
 * was the day it rolled over to, shown as Mar 1 and Feb 14 of the next year.
 */
export function recordDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const day = typeof value === 'string' ? DATE_ONLY.exec(value.trim()) : null;
  if (day) {
    const [year, month, date] = [Number(day[1]), Number(day[2]) - 1, Number(day[3])];
    const local = new Date(year, month, date);
    // `new Date(y, m, d)` reads a year below 100 as 19yy: "0050-06-01" was
    // 1 June 1950. setFullYear takes the year as it is written.
    if (year < 100) local.setFullYear(year, month, date);
    return local.getMonth() === month && local.getDate() === date ? local : new Date(NaN);
  }
  return new Date(value as string | number);
}

/**
 * `value` as a date field (`<input type="date">`) shows it: its day, as
 * `yyyy-mm-dd`, the only text such a field takes. Given a date with a time
 * (`2024-03-15T09:30:00`) or a Date, the field showed nothing, and a record's
 * editor opened with its date blank. The day is the one the record's cell
 * shows, the local one; what is no date is left as it is.
 */
export function dateFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' && (value.trim() === '' || isDateOnly(value))) return value.trim();
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') return String(value);
  const date = recordDate(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
