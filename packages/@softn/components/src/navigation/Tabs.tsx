/**
 * Tabs Component
 *
 * A tabbed navigation interface with smooth transitions.
 * Uses CSS variables for theming support.
 */

import React, { useState, useCallback, useRef } from 'react';

export interface Tab {
  /** Unique tab key */
  key: string;
  /** Tab label */
  label: React.ReactNode;
  /** Tab content */
  content?: React.ReactNode;
  /** Whether tab is disabled */
  disabled?: boolean;
  /** Icon */
  icon?: React.ReactNode;
}

export interface TabsProps {
  /** Tab items */
  tabs: Tab[];
  /** Active tab key */
  activeKey?: string;
  /** Default active tab key */
  defaultActiveKey?: string;
  /** Tab change handler */
  onChange?: (key: string) => void;
  /** Tabs variant */
  variant?: 'default' | 'pills' | 'underline';
  /** Tabs size */
  size?: 'sm' | 'md' | 'lg';
  /** Full width tabs */
  fullWidth?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeStyles: Record<string, { padding: string; fontSize: string }> = {
  sm: { padding: '0.5rem 0.875rem', fontSize: 'var(--text-sm, 0.875rem)' },
  md: { padding: '0.625rem 1rem', fontSize: 'var(--text-sm, 0.875rem)' },
  lg: { padding: '0.75rem 1.25rem', fontSize: 'var(--text-base, 1rem)' },
};

export function Tabs({
  tabs,
  activeKey,
  defaultActiveKey,
  onChange,
  variant = 'default',
  size = 'md',
  fullWidth = false,
  className,
  style,
}: TabsProps): React.ReactElement {
  const [internalActiveKey, setInternalActiveKey] = useState(defaultActiveKey ?? tabs[0]?.key);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const currentActiveKey = activeKey ?? internalActiveKey;
  const sizes = sizeStyles[size];

  const handleTabClick = useCallback(
    (key: string) => {
      if (activeKey === undefined) {
        setInternalActiveKey(key);
      }
      onChange?.(key);
    },
    [activeKey, onChange]
  );

  // Get next/previous enabled tab
  const getAdjacentTab = useCallback(
    (direction: 'next' | 'prev'): string | null => {
      const enabledTabs = tabs.filter((t) => !t.disabled);
      const currentIndex = enabledTabs.findIndex((t) => t.key === currentActiveKey);
      if (currentIndex === -1) return null;

      if (direction === 'next') {
        return enabledTabs[(currentIndex + 1) % enabledTabs.length]?.key ?? null;
      } else {
        return (
          enabledTabs[(currentIndex - 1 + enabledTabs.length) % enabledTabs.length]?.key ?? null
        );
      }
    },
    [tabs, currentActiveKey]
  );

  // Keyboard navigation with arrow keys
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, tabKey: string) => {
      let newKey: string | null = null;

      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          newKey = getAdjacentTab('prev');
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          newKey = getAdjacentTab('next');
          break;
        case 'Home':
          e.preventDefault();
          newKey = tabs.find((t) => !t.disabled)?.key ?? null;
          break;
        case 'End':
          e.preventDefault();
          newKey = [...tabs].reverse().find((t) => !t.disabled)?.key ?? null;
          break;
      }

