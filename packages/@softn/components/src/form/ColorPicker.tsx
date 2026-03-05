/**
 * ColorPicker Component
 *
 * A color selection input with palette and custom color support.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

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
  const sizes = sizeValues[size];

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
      setSelectedColor(normalized);
      setInputValue(normalized);
      onChange?.(normalized);
    },
    [onChange]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setInputValue(value);

      const normalized = normalizeHex(value);
      if (isValidHex(normalized)) {
        setSelectedColor(normalized);
        onChange?.(normalized);
      }
    },
    [onChange]
  );

  const handleInputBlur = useCallback(() => {
    // Reset to valid color on blur
    setInputValue(selectedColor);
  }, [selectedColor]);

  const handleNativeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const color = normalizeHex(e.target.value);
      setSelectedColor(color);
      setInputValue(color);
      onChange?.(color);
    },
    [onChange]
  );

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
    background: disabled ? 'var(--color-gray-800, #1e1e23)' : 'var(--color-surface, #16161a)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };

  const swatchStyle: React.CSSProperties = {
    width: sizes.swatch,
    height: sizes.swatch,
    borderRadius: '0.25rem',
    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    background: selectedColor,
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

  const presetSwatchStyle = (color: string): React.CSSProperties => ({
    width: '1.5rem',
    height: '1.5rem',
    borderRadius: '0.25rem',
    border: selectedColor === normalizeHex(color) ? '2px solid #6366f1' : '1px solid var(--color-border, #3f3f46)',
    background: color,
    cursor: 'pointer',
    outline: selectedColor === normalizeHex(color) ? '2px solid rgba(99, 102, 241, 0.5)' : 'none',
    outlineOffset: '1px',
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
  };

  return (
    <div ref={containerRef} className={className} style={containerStyle}>
      {label && <label style={labelStyle}>{label}</label>}

      <div style={triggerStyle} onClick={() => !disabled && setIsOpen(!isOpen)}>
        <div style={swatchStyle} />
        {showInput && (
          <span
            style={{
              fontSize: sizes.fontSize,
              fontFamily: 'ui-monospace, monospace',
              color: 'var(--color-text, #e4e4e7)',
            }}
          >
            {selectedColor}
          </span>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--color-text-muted, #a1a1aa)' }}>▼</span>
      </div>

      {isOpen && !disabled && (
        <div style={dropdownStyle}>
          <div
            style={{
              marginBottom: '0.5rem',
              fontSize: '0.75rem',
              fontWeight: 500,
              color: 'var(--color-text-muted, #a1a1aa)',
            }}
          >
            Preset Colors
          </div>
          <div style={presetGridStyle}>
            {presets.map((color, index) => (
              <button
                key={index}
                type="button"
                style={presetSwatchStyle(color)}
                onClick={() => handleColorSelect(color)}
                title={color}
              />
            ))}
          </div>

          <div style={inputContainerStyle}>
            <input
              type="color"
              value={selectedColor}
              onChange={handleNativeChange}
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
            />
          </div>

          <input type="hidden" name={name} value={selectedColor} />
        </div>
      )}
    </div>
  );
}

export default ColorPicker;
