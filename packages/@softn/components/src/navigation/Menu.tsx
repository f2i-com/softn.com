/**
 * Menu Component
 *
 * A dropdown menu for actions and navigation, following the WAI-ARIA menu
 * button pattern: the trigger is a button that says it opens a menu and
 * whether it is open; opening from the keyboard puts focus on the first item;
 * the arrow keys, Home and End move between items (one tab stop for the whole
 * menu); Escape closes and gives focus back to the trigger, and Tab closes
 * and moves on.
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
  /** Accessible name for the trigger, when its content does not give one (an icon) */
  ariaLabel?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const TRIGGER_RESET: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: 0,
  margin: 0,
  border: 'none',
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'inherit',
  cursor: 'pointer',
};

/** Whether a node renders a focusable control of its own (a Button, a link). */
function isInteractiveElement(node: React.ReactNode): boolean {
  if (!React.isValidElement(node)) return false;
  const type = node.type;
  if (typeof type === 'string') return ['button', 'a', 'input', 'select', 'textarea'].includes(type);
  const name = (type as { displayName?: string; name?: string }).displayName ?? (type as { name?: string }).name;
  return name === 'Button' || name === 'IconButton';
}

export function Menu({
  items: rawItems,
  trigger,
  placement = 'bottom-start',
  width = '12rem',
  ariaLabel,
  className,
  style,
}: MenuProps): React.ReactElement {
  const items = React.useMemo(() => (Array.isArray(rawItems) ? rawItems.filter(Boolean) : []), [rawItems]);
  const [isOpen, setIsOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = React.useId();
  const menuId = `${baseId}-menu`;
  const triggerId = `${baseId}-trigger`;

  const enabledIndexes = React.useMemo(
    () => items.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index >= 0),
    [items]
  );

  // The trigger content is a Button more often than not; nesting it in a
  // second <button> is invalid and gives two tab stops, so an interactive
  // trigger is wrapped in a span and given the menu-button attributes itself.
  const triggerIsInteractive = isInteractiveElement(trigger);

  const focusItem = React.useCallback((index: number) => {
    setActiveIndex(index);
    itemRefs.current[index]?.focus();
  }, []);

  const open = React.useCallback(
    (focus: 'first' | 'last' | 'none') => {
      setIsOpen(true);
      if (focus === 'none') {
        setActiveIndex(-1);
        return;
      }
      const index = focus === 'first' ? enabledIndexes[0] : enabledIndexes[enabledIndexes.length - 1];
      setActiveIndex(index ?? -1);
    },
    [enabledIndexes]
  );

  const close = React.useCallback((returnFocus: boolean) => {
    setIsOpen(false);
    setActiveIndex(-1);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Move focus to the active item once the menu is visible.
  React.useEffect(() => {
    if (isOpen && activeIndex >= 0) itemRefs.current[activeIndex]?.focus();
  }, [isOpen, activeIndex]);

  React.useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        close(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, close]);

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      open('first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      open('last');
    } else if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };

  const handleTriggerClick = (e: React.MouseEvent) => {
    if (isOpen) {
      close(false);
      return;
    }
    // Enter and Space activate the button as a click with no pointer
    // (`detail` 0); opened that way, focus goes to the first item.
    open(e.detail === 0 ? 'first' : 'none');
  };

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    const position = enabledIndexes.indexOf(activeIndex);
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        if (enabledIndexes.length === 0) return;
        focusItem(enabledIndexes[(position + 1) % enabledIndexes.length]);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        if (enabledIndexes.length === 0) return;
        const previous = position <= 0 ? enabledIndexes.length - 1 : position - 1;
        focusItem(enabledIndexes[previous]);
        break;
      }
      case 'Home':
        e.preventDefault();
        if (enabledIndexes.length) focusItem(enabledIndexes[0]);
        break;
      case 'End':
        e.preventDefault();
        if (enabledIndexes.length) focusItem(enabledIndexes[enabledIndexes.length - 1]);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case 'Tab':
        // Leave with Tab: close, and let focus move on from the trigger.
        close(false);
        break;
      default:
        break;
    }
  };

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
      maxWidth: 'min(24rem, calc(100vw - 2rem))',
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
    color: item.danger
      ? 'var(--color-error-600, #dc2626)'
      : item.disabled
        ? 'var(--color-text-disabled, #9ca3af)'
        : 'var(--color-text, #ececf0)',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: '0.25rem',
    cursor: item.disabled ? 'not-allowed' : 'pointer',
    textAlign: 'left',
    overflowWrap: 'anywhere',
    transition: 'background-color 150ms cubic-bezier(0.16, 1, 0.3, 1)',
  });

  const handleItemClick = (item: MenuItem) => {
    if (!item.disabled) {
      item.onClick?.();
      close(true);
    }
  };

  const triggerAria = {
    id: triggerId,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': isOpen,
    'aria-controls': menuId,
    'aria-label': ariaLabel,
  };

  return (
    <div ref={menuRef} className={className} style={containerStyle}>
      <style>{`
        .softn-menu-item:hover:not(:disabled),
        .softn-menu-item:focus-visible {
          background-color: var(--color-surface-hover, rgba(255, 255, 255, 0.06)) !important;
        }
        @media (prefers-reduced-motion: reduce) {
          .softn-menu-list { transition: none !important; }
        }
      `}</style>
      {triggerIsInteractive ? (
        <span
          style={{ display: 'inline-flex' }}
          onClickCapture={handleTriggerClick}
          onKeyDown={handleTriggerKeyDown}
          ref={(el) => {
            // The attributes belong on the control the user focuses.
            const control = el?.querySelector<HTMLElement>('button, a[href], input, select, textarea') ?? null;
            triggerRef.current = control;
          }}
        >
          <MenuTriggerAttributes target={triggerRef} menuId={menuId} attributes={triggerAria} />
          {trigger}
        </span>
      ) : (
        <button
          type="button"
          ref={(el) => {
            triggerRef.current = el;
          }}
          style={TRIGGER_RESET}
          onClick={handleTriggerClick}
          onKeyDown={handleTriggerKeyDown}
          {...triggerAria}
        >
          {trigger}
        </button>
      )}
      <div
        id={menuId}
        className="softn-menu-list"
        style={getMenuStyle()}
        role="menu"
        aria-labelledby={triggerId}
        onKeyDown={handleMenuKeyDown}
      >
        {items.map((item, index) => (
          <React.Fragment key={item.key}>
            <button
              type="button"
              role="menuitem"
              className="softn-menu-item"
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              tabIndex={index === activeIndex ? 0 : -1}
              disabled={item.disabled}
              aria-disabled={item.disabled || undefined}
              onClick={() => handleItemClick(item)}
              onMouseEnter={() => {
                if (!item.disabled) setActiveIndex(index);
              }}
              style={getItemStyle(item)}
            >
              {item.icon && (
                <span aria-hidden="true" style={{ display: 'inline-flex', flexShrink: 0 }}>
                  {item.icon}
                </span>
              )}
              {item.label}
            </button>
            {item.divider && index < items.length - 1 && (
              <div
                role="separator"
                style={{
                  height: '1px',
                  backgroundColor: 'var(--color-border, #3f3f46)',
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

/**
 * Put the menu-button attributes on a trigger control the Menu did not
 * render itself (an app's own Button), and keep them current.
 */
function MenuTriggerAttributes({
  target,
  menuId,
  attributes,
}: {
  target: React.MutableRefObject<HTMLElement | null>;
  menuId: string;
  attributes: Record<string, string | boolean | undefined>;
}): null {
  const serialized = JSON.stringify(attributes);
  React.useEffect(() => {
    const el = target.current;
    if (!el) return;
    const entries = Object.entries(JSON.parse(serialized) as Record<string, string | boolean | null>);
    const set: string[] = [];
    for (const [name, value] of entries) {
      if (name === 'id' && el.id) {
        // Keep the app's own id, and name the menu after it instead.
        document.getElementById(menuId)?.setAttribute('aria-labelledby', el.id);
        continue;
      }
      if (value === undefined || value === null) continue;
      el.setAttribute(name, String(value));
      set.push(name);
    }
    return () => {
      for (const name of set) el.removeAttribute(name);
    };
  }, [target, menuId, serialized]);
  return null;
}

export default Menu;
