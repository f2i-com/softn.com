/**
 * Tabs Component
 *
 * A tabbed navigation interface with smooth transitions.
 * Uses CSS variables for theming support.
 */

import React, { useState, useCallback, useEffect, useRef, useId, useMemo } from 'react';
import { choice } from '../utils/choice';
import { TOUCH_MEDIA } from '../utils/media';

/** Whether two keys name the same tab: as text, since a page writes `activeKey="2"` for a tab keyed 2. */
function sameKey(a: unknown, b: unknown): boolean {
  return a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);
}

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
  /** Accessible name for the tab list */
  ariaLabel?: string;
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
  tabs: rawTabs,
  activeKey,
  defaultActiveKey,
  onChange,
  variant = 'default',
  size = 'md',
  fullWidth = false,
  ariaLabel = 'Tabs',
  className,
  style,
}: TabsProps): React.ReactElement {
  // A tab with no key is keyed by its place: without, every tab was
  // `undefined`, all of them were selected at once and shared one id.
  const tabs = useMemo(
    () =>
      (Array.isArray(rawTabs) ? rawTabs.filter(Boolean) : []).map((tab, index) =>
        tab.key === undefined || tab.key === null || tab.key === '' ? { ...tab, key: String(index) } : tab
      ),
    [rawTabs]
  );
  // Per instance: two Tabs with a `general` tab each gave two elements the id
  // `tab-general`, and each tablist's aria-controls pointed into the other.
  const idPrefix = useId();
  const tabId = (key: string) => `${idPrefix}-tab-${key}`;
  const panelId = (key: string) => `${idPrefix}-panel-${key}`;
  const [internalActiveKey, setInternalActiveKey] = useState(defaultActiveKey);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const listRef = useRef<HTMLDivElement>(null);

  // Left to itself, the selected tab is the one chosen, else the default the
  // page named, else the first that can be chosen, whenever that names no
  // tab. The first tab was read once, at the first draw: tabs bound to data
  // that arrived after it had no selected tab and no panel when they came.
  // Nobody chose this one, so the page is not told of it.
  const ownKey = (
    tabs.find((t) => sameKey(t.key, internalActiveKey)) ??
    tabs.find((t) => !t.disabled) ??
    tabs[0]
  )?.key;
  // The page's key decides while it names a tab. One that names none is no
  // choice: `:bind` hands an unset variable in as "", which is not `undefined`,
  // and the tabs opened with no tab chosen and no panel. Keys are compared as
  // text, as a page writes them: tabs keyed 1 and 2 with `activeKey="2"` had
  // none chosen either.
  const namedTab = activeKey === undefined || activeKey === null ? undefined : tabs.find((t) => sameKey(t.key, activeKey));
  const currentActiveKey = namedTab ? namedTab.key : ownKey;
  // The tab that holds the tab stop: the active one, or — when the active key
  // names no tab, or a disabled one — the first enabled tab. Without this,
  // no tab had tabIndex 0 and the whole tablist was unreachable by keyboard.
  const activeEnabled = tabs.find((t) => t.key === currentActiveKey && !t.disabled);
  const focusKey = activeEnabled?.key ?? tabs.find((t) => !t.disabled)?.key;
  const sizes = choice(sizeStyles, size, 'md');

  const pageDecides = namedTab !== undefined;
  const handleTabClick = useCallback(
    (key: string) => {
      // While the page's key names no tab, the choice is kept here too.
      if (!pageDecides) {
        setInternalActiveKey(key);
      }
      onChange?.(key);
    },
    [pageDecides, onChange]
  );

  // The chosen tab is brought into view in its own row, and nothing else is
  // scrolled: `scrollIntoView` would move the page to tabs further down it.
  useEffect(() => {
    const list = listRef.current;
    const tab = currentActiveKey === undefined ? undefined : tabRefs.current.get(currentActiveKey);
    if (!list || !tab || list.scrollWidth <= list.clientWidth) return;
    // The row is the tabs' offset parent (it is positioned), so this is the
    // tab's place in the row whatever the row is scrolled to.
    const room = 16;
    const start = tab.offsetLeft;
    const end = start + tab.offsetWidth;
    if (start - room < list.scrollLeft) list.scrollLeft = Math.max(0, start - room);
    else if (end + room > list.scrollLeft + list.clientWidth) list.scrollLeft = end + room - list.clientWidth;
    // When another tab is chosen, or the tabs arrive, and not on every draw:
    // a page hands a new list of the same tabs each time it is drawn, and a
    // row the person had scrolled along was pulled back to the chosen tab.
  }, [currentActiveKey, tabs.length]);

  // Get next/previous enabled tab
  const getAdjacentTab = useCallback(
    (from: string, direction: 'next' | 'prev'): string | null => {
      const enabledTabs = tabs.filter((t) => !t.disabled);
      if (enabledTabs.length === 0) return null;
      const currentIndex = enabledTabs.findIndex((t) => t.key === from);
      if (currentIndex === -1) return enabledTabs[0].key;

      if (direction === 'next') {
        return enabledTabs[(currentIndex + 1) % enabledTabs.length]?.key ?? null;
      } else {
        return (
          enabledTabs[(currentIndex - 1 + enabledTabs.length) % enabledTabs.length]?.key ?? null
        );
      }
    },
    [tabs]
  );

  // Keyboard navigation with arrow keys
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, tabKey: string) => {
      let newKey: string | null = null;

      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          newKey = getAdjacentTab(tabKey, 'prev');
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          newKey = getAdjacentTab(tabKey, 'next');
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

  // More tabs than the row has room for scroll in the row, sideways, with no
  // scrollbar drawn (the rule below). The row was a flex box that neither
  // wrapped nor scrolled, so seven tabs on a phone were wider than the page:
  // the whole page scrolled sideways, or, in an app that clips, the last tabs
  // could not be reached. A row that scrolls clips what is drawn outside it,
  // so the pills, whose shadow is, get room for it that takes none from the
  // page around them.
  const tabListStyle: React.CSSProperties = {
    display: 'flex',
    position: 'relative',
    overflowX: 'auto',
    overflowY: 'hidden',
    gap: variant === 'pills' ? '0.5rem' : '0',
    borderBottom: variant === 'underline' ? '1px solid var(--color-border, rgba(255, 255, 255, 0.08))' : undefined,
    backgroundColor: variant === 'default' ? 'var(--color-gray-100, rgba(255, 255, 255, 0.04))' : undefined,
    borderRadius: variant === 'default' ? 'var(--radius-lg, 0.5rem)' : undefined,
    padding: variant === 'default' ? '0.25rem' : variant === 'pills' ? '4px 4px 8px' : undefined,
    margin: variant === 'pills' ? '-4px -4px -8px' : undefined,
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
      // A tab keeps its label on one line and is never narrower than it; the
      // row scrolls. Full width, they share the row equally while they fit.
      flex: fullWidth ? '1 0 0%' : '0 0 auto',
      whiteSpace: 'nowrap',
      justifyContent: fullWidth ? 'center' : undefined,
      // No `outline: none`: it overrode the theme's :focus-visible ring, and
      // arrowing between tabs showed nowhere where focus was.
    };

    if (variant === 'default') {
      return {
        ...baseStyle,
        backgroundColor: isActive
          ? 'var(--color-surface, #16161a)'
          : isHovered
            ? 'var(--color-surface-hover, rgba(255, 255, 255, 0.06))'
            : 'transparent',
        color: isActive
          ? 'var(--color-text, #ececf0)'
          : isHovered
            ? 'var(--color-text, #d4d4d8)'
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
            ? 'var(--color-surface-hover, rgba(255, 255, 255, 0.06))'
            : 'transparent',
        color: isActive
          ? 'var(--color-white, #fafafa)'
          : isHovered
            ? 'var(--color-text, #d4d4d8)'
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
            ? 'var(--color-text, #d4d4d8)'
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
      {/*
        The row scrolls without a scrollbar: the tabs cut off at its edge say
        there are more. A row that scrolls clips a focus ring drawn outside
        its tabs, so the ring is drawn just inside them. Under a finger a tab
        is 44 pixels tall.
      */}
      <style>{`
        .softn-tabs-list { scrollbar-width: none; -ms-overflow-style: none; }
        .softn-tabs-list::-webkit-scrollbar { display: none; }
        .softn-tabs-list > [role="tab"]:focus-visible { outline-offset: -2px; }
        ${TOUCH_MEDIA} { .softn-tabs-list > [role="tab"] { min-height: 44px; } }
      `}</style>
      <div ref={listRef} role="tablist" className="softn-tabs-list" style={tabListStyle} aria-label={ariaLabel}>
        {tabs.map((tab) => {
          const isActive = currentActiveKey === tab.key;
          const hasPanel = isActive && !!tab.content;
          return (
            <button
              key={tab.key}
              type="button"
              ref={(el) => {
                if (el) tabRefs.current.set(tab.key, el);
                else tabRefs.current.delete(tab.key);
              }}
              role="tab"
              id={tabId(tab.key)}
              aria-selected={isActive}
              aria-controls={hasPanel ? panelId(tab.key) : undefined}
              tabIndex={tab.key === focusKey ? 0 : -1}
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
          id={panelId(activeTab.key)}
          aria-labelledby={tabId(activeTab.key)}
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
