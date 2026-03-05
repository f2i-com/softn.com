/**
 * Menu Component
 *
 * A dropdown menu for actions and navigation.
 */

import React from 'react';

export interface MenuItem {
  /** Unique key */
  key: string;
  /** Item label */
  label: React.ReactNode;
  /** Icon */
  icon?: React.ReactNode;
  /** Whether disabled */
  disabled?: boolean;
  /** Danger style */
  danger?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Divider after this item */
  divider?: boolean;
}

export interface MenuProps {
  /** Menu items */
  items: MenuItem[];
  /** Trigger element */
  trigger: React.ReactNode;
  /** Menu placement */
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
  /** Menu width */
  width?: string | number;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

export function Menu({
  items,
  trigger,
  placement = 'bottom-start',
  width = '12rem',
  className,
  style,
}: MenuProps): React.ReactElement {
  const [isOpen, setIsOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'inline-block',
    ...style,
  };

  const getMenuStyle = (): React.CSSProperties => {
    const base: React.CSSProperties = {
      position: 'absolute',
      zIndex: 1000,
      minWidth: typeof width === 'number' ? `${width}px` : width,
      backgroundColor: 'var(--color-surface, #16161a)',
      borderRadius: '0.5rem',
      boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -2px rgba(0, 0, 0, 0.2)',
      border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
      padding: '0.25rem',
      opacity: isOpen ? 1 : 0,
      visibility: isOpen ? 'visible' : 'hidden',
      transform: isOpen ? 'translateY(0)' : 'translateY(-0.5rem)',
      transition: 'opacity 180ms cubic-bezier(0.16, 1, 0.3, 1), transform 180ms cubic-bezier(0.16, 1, 0.3, 1), visibility 180ms',
    };

    switch (placement) {
      case 'bottom-start':
        return { ...base, top: '100%', left: 0, marginTop: '0.25rem' };
      case 'bottom-end':
        return { ...base, top: '100%', right: 0, marginTop: '0.25rem' };
      case 'top-start':
        return { ...base, bottom: '100%', left: 0, marginBottom: '0.25rem' };
      case 'top-end':
        return { ...base, bottom: '100%', right: 0, marginBottom: '0.25rem' };
      default:
        return base;
    }
  };

  const getItemStyle = (item: MenuItem): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    width: '100%',
    padding: '0.5rem 0.75rem',
    fontSize: '0.875rem',
    color: item.danger ? '#dc2626' : item.disabled ? '#9ca3af' : 'var(--color-text, #ececf0)',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: '0.25rem',
    cursor: item.disabled ? 'not-allowed' : 'pointer',
    textAlign: 'left',
    transition: 'background-color 150ms cubic-bezier(0.16, 1, 0.3, 1)',
  });

  const handleItemClick = (item: MenuItem) => {
    if (!item.disabled) {
      item.onClick?.();
      setIsOpen(false);
    }
  };

  return (
    <div ref={menuRef} className={className} style={containerStyle}>
      <div onClick={() => setIsOpen(!isOpen)} style={{ cursor: 'pointer' }}>
        {trigger}
      </div>
      <div style={getMenuStyle()} role="menu">
        {items.map((item, index) => (
          <React.Fragment key={item.key}>
            <button
              role="menuitem"
              disabled={item.disabled}
              onClick={() => handleItemClick(item)}
              style={getItemStyle(item)}
              onMouseEnter={(e) => {
                if (!item.disabled) {
                  e.currentTarget.style.backgroundColor = 'var(--color-surface-raised, #27272a)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              {item.icon}
              {item.label}
            </button>
            {item.divider && index < items.length - 1 && (
              <div
                style={{
                  height: '1px',
                  backgroundColor: 'var(--color-surface-raised, #3f3f46)',
                  margin: '0.25rem 0',
                }}
              />
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

export default Menu;
