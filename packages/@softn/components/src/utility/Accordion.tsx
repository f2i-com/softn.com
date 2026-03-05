/**
 * Accordion Component
 *
 * A collapsible accordion panel group.
 */

import React from 'react';

export interface AccordionItem {
  /** Unique key */
  key: string;
  /** Header content */
  header: React.ReactNode;
  /** Panel content */
  content: React.ReactNode;
  /** Whether disabled */
  disabled?: boolean;
}

export interface AccordionProps {
  /** Accordion items */
  items: AccordionItem[];
  /** Allow multiple panels open */
  multiple?: boolean;
  /** Default open keys */
  defaultOpenKeys?: string[];
  /** Controlled open keys */
  openKeys?: string[];
  /** Change handler */
  onChange?: (keys: string[]) => void;
  /** Accordion variant */
  variant?: 'default' | 'bordered' | 'separated';
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

export function Accordion({
  items,
  multiple = false,
  defaultOpenKeys = [],
  openKeys,
  onChange,
  variant = 'default',
  className,
  style,
}: AccordionProps): React.ReactElement {
  const [internalOpenKeys, setInternalOpenKeys] = React.useState<string[]>(defaultOpenKeys);

  const currentOpenKeys = openKeys ?? internalOpenKeys;

  const handleToggle = (key: string) => {
    let newKeys: string[];

    if (currentOpenKeys.includes(key)) {
      newKeys = currentOpenKeys.filter((k) => k !== key);
    } else {
      newKeys = multiple ? [...currentOpenKeys, key] : [key];
    }

    if (openKeys === undefined) {
      setInternalOpenKeys(newKeys);
    }
    onChange?.(newKeys);
  };

  // Keyboard navigation - handle arrow keys to navigate between accordion items
  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    const enabledItems = items.filter((item) => !item.disabled);
    const currentEnabledIndex = enabledItems.findIndex((item) => item.key === items[index].key);

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const nextIndex = (currentEnabledIndex + 1) % enabledItems.length;
        const nextButton = document.getElementById(
          `accordion-button-${enabledItems[nextIndex].key}`
        );
        nextButton?.focus();
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prevIndex = (currentEnabledIndex - 1 + enabledItems.length) % enabledItems.length;
        const prevButton = document.getElementById(
          `accordion-button-${enabledItems[prevIndex].key}`
        );
        prevButton?.focus();
        break;
      }
      case 'Home': {
        e.preventDefault();
        const firstButton = document.getElementById(`accordion-button-${enabledItems[0].key}`);
        firstButton?.focus();
        break;
      }
      case 'End': {
        e.preventDefault();
        const lastButton = document.getElementById(
          `accordion-button-${enabledItems[enabledItems.length - 1].key}`
        );
        lastButton?.focus();
        break;
      }
    }
  };

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: variant === 'separated' ? '0.5rem' : '0',
    ...style,
  };

  const getItemStyle = (index: number): React.CSSProperties => {
    if (variant === 'bordered' || variant === 'separated') {
      return {
        border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
        borderRadius: variant === 'separated' ? '0.5rem' : undefined,
        borderTop: variant === 'bordered' && index > 0 ? 'none' : undefined,
        borderTopLeftRadius: variant === 'bordered' && index === 0 ? '0.5rem' : undefined,
        borderTopRightRadius: variant === 'bordered' && index === 0 ? '0.5rem' : undefined,
        borderBottomLeftRadius:
          variant === 'bordered' && index === items.length - 1 ? '0.5rem' : undefined,
        borderBottomRightRadius:
          variant === 'bordered' && index === items.length - 1 ? '0.5rem' : undefined,
      };
    }
    return {
      borderBottom: index < items.length - 1 ? '1px solid var(--color-border, rgba(255, 255, 255, 0.08))' : undefined,
    };
  };

  const getHeaderStyle = (item: AccordionItem, isOpen: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '1rem',
    fontSize: '1rem',
    fontWeight: 500,
    color: item.disabled ? 'var(--color-text-disabled, #52525b)' : 'var(--color-text, #ececf0)',
    backgroundColor: isOpen && variant !== 'default' ? 'var(--color-gray-50, #1e1e23)' : 'transparent',
    border: 'none',
    cursor: item.disabled ? 'not-allowed' : 'pointer',
    textAlign: 'left',
    transition: 'background-color 180ms cubic-bezier(0.16, 1, 0.3, 1)',
  });

  const contentStyle = (isOpen: boolean): React.CSSProperties => ({
    overflow: 'hidden',
    maxHeight: isOpen ? '1000px' : '0',
    opacity: isOpen ? 1 : 0,
    transition: 'max-height 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms cubic-bezier(0.16, 1, 0.3, 1)',
  });

  const innerContentStyle: React.CSSProperties = {
    padding: '0 1rem 1rem 1rem',
    color: 'var(--color-text-muted, #a1a1aa)',
  };

  const ChevronIcon = ({ isOpen }: { isOpen: boolean }) => (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      style={{
        transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );

  return (
    <div className={className} style={containerStyle} role="region">
      {items.map((item, index) => {
        const isOpen = currentOpenKeys.includes(item.key);
        const buttonId = `accordion-button-${item.key}`;
        const panelId = `accordion-panel-${item.key}`;

        return (
          <div key={item.key} style={getItemStyle(index)}>
            <h3 style={{ margin: 0 }}>
              <button
                id={buttonId}
                onClick={() => !item.disabled && handleToggle(item.key)}
                onKeyDown={(e) => handleKeyDown(e, index)}
                disabled={item.disabled}
                style={getHeaderStyle(item, isOpen)}
                aria-expanded={isOpen}
                aria-controls={panelId}
              >
                {item.header}
                <ChevronIcon isOpen={isOpen} />
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={buttonId}
              style={contentStyle(isOpen)}
              hidden={!isOpen}
            >
              <div style={innerContentStyle}>{item.content}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default Accordion;
