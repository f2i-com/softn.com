/**
 * SmartGrid Component
 *
 * An opinionated data grid with built-in search, sort, pagination, and CRUD.
 * Just pass data and it works - the power is in the engine, not the syntax.
 *
 * Usage:
 * <SmartGrid data={items} columns="name, email, status" search sort pagination edit delete add />
 */

import React, { useState, useMemo, useCallback } from 'react';

/**
 * Get field value from item, handling both flat objects and XDB record format
 * XDB records have structure: { id, collection, data: {...}, createdAt, updatedAt }
 */
function getFieldValue<T>(item: T, field: string): unknown {
  if (!item || !field) return undefined;
  const obj = item as Record<string, unknown>;
  // First try direct access
  if (field in obj) return obj[field];
  // Then try nested data property (XDB record format)
  if (obj.data && typeof obj.data === 'object' && field in (obj.data as Record<string, unknown>)) {
    return (obj.data as Record<string, unknown>)[field];
  }
  return undefined;
}

export interface SmartGridProps<T = Record<string, unknown>> {
  /** Data array or collection name (for XDB) */
  data: T[];
  /** Comma-separated column names, or auto-detect if not provided */
  columns?: string;
  /** Enable search (new: searchable, legacy: search) */
  searchable?: boolean;
  search?: boolean;
  /** Enable sorting (new: sortable, legacy: sort) */
  sortable?: boolean;
  sort?: boolean;
  /** Enable pagination (new: pageable, legacy: pagination) */
  pageable?: boolean;
  pagination?: boolean;
  /** Items per page */
  pageSize?: number;
  /** Enable editing (new: editable, legacy: edit) */
  editable?: boolean;
  edit?: boolean;
  /** Enable delete */
  delete?: boolean;
  /** Enable add new */
  add?: boolean;
  /** Auto-assign selected row to variable (new DSL pattern) */
  selectTo?: string;
  /** Row selection handler */
  onSelect?: (row: T) => void;
  /** Add handler */
  onAdd?: (data: Partial<T>) => void | Promise<void>;
  /** Edit handler */
  onEdit?: (row: T, data: Partial<T>) => void | Promise<void>;
  /** Delete handler */
  onDelete?: (row: T) => void | Promise<void>;
  /** Custom column renderers */
  renderColumn?: Record<string, (value: unknown, row: T) => React.ReactNode>;
  /** Hide specific columns */
  hideColumns?: string[];
  /** Row key field */
  rowKey?: string;
  /** Empty state message */
  emptyMessage?: string;
  /** Loading state */
  loading?: boolean;
  /** Export format */
  export?: 'csv' | 'xlsx' | boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

interface ColumnConfig {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'unknown';
}

// Utility to capitalize and humanize column names
function humanize(str: string): string {
  return str
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

// Detect column type from value
function detectType(value: unknown): ColumnConfig['type'] {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string') {
    // Check if it's a date string
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
  }
  return 'string';
}

// Format value for display
function formatValue(value: unknown, type: ColumnConfig['type']): React.ReactNode {
  if (value === null || value === undefined) return '—';

  switch (type) {
    case 'boolean':
      return value ? (
        <span style={{ color: 'var(--color-success-500, #22c55e)' }}>Yes</span>
      ) : (
        <span style={{ color: 'var(--color-gray-400, #9ca3af)' }}>No</span>
      );
    case 'date':
      try {
        const date = new Date(value as string | number | Date);
        return date.toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });
      } catch {
        return String(value);
      }
    case 'number':
      return typeof value === 'number' ? value.toLocaleString() : String(value);
    default:
      return String(value);
  }
}

// Search icon
const SearchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8" />
    <path d="M21 21l-4.35-4.35" />
  </svg>
);

