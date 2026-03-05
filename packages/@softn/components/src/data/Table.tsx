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
  columns,
  data,
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
  className,
  style,
}: TableProps<T>): React.ReactElement {
  const sizes = sizeStyles[size];

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
    cursor: column.sortable ? 'pointer' : 'default',
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

  // Handle keyboard navigation on sortable headers
  const handleHeaderKeyDown = (e: React.KeyboardEvent, column: Column<T>) => {
    if (column.sortable && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      handleSort(column);
    }
  };

  const SortIcon = ({ column }: { column: Column<T> }) => {
    if (!column.sortable) return null;
    const isActive = sortColumn === column.key;
    const isAsc = isActive && sortDirection === 'asc';
    const isDesc = isActive && sortDirection === 'desc';

    return (
      <span
        style={{ marginLeft: '0.25rem', display: 'inline-flex', flexDirection: 'column' }}
        aria-hidden="true"
      >
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          fill={isAsc ? '#6366f1' : '#a1a1aa'}
          style={{ marginBottom: '-2px' }}
        >
          <path d="M4 0L8 4H0L4 0Z" />
        </svg>
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          fill={isDesc ? '#6366f1' : '#a1a1aa'}
          style={{ marginTop: '-2px' }}
        >
          <path d="M4 8L0 4H8L4 8Z" />
        </svg>
      </span>
    );
  };

  const TableRow = ({ row, index }: { row: T; index: number }) => {
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
        tabIndex={onRowClick ? 0 : undefined}
        role={onRowClick ? 'button' : undefined}
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
  };

  return (
    <div className={className} style={containerStyle} role="region" aria-label="Data table">
      <table style={tableStyle} role="table">
        <thead role="rowgroup">
          <tr style={headerRowStyle} role="row">
            {columns.map((column) => (
              <th
                key={column.key}
                style={getHeaderCellStyle(column)}
                onClick={() => handleSort(column)}
                onKeyDown={(e) => handleHeaderKeyDown(e, column)}
                tabIndex={column.sortable ? 0 : undefined}
                role="columnheader"
                aria-sort={getAriaSort(column)}
                scope="col"
              >
                {column.header}
                <SortIcon column={column} />
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
              <TableRow key={getRowKey(row, index)} row={row} index={index} />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default Table;
