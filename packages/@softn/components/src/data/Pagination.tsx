/**
 * Pagination Component
 *
 * Page navigation with customizable page size and display options.
 */

import * as React from 'react';

export interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems?: number;
  pageSize?: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
  showPageSize?: boolean;
  showTotal?: boolean;
  showFirstLast?: boolean;
  siblingCount?: number;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  style?: React.CSSProperties;
}

const sizeStyles = {
  sm: { padding: '0.25rem 0.5rem', fontSize: '0.75rem', minWidth: '28px' },
  md: { padding: '0.375rem 0.75rem', fontSize: '0.875rem', minWidth: '36px' },
  lg: { padding: '0.5rem 1rem', fontSize: '1rem', minWidth: '44px' },
};

function range(start: number, end: number): number[] {
  const length = end - start + 1;
  return Array.from({ length }, (_, i) => start + i);
}

export function Pagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize = 10,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50, 100],
  showPageSize = false,
  showTotal = false,
  showFirstLast = true,
  siblingCount = 1,
  size = 'md',
  className = '',
  style,
}: PaginationProps) {
  const sizes = sizeStyles[size];

  // Calculate page numbers to display
  const getPageNumbers = (): (number | 'ellipsis')[] => {
    const totalPageNumbers = siblingCount * 2 + 5; // siblings + first + last + current + 2 ellipsis

    if (totalPages <= totalPageNumbers) {
      return range(1, totalPages);
    }

    const leftSiblingIndex = Math.max(currentPage - siblingCount, 1);
    const rightSiblingIndex = Math.min(currentPage + siblingCount, totalPages);

    const showLeftEllipsis = leftSiblingIndex > 2;
    const showRightEllipsis = rightSiblingIndex < totalPages - 1;

    if (!showLeftEllipsis && showRightEllipsis) {
      const leftRange = range(1, 3 + siblingCount * 2);
      return [...leftRange, 'ellipsis', totalPages];
    }

    if (showLeftEllipsis && !showRightEllipsis) {
      const rightRange = range(totalPages - (2 + siblingCount * 2), totalPages);
      return [1, 'ellipsis', ...rightRange];
    }

    const middleRange = range(leftSiblingIndex, rightSiblingIndex);
    return [1, 'ellipsis', ...middleRange, 'ellipsis', totalPages];
  };

  const pageNumbers = getPageNumbers();

  const buttonStyle: React.CSSProperties = {
    ...sizes,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    backgroundColor: 'var(--color-surface, #16161a)',
    color: 'var(--color-text, #ececf0)',
    cursor: 'pointer',
    borderRadius: '4px',
    margin: '0 2px',
    transition: 'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',
  };

  const activeButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    backgroundColor: '#6366f1',
    borderColor: '#6366f1',
    color: 'var(--color-surface, #16161a)',
  };

  const disabledButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    opacity: 0.5,
    cursor: 'not-allowed',
  };

  const ellipsisStyle: React.CSSProperties = {
    ...sizes,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--color-text-muted, #a1a1aa)',
    margin: '0 2px',
  };

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    flexWrap: 'wrap',
    ...style,
  };

  const navStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
  };

  const selectStyle: React.CSSProperties = {
    ...sizes,
    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    borderRadius: '4px',
    backgroundColor: 'var(--color-surface, #16161a)',
    color: 'var(--color-text, #ececf0)',
    cursor: 'pointer',
  };

  const infoStyle: React.CSSProperties = {
    fontSize: sizes.fontSize,
    color: 'var(--color-text-muted, #a1a1aa)',
  };

  return (
    <div className={`softn-pagination ${className}`} style={containerStyle}>
      {showTotal && totalItems !== undefined && (
        <span style={infoStyle}>Total: {totalItems} items</span>
      )}

      <nav style={navStyle}>
        {showFirstLast && (
          <button
            style={currentPage === 1 ? disabledButtonStyle : buttonStyle}
            onClick={() => onPageChange(1)}
            disabled={currentPage === 1}
            title="First page"
          >
            ««
          </button>
        )}

        <button
          style={currentPage === 1 ? disabledButtonStyle : buttonStyle}
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          title="Previous page"
        >
          «
        </button>

        {pageNumbers.map((page, index) =>
          page === 'ellipsis' ? (
            <span key={`ellipsis-${index}`} style={ellipsisStyle}>
              ...
            </span>
          ) : (
            <button
              key={page}
              style={currentPage === page ? activeButtonStyle : buttonStyle}
              onClick={() => onPageChange(page)}
              onMouseEnter={(e) => {
                if (currentPage !== page) {
                  e.currentTarget.style.borderColor = '#6366f1';
                  e.currentTarget.style.color = '#6366f1';
                }
              }}
              onMouseLeave={(e) => {
                if (currentPage !== page) {
                  e.currentTarget.style.borderColor = 'var(--color-border, rgba(255, 255, 255, 0.08))';
                  e.currentTarget.style.color = 'var(--color-text, #ececf0)';
                }
              }}
            >
              {page}
            </button>
          )
        )}

        <button
          style={currentPage === totalPages ? disabledButtonStyle : buttonStyle}
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          title="Next page"
        >
          »
        </button>

        {showFirstLast && (
          <button
            style={currentPage === totalPages ? disabledButtonStyle : buttonStyle}
            onClick={() => onPageChange(totalPages)}
            disabled={currentPage === totalPages}
            title="Last page"
          >
            »»
          </button>
        )}
      </nav>

      {showPageSize && onPageSizeChange && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={infoStyle}>Show:</span>
          <select
            style={selectStyle}
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <span style={infoStyle}>per page</span>
        </div>
      )}
    </div>
  );
}

export default Pagination;
