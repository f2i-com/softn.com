/**
 * ColorPicker Component
 *
 * A color selection input with palette and custom color support.
 */

import React, { useState, useCallback, useRef, useEffect, useId } from 'react';
import { cssPaint } from '../utils/egress';

export interface ColorPickerProps {
  /** Current color value (hex) */
  value?: string;
  /** Default value */
  defaultValue?: string;
  /** Input name */
  name?: string;
  /** Label text */
  label?: string;
  /** Whether disabled */
  disabled?: boolean;
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** Preset colors to show */
  presets?: string[];
  /** Show text input for hex value */
  showInput?: boolean;
  /** Full width */
  fullWidth?: boolean;
  /** Change handler */
  onChange?: (color: string) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const DEFAULT_PRESETS = [
  // Grays
  '#000000',
  '#374151',
  '#6b7280',
  '#9ca3af',
  '#d1d5db',
  '#f3f4f6',
  '#ffffff',
  // Colors
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#eab308',
  '#84cc16',
  '#22c55e',
  '#10b981',
  '#14b8a6',
  '#06b6d4',
  '#0ea5e9',
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#d946ef',
  '#ec4899',
  '#f43f5e',
];

const sizeValues: Record<string, { swatch: string; fontSize: string }> = {
  sm: { swatch: '1.5rem', fontSize: '0.75rem' },
  md: { swatch: '2rem', fontSize: '0.875rem' },
  lg: { swatch: '2.5rem', fontSize: '1rem' },
};

function isValidHex(color: string): boolean {
  return /^#([0-9A-Fa-f]{3}){1,2}$/.test(color);
}

function normalizeHex(color: string): string {
  if (!color.startsWith('#')) {
    color = '#' + color;
  }
  if (color.length === 4) {
    // Expand short form (#RGB -> #RRGGBB)
    color = '#' + color[1] + color[1] + color[2] + color[2] + color[3] + color[3];
  }
  return color.toUpperCase();
}

export function ColorPicker({
  value,
  defaultValue = '#6366f1',
  name,
  label,
  disabled = false,
  size = 'md',
  presets = DEFAULT_PRESETS,
  showInput = true,
  fullWidth = false,
  onChange,
  className,
  style,
}: ColorPickerProps): React.ReactElement {
  const [selectedColor, setSelectedColor] = useState(normalizeHex(value ?? defaultValue));
  const [inputValue, setInputValue] = useState(selectedColor);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sizes = sizeValues[size];
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const panelId = `${baseId}-panel`;
  // With `value`, the parent decides what is selected; a change it does not
  // accept must not show anyway.
  const isControlled = value !== undefined;

  useEffect(() => {
    if (value !== undefined) {
      const normalized = normalizeHex(value);
      setSelectedColor(normalized);
      setInputValue(normalized);
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

  const handleColorSelect = useCallback(
    (color: string) => {
      const normalized = normalizeHex(color);
      if (!isControlled) setSelectedColor(normalized);
      setInputValue(normalized);
      onChange?.(normalized);
    },
    [onChange, isControlled]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setInputValue(value);

      const normalized = normalizeHex(value);
      if (isValidHex(normalized)) {
        if (!isControlled) setSelectedColor(normalized);
        onChange?.(normalized);
      }
    },
    [onChange, isControlled]
  );

  const handleInputBlur = useCallback(() => {
    // Reset to valid color on blur
    setInputValue(selectedColor);
  }, [selectedColor]);

  const handleNativeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const color = normalizeHex(e.target.value);
      if (!isControlled) setSelectedColor(color);
      setInputValue(color);
      onChange?.(color);
    },
    [onChange, isControlled]
  );

  const close = useCallback((refocus: boolean) => {
    setIsOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    flexDirection: 'column',
    gap: '0.375rem',
    width: fullWidth ? '100%' : undefined,
    ...style,
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: 500,
    color: 'var(--color-text, #ececf0)',
  };

  const triggerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.375rem 0.5rem',
    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    borderRadius: '0.375rem',
    background: disabled ? 'var(--color-surface-hover, #1e1e23)' : 'var(--color-surface, #16161a)',
    color: 'var(--color-text, #e4e4e7)',
    font: 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };

  const swatchStyle: React.CSSProperties = {
    width: sizes.swatch,
    height: sizes.swatch,
    borderRadius: '0.25rem',
    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    // `value` and `presets` are the bundle's, and `background` fetches a
    // `url()`: normalizeHex only prefixes `#` and uppercases, and CSS function
    // names ignore case, so `fff url(https://…)` still loaded as an image.
    background: cssPaint(selectedColor),
    flexShrink: 0,
  };

  const dropdownStyle: React.CSSProperties = {
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
    minWidth: '240px',
  };

  const presetGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: '0.25rem',
  };

