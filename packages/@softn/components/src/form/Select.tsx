/**
 * Select Component
 *
 * A customizable dropdown select with search, multi-select,
 * grouped options, and keyboard navigation.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  icon?: React.ReactNode;
  description?: string;
}

export interface SelectOptionGroup {
  label: string;
  options: SelectOption[];
}

export type SelectOptions = (SelectOption | SelectOptionGroup)[];

export interface SelectProps {
  /** Input name */
  name?: string;
  /** Current value (string for single, string[] for multi) */
  value?: string | string[];
  /** Default value */
  defaultValue?: string | string[];
  /** Options (flat or grouped) */
  options?: SelectOptions;
  /** Placeholder text */
  placeholder?: string;
  /** Label text */
  label?: string;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Whether the input is required */
  required?: boolean;
  /** Enable search/filter */
  searchable?: boolean;
  /** Search placeholder */
  searchPlaceholder?: string;
  /** Enable multi-select */
  multiple?: boolean;
  /** Max selections for multi-select */
  maxSelections?: number;
  /** Show clear button */
  clearable?: boolean;
  /** Input size */
  size?: 'sm' | 'md' | 'lg';
  /** Full width */
  fullWidth?: boolean;
  /** Error state or error message */
  error?: boolean | string;
  /** Loading state */
  loading?: boolean;
  /** No options text */
  noOptionsText?: string;
  /** Create option text (for creatable select) */
  createOptionText?: (query: string) => string;
  /** Change handler */
  onChange?: (value: string | string[]) => void;
  /** Search handler (for async options) */
  onSearch?: (query: string) => void;
  /** Create handler */
  onCreate?: (value: string) => void;
  /** Focus handler */
  onFocus?: () => void;
  /** Blur handler */
  onBlur?: () => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

// Type guard for option groups
function isOptionGroup(option: SelectOption | SelectOptionGroup): option is SelectOptionGroup {
  return 'options' in option;
}

// Flatten options for easier searching
function flattenOptions(options: SelectOptions): SelectOption[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((opt) => (isOptionGroup(opt) ? opt.options : [opt]));
}

const sizeConfig = {
  sm: { height: 32, padding: '0.375rem 0.5rem', fontSize: '0.875rem', iconSize: 14 },
  md: { height: 40, padding: '0.5rem 0.75rem', fontSize: '0.875rem', iconSize: 16 },
  lg: { height: 48, padding: '0.625rem 1rem', fontSize: '1rem', iconSize: 18 },
};

