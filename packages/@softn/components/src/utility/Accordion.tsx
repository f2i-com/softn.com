/**
 * Accordion Component
 *
 * A collapsible accordion panel group, following the WAI-ARIA accordion
 * pattern: each header is a button in a heading, with `aria-expanded` and
 * `aria-controls`; the arrow keys, Home and End move between headers.
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
  /** Heading level of the item headers (default 3) */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

/**
 * Hoisted: declared inside the component it was a new component type on every
 * render, so React remounted the icon each time and its rotation never
 * animated.
 */
function ChevronIcon({ isOpen }: { isOpen: boolean }): React.ReactElement {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
      style={{
        flexShrink: 0,
        transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

const EMPTY_KEYS: string[] = [];

export function Accordion({
  items: rawItems,
  multiple = false,
  defaultOpenKeys = EMPTY_KEYS,
  openKeys,
  onChange,
  variant = 'default',
  headingLevel = 3,
  className,
  style,
}: AccordionProps): React.ReactElement {
  const items = React.useMemo(() => (Array.isArray(rawItems) ? rawItems.filter(Boolean) : []), [rawItems]);
  const [internalOpenKeys, setInternalOpenKeys] = React.useState<string[]>(defaultOpenKeys);
  // Ids per instance, and headers found by ref: ids built from the item keys
  // alone collided between two accordions with the same keys, and ArrowDown
  // (which looked the next header up by id) could focus a header in the
  // other accordion.
  const idPrefix = React.useId();
  const buttonRefs = React.useRef(new Map<string, HTMLButtonElement>());

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
  const handleKeyDown = (e: React.KeyboardEvent, key: string) => {
    const enabledItems = items.filter((item) => !item.disabled);
    if (enabledItems.length === 0) return;
    const currentEnabledIndex = enabledItems.findIndex((item) => item.key === key);
    let target: AccordionItem | undefined;

    switch (e.key) {
      case 'ArrowDown':
        target = enabledItems[(currentEnabledIndex + 1) % enabledItems.length];
        break;
      case 'ArrowUp':
        target = enabledItems[(currentEnabledIndex - 1 + enabledItems.length) % enabledItems.length];
        break;
      case 'Home':
        target = enabledItems[0];
        break;
      case 'End':
        target = enabledItems[enabledItems.length - 1];
        break;
      default:
        return;
    }
    e.preventDefault();
    buttonRefs.current.get(target.key)?.focus();
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
    gap: '0.75rem',
    width: '100%',
    padding: '1rem',
    fontSize: '1rem',
    fontWeight: 500,
    fontFamily: 'inherit',
    color: item.disabled ? 'var(--color-text-disabled, #52525b)' : 'var(--color-text, #ececf0)',
    backgroundColor: isOpen && variant !== 'default' ? 'var(--color-surface-hover, #1e1e23)' : 'transparent',
    border: 'none',
    cursor: item.disabled ? 'not-allowed' : 'pointer',
    textAlign: 'left',
    overflowWrap: 'anywhere',
    transition: 'background-color 180ms cubic-bezier(0.16, 1, 0.3, 1)',
  });

  // No max-height: a 1000px cap clipped any taller panel, and `hidden`
  // removes a closed panel from layout anyway.
  const innerContentStyle: React.CSSProperties = {
    padding: '0 1rem 1rem 1rem',
    color: 'var(--color-text-muted, #a1a1aa)',
    overflowWrap: 'anywhere',
  };

  const Heading = `h${headingLevel}` as 'h3';

  return (
    <div className={className} style={containerStyle}>
      {items.map((item, index) => {
        const isOpen = currentOpenKeys.includes(item.key);
        const buttonId = `${idPrefix}-button-${item.key}`;
        const panelId = `${idPrefix}-panel-${item.key}`;

        return (
          <div key={item.key} style={getItemStyle(index)}>
            <Heading style={{ margin: 0, fontSize: 'inherit', fontWeight: 'inherit' }}>
              <button
                type="button"
                id={buttonId}
                ref={(el) => {
                  if (el) buttonRefs.current.set(item.key, el);
                  else buttonRefs.current.delete(item.key);
                }}
                onClick={() => !item.disabled && handleToggle(item.key)}
                onKeyDown={(e) => handleKeyDown(e, item.key)}
                disabled={item.disabled}
                style={getHeaderStyle(item, isOpen)}
                aria-expanded={isOpen}
                aria-controls={panelId}
              >
                <span style={{ minWidth: 0 }}>{item.header}</span>
                <ChevronIcon isOpen={isOpen} />
              </button>
            </Heading>
            <div
              id={panelId}
              role="region"
              aria-labelledby={buttonId}
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
