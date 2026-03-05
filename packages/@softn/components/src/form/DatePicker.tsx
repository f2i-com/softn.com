/**
 * DatePicker Component
 *
 * A date input with calendar popup functionality.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

export interface DatePickerProps {
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

function parseDate(value: string | Date | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
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

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

export function DatePicker({
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
  const [selectedDate, setSelectedDate] = useState<Date | null>(
    parseDate(value) ?? parseDate(defaultValue)
  );
  const [isOpen, setIsOpen] = useState(false);
  const [viewDate, setViewDate] = useState(selectedDate || new Date());
  const containerRef = useRef<HTMLDivElement>(null);

  const minDate = parseDate(min);
  const maxDate = parseDate(max);
  const hasError = Boolean(error);
  const errorMessage = typeof error === 'string' ? error : undefined;

  useEffect(() => {
    const newDate = parseDate(value);
    if (newDate) {
      setSelectedDate(newDate);
      setViewDate(newDate);
    }
  }, [value]);

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

  const handleDateSelect = useCallback(
    (date: Date) => {
      setSelectedDate(date);
      setIsOpen(false);
      onChange?.(date, formatDateForInput(date));
    },
    [onChange]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const date = parseDate(e.target.value);
      setSelectedDate(date);
      if (date) {
        setViewDate(date);
      }
      onChange?.(date, e.target.value);
    },
    [onChange]
  );

  const handleClear = useCallback(() => {
    setSelectedDate(null);
    onChange?.(null, '');
  }, [onChange]);

  const navigateMonth = useCallback((delta: number) => {
    setViewDate((prev) => {
      const newDate = new Date(prev);
      newDate.setMonth(newDate.getMonth() + delta);
      return newDate;
    });
  }, []);

  const navigateYear = useCallback((delta: number) => {
    setViewDate((prev) => {
      const newDate = new Date(prev);
      newDate.setFullYear(newDate.getFullYear() + delta);
      return newDate;
    });
  }, []);

  const isDateDisabled = useCallback(
    (date: Date): boolean => {
      if (minDate && date < minDate) return true;
      if (maxDate && date > maxDate) return true;
      return false;
    },
    [minDate, maxDate]
  );

  const isSelectedDate = useCallback(
    (date: Date): boolean => {
      if (!selectedDate) return false;
      return date.toDateString() === selectedDate.toDateString();
    },
    [selectedDate]
  );

  const isToday = useCallback((date: Date): boolean => {
    return date.toDateString() === new Date().toDateString();
  }, []);

  // Generate calendar days
  const renderCalendar = () => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const daysInMonth = getDaysInMonth(year, month);
    const firstDay = getFirstDayOfMonth(year, month);

    const days: React.ReactNode[] = [];

    // Empty cells for days before the first day
    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} style={{ width: '2rem', height: '2rem' }} />);
    }

    // Days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day);
      const isDisabled = isDateDisabled(date);
      const isSelected = isSelectedDate(date);
      const isTodayDate = isToday(date);

      days.push(
        <button
          key={day}
          type="button"
          onClick={() => !isDisabled && handleDateSelect(date)}
          disabled={isDisabled}
          style={{
            width: '2rem',
            height: '2rem',
            border: 'none',
            borderRadius: '0.25rem',
            background: isSelected ? 'var(--color-primary-500, #6366f1)' : isTodayDate ? 'var(--color-primary-500, rgba(99, 102, 241, 0.15))' : 'transparent',
            color: isSelected ? 'var(--color-surface, #16161a)' : isDisabled ? 'var(--color-text-muted, #a1a1aa)' : 'var(--color-text, #ececf0)',
            cursor: isDisabled ? 'not-allowed' : 'pointer',
            fontWeight: isTodayDate ? 600 : 400,
            fontSize: '0.875rem',
          }}
        >
          {day}
        </button>
      );
    }

    return days;
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
    border: `1px solid ${hasError ? '#ef4444' : 'var(--color-border, rgba(255, 255, 255, 0.08))'}`,
    borderRadius: '0.375rem',
    background: disabled ? 'var(--color-gray-800, #1e1e23)' : 'var(--color-surface, #16161a)',
    color: 'var(--color-text, #ececf0)',
    outline: 'none',
    width: fullWidth ? '100%' : '200px',
    cursor: readOnly ? 'pointer' : undefined,
  };

  const calendarStyle: React.CSSProperties = {
    position: 'absolute',
    top: '100%',
    left: 0,
    marginTop: '0.25rem',
    padding: '0.75rem',
    background: 'var(--color-surface, #16161a)',
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
    color: '#ef4444',
  };

  return (
    <div ref={containerRef} className={className} style={containerStyle}>
      {label && <label style={labelStyle}>{label}</label>}
      <div style={inputContainerStyle}>
        <input
          type="text"
          name={name}
          value={formatDateForDisplay(selectedDate, format)}
          placeholder={placeholder}
          disabled={disabled}
          readOnly
          required={required}
          onClick={() => !disabled && !readOnly && setIsOpen(true)}
          onChange={handleInputChange}
          style={inputStyle}
        />
        {selectedDate && !disabled && !readOnly && (
          <button
            type="button"
            onClick={handleClear}
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
            ×
          </button>
        )}
      </div>

      {isOpen && !disabled && !readOnly && (
        <div style={calendarStyle}>
          <div style={headerStyle}>
            <div style={{ display: 'flex', gap: '0.25rem' }}>
              <button type="button" style={navButtonStyle} onClick={() => navigateYear(-1)}>
                ««
              </button>
              <button type="button" style={navButtonStyle} onClick={() => navigateMonth(-1)}>
                «
              </button>
            </div>
            <span style={{ fontWeight: 500 }}>
              {MONTHS[viewDate.getMonth()]} {viewDate.getFullYear()}
            </span>
            <div style={{ display: 'flex', gap: '0.25rem' }}>
              <button type="button" style={navButtonStyle} onClick={() => navigateMonth(1)}>
                »
              </button>
              <button type="button" style={navButtonStyle} onClick={() => navigateYear(1)}>
                »»
              </button>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(7, 1fr)',
              gap: '0.125rem',
              marginBottom: '0.5rem',
            }}
          >
            {DAYS.map((day) => (
              <div
                key={day}
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

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '0.125rem' }}>
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
              onClick={() => handleDateSelect(new Date())}
              style={{
                padding: '0.25rem 0.75rem',
                border: 'none',
                borderRadius: '0.25rem',
                background: 'var(--color-surface-raised, #27272a)',
                color: 'var(--color-text, #e4e4e7)',
                cursor: 'pointer',
                fontSize: '0.875rem',
              }}
            >
              Today
            </button>
          </div>
        </div>
      )}

      {errorMessage && <div style={errorStyle}>{errorMessage}</div>}
    </div>
  );
}

export default DatePicker;
