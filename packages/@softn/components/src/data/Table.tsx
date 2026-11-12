/**
 * Table Component
 *
 * A data table with sorting and styling options.
 */

import React from 'react';
import { choice } from '../utils/choice';
import { presentRows, recordRows } from '../utils/rows';
import { sortOrder } from '../utils/sort';
import { NARROW_QUERY, useMediaQuery } from '../utils/media';

// Before paint in a browser, so a phone never shows a frame of the table
// that is about to be cards.
const useBeforePaint = typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

/**
 * A table drawn as cards, on a phone: every row a block of its own, its first
 * cell the heading and each of the others beside its column's name. The rows
 * and cells are the table's own, so what a column renders, a row's click and
 * the keyboard are as they were; they keep their roles, and so are still a
 * table to a screen reader. The header row is kept for the columns that
 * sort, as a row of buttons, and otherwise only for a screen reader.
 */
const CARD_RULES = `
  @media ${NARROW_QUERY} {
    .softn-table-cards { overflow: visible !important; }
    .softn-table-cards > table,
    .softn-table-cards > table > tbody { display: block !important; width: 100% !important; border: none !important; }
    .softn-table-cards > table > caption { display: block; }
    .softn-table-cards > table > thead { display: block !important; }
    .softn-table-cards > table > thead > tr { display: flex !important; flex-wrap: wrap; gap: 0.5rem; padding: 0 0 0.5rem; background: transparent !important; position: static !important; }
    .softn-table-cards > table > thead > tr:not(:has(th[aria-sort])) { padding: 0; }
    .softn-table-cards > table > thead > tr > th { display: block; padding: 0 !important; border: none !important; width: auto !important; font-size: 0.8125rem; }
    .softn-table-cards > table > thead > tr > th:not([aria-sort]) {
      position: absolute; width: 1px !important; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
    }
    .softn-table-cards > table > thead > tr > th[aria-sort] > button {
      min-height: 2.25rem; padding: 0 0.75rem !important; border: 1px solid var(--color-border, rgba(127, 127, 127, 0.3)) !important; border-radius: 9999px;
    }
    .softn-table-cards > table > tbody > tr {
      display: flex !important; flex-wrap: wrap; align-items: baseline; gap: 0.375rem 1rem;
      padding: 0.875rem 0.25rem; border-bottom: 1px solid var(--color-border, rgba(127, 127, 127, 0.3));
    }
    .softn-table-cards > table > tbody > tr:last-child { border-bottom: none; }
    .softn-table-cards > table > tbody > tr > td {
      display: flex !important; gap: 0.25rem; min-width: 0; padding: 0 !important; border: none !important;
      width: auto !important; text-align: left !important; font-size: 0.8125rem; overflow-wrap: anywhere;
    }
    .softn-table-cards > table > tbody > tr > td[data-label]::before {
      content: attr(data-label) ":"; flex: none; color: var(--color-text-muted, inherit); opacity: 0.85;
    }
    .softn-table-cards > table > tbody > tr > td:first-child { flex: 0 0 100%; font-size: 0.9375rem; font-weight: 600; }
    .softn-table-cards > table > tbody > tr > td:first-child::before { content: none; }
    .softn-table-cards > table > tbody > tr > td.softn-table-empty { display: block !important; flex: 1 1 100%; padding: 1.25rem 0 !important; text-align: center !important; font-weight: 400; }
  }
  @media ${NARROW_QUERY} and (pointer: coarse) {
    .softn-table-cards > table > thead > tr > th[aria-sort] > button { min-height: 44px; }
  }
`;

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
  position,
  columns,
  onRowClick,
  getRowStyle,
  getBodyCellStyle,
}: {
  row: T;
  /** The row's place in the list the page gave: what the page is told. */
  index: number;
  /** The row's place on screen, which differs once the table has sorted: what stripes go by. */
  position: number;
  columns: Column<T>[];
  onRowClick?: (row: T, index: number) => void;
  getRowStyle: (position: number, isHovered: boolean) => React.CSSProperties;
  getBodyCellStyle: (column: Column<T>) => React.CSSProperties;
}): React.ReactElement {
  const [isHovered, setIsHovered] = React.useState(false);

  const handleRowKeyDown = (e: React.KeyboardEvent) => {
    // A key pressed on a button or in a field inside the row is that
    // control's: Enter on a Delete button deletes, a space in a field is typed.
    if (e.target !== e.currentTarget) return;
    if (onRowClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onRowClick(row, index);
    }
  };

  return (
    <tr
      // Said outright, as the cells' and the header row's are: drawn as a
      // card on a phone, a row is no longer laid out as one, and a browser
      // that goes by the layout would stop calling it a row.
      role="row"
      style={getRowStyle(position, isHovered)}
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
        <td
          key={column.key}
          style={getBodyCellStyle(column)}
          role="cell"
          // The column's name, for the card a row is on a phone.
          data-label={typeof column.header === 'string' && column.header !== '' ? column.header : undefined}
        >
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
  /**
   * On a phone (640 pixels wide and under), whether each row is drawn as a
   * card: its first cell as the heading, the others beside their column's
   * name. `auto` (the default) does so when the table is too wide for its
   * box and would scroll sideways; `always` does so whatever its width;
   * `never` leaves it a table that scrolls.
   */
  mobileCards?: 'auto' | 'always' | 'never';
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
  mobileCards = 'auto',
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
  const sizes = choice(sizeStyles, size, 'md');
  // Bound to rows that have not arrived, the table is empty, not an error.
  const given = presentRows<T>(rawData);
  const columns = recordRows<Column<T>>(rawColumns);
  const captionId = React.useId();

  // Cards on a phone: asked for outright, or because the table, drawn as a
  // table, is wider than its box. Measured as a table, before paint, and
  // again when the box changes size or the columns change.
  const narrow = useMediaQuery(NARROW_QUERY);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const columnKeys = columns.map((column) => column.key).join('\n');
  const [tooWide, setTooWide] = React.useState<{ columns: string; wide: boolean }>({ columns: columnKeys, wide: false });
  const measured = tooWide.columns === columnKeys && tooWide.wide;
  const asCards = narrow && mobileCards !== 'never' && (mobileCards === 'always' || measured);
  useBeforePaint(() => {
    if (!narrow || mobileCards !== 'auto') return;
    const box = boxRef.current;
    if (!box) return;
    // Once it is cards there is no table to measure; it stays cards until
    // the screen is wide again or the columns change.
    if (measured) return;
    const measure = () => {
      if (box.scrollWidth > box.clientWidth + 1) setTooWide({ columns: columnKeys, wide: true });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [narrow, mobileCards, measured, columnKeys, given.length]);
  // Wide again: the next time it is narrow, it is measured afresh.
  React.useEffect(() => {
    if (!narrow) setTooWide((was) => (was.wide ? { columns: was.columns, wide: false } : was));
  }, [narrow]);

  // Without `onSort` the table sorts its rows itself: a sortable header was
  // a button that did nothing. It starts from the sort the page names, and
  // follows it when the page changes it. With `onSort` the page sorts, and
  // the rows are drawn in the order it gives them.
  const [ownSort, setOwnSort] = React.useState({ column: sortColumn, direction: sortDirection });
  const [seenSort, setSeenSort] = React.useState({ column: sortColumn, direction: sortDirection });
  // As Object.is compares: a NaN sort column re-rendered without end.
  if (!Object.is(seenSort.column, sortColumn) || !Object.is(seenSort.direction, sortDirection)) {
    setSeenSort({ column: sortColumn, direction: sortDirection });
    setOwnSort({ column: sortColumn, direction: sortDirection });
  }
  const sortsItself = !onSort;
  const activeColumn = sortsItself ? ownSort.column : sortColumn;
  const activeDirection = (sortsItself ? ownSort.direction : sortDirection) === 'desc' ? 'desc' : 'asc';
  // The rows' places in the page's list, in the order they are drawn; null
  // when they are drawn as given. The sort is the table's and the list is the
  // page's, so a row keeps the index it has there: a click is told it, a
  // column's `render` is handed it, and a row with no key field is keyed by
  // it. They were given the row's place on screen, and a page that wrote
  // `rows[index]` in its handler opened or removed another record.
  const order = React.useMemo(() => {
    const by = sortsItself ? columns.find((column) => column.key === activeColumn && column.sortable) : undefined;
    return by ? sortOrder(given, (row) => row[by.key], activeDirection) : null;
  }, [given, columns, sortsItself, activeColumn, activeDirection]);

  const getRowKey = (row: T, index: number): string => {
    if (typeof rowKey === 'function') {
      return rowKey(row, index);
    }
    return String(row[rowKey] ?? index);
  };

  const handleSort = (column: Column<T>) => {
    if (!column.sortable) return;
    const newDirection = activeColumn === column.key && activeDirection === 'asc' ? 'desc' : 'asc';
    if (onSort) onSort(column.key, newDirection);
    else setOwnSort({ column: column.key, direction: newDirection });
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
    if (activeColumn === column.key) {
      return activeDirection === 'asc' ? 'ascending' : 'descending';
    }
    return 'none';
  };

  return (
    <div
      ref={boxRef}
      className={[asCards ? 'softn-table-cards' : '', className].filter(Boolean).join(' ') || undefined}
      style={containerStyle}
      role="region"
      aria-label={ariaLabel ?? (caption ? undefined : 'Data table')}
      aria-labelledby={ariaLabel || !caption ? undefined : captionId}
      // A scrolling region is focusable so its overflow can be scrolled from the keyboard.
      tabIndex={0}
    >
      {asCards && <style>{CARD_RULES}</style>}
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
                    <SortIcon active={activeColumn === column.key} direction={activeDirection} />
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {given.length === 0 ? (
            <tr role="row">
              <td colSpan={columns.length} className="softn-table-empty" style={emptyStyle} role="cell">
                {emptyContent}
              </td>
            </tr>
          ) : (
            given.map((_row, position) => {
              const index = order ? order[position] : position;
              const row = given[index];
              return (
                <TableRow
                  key={getRowKey(row, index)}
                  row={row}
                  index={index}
                  position={position}
                  columns={columns}
                  onRowClick={onRowClick}
                  getRowStyle={getRowStyle}
                  getBodyCellStyle={getBodyCellStyle}
                />
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

export default Table;