export function Select({
  name,
  value: controlledValue,
  defaultValue,
  options = [],
  placeholder = 'Select...',
  label,
  disabled = false,
  required = false,
  searchable = false,
  searchPlaceholder = 'Search...',
  multiple = false,
  maxSelections,
  clearable = false,
  size = 'md',
  fullWidth = false,
  error = false,
  loading = false,
  noOptionsText = 'No options',
  createOptionText,
  onChange,
  onSearch,
  onCreate,
  onFocus,
  onBlur,
  className,
  style,
}: SelectProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [internalValue, setInternalValue] = useState<string | string[]>(
    defaultValue ?? (multiple ? [] : '')
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const value = controlledValue !== undefined ? controlledValue : internalValue;
  const hasError = Boolean(error);
  const errorMessage = typeof error === 'string' ? error : undefined;
  const config = sizeConfig[size];

  // Get all flat options for filtering
  const allOptions = useMemo(() => flattenOptions(options), [options]);

  // Filter options based on search query
  const filteredOptions = useMemo(() => {
    if (!Array.isArray(options)) return [];
    if (!searchQuery) return options;

    const query = searchQuery.toLowerCase();
    return options
      .map((opt) => {
        if (isOptionGroup(opt)) {
          const filtered = opt.options.filter(
            (o) => o.label.toLowerCase().includes(query) || o.value.toLowerCase().includes(query)
          );
          return filtered.length > 0 ? { ...opt, options: filtered } : null;
        }
        return opt.label.toLowerCase().includes(query) || opt.value.toLowerCase().includes(query)
          ? opt
          : null;
      })
      .filter((opt): opt is SelectOption | SelectOptionGroup => opt !== null);
  }, [options, searchQuery]);

  const flatFilteredOptions = useMemo(() => flattenOptions(filteredOptions), [filteredOptions]);

  // Get selected option labels
  const selectedLabels = useMemo(() => {
    if (multiple) {
      const values = Array.isArray(value) ? value : [];
      return values.map((v) => allOptions.find((o) => o.value === v)?.label ?? v).join(', ');
    }
    return allOptions.find((o) => o.value === value)?.label ?? '';
  }, [value, allOptions, multiple]);

  // Handle value change
  const handleSelect = useCallback(
    (optionValue: string) => {
      if (multiple) {
        const currentValues = Array.isArray(value) ? value : [];
        let newValues: string[];

        if (currentValues.includes(optionValue)) {
          newValues = currentValues.filter((v) => v !== optionValue);
        } else {
          if (maxSelections && currentValues.length >= maxSelections) {
            return;
          }
          newValues = [...currentValues, optionValue];
        }

        if (controlledValue === undefined) {
          setInternalValue(newValues);
        }
        onChange?.(newValues);
      } else {
        if (controlledValue === undefined) {
          setInternalValue(optionValue);
        }
        onChange?.(optionValue);
        setIsOpen(false);
        setSearchQuery('');
      }
    },
    [value, multiple, maxSelections, controlledValue, onChange]
  );

  // Handle clear
  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const newValue = multiple ? [] : '';
      if (controlledValue === undefined) {
        setInternalValue(newValue);
      }
      onChange?.(newValue);
    },
    [multiple, controlledValue, onChange]
  );

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (!isOpen) {
            setIsOpen(true);
          } else {
            setHighlightedIndex((prev) => Math.min(prev + 1, flatFilteredOptions.length - 1));
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlightedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (isOpen && flatFilteredOptions[highlightedIndex]) {
            handleSelect(flatFilteredOptions[highlightedIndex].value);
          } else if (!isOpen) {
            setIsOpen(true);
          }
          break;
        case 'Escape':
          setIsOpen(false);
          setSearchQuery('');
          break;
        case 'Tab':
          setIsOpen(false);
          setSearchQuery('');
          break;
      }
    },
    [isOpen, highlightedIndex, flatFilteredOptions, handleSelect]
  );

  // Handle search input
  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const query = e.target.value;
      setSearchQuery(query);
      setHighlightedIndex(0);
      onSearch?.(query);
    },
    [onSearch]
  );

  // Handle create
  const handleCreate = useCallback(() => {
    if (onCreate && searchQuery.trim()) {
      onCreate(searchQuery.trim());
      setSearchQuery('');
    }
  }, [onCreate, searchQuery]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && searchable && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen, searchable]);

  // Scroll highlighted option into view
  useEffect(() => {
    if (isOpen && listRef.current) {
      const highlighted = listRef.current.querySelector('[data-highlighted="true"]');
      highlighted?.scrollIntoView({ block: 'nearest' });
    }
  }, [isOpen, highlightedIndex]);

  // Styles
  const containerStyle: React.CSSProperties = {
    position: 'relative',
    width: fullWidth ? '100%' : 'fit-content',
    ...style,
  };

  const triggerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    width: '100%',
    minHeight: config.height,
    padding: config.padding,
    paddingRight: '2.5rem',
    fontSize: config.fontSize,
    border: `1px solid ${hasError ? 'var(--color-error-500, #ef4444)' : isOpen ? 'var(--color-primary-500, #6366f1)' : 'var(--color-border, rgba(255, 255, 255, 0.08))'}`,
    borderRadius: 'var(--radius-lg, 0.5rem)',
    backgroundColor: disabled ? 'var(--color-gray-800, #1e1e23)' : 'var(--color-surface, #16161a)',
    color: selectedLabels ? 'var(--color-text, #ececf0)' : 'var(--color-text-muted, #a1a1aa)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    outline: 'none',
    boxShadow: hasError
      ? isOpen
        ? '0 0 0 3px rgba(239, 68, 68, 0.15), 0 1px 2px rgba(0, 0, 0, 0.05)'
        : '0 1px 2px rgba(0, 0, 0, 0.05)'
      : isOpen
        ? '0 0 0 3px rgba(99, 102, 241, 0.15), 0 1px 2px rgba(0, 0, 0, 0.05)'
        : '0 1px 2px rgba(0, 0, 0, 0.05)',
    transition: 'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',
    opacity: disabled ? 0.6 : 1,
  };

  const dropdownStyle: React.CSSProperties = {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: '6px',
    backgroundColor: 'var(--color-surface, #16161a)',
    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    borderRadius: 'var(--radius-lg, 0.5rem)',
    boxShadow:
      '0 12px 28px -5px rgba(0, 0, 0, 0.3), 0 8px 16px -8px rgba(0, 0, 0, 0.2), 0 0 0 1px rgba(255, 255, 255, 0.04)',
    zIndex: 50,
    maxHeight: '300px',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    animation: 'softn-select-dropdown-enter 200ms cubic-bezier(0.16, 1, 0.3, 1)',
    transformOrigin: 'top center',
  };

  const searchInputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.75rem 1rem',
    fontSize: config.fontSize,
    border: 'none',
    borderBottom: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    outline: 'none',
    backgroundColor: 'var(--color-gray-800, #1e1e23)',
    color: 'var(--color-text, #ececf0)',
  };

  const listStyle: React.CSSProperties = {
    flex: 1,
    overflowY: 'auto',
    padding: '0.25rem',
  };

  const optionStyle = (
    isHighlighted: boolean,
    isSelected: boolean,
    isDisabled: boolean
  ): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.625rem 0.75rem',
    fontSize: config.fontSize,
    borderRadius: 'var(--radius-md, 0.375rem)',
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    backgroundColor: isSelected
      ? 'var(--color-primary-500, rgba(99, 102, 241, 0.15))'
      : isHighlighted
        ? 'var(--color-gray-800, #1e1e23)'
        : 'transparent',
    color: isDisabled
      ? 'var(--color-text-muted, #a1a1aa)'
      : isSelected
        ? 'var(--color-primary-400, #818cf8)'
        : 'var(--color-text, #ececf0)',
    fontWeight: isSelected ? 600 : 400,
    opacity: isDisabled ? 0.5 : 1,
    transition: 'all 120ms cubic-bezier(0.16, 1, 0.3, 1)',
    margin: '2px 0',
    boxShadow: isSelected
      ? 'inset 0 0 0 1px var(--color-primary-500, rgba(99, 102, 241, 0.3))'
      : isHighlighted
        ? 'inset 0 0 0 1px var(--color-border, rgba(255, 255, 255, 0.1))'
        : 'none',
  });

  const groupLabelStyle: React.CSSProperties = {
    padding: '0.5rem 0.75rem 0.25rem',
    fontSize: '0.75rem',
    fontWeight: 600,
    color: 'var(--color-gray-500, #6b7280)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
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

  const iconContainerStyle: React.CSSProperties = {
    position: 'absolute',
    right: '0.5rem',
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
    pointerEvents: 'none',
  };

  // Check if value is selected (for multi-select)
  const isValueSelected = (optionValue: string): boolean => {
    if (multiple) {
      return Array.isArray(value) && value.includes(optionValue);
    }
    return value === optionValue;
  };

  // Render dropdown
  const renderDropdown = () => {
    if (!isOpen) return null;

    let optionIndex = 0;

    return (
      <>
        <style>{`
          @keyframes softn-select-dropdown-enter {
            0% { opacity: 0; transform: scale(0.95) translateY(-8px); }
            100% { opacity: 1; transform: scale(1) translateY(0); }
          }
        `}</style>
        <div style={dropdownStyle}>
          {searchable && (
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={handleSearchChange}
              placeholder={searchPlaceholder}
              style={searchInputStyle}
              onClick={(e) => e.stopPropagation()}
            />
          )}
          <div ref={listRef} style={listStyle}>
            {loading ? (
              <div
                style={{
                  padding: '1rem',
                  textAlign: 'center',
                  color: 'var(--color-gray-500, #6b7280)',
                }}
              >
                Loading...
              </div>
            ) : flatFilteredOptions.length === 0 ? (
              <div style={{ padding: '1rem' }}>
                <div style={{ textAlign: 'center', color: 'var(--color-gray-500, #6b7280)' }}>
                  {noOptionsText}
                </div>
                {onCreate && searchQuery.trim() && (
                  <button
                    onClick={handleCreate}
                    style={{
                      display: 'block',
                      width: '100%',
                      marginTop: '0.5rem',
                      padding: '0.5rem',
                      border: 'none',
                      borderRadius: 'var(--radius-sm, 0.25rem)',
                      backgroundColor: 'var(--color-primary-50, #eff6ff)',
                      color: 'var(--color-primary-700, #1d4ed8)',
                      cursor: 'pointer',
                      fontSize: config.fontSize,
                    }}
                  >
                    {createOptionText?.(searchQuery) ?? `Create "${searchQuery}"`}
                  </button>
                )}
              </div>
            ) : (
              filteredOptions.map((opt, groupIndex) => {
                if (isOptionGroup(opt)) {
                  return (
                    <div key={`group-${groupIndex}`}>
                      <div style={groupLabelStyle}>{opt.label}</div>
                      {opt.options.map((option) => {
                        const currentIndex = optionIndex++;
                        const isHighlighted = currentIndex === highlightedIndex;
                        const isSelected = isValueSelected(option.value);

                        return (
                          <div
                            key={option.value}
                            data-highlighted={isHighlighted}
                            style={optionStyle(isHighlighted, isSelected, option.disabled ?? false)}
                            onClick={() => !option.disabled && handleSelect(option.value)}
                            onMouseEnter={() => setHighlightedIndex(currentIndex)}
                          >
                            {multiple && (
                              <span
                                style={{
                                  width: 16,
                                  height: 16,
                                  borderRadius: 3,
                                  border: `2px solid ${isSelected ? 'var(--color-primary-500, #6366f1)' : 'var(--color-gray-300, #d1d5db)'}`,
                                  backgroundColor: isSelected
                                    ? 'var(--color-primary-500, #6366f1)'
                                    : 'transparent',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                {isSelected && (
                                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                                    <path
                                      d="M2 6l3 3 5-6"
                                      stroke="white"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                )}
                              </span>
                            )}
                            {option.icon && <span>{option.icon}</span>}
                            <span style={{ flex: 1 }}>
                              {option.label}
                              {option.description && (
                                <span
                                  style={{
                                    display: 'block',
                                    fontSize: '0.75rem',
                                    color: 'var(--color-gray-500, #6b7280)',
                                  }}
                                >
                                  {option.description}
                                </span>
                              )}
                            </span>
                            {!multiple && isSelected && (
                              <svg
                                width={config.iconSize}
                                height={config.iconSize}
                                viewBox="0 0 16 16"
                                fill="currentColor"
                              >
                                <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06l2.72 2.72 6.72-6.72a.75.75 0 011.06 0z" />
                              </svg>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                }

                const currentIndex = optionIndex++;
                const isHighlighted = currentIndex === highlightedIndex;
                const isSelected = isValueSelected(opt.value);

                return (
                  <div
                    key={opt.value}
                    data-highlighted={isHighlighted}
                    style={optionStyle(isHighlighted, isSelected, opt.disabled ?? false)}
                    onClick={() => !opt.disabled && handleSelect(opt.value)}
                    onMouseEnter={() => setHighlightedIndex(currentIndex)}
                  >
                    {multiple && (
                      <span
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 3,
                          border: `2px solid ${isSelected ? 'var(--color-primary-500, #6366f1)' : 'var(--color-gray-300, #d1d5db)'}`,
                          backgroundColor: isSelected
                            ? 'var(--color-primary-500, #6366f1)'
                            : 'transparent',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {isSelected && (
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                            <path
                              d="M2 6l3 3 5-6"
                              stroke="white"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </span>
                    )}
                    {opt.icon && <span>{opt.icon}</span>}
                    <span style={{ flex: 1 }}>
                      {opt.label}
                      {opt.description && (
                        <span
                          style={{
                            display: 'block',
                            fontSize: '0.75rem',
                            color: 'var(--color-gray-500, #6b7280)',
                          }}
                        >
                          {opt.description}
                        </span>
                      )}
                    </span>
                    {!multiple && isSelected && (
                      <svg
                        width={config.iconSize}
                        height={config.iconSize}
                        viewBox="0 0 16 16"
                        fill="currentColor"
                      >
                        <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06l2.72 2.72 6.72-6.72a.75.75 0 011.06 0z" />
                      </svg>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </>
    );
  };

  const hasValue = multiple ? Array.isArray(value) && value.length > 0 : Boolean(value);

  return (
    <div style={{ width: fullWidth ? '100%' : undefined }}>
      {label && (
        <label style={labelStyle}>
          {label}
          {required && <span style={{ color: 'var(--color-error-500, #ef4444)' }}> *</span>}
        </label>
      )}
      <div ref={containerRef} className={className} style={containerStyle}>
        <input type="hidden" name={name} value={Array.isArray(value) ? value.join(',') : value} />
        <div
          tabIndex={disabled ? -1 : 0}
          style={triggerStyle}
          onClick={() => !disabled && setIsOpen(!isOpen)}
          onKeyDown={handleKeyDown}
          onFocus={onFocus}
          onBlur={() => {
            if (!isOpen) onBlur?.();
          }}
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-disabled={disabled}
        >
          <span
            style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {selectedLabels || placeholder}
          </span>
          <div style={iconContainerStyle}>
            {clearable && hasValue && !disabled && (
              <button
                type="button"
                onClick={handleClear}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  padding: 0,
                  border: 'none',
                  background: 'none',
                  color: 'var(--color-gray-400, #9ca3af)',
                  cursor: 'pointer',
                  pointerEvents: 'auto',
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M4 4l6 6M10 4l-6 6" strokeLinecap="round" />
                </svg>
              </button>
            )}
            <svg
              width={config.iconSize}
              height={config.iconSize}
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--color-gray-400, #9ca3af)"
              strokeWidth="2"
              strokeLinecap="round"
              style={{
                transform: isOpen ? 'rotate(180deg)' : undefined,
                transition: 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            >
              <path d="M4 6l4 4 4-4" />
            </svg>
          </div>
        </div>
        {renderDropdown()}
      </div>
      {errorMessage && <div style={errorStyle}>{errorMessage}</div>}
    </div>
  );
}

export default Select;
