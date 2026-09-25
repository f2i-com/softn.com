/**
 * DatePicker Component
 *
 * A date field with a calendar popup, following the WAI-ARIA date picker
 * dialog pattern: the field opens the calendar from the keyboard as well as
 * the mouse, the calendar is a grid the arrow keys move through, and Escape
 * closes it and puts focus back on the field.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

export interface DatePickerProps {
  /** Input id (generated when omitted) */
  id?: string;
  /** Current date value (ISO string or Date object) */
  value?: string | Date;
  /** Default value */
  defaultValue?: string | Date;
  /** Input name */
  name?: string;
  /** Label text */
  label?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Whether disabled */
  disabled?: boolean;
  /** Whether read-only */
  readOnly?: boolean;
  /** Whether required */
  required?: boolean;
  /** Minimum date */
  min?: string | Date;
  /** Maximum date */
  max?: string | Date;
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** Full width */
  fullWidth?: boolean;
  /** Error state or message */
  error?: boolean | string;
  /** Date format for display */
  format?: 'yyyy-mm-dd' | 'mm/dd/yyyy' | 'dd/mm/yyyy';
  /** Change handler */
  onChange?: (date: Date | null, dateString: string) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeStyles: Record<string, React.CSSProperties> = {
  sm: { padding: '0.375rem 0.5rem', fontSize: '0.875rem' },
  md: { padding: '0.5rem 0.75rem', fontSize: '0.875rem' },
  lg: { padding: '0.625rem 1rem', fontSize: '1rem' },
};

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * A date from a prop. `YYYY-MM-DD` is read as that day where the user is.
 * `new Date('2024-01-15')` reads it as midnight UTC, which west of Greenwich
 * is the evening of the 14th — so the field showed the day before the one it
 * was given, and a controlled field that echoed its own onChange back walked
 * one day earlier on every pick.
 */
function parseDate(value: string | Date | undefined | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    // 2024-02-31 is not a date, not the 2nd of March.
    return date.getMonth() === Number(m) - 1 ? date : null;
  }
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** The same day `months` later, pinned to the month's last day when it has fewer. */
function addMonths(date: Date, months: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = getDaysInMonth(target.getFullYear(), target.getMonth());
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), last));
}

function sameDay(a: Date | null, b: Date | null): boolean {
  return !!a && !!b && a.toDateString() === b.toDateString();
}

