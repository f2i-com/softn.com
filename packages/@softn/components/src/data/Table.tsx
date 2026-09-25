/**
 * Table Component
 *
 * A data table with sorting and styling options.
 */

import React from 'react';

export interface Column<T> {
  /** Column key (maps to data property) */
  key: string;
  /** Column header */
  header: string;
  /** Column width */
  width?: string | number;
  /** Text alignment */
  align?: 'left' | 'center' | 'right';
  /** Whether column is sortable */
  sortable?: boolean;
  /** Custom render function */
  render?: (value: unknown, row: T, index: number) => React.ReactNode;
}

/**
 * A single row.
 *
 * Declared at module scope, not inside `Table`.
 *
 * A component defined in another component's body is a new *type* on every
 * render, so React cannot match it against the previous tree — it unmounts and
 * remounts the whole subtree rather than updating it. With a column rendering
 * an `<input>`, that destroyed and rebuilt the field on every parent render:
 * typing one character lost the caret and the focus, which reads as the table
 * fighting the user.
 */
function TableRow<T extends Record<string, unknown>>({
  row,
  index,
  columns,
  onRowClick,
  getRowStyle,
  getBodyCellStyle,
}: {
  row: T;
  index: number;
  columns: Column<T>[];
  onRowClick?: (row: T, index: number) => void;
  getRowStyle: (index: number, isHovered: boolean) => React.CSSProperties;
  getBodyCellStyle: (column: Column<T>) => React.CSSProperties;
}): React.ReactElement {
  const [isHovered, setIsHovered] = React.useState(false);

  const handleRowKeyDown = (e: React.KeyboardEvent) => {
    if (onRowClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onRowClick(row, index);
    }
  };

  return (
    <tr
      style={getRowStyle(index, isHovered)}
      onClick={() => onRowClick?.(row, index)}
      onKeyDown={onRowClick ? handleRowKeyDown : undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      // Focusable and activated with Enter or Space, but still a row: a
      // `role="button"` here took the row out of the table, and its cells
      // with it, for anyone reading by table navigation.
      tabIndex={onRowClick ? 0 : undefined}
    >
      {columns.map((column) => (
        <td key={column.key} style={getBodyCellStyle(column)} role="cell">
          {column.render
            ? column.render(row[column.key], row, index)
            : String(row[column.key] ?? '')}
        </td>
      ))}
    </tr>
  );
}

/** The sort arrows in a header. Module scope, so it is updated, not remounted. */
function SortIcon({ active, direction }: { active: boolean; direction?: 'asc' | 'desc' }): React.ReactElement {
  const on = 'var(--color-primary-500, #6366f1)';
  const off = 'var(--color-text-muted, #a1a1aa)';
  return (
    <span
      style={{ marginLeft: '0.25rem', display: 'inline-flex', flexDirection: 'column', verticalAlign: 'middle' }}
      aria-hidden="true"
    >
      <svg width="8" height="8" viewBox="0 0 8 8" fill={active && direction === 'asc' ? on : off} style={{ marginBottom: '-2px' }}>
        <path d="M4 0L8 4H0L4 0Z" />
      </svg>
      <svg width="8" height="8" viewBox="0 0 8 8" fill={active && direction === 'desc' ? on : off} style={{ marginTop: '-2px' }}>
        <path d="M4 8L0 4H8L4 8Z" />
      </svg>
    </span>
  );
}

export interface TableProps<T> {
  /** Table columns */
  columns: Column<T>[];
  /** Table data */
  data: T[];
  /** Row key field */
  rowKey?: string | ((row: T, index: number) => string);
  /** Table variant */
  variant?: 'default' | 'striped' | 'bordered';
  /** Table size */
  size?: 'sm' | 'md' | 'lg';
  /** Whether header is sticky */
  stickyHeader?: boolean;
  /** Whether rows are hoverable */
  hoverable?: boolean;
  /** Row click handler */
  onRowClick?: (row: T, index: number) => void;
  /** Current sort column */
  sortColumn?: string;
  /** Sort direction */
  sortDirection?: 'asc' | 'desc';
  /** Sort change handler */
  onSort?: (column: string, direction: 'asc' | 'desc') => void;
  /** Empty state content */
  emptyContent?: React.ReactNode;
  /** Visible caption naming the table */
  caption?: React.ReactNode;
  /** Accessible name for the table (default: the caption, else "Data table") */
  ariaLabel?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeStyles: Record<string, { cell: string; header: string }> = {
  sm: { cell: '0.5rem 0.75rem', header: '0.5rem 0.75rem' },
  md: { cell: '0.75rem 1rem', header: '0.75rem 1rem' },
  lg: { cell: '1rem 1.25rem', header: '1rem 1.25rem' },
};

export function Table<T extends Record<string, unknown>>({
  columns: rawColumns,
  data: rawData,
  rowKey = 'id',
  variant = 'default',
  size = 'md',
  stickyHeader = false,
  hoverable = true,
  onRowClick,
  sortColumn,
  sortDirection,
  onSort,
  emptyContent = 'No data available',
  caption,
  ariaLabel,
  className,
  style,
}: TableProps<T>): React.ReactElement {
  const sizes = sizeStyles[size] ?? sizeStyles.md;
  // Bound to rows that have not arrived, the table is empty, not an error.
  const data = Array.isArray(rawData) ? rawData : [];
  const columns = Array.isArray(rawColumns) ? rawColumns : [];
  const captionId = React.useId();

  const getRowKey = (row: T, index: number): string => {
    if (typeof rowKey === 'function') {
      return rowKey(row, index);
    }
    return String(row[rowKey] ?? index);
  };

  const handleSort = (column: Column<T>) => {
    if (!column.sortable || !onSort) return;

    const newDirection = sortColumn === column.key && sortDirection === 'asc' ? 'desc' : 'asc';
    onSort(column.key, newDirection);
  };

  const containerStyle: React.CSSProperties = {
    width: '100%',
    overflow: 'auto',
    ...style,
  };

  const tableStyle: React.CSSProperties = {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: size === 'sm' ? '0.875rem' : '1rem',
    ...(variant === 'bordered' && {
      border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    }),
  };

  const headerRowStyle: React.CSSProperties = {
    backgroundColor: 'var(--color-gray-50, #1e1e23)',
    ...(stickyHeader && {
      position: 'sticky',
      top: 0,
      zIndex: 1,
    }),
  };

  const getHeaderCellStyle = (column: Column<T>): React.CSSProperties => ({
    padding: sizes.header,
    textAlign: column.align ?? 'left',
    fontWeight: 600,
    color: 'var(--color-text, #ececf0)',
    borderBottom: '2px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    width: column.width,
    userSelect: column.sortable ? 'none' : 'auto',
    whiteSpace: 'nowrap',
    ...(variant === 'bordered' && {
      borderRight: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    }),
  });

  const getBodyCellStyle = (column: Column<T>): React.CSSProperties => ({
    padding: sizes.cell,
    textAlign: column.align ?? 'left',
    color: 'var(--color-text, #ececf0)',
    borderBottom: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    ...(variant === 'bordered' && {
      borderRight: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    }),
  });

  const getRowStyle = (index: number, isHovered: boolean): React.CSSProperties => ({
    backgroundColor:
      isHovered && hoverable
        ? 'var(--color-gray-100, rgba(255, 255, 255, 0.04))'
        : variant === 'striped' && index % 2 === 1
          ? 'var(--color-gray-50, #1e1e23)'
          : 'transparent',
    cursor: onRowClick ? 'pointer' : 'default',
    transition: 'background-color 180ms cubic-bezier(0.16, 1, 0.3, 1)',
  });

  const emptyStyle: React.CSSProperties = {
    padding: '2rem',
    textAlign: 'center',
    color: 'var(--color-text-muted, #a1a1aa)',
  };

  // Get aria-sort value for sortable columns
  const getAriaSort = (column: Column<T>): 'ascending' | 'descending' | 'none' | undefined => {
    if (!column.sortable) return undefined;
    if (sortColumn === column.key) {
      return sortDirection === 'asc' ? 'ascending' : 'descending';
    }
    return 'none';
  };

  return (
    <div
      className={className}
      style={containerStyle}
      role="region"
      aria-label={ariaLabel ?? (caption ? undefined : 'Data table')}
      aria-labelledby={ariaLabel || !caption ? undefined : captionId}
      // A scrolling region is focusable so its overflow can be scrolled from the keyboard.
      tabIndex={0}
    >
      <table style={tableStyle} role="table" aria-label={ariaLabel} aria-labelledby={ariaLabel || !caption ? undefined : captionId}>
        {caption && (
          <caption id={captionId} style={{ textAlign: 'left', padding: '0.5rem 0', color: 'var(--color-text, inherit)', fontWeight: 600 }}>
            {caption}
          </caption>
        )}
        <thead role="rowgroup">
          <tr style={headerRowStyle} role="row">
            {columns.map((column) => (
              <th
                key={column.key}
                style={getHeaderCellStyle(column)}
                role="columnheader"
                aria-sort={getAriaSort(column)}
                scope="col"
              >
                {column.sortable ? (
                  <button
                    type="button"
                    onClick={() => handleSort(column)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: 0,
                      margin: 0,
                      border: 0,
                      background: 'transparent',
                      color: 'inherit',
                      font: 'inherit',
                      textAlign: 'inherit',
                      cursor: 'pointer',
                    }}
                  >
                    {column.header}
                    <SortIcon active={sortColumn === column.key} direction={sortDirection} />
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {data.length === 0 ? (
            <tr role="row">
              <td colSpan={columns.length} style={emptyStyle} role="cell">
                {emptyContent}
              </td>
            </tr>
          ) : (
            data.map((row, index) => (
              <TableRow
                key={getRowKey(row, index)}
                row={row}
                index={index}
                columns={columns}
                onRowClick={onRowClick}
                getRowStyle={getRowStyle}
                getBodyCellStyle={getBodyCellStyle}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default Table;