  // The selected swatch wears a ring of its own. The others leave `outline`
  // alone, so the keyboard focus ring still shows on whichever has focus;
  // `outline: none` made a focused swatch look exactly like any other.
  const presetSwatchStyle = (color: string): React.CSSProperties => ({
    width: '1.5rem',
    height: '1.5rem',
    padding: 0,
    borderRadius: '0.25rem',
    border: selectedColor === normalizeHex(color) ? '2px solid var(--color-primary-500, #6366f1)' : '1px solid var(--color-border, #3f3f46)',
    background: cssPaint(color),
    cursor: 'pointer',
    boxShadow: selectedColor === normalizeHex(color) ? '0 0 0 2px rgba(99, 102, 241, 0.5)' : undefined,
  });

  const inputContainerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginTop: '0.75rem',
    paddingTop: '0.75rem',
    borderTop: '1px solid var(--color-border, #3f3f46)',
  };

  const hexInputStyle: React.CSSProperties = {
    flex: 1,
    padding: '0.375rem 0.5rem',
    border: '1px solid var(--color-border, #3f3f46)',
    borderRadius: '0.25rem',
    fontSize: sizes.fontSize,
    fontFamily: 'ui-monospace, monospace',
    textTransform: 'uppercase',
    background: 'var(--color-bg, transparent)',
    color: 'var(--color-text, inherit)',
  };

  return (
    <div
      ref={containerRef}
      className={className}
      style={containerStyle}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !isOpen) return;
        // Close the palette only — not a Modal the picker sits in.
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }}
    >
      {label && (
        <label
          id={labelId}
          style={labelStyle}
          onClick={() => {
            if (!disabled) triggerRef.current?.focus();
          }}
        >
          {label}
        </label>
      )}

      {/*
        A real button: the trigger was a <div onClick>, which Tab never
        reaches, so a keyboard user could not open the palette at all.
      */}
      <button
        ref={triggerRef}
        type="button"
        style={triggerStyle}
        disabled={disabled}
        onClick={() => (isOpen ? close(false) : setIsOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        aria-labelledby={label ? `${labelId} ${baseId}-value` : undefined}
        aria-label={label ? undefined : `Colour ${selectedColor}`}
      >
        <span aria-hidden="true" style={{ ...swatchStyle, display: 'block' }} />
        {showInput && (
          <span
            id={`${baseId}-value`}
            style={{
              fontSize: sizes.fontSize,
              fontFamily: 'ui-monospace, monospace',
              color: 'var(--color-text, #e4e4e7)',
            }}
          >
            {selectedColor}
          </span>
        )}
        {!showInput && (
          <span id={`${baseId}-value`} hidden>
            {selectedColor}
          </span>
        )}
        <span aria-hidden="true" style={{ marginLeft: 'auto', color: 'var(--color-text-muted, #a1a1aa)' }}>
          ▼
        </span>
      </button>

      {/*
        The form value lives beside the trigger, always. Inside the palette it
        was only in the form while the palette happened to be open.
      */}
      <input type="hidden" name={name} value={selectedColor} />

      {isOpen && !disabled && (
        <div
          id={panelId}
          role="dialog"
          aria-label={label ? `${label} palette` : 'Colour palette'}
          style={dropdownStyle}
        >
          <div
            id={`${baseId}-presets`}
            style={{
              marginBottom: '0.5rem',
              fontSize: '0.75rem',
              fontWeight: 500,
              color: 'var(--color-text-muted, #a1a1aa)',
            }}
          >
            Preset Colors
          </div>
          <div style={presetGridStyle} role="group" aria-labelledby={`${baseId}-presets`}>
            {presets.map((color, index) => (
              <button
                key={index}
                type="button"
                style={presetSwatchStyle(color)}
                onClick={() => handleColorSelect(color)}
                title={color}
                aria-label={color}
                aria-pressed={selectedColor === normalizeHex(color)}
              />
            ))}
          </div>

          <div style={inputContainerStyle}>
            <input
              type="color"
              value={selectedColor}
              onChange={handleNativeChange}
              aria-label="Custom colour"
              style={{
                width: '2rem',
                height: '2rem',
                border: 'none',
                borderRadius: '0.25rem',
                cursor: 'pointer',
                padding: 0,
              }}
            />
            <input
              type="text"
              value={inputValue}
              onChange={handleInputChange}
              onBlur={handleInputBlur}
              maxLength={7}
              style={hexInputStyle}
              placeholder="#RRGGBB"
              aria-label="Hex colour"
              spellCheck={false}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default ColorPicker;