function formatDateForInput(date: Date | null): string {
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateForDisplay(date: Date | null, format: string): string {
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  switch (format) {
    case 'mm/dd/yyyy':
      return `${month}/${day}/${year}`;
    case 'dd/mm/yyyy':
      return `${day}/${month}/${year}`;
    default:
      return `${year}-${month}-${day}`;
  }
}

/** "Monday 15 January 2024": what a day button is called. */
function spokenDate(date: Date): string {
  return `${DAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

export function DatePicker({
  id,
  value,
  defaultValue,
  name,
  label,
  placeholder = 'Select date',
  disabled = false,
  readOnly = false,
  required = false,
  min,
  max,
  size = 'md',
  fullWidth = false,
  error = false,
  format = 'yyyy-mm-dd',
  onChange,
  className,
  style,
}: DatePickerProps): React.ReactElement {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const dialogId = `${inputId}-calendar`;
  const headingId = `${inputId}-calendar-heading`;
  const [selectedDate, setSelectedDate] = useState<Date | null>(
    parseDate(value) ?? parseDate(defaultValue)
  );
  const [isOpen, setIsOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [viewDate, setViewDate] = useState(selectedDate || new Date());
  /** The day the grid's roving tab stop is on. */
  const [focusedDate, setFocusedDate] = useState<Date>(startOfDay(selectedDate || new Date()));
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** Set when focus should follow `focusedDate` into the grid on the next render. */
  const moveFocusToGrid = useRef(false);

  const minDate = parseDate(min);
  const maxDate = parseDate(max);
  const hasError = Boolean(error);
  const errorMessage = typeof error === 'string' ? error : undefined;
  const interactive = !disabled && !readOnly;

  useEffect(() => {
    // When the parent supplies `value` it is the authority, including when it
    // supplies an empty one. The `if (newDate)` guard here meant a parent could
    // set a date but never clear it and never refuse a change: after a save that
    // reset the form, the field kept showing the old date and the named input
    // kept submitting it, so the screen and the app's state disagreed with
    // nothing reporting a problem.
    if (value === undefined) return;
    const newDate = parseDate(value);
    setSelectedDate(newDate);
    // The month on view only follows a real date; clearing should not throw the
    // calendar back to whatever month an empty string parses as.
    if (newDate) setViewDate(newDate);
    // `value` may be a new Date object with the same time on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value instanceof Date ? value.getTime() : value]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Keyboard movement in the grid focuses the day it moved to.
  useEffect(() => {
    if (!isOpen || !moveFocusToGrid.current) return;
    moveFocusToGrid.current = false;
    gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }, [isOpen, focusedDate, viewDate]);

  const isDateDisabled = useCallback(
    (date: Date): boolean => {
      if (minDate && date < startOfDay(minDate)) return true;
      if (maxDate && date > startOfDay(maxDate)) return true;
      return false;
    },
    [minDate, maxDate]
  );

  const openCalendar = useCallback(() => {
    if (!interactive) return;
    const start = startOfDay(selectedDate ?? new Date());
    setViewDate(start);
    setFocusedDate(start);
    moveFocusToGrid.current = true;
    setIsOpen(true);
  }, [interactive, selectedDate]);

  const closeCalendar = useCallback((refocus: boolean) => {
    setIsOpen(false);
    if (refocus) inputRef.current?.focus();
  }, []);

  const handleDateSelect = useCallback(
    (date: Date) => {
      if (isDateDisabled(date)) return;
      // Only move the field ourselves when nobody else is holding it. Writing
      // internal state unconditionally is what let the control drift away from
      // a controlling parent — it showed a date the parent had not accepted.
      if (value === undefined) setSelectedDate(date);
      closeCalendar(true);
      onChange?.(date, formatDateForInput(date));
    },
    [onChange, value, isDateDisabled, closeCalendar]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const date = parseDate(e.target.value);
      if (value === undefined) setSelectedDate(date);
      if (date) {
        setViewDate(date);
      }
      onChange?.(date, e.target.value);
    },
    [onChange, value]
  );

  const handleClear = useCallback(() => {
    if (value === undefined) setSelectedDate(null);
    onChange?.(null, '');
    inputRef.current?.focus();
  }, [onChange, value]);

  const navigateMonth = useCallback((delta: number) => {
    setViewDate((prev) => addMonths(prev, delta));
    setFocusedDate((prev) => addMonths(prev, delta));
  }, []);

  const navigateYear = useCallback((delta: number) => {
    setViewDate((prev) => addMonths(prev, delta * 12));
    setFocusedDate((prev) => addMonths(prev, delta * 12));
  }, []);

  /** Move the grid's focus to `date`, turning the page when it is in another month. */
  const focusDay = useCallback((date: Date) => {
    moveFocusToGrid.current = true;
    setFocusedDate(date);
    setViewDate((view) =>
      view.getFullYear() === date.getFullYear() && view.getMonth() === date.getMonth() ? view : date
    );
  }, []);

  const handleFieldKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!interactive) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      openCalendar();
    } else if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      e.stopPropagation();
      closeCalendar(true);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDate) {
      e.preventDefault();
      handleClear();
    }
  };

  const handleGridKeyDown = (e: React.KeyboardEvent) => {
    const d = focusedDate;
    let next: Date | null = null;
    switch (e.key) {
      case 'ArrowLeft':
        next = addDays(d, -1);
        break;
      case 'ArrowRight':
        next = addDays(d, 1);
        break;
      case 'ArrowUp':
        next = addDays(d, -7);
        break;
      case 'ArrowDown':
        next = addDays(d, 7);
        break;
      case 'Home':
        next = addDays(d, -d.getDay());
        break;
      case 'End':
        next = addDays(d, 6 - d.getDay());
        break;
      case 'PageUp':
        next = addMonths(d, e.shiftKey ? -12 : -1);
        break;
      case 'PageDown':
        next = addMonths(d, e.shiftKey ? 12 : 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        handleDateSelect(d);
        return;
      default:
        return;
    }
    e.preventDefault();
    focusDay(next);
  };

  // Escape anywhere in the calendar closes it — and only it, not a Modal the
  // field sits in.
  const handleDialogKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeCalendar(true);
  };

  // Generate calendar weeks
  const renderCalendar = () => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const daysInMonth = getDaysInMonth(year, month);
    const firstDay = getFirstDayOfMonth(year, month);
    // The roving tab stop stays inside the month on view.
    const tabStop =
      focusedDate.getFullYear() === year && focusedDate.getMonth() === month
        ? focusedDate.getDate()
        : 1;
    const today = new Date();

    const cells: React.ReactNode[] = [];

    // Empty cells for days before the first day
    for (let i = 0; i < firstDay; i++) {
      cells.push(<div key={`empty-${i}`} role="gridcell" style={{ width: '2rem', height: '2rem' }} />);
    }

    // Days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day);
      const isDisabled = isDateDisabled(date);
      const isSelected = sameDay(date, selectedDate);
      const isTodayDate = sameDay(date, today);
      const isStop = day === tabStop;

      cells.push(
        <button
          key={day}
          type="button"
          role="gridcell"
          tabIndex={isStop ? 0 : -1}
          aria-label={spokenDate(date)}
          aria-selected={isSelected}
          aria-current={isTodayDate ? 'date' : undefined}
          aria-disabled={isDisabled || undefined}
          onClick={() => handleDateSelect(date)}
          onFocus={() => {
            if (!sameDay(date, focusedDate)) setFocusedDate(date);
          }}
          style={{
            width: '2rem',
            height: '2rem',
            border: 'none',
            borderRadius: '0.25rem',
            // Today is a tint, the selected day solid: they looked the same.
            background: isSelected
              ? 'var(--color-primary-500, #6366f1)'
              : isTodayDate
                ? 'color-mix(in srgb, var(--color-primary-500, currentColor) 18%, transparent)'
                : 'transparent',
            color: isSelected
              ? 'var(--color-primary-text, white)'
              : isDisabled
                ? 'var(--color-text-muted, #a1a1aa)'
                : 'var(--color-text, #ececf0)',
            cursor: isDisabled ? 'not-allowed' : 'pointer',
            opacity: isDisabled ? 0.5 : 1,
            fontWeight: isTodayDate ? 600 : 400,
            fontSize: '0.875rem',
          }}
        >
          {day}
        </button>
      );
    }

    // Trailing cells so the last week is a full row.
    while (cells.length % 7 !== 0) {
      cells.push(
        <div key={`trail-${cells.length}`} role="gridcell" style={{ width: '2rem', height: '2rem' }} />
      );
    }

    const weeks: React.ReactNode[] = [];
    for (let w = 0; w < cells.length; w += 7) {
      weeks.push(
        <div key={w} role="row" style={weekStyle}>
          {cells.slice(w, w + 7)}
        </div>
      );
    }
    return weeks;
  };

  const weekStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: '0.125rem',
  };

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'inline-block',
    width: fullWidth ? '100%' : undefined,
    ...style,
  };

  const inputContainerStyle: React.CSSProperties = {
    position: 'relative',
    width: fullWidth ? '100%' : undefined,
  };

  const inputStyle: React.CSSProperties = {
    ...sizeStyles[size],
    border: `1px solid ${hasError ? 'var(--color-error-500, #ef4444)' : isFocused || isOpen ? 'var(--color-primary-500, rgb(99, 102, 241))' : 'var(--color-border, rgba(255, 255, 255, 0.08))'}`,
    borderRadius: '0.375rem',
    background: disabled ? 'var(--color-surface-hover, #1e1e23)' : 'var(--color-surface, #16161a)',
    color: 'var(--color-text, #ececf0)',
    // The outline is replaced by the ring below, drawn while focused.
    outline: 'none',
    boxShadow: isFocused
      ? `0 0 0 3px ${hasError ? 'rgba(239, 68, 68, 0.35)' : 'rgba(99, 102, 241, 0.35)'}`
      : undefined,
    width: fullWidth ? '100%' : '200px',
    paddingRight: selectedDate && interactive ? '2rem' : undefined,
    cursor: interactive ? 'pointer' : undefined,
    opacity: disabled ? 0.6 : undefined,
  };

  const calendarStyle: React.CSSProperties = {
    position: 'absolute',
    top: '100%',
    left: 0,
    marginTop: '0.25rem',
    padding: '0.75rem',
    background: 'var(--color-surface, #16161a)',
    color: 'var(--color-text, inherit)',
    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    borderRadius: '0.5rem',
    boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.3)',
    zIndex: 50,
    minWidth: '280px',
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '0.75rem',
  };

  const navButtonStyle: React.CSSProperties = {
    padding: '0.25rem 0.5rem',
    border: 'none',
    borderRadius: '0.25rem',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '1rem',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: '0.375rem',
    fontSize: '0.875rem',
    fontWeight: 500,
    color: 'var(--color-text, #ececf0)',
  };

  const errorStyle: React.CSSProperties = {
    marginTop: '0.25rem',
    fontSize: '0.75rem',
    color: 'var(--color-error-500, #ef4444)',
  };

  const today = startOfDay(new Date());
  const todayDisabled = isDateDisabled(today);

  return (
    <div
      ref={containerRef}
      className={className}
      style={containerStyle}
      onBlur={(e) => {
        // Tabbing out of the calendar closes it; it is not a modal.
        if (isOpen && !containerRef.current?.contains(e.relatedTarget as Node | null)) {
          setIsOpen(false);
        }
      }}
    >
      {label && (
        <label htmlFor={inputId} style={labelStyle}>
          {label}
          {required && (
            <span aria-hidden="true" style={{ color: 'var(--color-error-500, currentColor)' }}>
              {' '}
              *
            </span>
          )}
        </label>
      )}
      <div style={inputContainerStyle}>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          name={name}
          value={formatDateForDisplay(selectedDate, format)}
          placeholder={placeholder}
          disabled={disabled}
          readOnly
          required={required}
          onClick={() => (isOpen ? closeCalendar(false) : openCalendar())}
          onKeyDown={handleFieldKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          onChange={handleInputChange}
          style={inputStyle}
          aria-haspopup={interactive ? 'dialog' : undefined}
          aria-expanded={interactive ? isOpen : undefined}
          aria-controls={isOpen ? dialogId : undefined}
          aria-required={required || undefined}
          aria-invalid={hasError}
          aria-describedby={errorMessage ? errorId : undefined}
        />
        {/*
          A read-only input is barred from constraint validation, so `required`
          on the field above never stopped a form submitting without a date.
          This twin carries the requirement: empty while the field is, it is
          what the browser reports as missing, and focus it receives goes on
          to the real field.
        */}
        {required && interactive && (
          <input
            tabIndex={-1}
            aria-hidden="true"
            required
            value={formatDateForInput(selectedDate)}
            onChange={() => {}}
            onFocus={() => inputRef.current?.focus()}
            style={{
              position: 'absolute',
              left: 0,
              bottom: 0,
              width: 1,
              height: 1,
              opacity: 0,
              padding: 0,
              border: 0,
              pointerEvents: 'none',
            }}
          />
        )}
        {selectedDate && interactive && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear date"
            style={{
              position: 'absolute',
              right: '0.5rem',
              top: '50%',
              transform: 'translateY(-50%)',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--color-text-muted, #a1a1aa)',
              fontSize: '1rem',
              padding: '0.25rem',
            }}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>

      {isOpen && interactive && (
        <div
          id={dialogId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          style={calendarStyle}
          onKeyDown={handleDialogKeyDown}
        >
          <div style={headerStyle}>
            <div style={{ display: 'flex', gap: '0.25rem' }}>
              <button
                type="button"
                style={navButtonStyle}
                onClick={() => navigateYear(-1)}
                aria-label="Previous year"
              >
                <span aria-hidden="true">««</span>
              </button>
              <button
                type="button"
                style={navButtonStyle}
                onClick={() => navigateMonth(-1)}
                aria-label="Previous month"
              >
                <span aria-hidden="true">«</span>
              </button>
            </div>
            <span id={headingId} aria-live="polite" style={{ fontWeight: 500 }}>
              {MONTHS[viewDate.getMonth()]} {viewDate.getFullYear()}
            </span>
            <div style={{ display: 'flex', gap: '0.25rem' }}>
              <button
                type="button"
                style={navButtonStyle}
                onClick={() => navigateMonth(1)}
                aria-label="Next month"
              >
                <span aria-hidden="true">»</span>
              </button>
              <button
                type="button"
                style={navButtonStyle}
                onClick={() => navigateYear(1)}
                aria-label="Next year"
              >
                <span aria-hidden="true">»»</span>
              </button>
            </div>
          </div>

          <div
            ref={gridRef}
            role="grid"
            aria-labelledby={headingId}
            onKeyDown={handleGridKeyDown}
            style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem' }}
          >
            <div role="row" style={{ ...weekStyle, marginBottom: '0.375rem' }}>
              {DAYS.map((day, index) => (
                <div
                  key={day}
                  role="columnheader"
                  aria-label={DAY_NAMES[index]}
                  style={{
                    width: '2rem',
                    height: '1.5rem',
                    textAlign: 'center',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    color: 'var(--color-text-muted, #a1a1aa)',
                  }}
                >
                  {day}
                </div>
              ))}
            </div>
            {renderCalendar()}
          </div>

          <div
            style={{
              marginTop: '0.75rem',
              paddingTop: '0.5rem',
              borderTop: '1px solid var(--color-border, #3f3f46)',
              textAlign: 'center',
            }}
          >
            <button
              type="button"
              onClick={() => handleDateSelect(today)}
              disabled={todayDisabled}
              style={{
                padding: '0.25rem 0.75rem',
                border: 'none',
                borderRadius: '0.25rem',
                background: 'var(--color-surface-raised, var(--color-surface-hover, #27272a))',
                color: 'var(--color-text, #e4e4e7)',
                cursor: todayDisabled ? 'not-allowed' : 'pointer',
                opacity: todayDisabled ? 0.5 : 1,
                fontSize: '0.875rem',
              }}
            >
              Today
            </button>
          </div>
        </div>
      )}

      {errorMessage && <div id={errorId} style={errorStyle}>{errorMessage}</div>}
    </div>
  );
}

export default DatePicker;
