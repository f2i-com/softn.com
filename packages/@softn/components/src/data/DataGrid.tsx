/**
 * DataGrid Component
 *
 * Advanced data grid with virtual scrolling, filtering, and inline editing support.
 */

import * as React from 'react';

/**
 * A row, when nothing more specific is known about it. The grid is usually fed
 * a document's data at run time, so a cell's value is `unknown` until a
 * column's `render` or `editor` says what it is.
 */
type Row = Record<string, unknown>;


export interface DataGridColumn<T = Row> {
  key: string;
  header: React.ReactNode;
  width?: number | string;
  minWidth?: number;
  maxWidth?: number;
  align?: 'left' | 'center' | 'right';
  sortable?: boolean;
  filterable?: boolean;
  editable?: boolean;
  frozen?: boolean;
  resizable?: boolean;
  accessor?: keyof T | ((row: T) => unknown);
  render?: (value: unknown, row: T, index: number) => React.ReactNode;
  editor?: (props: CellEditorProps<T>) => React.ReactNode;
  filterType?: 'text' | 'number' | 'select' | 'date';
  filterOptions?: { label: string; value: string | number }[];
}

/** What a cell's box depends on. The selection column has no data column
 * behind it, so its cells are styled from these alone. */
type ColumnLayout = Pick<DataGridColumn, 'align' | 'width' | 'minWidth' | 'maxWidth' | 'frozen' | 'sortable'>;

export interface CellEditorProps<T = Row> {
  value: unknown;
  row: T;
  column: DataGridColumn<T>;
  onSave: (value: unknown) => void;
  onCancel: () => void;
}

export interface DataGridProps<T = Row> {
  columns: DataGridColumn<T>[];
  data: T[];
  keyField?: keyof T | ((row: T) => string | number);
  height?: number | string;
  rowHeight?: number;
  headerHeight?: number;
  virtualized?: boolean;
  bordered?: boolean;
  striped?: boolean;
  hoverable?: boolean;
  sortKey?: string;
  sortDirection?: 'asc' | 'desc';
  onSort?: (key: string, direction: 'asc' | 'desc') => void;
  /** What was typed into each column's filter input, by column key. */
  filters?: Record<string, string | number>;
  onFilterChange?: (filters: Record<string, string | number>) => void;
  selectedKeys?: Set<string | number>;
  onSelectionChange?: (keys: Set<string | number>) => void;
  selectionMode?: 'none' | 'single' | 'multiple';
  onCellEdit?: (key: string | number, columnKey: string, value: unknown) => void;
  loading?: boolean;
  emptyMessage?: React.ReactNode;
  /** Accessible name for the grid */
  ariaLabel?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function DataGrid<T = Row>({
  columns,
  data: rawData,
  keyField = 'id' as keyof T,
  height = 400,
  rowHeight = 40,
  headerHeight = 44,
  virtualized = true,
  bordered = true,
  striped = false,
  hoverable = true,
  sortKey,
  sortDirection = 'asc',
  onSort,
  filters = {},
  onFilterChange,
  selectedKeys: controlledSelectedKeys,
  onSelectionChange,
  selectionMode = 'none',
  onCellEdit,
  loading = false,
  emptyMessage = 'No data available',
  ariaLabel,
  className = '',
  style,
}: DataGridProps<T>) {
  // A grid is routinely bound to rows that have not arrived: `data.length`
  // of undefined threw into the error boundary where an empty grid belonged.
  const data = React.useMemo(() => (Array.isArray(rawData) ? rawData : []), [rawData]);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [editingCell, setEditingCell] = React.useState<{
    rowKey: string | number;
    columnKey: string;
  } | null>(null);
  const [showFilters, setShowFilters] = React.useState(false);
  // Without `selectedKeys` the grid keeps its own selection, so a caller that
  // only listens through `onSelectionChange` still sees rows select.
  const [internalSelectedKeys, setInternalSelectedKeys] = React.useState<Set<string | number>>(() => new Set());
  const selectedKeys = controlledSelectedKeys ?? internalSelectedKeys;
  const setSelection = (next: Set<string | number>) => {
    if (!controlledSelectedKeys) setInternalSelectedKeys(next);
    onSelectionChange?.(next);
  };
  const selectAllRef = React.useRef<HTMLInputElement>(null);
  // A string height (`100%`, `60vh`) is measured, so virtual scrolling draws
  // enough rows to fill the box it actually got.
  const [measuredHeight, setMeasuredHeight] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (typeof height === 'number') return;
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setMeasuredHeight(element.clientHeight || null);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [height]);
  // Toggle filters (can be called externally via ref or used with a filter button)
  const toggleFilters = () => setShowFilters((prev) => !prev);