      if (newKey && newKey !== tabKey) {
        handleTabClick(newKey);
        // Focus the new tab
        tabRefs.current.get(newKey)?.focus();
      }
    },
    [getAdjacentTab, handleTabClick, tabs]
  );

  const containerStyle: React.CSSProperties = {
    ...style,
  };

  const tabListStyle: React.CSSProperties = {
    display: 'flex',
    gap: variant === 'pills' ? '0.5rem' : '0',
    borderBottom: variant === 'underline' ? '1px solid var(--color-border, rgba(255, 255, 255, 0.08))' : undefined,
    backgroundColor: variant === 'default' ? 'var(--color-gray-100, rgba(255, 255, 255, 0.04))' : undefined,
    borderRadius: variant === 'default' ? 'var(--radius-lg, 0.5rem)' : undefined,
    padding: variant === 'default' ? '0.25rem' : undefined,
    boxShadow: variant === 'default' ? 'inset 0 1px 2px rgba(0, 0, 0, 0.06)' : undefined,
  };

  const getTabStyle = (tab: Tab, isActive: boolean): React.CSSProperties => {
    const isHovered = hoveredKey === tab.key && !tab.disabled;

    const baseStyle: React.CSSProperties = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.5rem',
      padding: sizes.padding,
      fontSize: sizes.fontSize,
      fontWeight: 500,
      cursor: tab.disabled ? 'not-allowed' : 'pointer',
      opacity: tab.disabled ? 0.5 : 1,
      border: 'none',
      background: 'none',
      transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
      flex: fullWidth ? 1 : undefined,
      justifyContent: fullWidth ? 'center' : undefined,
      outline: 'none',
    };

    if (variant === 'default') {
      return {
        ...baseStyle,
        backgroundColor: isActive
          ? 'var(--color-surface, #16161a)'
          : isHovered
            ? 'rgba(255, 255, 255, 0.06)'
            : 'transparent',
        color: isActive
          ? 'var(--color-text, #ececf0)'
          : isHovered
            ? 'var(--color-gray-200, #d4d4d8)'
            : 'var(--color-text-muted, #a1a1aa)',
        borderRadius: 'var(--radius-md, 0.375rem)',
        boxShadow: isActive
          ? '0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.06)'
          : undefined,
        transform: isActive ? 'translateY(0)' : isHovered ? 'translateY(-1px)' : undefined,
      };
    }

    if (variant === 'pills') {
      return {
        ...baseStyle,
        background: isActive
          ? 'linear-gradient(to bottom, var(--color-primary-500, #6366f1), var(--color-primary-600, #4f46e5))'
          : isHovered
            ? 'var(--color-gray-100, rgba(255, 255, 255, 0.06))'
            : 'transparent',
        color: isActive
          ? 'var(--color-white, #fafafa)'
          : isHovered
            ? 'var(--color-gray-200, #d4d4d8)'
            : 'var(--color-text-muted, #a1a1aa)',
        borderRadius: 'var(--radius-full, 9999px)',
        boxShadow: isActive
          ? '0 2px 4px rgba(99, 102, 241, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.15)'
          : isHovered
            ? '0 1px 2px rgba(0, 0, 0, 0.05)'
            : undefined,
        transform: isActive ? 'translateY(0)' : isHovered ? 'translateY(-1px)' : undefined,
      };
    }

    if (variant === 'underline') {
      return {
        ...baseStyle,
        color: isActive
          ? 'var(--color-primary-600, #4f46e5)'
          : isHovered
            ? 'var(--color-gray-200, #d4d4d8)'
            : 'var(--color-text-muted, #a1a1aa)',
        borderBottom: `2px solid ${isActive ? 'var(--color-primary-500, #6366f1)' : 'transparent'}`,
        marginBottom: '-1px',
        paddingBottom: 'calc(0.625rem - 1px)',
      };
    }

    return baseStyle;
  };

  const activeTab = tabs.find((t) => t.key === currentActiveKey);

  return (
    <div className={className} style={containerStyle}>
      <div role="tablist" style={tabListStyle} aria-label="Tabs">
        {tabs.map((tab) => {
          const isActive = currentActiveKey === tab.key;
          return (
            <button
              key={tab.key}
              ref={(el) => {
                if (el) tabRefs.current.set(tab.key, el);
                else tabRefs.current.delete(tab.key);
              }}
              role="tab"
              id={`tab-${tab.key}`}
              aria-selected={isActive}
              aria-controls={`tabpanel-${tab.key}`}
              tabIndex={isActive ? 0 : -1}
              disabled={tab.disabled}
              onClick={() => !tab.disabled && handleTabClick(tab.key)}
              onKeyDown={(e) => handleKeyDown(e, tab.key)}
              onMouseEnter={() => setHoveredKey(tab.key)}
              onMouseLeave={() => setHoveredKey(null)}
              style={getTabStyle(tab, isActive)}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
      </div>
      {activeTab?.content && (
        <div
          role="tabpanel"
          id={`tabpanel-${activeTab.key}`}
          aria-labelledby={`tab-${activeTab.key}`}
          tabIndex={0}
          style={{ paddingTop: '1rem' }}
        >
          {activeTab.content}
        </div>
      )}
    </div>
  );
}

export default Tabs;
