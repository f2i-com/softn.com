/**
 * DataGrid Component
 *
 * Advanced data grid with virtual scrolling, filtering, and inline editing support.
 */

import * as React from 'react';

export interface DataGridColumn<T = any> {
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
  accessor?: keyof T | ((row: T) => any);
  render?: (value: any, row: T, index: number) => React.ReactNode;
  editor?: (props: CellEditorProps<T>) => React.ReactNode;
  filterType?: 'text' | 'number' | 'select' | 'date';
  filterOptions?: { label: string; value: any }[];
}

export interface CellEditorProps<T = any> {
  value: any;
  row: T;
  column: DataGridColumn<T>;
  onSave: (value: any) => void;
  onCancel: () => void;
}

export interface DataGridProps<T = any> {
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
  filters?: Record<string, any>;
  onFilterChange?: (filters: Record<string, any>) => void;
  selectedKeys?: Set<string | number>;
  onSelectionChange?: (keys: Set<string | number>) => void;
  selectionMode?: 'none' | 'single' | 'multiple';
  onCellEdit?: (key: string | number, columnKey: string, value: any) => void;
  loading?: boolean;
  emptyMessage?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function DataGrid<T = any>({
  columns,
  data,
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
  selectedKeys = new Set(),
  onSelectionChange,
  selectionMode = 'none',
  onCellEdit,
  loading = false,
  emptyMessage = 'No data available',
  className = '',
  style,
}: DataGridProps<T>) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [editingCell, setEditingCell] = React.useState<{
    rowKey: string | number;
    columnKey: string;
  } | null>(null);
  const [showFilters, setShowFilters] = React.useState(false);
  // Toggle filters (can be called externally via ref or used with a filter button)
  const toggleFilters = () => setShowFilters((prev) => !prev);

  const getRowKey = (row: T, index: number): string | number => {
    if (typeof keyField === 'function') {
      return keyField(row);
    }
    return (row[keyField] as string | number) ?? index;
  };

  const getCellValue = (row: T, column: DataGridColumn<T>): any => {
    if (column.accessor) {
      if (typeof column.accessor === 'function') {
        return column.accessor(row);
      }
      return row[column.accessor];
    }
    return (row as any)[column.key];
  };

  // Virtual scrolling calculations
  const totalHeight = data.length * rowHeight;
  const containerHeight = typeof height === 'number' ? height : 400;
  const visibleRows = Math.ceil(containerHeight / rowHeight) + 2;
  const startIndex = virtualized ? Math.floor(scrollTop / rowHeight) : 0;
  const endIndex = virtualized ? Math.min(startIndex + visibleRows, data.length) : data.length;
  const offsetY = virtualized ? startIndex * rowHeight : 0;

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
    if (selectionMode === 'none' || !onSelectionChange) return;

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
    onSelectionChange(newSelection);
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

  const handleCellSave = (value: any) => {
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
    position: 'sticky',
    top: 0,
    zIndex: 2,
    display: 'flex',
    backgroundColor: 'var(--color-gray-50, #1e1e23)',
    borderBottom: '2px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    minHeight: headerHeight,
  };

  const headerCellStyle = (column: DataGridColumn<T>): React.CSSProperties => ({
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

  const cellStyle = (column: DataGridColumn<T>): React.CSSProperties => ({
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
      <span style={{ marginLeft: '4px' }}>{sortDirection === 'asc' ? '\u2191' : '\u2193'}</span>
    );
  };

  return (
    <div
      ref={containerRef}
      className={`softn-data-grid ${className}`}
      style={containerStyle}
      onScroll={handleScroll}
    >
      {/* Header */}
      <div style={headerStyle}>
        {selectionMode === 'multiple' && (
          <div style={{ ...headerCellStyle({} as any), width: 40, minWidth: 40, flexGrow: 0 }}>
            <input
              type="checkbox"
              checked={data.length > 0 && selectedKeys.size === data.length}
              onChange={() => {
                if (onSelectionChange) {
                  if (selectedKeys.size === data.length) {
                    onSelectionChange(new Set());
                  } else {
                    onSelectionChange(new Set(data.map((row, i) => getRowKey(row, i))));
                  }
                }
              }}
            />
          </div>
        )}
        {columns.map((column) => (
          <div
            key={column.key}
            style={headerCellStyle(column)}
            onClick={() => column.sortable && handleSort(column.key)}
          >
            {column.header}
            {column.sortable && getSortIcon(column.key)}
          </div>
        ))}
        {/* Filter toggle button */}
        {onFilterChange && columns.some((c) => c.filterable) && (
          <button
            onClick={toggleFilters}
            style={{
              padding: '4px 8px',
              margin: '0 8px',
              border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
              borderRadius: '4px',
              backgroundColor: showFilters ? 'var(--color-primary-50, rgba(99, 102, 241, 0.1))' : 'var(--color-surface, #16161a)',
              cursor: 'pointer',
              fontSize: '0.75rem',
              display: 'flex',
              alignItems: 'center',
              flexShrink: 0,
            }}
            title={showFilters ? 'Hide filters' : 'Show filters'}
          >
            {'\u2699'}
          </button>
        )}
      </div>

      {/* Filter Row */}
      {showFilters && onFilterChange && (
        <div style={{ ...headerStyle, backgroundColor: 'var(--color-surface, #16161a)', borderBottom: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))' }}>
          {selectionMode === 'multiple' && (
            <div style={{ ...cellStyle({} as any), width: 40, minWidth: 40, flexGrow: 0 }} />
          )}
          {columns.map((column) => (
            <div key={column.key} style={cellStyle(column)}>
              {column.filterable && (
                <input
                  type={column.filterType === 'number' ? 'number' : 'text'}
                  placeholder={`Filter ${column.header}...`}
                  value={filters[column.key] ?? ''}
                  onChange={(e) => onFilterChange({ ...filters, [column.key]: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '4px 8px',
                    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Body */}
      {loading ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-muted, #a1a1aa)' }}>Loading...</div>
      ) : data.length === 0 ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-muted, #a1a1aa)' }}>{emptyMessage}</div>
      ) : (
        <div style={{ position: 'relative', height: virtualized ? totalHeight : 'auto' }}>
          <div style={{ position: 'absolute', top: offsetY, left: 0, right: 0 }}>
            {visibleData.map((row, idx) => {
              const actualIndex = startIndex + idx;
              const rowKey = getRowKey(row, actualIndex);
              const isSelected = selectedKeys.has(rowKey);

              return (
                <div
                  key={rowKey}
                  style={rowStyle(actualIndex, isSelected)}
                  onClick={() => handleRowSelect(rowKey)}
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
                    <div style={{ ...cellStyle({} as any), width: 40, minWidth: 40, flexGrow: 0 }}>
                      <input
                        type="checkbox"
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

                    return (
                      <div
                        key={column.key}
                        style={cellStyle(column)}
                        onDoubleClick={() => handleCellDoubleClick(rowKey, column.key, column)}
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