  const getRowKey = (row: T, index: number): string | number => {
    if (typeof keyField === 'function') {
      return keyField(row);
    }
    return (row[keyField] as string | number) ?? index;
  };

  const getCellValue = (row: T, column: DataGridColumn<T>): unknown => {
    if (column.accessor) {
      if (typeof column.accessor === 'function') {
        return column.accessor(row);
      }
      return row[column.accessor];
    }
    // A column's key is a string chosen at run time, so the row is read as the
    // keyed record it is in practice rather than through `T`, which may be any
    // shape at all.
    return (row as unknown as Row)[column.key];
  };

  // Virtual scrolling calculations. A row height of zero or less (or not a
  // number) would divide by zero; it is read as the default.
  const safeRowHeight = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 40;
  const totalHeight = data.length * safeRowHeight;
  const containerHeight = typeof height === 'number' ? height : (measuredHeight ?? 400);
  const visibleRows = Math.ceil(containerHeight / safeRowHeight) + 2;
  const startIndex = virtualized ? Math.min(Math.floor(scrollTop / safeRowHeight), Math.max(0, data.length - 1)) : 0;
  const endIndex = virtualized ? Math.min(startIndex + visibleRows, data.length) : data.length;
  const offsetY = virtualized ? startIndex * safeRowHeight : 0;