// Sort icons
const SortIcon = ({ direction }: { direction: 'asc' | 'desc' | null }) => (
  <span
    style={{
      marginLeft: '0.25rem',
      display: 'inline-flex',
      flexDirection: 'column',
      opacity: direction ? 1 : 0.3,
    }}
  >
    <svg
      width="8"
      height="8"
      viewBox="0 0 8 8"
      fill={direction === 'asc' ? 'var(--color-primary-500, #6366f1)' : '#a1a1aa'}
    >
      <path d="M4 0L8 4H0L4 0Z" />
    </svg>
    <svg
      width="8"
      height="8"
      viewBox="0 0 8 8"
      fill={direction === 'desc' ? 'var(--color-primary-500, #6366f1)' : '#a1a1aa'}
      style={{ marginTop: '-2px' }}
    >
      <path d="M4 8L0 4H8L4 8Z" />
    </svg>
  </span>
);

// Edit icon
const EditIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

// Delete icon
const DeleteIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
  </svg>
);

// Add icon
const AddIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

// Chevron icons for pagination
const ChevronLeft = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

const ChevronRight = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M9 18l6-6-6-6" />
  </svg>
);

export function SmartGrid<T extends Record<string, unknown>>({
  data,
  columns: columnsProp,
  // New prop names with backward compatibility
  searchable,
  search = false,
  sortable,
  sort = false,
  pageable,
  pagination = false,
  pageSize = 10,
  editable,
  edit = false,
  delete: canDelete = false,
  add = false,
  selectTo: _selectTo,
  onSelect,
  onAdd,
  onEdit,
  onDelete,
  renderColumn = {},
  hideColumns = ['id', '_id'],
  rowKey = 'id',
  emptyMessage = 'No data available',
  loading = false,
  className,
  style,
}: SmartGridProps<T>): React.ReactElement {
  // Resolve new vs legacy prop names (new props take priority)
  const isSearchable = searchable ?? search;
  const isSortable = sortable ?? sort;
  const isPageable = pageable ?? pagination;
  const isEditable = editable ?? edit;
  // State
  const [searchQuery, setSearchQuery] = useState('');
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [currentPage, setCurrentPage] = useState(1);
  const [editingRow, setEditingRow] = useState<T | null>(null);
  const [editFormData, setEditFormData] = useState<Record<string, unknown>>({});
  const [isAdding, setIsAdding] = useState(false);
  const [addFormData, setAddFormData] = useState<Record<string, unknown>>({});
  const [confirmDelete, setConfirmDelete] = useState<T | null>(null);
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Ensure data is an array
  const safeData = Array.isArray(data) ? data : [];

  // Infer columns from data or parse from prop
  const columns = useMemo<ColumnConfig[]>(() => {
    if (columnsProp) {
      return columnsProp.split(',').map((col) => {
        const key = col.trim();
        const sampleValue = safeData[0] ? getFieldValue(safeData[0], key) : undefined;
        return {
          key,
          label: humanize(key),
          type: detectType(sampleValue),
        };
      });
    }

    // Auto-detect columns from first row
    const firstRow = safeData[0];
    if (!firstRow) return [];

    // Get keys from both the object and nested data property (XDB format)
    const directKeys = Object.keys(firstRow).filter((k) => k !== 'data');
    const dataKeys =
      firstRow.data && typeof firstRow.data === 'object'
        ? Object.keys(firstRow.data as Record<string, unknown>)
        : [];
    const allKeys = [...new Set([...directKeys, ...dataKeys])];

    return allKeys
      .filter((key) => !hideColumns.includes(key))
      .map((key) => ({
        key,
        label: humanize(key),
        type: detectType(getFieldValue(firstRow, key)),
      }));
  }, [columnsProp, safeData, hideColumns]);

  // Filter data by search
  const filteredData = useMemo(() => {
    if (!searchQuery) return safeData;

    const query = searchQuery.toLowerCase();
    return safeData.filter((row) =>
      columns.some((col) => {
        const value = getFieldValue(row, col.key);
        return value != null && String(value).toLowerCase().includes(query);
      })
    );
  }, [data, searchQuery, columns]);

  // Sort data
  const sortedData = useMemo(() => {
    if (!sortColumn) return filteredData;

    return [...filteredData].sort((a, b) => {
      const aVal = getFieldValue(a, sortColumn);
      const bVal = getFieldValue(b, sortColumn);

      if (aVal == null) return 1;
      if (bVal == null) return -1;

      let comparison = 0;
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        comparison = aVal - bVal;
      } else {
        comparison = String(aVal).localeCompare(String(bVal));
      }

      return sortDirection === 'desc' ? -comparison : comparison;
    });
  }, [filteredData, sortColumn, sortDirection]);

  // Paginate data
  const paginatedData = useMemo(() => {
    if (!isPageable) return sortedData;

    const start = (currentPage - 1) * pageSize;
    return sortedData.slice(start, start + pageSize);
  }, [sortedData, isPageable, currentPage, pageSize]);

  const totalPages = Math.ceil(sortedData.length / pageSize);

  // Handlers
  const handleSort = useCallback(
    (column: string) => {
      if (!isSortable) return;
      if (sortColumn === column) {
        setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortColumn(column);
        setSortDirection('asc');
      }
    },
    [isSortable, sortColumn]
  );

  const handleEdit = useCallback((row: T) => {
    setEditingRow(row);
    // For XDB records, extract the data property; otherwise use the row directly
    const rowObj = row as Record<string, unknown>;
    if (rowObj.data && typeof rowObj.data === 'object') {
      setEditFormData({ ...(rowObj.data as Record<string, unknown>) });
    } else {
      setEditFormData({ ...row });
    }
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editingRow || !onEdit || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onEdit(editingRow, editFormData as Partial<T>);
      setEditingRow(null);
      setEditFormData({});
    } catch (err) {
      console.error('[SmartGrid] Edit failed:', err);
    } finally {
      setIsSubmitting(false);
    }
  }, [editingRow, editFormData, onEdit, isSubmitting]);

  const handleAdd = useCallback(async () => {
    if (!onAdd || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onAdd(addFormData as Partial<T>);
      setIsAdding(false);
      setAddFormData({});
    } catch (err) {
      console.error('[SmartGrid] Add failed:', err);
    } finally {
      setIsSubmitting(false);
    }
  }, [addFormData, onAdd, isSubmitting]);

  const handleDelete = useCallback(
    async (row: T) => {
      if (!onDelete || isSubmitting) return;
      setIsSubmitting(true);
      try {
        await onDelete(row);
        setConfirmDelete(null);
      } catch (err) {
        console.error('[SmartGrid] Delete failed:', err);
      } finally {
        setIsSubmitting(false);
      }
    },
    [onDelete, isSubmitting]
  );

  const getRowKey = (row: T, index: number): string => {
    return String(row[rowKey] ?? index);
  };

  // Mobile detection via media query
  const [isMobile, setIsMobile] = useState(false);
  React.useEffect(() => {
    const mql = window.matchMedia('(max-width: 640px)');
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  // Styles
  const containerStyle: React.CSSProperties = {
    width: '100%',
    background: 'var(--color-surface, #ffffff)',
    borderRadius: 'var(--radius-lg, 0.75rem)',
    border: '1px solid var(--color-border, rgba(0, 0, 0, 0.08))',
    overflow: 'hidden',
    ...style,
  };

  const toolbarStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '1rem',
    borderBottom: '1px solid var(--color-border, rgba(0, 0, 0, 0.08))',
    background: 'var(--color-gray-50, #f3f3f6)',
    gap: '1rem',
    flexWrap: 'wrap',
  };

  const searchWrapperStyle: React.CSSProperties = {
    position: 'relative',
    flex: '1',
    maxWidth: '320px',
  };

  const searchInputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.5rem 0.75rem 0.5rem 2.25rem',
    borderRadius: 'var(--radius-md, 0.5rem)',
    border: '1px solid var(--color-border, rgba(0, 0, 0, 0.08))',
    background: 'var(--color-surface, #ffffff)',
    color: 'var(--color-text, #1a1a2e)',
    fontSize: '0.875rem',
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  };

  const searchIconStyle: React.CSSProperties = {
    position: 'absolute',
    left: '0.75rem',
    top: '50%',
    transform: 'translateY(-50%)',
    color: 'var(--color-gray-400, #9ca3af)',
    pointerEvents: 'none',
  };

  const buttonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    padding: '0.5rem 0.875rem',
    borderRadius: 'var(--radius-md, 0.5rem)',
    border: 'none',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.15s',
  };

  const primaryButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    background:
      'linear-gradient(to bottom, var(--color-primary-500, #6366f1), var(--color-primary-600, #4f46e5))',
    color: 'white',
    boxShadow: '0 1px 3px rgba(99, 102, 241, 0.3)',
  };

  const iconButtonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '2rem',
    height: '2rem',
    borderRadius: 'var(--radius-md, 0.375rem)',
    border: 'none',
    background: 'transparent',
    color: 'var(--color-gray-500, #6b7280)',
    cursor: 'pointer',
    transition: 'all 0.15s',
  };

  const tableStyle: React.CSSProperties = {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.875rem',
  };

  const thStyle: React.CSSProperties = {
    padding: '0.75rem 1rem',
    textAlign: 'left',
    fontWeight: 600,
    color: 'var(--color-gray-400, #a1a1aa)',
    background: 'var(--color-gray-50, #f3f3f6)',
    borderBottom: '2px solid var(--color-border, rgba(0, 0, 0, 0.08))',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  };

  const tdStyle: React.CSSProperties = {
    padding: '0.75rem 1rem',
    color: 'var(--color-text, #1a1a2e)',
    borderBottom: '1px solid var(--color-border, rgba(0, 0, 0, 0.08))',
  };

  const paginationStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.5rem 0.75rem',
    borderTop: '1px solid var(--color-border, rgba(0, 0, 0, 0.08))',
    background: 'var(--color-gray-50, #f3f3f6)',
    fontSize: '0.8rem',
    color: 'var(--color-gray-400, #a1a1aa)',
    flexWrap: 'wrap',
    gap: '0.5rem',
  };

  const paginationButtonStyle: React.CSSProperties = {
    ...iconButtonStyle,
    border: '1px solid var(--color-border, rgba(0, 0, 0, 0.08))',
    background: 'var(--color-surface, #ffffff)',
    color: 'var(--color-text, #1a1a2e)',
  };

  const modalOverlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  };

  const modalStyle: React.CSSProperties = {
    background: 'var(--color-surface, #ffffff)',
    borderRadius: 'var(--radius-lg, 0.75rem)',
    padding: '1.5rem',
    width: 'min(400px, calc(100vw - 2rem))',
    maxWidth: '90vw',
    maxHeight: '90vh',
    overflow: 'auto',
    border: '1px solid var(--color-border, rgba(0, 0, 0, 0.08))',
    boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.2)',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.5rem 0.75rem',
    borderRadius: 'var(--radius-md, 0.375rem)',
    border: '1px solid var(--color-border, rgba(0, 0, 0, 0.08))',
    background: 'var(--color-gray-50, #f3f3f6)',
    color: 'var(--color-text, #1a1a2e)',
    fontSize: '0.875rem',
    outline: 'none',
  };

  // Render form for add/edit
  const renderForm = (
    formData: Record<string, unknown>,
    setFormData: React.Dispatch<React.SetStateAction<Record<string, unknown>>>,
    title: string,
    onSave: () => void,
    onCancel: () => void
  ) => (
    <div style={modalOverlayStyle} onClick={onCancel}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h3
          style={{
            margin: '0 0 1rem',
            fontSize: '1.125rem',
            fontWeight: 600,
            color: 'var(--color-gray-900, #1a1a2e)',
          }}
        >
          {title}
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {columns.map((col) => (
            <div key={col.key}>
              <label
                style={{
                  display: 'block',
                  marginBottom: '0.25rem',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  color: 'var(--color-text-muted, #6b6b80)',
                }}
              >
                {col.label}
              </label>
              {col.type === 'boolean' ? (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={Boolean(formData[col.key])}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, [col.key]: e.target.checked }))
                    }
                    style={{
                      width: '1rem',
                      height: '1rem',
                      accentColor: 'var(--color-primary, #6366f1)',
                    }}
                  />
                  <span style={{ fontSize: '0.875rem', color: 'var(--color-text, #1a1a2e)' }}>
                    {formData[col.key] ? 'Yes' : 'No'}
                  </span>
                </label>
              ) : (
                <input
                  type={col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : 'text'}
                  value={formData[col.key] != null ? String(formData[col.key]) : ''}
                  onChange={(e) => setFormData((prev) => ({ ...prev, [col.key]: e.target.value }))}
                  style={inputStyle}
                />
              )}
            </div>
          ))}
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.75rem',
            marginTop: '1.5rem',
          }}
        >
          <button
            onClick={onCancel}
            style={{
              ...buttonStyle,
              background: 'var(--color-gray-100, #e8e8ee)',
              color: 'var(--color-text, #1a1a2e)',
            }}
          >
            Cancel
          </button>
          <button onClick={onSave} style={primaryButtonStyle}>
            Save
          </button>
        </div>
      </div>
    </div>
  );

  // Render delete confirmation
  const renderDeleteConfirm = () => (
    <div style={modalOverlayStyle} onClick={() => setConfirmDelete(null)}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h3
          style={{
            margin: '0 0 0.5rem',
            fontSize: '1.125rem',
            fontWeight: 600,
            color: 'var(--color-text, #1a1a2e)',
          }}
        >
          Confirm Delete
        </h3>
        <p style={{ margin: '0 0 1.5rem', color: 'var(--color-text-muted, #6b6b80)' }}>
          Are you sure you want to delete this item? This action cannot be undone.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
          <button
            onClick={() => setConfirmDelete(null)}
            style={{
              ...buttonStyle,
              background: 'var(--color-gray-100, #e8e8ee)',
              color: 'var(--color-text, #1a1a2e)',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => confirmDelete && handleDelete(confirmDelete)}
            style={{
              ...buttonStyle,
              background:
                'linear-gradient(to bottom, var(--color-error-500, #ef4444), var(--color-error-600, #dc2626))',
              color: 'white',
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );

  // Loading overlay
  if (loading) {
    return (
      <div
        className={className}
        style={{
          ...containerStyle,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '200px',
        }}
      >
        <div
          style={{
            width: '2rem',
            height: '2rem',
            border: '3px solid var(--color-gray-200, #d4d4dd)',
            borderTopColor: 'var(--color-primary-500, #6366f1)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }}
        />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div className={className} style={containerStyle}>
      {/* Toolbar */}
      {(isSearchable || add) && (
        <div style={toolbarStyle}>
          {isSearchable && (
            <div style={searchWrapperStyle}>
              <span style={searchIconStyle}>
                <SearchIcon />
              </span>
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(1);
                }}
                style={searchInputStyle}
              />
            </div>
          )}
          {add && onAdd && (
            <button onClick={() => setIsAdding(true)} style={primaryButtonStyle}>
              <AddIcon />
              Add New
            </button>
          )}
        </div>
      )}

      {/* Mobile Card View */}
      {isMobile ? (
        <div style={{ padding: '0.5rem' }}>
          {paginatedData.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--color-gray-500, #6b7280)' }}>
              {emptyMessage}
            </div>
          ) : (
            paginatedData.map((row, index) => (
              <div
                key={getRowKey(row, index)}
                style={{
                  padding: '0.875rem',
                  borderBottom: index < paginatedData.length - 1 ? '1px solid var(--color-border, rgba(0, 0, 0, 0.08))' : 'none',
                  cursor: onSelect ? 'pointer' : 'default',
                }}
                onClick={() => onSelect?.(row)}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                  {/* First column as title */}
                  {columns.length > 0 && (
                    <div style={{ fontWeight: 600, fontSize: '0.9375rem', color: 'var(--color-text, #1a1a2e)' }}>
                      {renderColumn[columns[0].key]
                        ? renderColumn[columns[0].key](getFieldValue(row, columns[0].key), row)
                        : formatValue(getFieldValue(row, columns[0].key), columns[0].type)}
                    </div>
                  )}
                  {/* Remaining columns as key-value pairs */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem 1rem' }}>
                    {columns.slice(1).map((col) => {
                      const cellValue = getFieldValue(row, col.key);
                      return (
                        <div key={col.key} style={{ display: 'flex', gap: '0.25rem', fontSize: '0.8125rem' }}>
                          <span style={{ color: 'var(--color-gray-400, #a1a1aa)' }}>{col.label}:</span>
                          <span style={{ color: 'var(--color-text, #1a1a2e)', fontWeight: 500 }}>
                            {renderColumn[col.key]
                              ? renderColumn[col.key](cellValue, row)
                              : formatValue(cellValue, col.type)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {/* Mobile actions */}
                {(isEditable || canDelete) && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
                    {isEditable && onEdit && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleEdit(row); }}
                        style={{ ...iconButtonStyle, color: 'var(--color-primary-500, #6366f1)' }}
                        title="Edit"
                      >
                        <EditIcon />
                      </button>
                    )}
                    {canDelete && onDelete && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmDelete(row); }}
                        style={{ ...iconButtonStyle, color: 'var(--color-error-500, #ef4444)' }}
                        title="Delete"
                      >
                        <DeleteIcon />
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      ) : (
      /* Desktop Table */
      <div style={{ overflowX: 'auto' }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  style={{
                    ...thStyle,
                    cursor: isSortable ? 'pointer' : 'default',
                  }}
                  onClick={() => handleSort(col.key)}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                    {col.label}
                    {isSortable && (
                      <SortIcon direction={sortColumn === col.key ? sortDirection : null} />
                    )}
                  </span>
                </th>
              ))}
              {(isEditable || canDelete) && (
                <th style={{ ...thStyle, width: '100px', textAlign: 'center' }}>Actions</th>
              )}
            </tr>
          </thead>
          <tbody>
            {paginatedData.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + (isEditable || canDelete ? 1 : 0)}
                  style={{
                    ...tdStyle,
                    textAlign: 'center',
                    padding: '2rem',
                    color: 'var(--color-gray-500, #6b7280)',
                  }}
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              paginatedData.map((row, index) => (
                <tr
                  key={getRowKey(row, index)}
                  style={{
                    background:
                      hoveredRow === index ? 'var(--color-gray-50, #f3f3f6)' : 'transparent',
                    cursor: onSelect ? 'pointer' : 'default',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={() => setHoveredRow(index)}
                  onMouseLeave={() => setHoveredRow(null)}
                  onClick={() => onSelect?.(row)}
                >
                  {columns.map((col) => {
                    const cellValue = getFieldValue(row, col.key);
                    return (
                      <td key={col.key} style={tdStyle}>
                        {renderColumn[col.key]
                          ? renderColumn[col.key](cellValue, row)
                          : formatValue(cellValue, col.type)}
                      </td>
                    );
                  })}
                  {(isEditable || canDelete) && (
                    <td style={{ ...tdStyle, textAlign: 'center' }}>
                      <div style={{ display: 'flex', justifyContent: 'center', gap: '0.25rem' }}>
                        {isEditable && onEdit && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEdit(row);
                            }}
                            style={{
                              ...iconButtonStyle,
                              color: 'var(--color-primary-500, #6366f1)',
                            }}
                            title="Edit"
                          >
                            <EditIcon />
                          </button>
                        )}
                        {canDelete && onDelete && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDelete(row);
                            }}
                            style={{ ...iconButtonStyle, color: 'var(--color-error-500, #ef4444)' }}
                            title="Delete"
                          >
                            <DeleteIcon />
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      )}

      {/* Pagination */}
      {isPageable && totalPages > 1 && (
        <div style={paginationStyle}>
          <span>
            Showing {(currentPage - 1) * pageSize + 1} to{' '}
            {Math.min(currentPage * pageSize, sortedData.length)} of {sortedData.length}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              style={{ ...paginationButtonStyle, opacity: currentPage === 1 ? 0.5 : 1 }}
            >
              <ChevronLeft />
            </button>
            <span style={{ padding: '0 0.5rem' }}>
              Page {currentPage} of {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              style={{ ...paginationButtonStyle, opacity: currentPage === totalPages ? 0.5 : 1 }}
            >
              <ChevronRight />
            </button>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingRow &&
        renderForm(editFormData, setEditFormData, 'Edit Item', handleSaveEdit, () =>
          setEditingRow(null)
        )}

      {/* Add Modal */}
      {isAdding &&
        renderForm(addFormData, setAddFormData, 'Add New Item', handleAdd, () =>
          setIsAdding(false)
        )}

      {/* Delete Confirmation */}
      {confirmDelete && renderDeleteConfirm()}
    </div>
  );
}

export default SmartGrid;
