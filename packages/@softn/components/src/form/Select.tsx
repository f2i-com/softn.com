/**
 * Select Component
 *
 * A customizable dropdown select with search, multi-select,
 * grouped options, and keyboard navigation.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo, useId } from 'react';

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

// Type guard for option groups.
//
// The object check is not decoration: `in` throws a TypeError on a primitive,
// and this is reached from a useMemo on the render path — so `options={['red',
// 'green']}` did not degrade, it threw during render and threw again on every
// retry, replacing the field with an error box for good.
function isOptionGroup(option: SelectOption | SelectOptionGroup): option is SelectOptionGroup {
  return typeof option === 'object' && option !== null && 'options' in option;
}

/** A bare string is a perfectly reasonable option, and is what SmartForm already accepts. */
function normaliseOption(option: SelectOption | SelectOptionGroup | string | number): SelectOption | SelectOptionGroup {
  if (typeof option === 'object' && option !== null) {
    // A group's members can be bare strings too, and only the outer array was
    // ever being normalised.
    if (isOptionGroup(option)) {
      const members = Array.isArray(option.options) ? option.options : [];
      return { ...option, options: members.map((o) => normaliseOption(o) as SelectOption) };
    }
    return option;
  }
  return { value: String(option), label: String(option) };
}

// Flatten options for easier searching
function flattenOptions(options: SelectOptions): SelectOption[] {
  if (!Array.isArray(options)) return [];
  return options
    .map(normaliseOption)
    .flatMap((opt) => (isOptionGroup(opt) ? opt.options : [opt]));
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

  const [isFocused, setIsFocused] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Typeahead: what has been typed on the trigger, and when. */
  const typeahead = useRef({ text: '', at: 0 });

  const baseId = useId();
  const labelId = `${baseId}-label`;
  const listboxId = `${baseId}-listbox`;
  const errorId = `${baseId}-error`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const value = controlledValue !== undefined ? controlledValue : internalValue;
  const hasError = Boolean(error);
  const errorMessage = typeof error === 'string' ? error : undefined;
  const config = sizeConfig[size];

  // Get all flat options for filtering
  // Normalised once, here, and used by everything below.
  //
  // The list that gets rendered used to be the caller's array untouched, while
  // only the lookup list was normalised. With `options={["quiet", "standard"]}`
  // — the shape SmartForm accepts and the obvious thing to write — the trigger
  // showed the right label while the menu below it rendered a row per option
  // with `opt.label` of undefined in it: a dropdown of blank lines, which reads
  // as text that has come out the same colour as the background.
  const normalisedOptions = useMemo(
    () => (Array.isArray(options) ? options.map(normaliseOption) : []),
    [options]
  );

  const allOptions = useMemo(() => flattenOptions(normalisedOptions), [normalisedOptions]);

  // Filter options based on search query
  const filteredOptions = useMemo(() => {
    if (!searchQuery) return normalisedOptions;

    const query = searchQuery.toLowerCase();
    return normalisedOptions
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
  }, [normalisedOptions, searchQuery]);

  const flatFilteredOptions = useMemo(() => flattenOptions(filteredOptions), [filteredOptions]);

  // Get selected option labels
  const selectedLabels = useMemo(() => {
    if (multiple) {
      const values = Array.isArray(value) ? value : [];
      return values.map((v) => allOptions.find((o) => o.value === v)?.label ?? v).join(', ');
    }
    // A value the options do not (yet) list shows as itself, as each value of
    // a multi-select already did — not as the placeholder beside a clear
    // button that clears something invisible.
    if (typeof value !== 'string' || value === '') return '';
    return allOptions.find((o) => o.value === value)?.label ?? value;
  }, [value, allOptions, multiple]);

  /** The next enabled option from `from` in direction `step`, or -1. */
  const findEnabled = useCallback(
    (from: number, step: 1 | -1): number => {
      for (let i = from; i >= 0 && i < flatFilteredOptions.length; i += step) {
        if (!flatFilteredOptions[i].disabled) return i;
      }
      return -1;
    },
    [flatFilteredOptions]
  );

  /** Open the list with the selected option (or the first enabled one) highlighted. */
  const openList = useCallback(() => {
    const selected = flatFilteredOptions.findIndex(
      (o) => !o.disabled && (Array.isArray(value) ? value.includes(o.value) : o.value === value)
    );
    setHighlightedIndex(selected >= 0 ? selected : findEnabled(0, 1));
    setIsOpen(true);
  }, [flatFilteredOptions, value, findEnabled]);

  /** Close the list; with `refocus`, put focus back on the trigger it opened from. */
  const closeList = useCallback((refocus: boolean) => {
    setIsOpen(false);
    setSearchQuery('');
    if (refocus) triggerRef.current?.focus();
  }, []);

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
        closeList(true);
      }
    },
    [value, multiple, maxSelections, controlledValue, onChange, closeList]
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
      triggerRef.current?.focus();
    },
    [multiple, controlledValue, onChange]
  );

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) return;
      const target = e.target as HTMLElement;
      // The clear and create buttons handle their own Enter and Space.
      if (target.tagName === 'BUTTON' && e.key !== 'Escape' && e.key !== 'Tab') return;
      const inSearch = target === inputRef.current;
      const selectHighlighted = () => {
        const option = flatFilteredOptions[highlightedIndex];
        if (option && !option.disabled) handleSelect(option.value);
      };

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          if (!isOpen) {
            openList();
          } else {
            const next = findEnabled(highlightedIndex + 1, 1);
            if (next >= 0) setHighlightedIndex(next);
          }
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          if (!isOpen) {
            openList();
          } else {
            const previous = findEnabled(highlightedIndex - 1, -1);
            if (previous >= 0) setHighlightedIndex(previous);
          }
          break;
        }
        case 'Home':
        case 'End': {
          // In the search box these move the caret.
          if (!isOpen || inSearch) break;
          e.preventDefault();
          const edge =
            e.key === 'Home' ? findEnabled(0, 1) : findEnabled(flatFilteredOptions.length - 1, -1);
          if (edge >= 0) setHighlightedIndex(edge);
          break;
        }
        case 'Enter':
          e.preventDefault();
          if (isOpen) selectHighlighted();
          else openList();
          break;
        case ' ':
          // A space typed into the search box is a space.
          if (inSearch) break;
          e.preventDefault();
          if (isOpen) selectHighlighted();
          else openList();
          break;
        case 'Escape':
          if (!isOpen) break;
          // Closing the list is all Escape does here: a Modal or Drawer
          // around the Select must not close with it.
          e.preventDefault();
          e.stopPropagation();
          closeList(true);
          break;
        case 'Tab':
          if (isOpen) closeList(false);
          break;
        default: {
          // Typeahead on the trigger: jump to the next option whose label
          // starts with what was typed.
          if (inSearch || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) break;
          const now = Date.now();
          const state = typeahead.current;
          const key = e.key.toLowerCase();
          state.text = now - state.at > 700 ? key : state.text + key;
          state.at = now;
          const count = flatFilteredOptions.length;
          const from = isOpen ? highlightedIndex + (state.text.length === 1 ? 1 : 0) : 0;
          for (let n = 0; n < count; n++) {
            const index = (((from + n) % count) + count) % count;
            const option = flatFilteredOptions[index];
            if (!option.disabled && option.label.toLowerCase().startsWith(state.text)) {
              if (!isOpen) setIsOpen(true);
              setHighlightedIndex(index);
              break;
            }
          }
        }
      }
    },
    [disabled, isOpen, highlightedIndex, flatFilteredOptions, handleSelect, openList, closeList, findEnabled]
  );

  // Handle search input
  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const query = e.target.value;
      setSearchQuery(query);
      setHighlightedIndex(-1);
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

  // After a search narrows the list, highlight its first enabled option.
  useEffect(() => {
    if (!isOpen) return;
    const current = flatFilteredOptions[highlightedIndex];
    if (!current || current.disabled) {
      const first = findEnabled(0, 1);
      if (first !== highlightedIndex) setHighlightedIndex(first);
    }
  }, [isOpen, flatFilteredOptions, highlightedIndex, findEnabled]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

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
    border: `1px solid ${hasError ? 'var(--color-error-500, #ef4444)' : isOpen || isFocused ? 'var(--color-primary-500, #6366f1)' : 'var(--color-border, rgba(255, 255, 255, 0.08))'}`,
    borderRadius: 'var(--radius-lg, 0.5rem)',
    backgroundColor: disabled ? 'var(--color-surface-hover, #1e1e23)' : 'var(--color-surface, #16161a)',
    color: selectedLabels ? 'var(--color-text, #ececf0)' : 'var(--color-text-muted, #a1a1aa)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    outline: 'none',
    // The trigger draws its own focus ring (its outline is off), so the ring
    // shows while it is focused, not only while the list is open: a keyboard
    // user who has just picked an option is left on a closed Select.
    boxShadow: hasError
      ? isOpen || isFocused
        ? '0 0 0 3px rgba(239, 68, 68, 0.35), 0 1px 2px rgba(0, 0, 0, 0.05)'
        : '0 1px 2px rgba(0, 0, 0, 0.05)'
      : isOpen || isFocused
        ? '0 0 0 3px rgba(99, 102, 241, 0.35), 0 1px 2px rgba(0, 0, 0, 0.05)'
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
    backgroundColor: 'var(--color-surface-hover, #1e1e23)',
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
    // A translucent wash of the primary over the surface, not a fixed tint.
    // `--color-primary-100` is the same pale swatch in both themes, so in a
    // dark theme the selected row was pale amber under pale text — the one
    // row you could not read. Mixing the full-strength primary into
    // transparent keeps the surface underneath, and the label keeps the
    // ordinary text colour, so it reads whichever way the theme goes.
    backgroundColor: isSelected
      ? 'color-mix(in srgb, var(--color-primary-500, #6366f1) 24%, transparent)'
      : isHighlighted
        ? 'var(--color-surface-hover, #1e1e23)'
        : 'transparent',
    color: isDisabled
      ? 'var(--color-text-muted, #a1a1aa)'
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
    color: 'var(--color-text-muted, #8b8b96)',
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

  const renderOption = (option: SelectOption, index: number) => {
    const isHighlighted = index === highlightedIndex;
    const isSelected = isValueSelected(option.value);
    const isDisabled = option.disabled ?? false;
    return (
      <div
        key={option.value}
        id={optionId(index)}
        role="option"
        aria-selected={isSelected}
        aria-disabled={isDisabled || undefined}
        data-highlighted={isHighlighted}
        style={optionStyle(isHighlighted, isSelected, isDisabled)}
        onClick={() => !isDisabled && handleSelect(option.value)}
        onMouseEnter={() => setHighlightedIndex(index)}
      >
        {multiple && (
          <span
            aria-hidden="true"
            style={{
              width: 16,
              height: 16,
              borderRadius: 3,
              border: `2px solid ${isSelected ? 'var(--color-primary-500, #6366f1)' : 'var(--color-border-hover, rgba(255, 255, 255, 0.14))'}`,
              backgroundColor: isSelected ? 'var(--color-primary-500, #6366f1)' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 'none',
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
        {option.icon && <span aria-hidden="true">{option.icon}</span>}
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
          {option.label}
          {option.description && (
            <span
              style={{
                display: 'block',
                fontSize: '0.75rem',
                color: 'var(--color-text-muted, #8b8b96)',
              }}
            >
              {option.description}
            </span>
          )}
        </span>
        {!multiple && isSelected && (
          <svg
            aria-hidden="true"
            width={config.iconSize}
            height={config.iconSize}
            viewBox="0 0 16 16"
            fill="currentColor"
            style={{ flex: 'none' }}
          >
            <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06l2.72 2.72 6.72-6.72a.75.75 0 011.06 0z" />
          </svg>
        )}
      </div>
    );
  };

  // Render dropdown
  const renderDropdown = () => {
    if (!isOpen) return null;

    let optionIndex = 0;
    const hasOptions = !loading && flatFilteredOptions.length > 0;

    return (
      <>
        <style>{`
          @keyframes softn-select-dropdown-enter {
            0% { opacity: 0; transform: scale(0.95) translateY(-8px); }
            100% { opacity: 1; transform: scale(1) translateY(0); }
          }
        `}</style>
        {/*
          Pressing an option must not take focus off the trigger or the search
          box: the list is not focusable, so the press would blur to <body>
          and the Select would close before the click that selects landed.
        */}
        <div
          style={dropdownStyle}
          onMouseDown={(e) => {
            if (e.target !== inputRef.current) e.preventDefault();
          }}
        >
          {searchable && (
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={handleSearchChange}
              placeholder={searchPlaceholder}
              style={searchInputStyle}
              onClick={(e) => e.stopPropagation()}
              role="combobox"
              aria-label={searchPlaceholder}
              aria-expanded={true}
              aria-controls={hasOptions ? listboxId : undefined}
              aria-autocomplete="list"
              aria-activedescendant={
                hasOptions && highlightedIndex >= 0 ? optionId(highlightedIndex) : undefined
              }
            />
          )}
          <div
            ref={listRef}
            style={listStyle}
            id={hasOptions ? listboxId : undefined}
            role={hasOptions ? 'listbox' : undefined}
            aria-labelledby={hasOptions && label ? labelId : undefined}
            aria-multiselectable={hasOptions && multiple ? true : undefined}
          >
            {loading ? (
              <div
                role="status"
                style={{
                  padding: '1rem',
                  textAlign: 'center',
                  color: 'var(--color-text-muted, #8b8b96)',
                }}
              >
                Loading...
              </div>
            ) : flatFilteredOptions.length === 0 ? (
              <div style={{ padding: '1rem' }}>
                <div
                  role="status"
                  style={{ textAlign: 'center', color: 'var(--color-text-muted, #8b8b96)' }}
                >
                  {noOptionsText}
                </div>
                {onCreate && searchQuery.trim() && (
                  <button
                    type="button"
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
                  const groupLabelId = `${baseId}-group-${groupIndex}`;
                  return (
                    <div key={`group-${groupIndex}`} role="group" aria-labelledby={groupLabelId}>
                      <div id={groupLabelId} role="presentation" style={groupLabelStyle}>
                        {opt.label}
                      </div>
                      {opt.options.map((option) => renderOption(option, optionIndex++))}
                    </div>
                  );
                }
                return renderOption(opt, optionIndex++);
              })
            )}
          </div>
        </div>
      </>
    );
  };

  const hasValue = multiple ? Array.isArray(value) && value.length > 0 : Boolean(value);

  const activeDescendant =
    isOpen && !searchable && !loading && flatFilteredOptions[highlightedIndex]
      ? optionId(highlightedIndex)
      : undefined;

  return (
    <div style={{ width: fullWidth ? '100%' : undefined }}>
      {label && (
        <label
          id={labelId}
          style={labelStyle}
          onClick={() => {
            if (!disabled) triggerRef.current?.focus();
          }}
        >
          {label}
          {required && (
            <span aria-hidden="true" style={{ color: 'var(--color-error-500, #ef4444)' }}>
              {' '}
              *
            </span>
          )}
        </label>
      )}
      {/*
        The keydown handler lives on the wrapper, not the trigger.
        Opening a searchable Select focuses the search input, which sits inside
        `renderDropdown()` — a sibling of the trigger — so keystrokes never
        reached a handler bound to the trigger alone. Arrow keys did nothing and
        Enter selected nothing; inside a <form>, Enter submitted it instead.
        Bound here, the handler sees keys from the trigger and the dropdown
        both.

        Blur is judged here too: focus moving from the trigger to the search
        box is still inside the Select, and focus leaving it while the list is
        open is still the field losing focus, so `onBlur` hears about it.
      */}
      <div
        ref={containerRef}
        className={className}
        style={containerStyle}
        onKeyDown={handleKeyDown}
        onBlur={(e) => {
          if (containerRef.current?.contains(e.relatedTarget as Node | null)) return;
          if (isOpen) {
            setIsOpen(false);
            setSearchQuery('');
          }
          onBlur?.();
        }}
      >
        <input type="hidden" name={name} value={Array.isArray(value) ? value.join(',') : value} />
        <div
          ref={triggerRef}
          tabIndex={disabled ? -1 : 0}
          style={triggerStyle}
          onClick={() => {
            if (disabled) return;
            if (isOpen) closeList(false);
            else openList();
          }}
          onFocus={() => {
            setIsFocused(true);
            onFocus?.();
          }}
          onBlur={() => setIsFocused(false)}
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-controls={isOpen && !loading && flatFilteredOptions.length > 0 ? listboxId : undefined}
          aria-activedescendant={activeDescendant}
          aria-labelledby={label ? labelId : undefined}
          aria-describedby={errorMessage ? errorId : undefined}
          aria-invalid={hasError || undefined}
          aria-required={required || undefined}
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
                aria-label="Clear selection"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  padding: 0,
                  border: 'none',
                  background: 'none',
                  color: 'var(--color-text-muted, #8b8b96)',
                  cursor: 'pointer',
                  pointerEvents: 'auto',
                }}
              >
                <svg
                  aria-hidden="true"
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
              aria-hidden="true"
              width={config.iconSize}
              height={config.iconSize}
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--color-text-muted, #8b8b96)"
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
      {errorMessage && (
        <div id={errorId} style={errorStyle}>
          {errorMessage}
        </div>
      )}
    </div>
  );
}

export default Select;