  const visibleData = virtualized ? data.slice(startIndex, endIndex) : data;

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (virtualized) {
      setScrollTop(e.currentTarget.scrollTop);
    }
  };

  const handleSort = (key: string) => {
    if (onSort) {
      const newDirection = sortKey === key && sortDirection === 'asc' ? 'desc' : 'asc';
      onSort(key, newDirection);
    }
  };

  const handleRowSelect = (rowKey: string | number) => {
    if (selectionMode === 'none') return;

    const newSelection = new Set(selectedKeys);
    if (selectionMode === 'single') {
      newSelection.clear();
      newSelection.add(rowKey);
    } else {
      if (newSelection.has(rowKey)) {
        newSelection.delete(rowKey);
      } else {
        newSelection.add(rowKey);
      }
    }
    setSelection(newSelection);
  };

  const handleCellDoubleClick = (
    rowKey: string | number,
    columnKey: string,
    column: DataGridColumn<T>
  ) => {
    if (column.editable && onCellEdit) {
      setEditingCell({ rowKey, columnKey });
    }
  };

  const allSelected = data.length > 0 && data.every((row, i) => selectedKeys.has(getRowKey(row, i)));
  const someSelected = !allSelected && data.some((row, i) => selectedKeys.has(getRowKey(row, i)));
  React.useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const filterToggle = !!onFilterChange && columns.some((c) => c.filterable);
  /** A column's name as text, for labels; a header that is not text falls back to the key. */
  const columnName = (column: DataGridColumn<T>) =>
    typeof column.header === 'string' || typeof column.header === 'number' ? String(column.header) : column.key;

  const handleCellSave = (value: unknown) => {
    if (editingCell && onCellEdit) {
      onCellEdit(editingCell.rowKey, editingCell.columnKey, value);
      setEditingCell(null);
    }
  };

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    height,
    overflow: 'auto',
    border: bordered ? '1px solid var(--color-border, rgba(255, 255, 255, 0.08))' : 'none',
    borderRadius: '4px',
    ...style,
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    backgroundColor: 'var(--color-gray-50, #1e1e23)',
    borderBottom: '2px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    minHeight: headerHeight,
  };

  const headerCellStyle = (column: ColumnLayout): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent:
      column.align === 'right' ? 'flex-end' : column.align === 'center' ? 'center' : 'flex-start',
    padding: '0 12px',
    fontWeight: 600,
    fontSize: '0.875rem',
    color: 'var(--color-text, #ececf0)',
    width: column.width ?? 150,
    minWidth: column.minWidth ?? 80,
    maxWidth: column.maxWidth,
    flexShrink: column.frozen ? 0 : 1,
    flexGrow: column.width ? 0 : 1,
    borderRight: bordered ? '1px solid var(--color-border, rgba(255, 255, 255, 0.08))' : 'none',
    cursor: column.sortable ? 'pointer' : 'default',
    userSelect: 'none',
    ...(column.frozen && {
      position: 'sticky',
      left: 0,
      backgroundColor: 'var(--color-gray-50, #1e1e23)',
      zIndex: 1,
    }),
  });

  const rowStyle = (index: number, isSelected: boolean): React.CSSProperties => ({
    display: 'flex',
    minHeight: rowHeight,
    backgroundColor: isSelected ? 'var(--color-primary-50, rgba(99, 102, 241, 0.1))' : striped && index % 2 === 1 ? 'var(--color-gray-50, #1e1e23)' : 'var(--color-surface, #16161a)',
    borderBottom: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    transition: 'background-color 180ms cubic-bezier(0.16, 1, 0.3, 1)',
  });

  const cellStyle = (column: ColumnLayout): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent:
      column.align === 'right' ? 'flex-end' : column.align === 'center' ? 'center' : 'flex-start',
    padding: '0 12px',
    fontSize: '0.875rem',
    color: 'var(--color-text, #ececf0)',
    width: column.width ?? 150,
    minWidth: column.minWidth ?? 80,
    maxWidth: column.maxWidth,
    flexShrink: column.frozen ? 0 : 1,
    flexGrow: column.width ? 0 : 1,
    borderRight: bordered ? '1px solid var(--color-border, rgba(255, 255, 255, 0.08))' : 'none',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    ...(column.frozen && {
      position: 'sticky',
      left: 0,
      backgroundColor: 'inherit',
      zIndex: 1,
    }),
  });

  const getSortIcon = (key: string) => {
    if (sortKey !== key) return null;
    return (
      <span aria-hidden="true">{sortDirection === 'asc' ? '\u2191' : '\u2193'}</span>
    );
  };

  /** The filter toggle's column, mirrored in every row so the columns line up. */
  const toggleCellStyle: React.CSSProperties = {
    width: 44,
    minWidth: 44,
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <div
      ref={containerRef}
      role="table"
      aria-label={ariaLabel}
      aria-rowcount={data.length + 1}
      aria-busy={loading || undefined}
      className={`softn-data-grid ${className}`}
      style={containerStyle}
      onScroll={handleScroll}
    >
      {/* Header */}
      <div role="rowgroup" style={{ position: 'sticky', top: 0, zIndex: 2 }}>
      <div role="row" aria-rowindex={1} style={headerStyle}>
        {selectionMode === 'multiple' && (
          <div role="columnheader" style={{ ...headerCellStyle({}), width: 40, minWidth: 40, flexGrow: 0 }}>
            <input
              ref={selectAllRef}
              type="checkbox"
              aria-label="Select all rows"
              checked={allSelected}
              onChange={() => {
                setSelection(allSelected ? new Set() : new Set(data.map((row, i) => getRowKey(row, i))));
              }}
            />
          </div>
        )}
        {columns.map((column) => {
          const sorted = column.sortable && sortKey === column.key;
          return (
            <div
              key={column.key}
              role="columnheader"
              aria-sort={column.sortable ? (sorted ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
              style={headerCellStyle(column)}
            >
              {column.sortable ? (
                <button
                  type="button"
                  onClick={() => handleSort(column.key)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: 0,
                    margin: 0,
                    border: 0,
                    background: 'transparent',
                    color: 'inherit',
                    font: 'inherit',
                    cursor: 'pointer',
                    textAlign: 'inherit',
                  }}
                >
                  {column.header}
                  {getSortIcon(column.key)}
                </button>
              ) : (
                column.header
              )}
            </div>
          );
        })}
        {/* Filter toggle button */}
        {filterToggle && (
          <div style={toggleCellStyle}>
            <button
              type="button"
              onClick={toggleFilters}
              aria-label={showFilters ? 'Hide filters' : 'Show filters'}
              aria-pressed={showFilters}
              style={{
                padding: '4px 8px',
                border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
                borderRadius: '4px',
                backgroundColor: showFilters ? 'var(--color-primary-50, rgba(99, 102, 241, 0.1))' : 'var(--color-surface, #16161a)',
                color: 'var(--color-text, inherit)',
                cursor: 'pointer',
                fontSize: '0.75rem',
                display: 'flex',
                alignItems: 'center',
              }}
              title={showFilters ? 'Hide filters' : 'Show filters'}
            >
              <span aria-hidden="true">{'\u2699'}</span>
            </button>
          </div>
        )}
      </div>

      {/* Filter Row: inside the sticky header group, so it scrolls with the header rather than under it */}
      {showFilters && onFilterChange && (
        <div style={{ ...headerStyle, backgroundColor: 'var(--color-surface, #16161a)', borderBottom: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))' }}>
          {selectionMode === 'multiple' && (
            <div style={{ ...cellStyle({}), width: 40, minWidth: 40, flexGrow: 0 }} />
          )}
          {columns.map((column) => (
            <div key={column.key} style={cellStyle(column)}>
              {column.filterable && (
                <input
                  type={column.filterType === 'number' ? 'number' : 'text'}
                  aria-label={`Filter ${columnName(column)}`}
                  placeholder={`Filter ${columnName(column)}...`}
                  value={filters[column.key] ?? ''}
                  onChange={(e) => onFilterChange({ ...filters, [column.key]: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '4px 8px',
                    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    background: 'var(--color-bg, transparent)',
                    color: 'var(--color-text, inherit)',
                  }}
                />
              )}
            </div>
          ))}
          {filterToggle && <div style={toggleCellStyle} />}
        </div>
      )}
      </div>

      {/* Body */}
      {loading ? (
        <div role="status" style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-muted, #a1a1aa)' }}>Loading...</div>
      ) : data.length === 0 ? (
        <div role="row"><div role="cell" style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-muted, #a1a1aa)' }}>{emptyMessage}</div></div>
      ) : (
        <div role="rowgroup" style={{ position: 'relative', height: virtualized ? totalHeight : 'auto' }}>
          <div style={{ position: 'absolute', top: offsetY, left: 0, right: 0 }}>
            {visibleData.map((row, idx) => {
              const actualIndex = startIndex + idx;
              const rowKey = getRowKey(row, actualIndex);
              const isSelected = selectedKeys.has(rowKey);

              return (
                <div
                  key={rowKey}
                  role="row"
                  aria-rowindex={actualIndex + 2}
                  aria-selected={selectionMode === 'none' ? undefined : isSelected}
                  tabIndex={selectionMode === 'single' ? 0 : undefined}
                  style={rowStyle(actualIndex, isSelected)}
                  onClick={() => handleRowSelect(rowKey)}
                  onKeyDown={(e) => {
                    if (selectionMode !== 'single' || e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleRowSelect(rowKey);
                    }
                  }}
                  onMouseEnter={(e) => {
                    if (hoverable && !isSelected) {
                      e.currentTarget.style.backgroundColor = 'var(--color-gray-100, rgba(255, 255, 255, 0.04))';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (hoverable && !isSelected) {
                      e.currentTarget.style.backgroundColor =
                        striped && actualIndex % 2 === 1 ? 'var(--color-gray-50, #1e1e23)' : 'var(--color-surface, #16161a)';
                    }
                  }}
                >
                  {selectionMode === 'multiple' && (
                    <div role="cell" style={{ ...cellStyle({}), width: 40, minWidth: 40, flexGrow: 0 }}>
                      <input
                        type="checkbox"
                        aria-label={`Select row ${actualIndex + 1}`}
                        checked={isSelected}
                        onChange={() => handleRowSelect(rowKey)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  )}
                  {columns.map((column) => {
                    const value = getCellValue(row, column);
                    const isEditing =
                      editingCell?.rowKey === rowKey && editingCell?.columnKey === column.key;
                    const canEdit = !!column.editable && !!onCellEdit && !isEditing;

                    return (
                      <div
                        key={column.key}
                        role="cell"
                        style={cellStyle(column)}
                        tabIndex={canEdit ? 0 : undefined}
                        aria-description={canEdit ? 'Press Enter to edit' : undefined}
                        onDoubleClick={() => handleCellDoubleClick(rowKey, column.key, column)}
                        onKeyDown={(e) => {
                          if (!canEdit || e.target !== e.currentTarget) return;
                          if (e.key === 'Enter' || e.key === 'F2') {
                            e.preventDefault();
                            e.stopPropagation();
                            handleCellDoubleClick(rowKey, column.key, column);
                          }
                        }}
                      >
                        {isEditing && column.editor
                          ? column.editor({
                              value,
                              row,
                              column,
                              onSave: handleCellSave,
                              onCancel: () => setEditingCell(null),
                            })
                          : column.render
                            ? column.render(value, row, actualIndex)
                            : String(value ?? '')}
                      </div>
                    );
                  })}
                  {filterToggle && <div style={toggleCellStyle} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default DataGrid;
