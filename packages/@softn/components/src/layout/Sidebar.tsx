/**
 * Sidebar Component
 *
 * A collapsible sidebar layout component with dark theme support.
 */

import React, { useState, useCallback, createContext, useContext } from 'react';

// Context for sidebar collapsed state
export const SidebarContext = createContext<{ collapsed: boolean }>({ collapsed: false });

export function useSidebarCollapsed(): boolean {
  return useContext(SidebarContext).collapsed;
}

export interface SidebarProps {
  /** Sidebar content */
  children?: React.ReactNode;
  /** Width when expanded */
  width?: string;
  /** Width when collapsed */
  collapsedWidth?: string;
  /** Which side to show on */
  position?: 'left' | 'right';
  /** Whether sidebar is collapsible */
  collapsible?: boolean;
  /** Controlled collapsed state */
  collapsed?: boolean;
  /** Default collapsed state */
  defaultCollapsed?: boolean;
  /** Callback when collapsed state changes */
  onCollapse?: (collapsed: boolean) => void;
  /** Background color */
  background?: string;
  /** Border color */
  borderColor?: string;
  /** Show toggle button */
  showToggle?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

export function Sidebar({
  children,
  width = '280px',
  collapsedWidth = '72px',
  position = 'left',
  collapsible = true,
  collapsed: controlledCollapsed,
  defaultCollapsed = false,
  onCollapse,
  background = 'linear-gradient(180deg, #1c1917 0%, #0c0a09 100%)',
  borderColor = 'rgba(255, 255, 255, 0.05)',
  showToggle = true,
  className,
  style,
}: SidebarProps): React.ReactElement {
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);

  const isCollapsed = controlledCollapsed !== undefined ? controlledCollapsed : internalCollapsed;

  const handleToggle = useCallback(() => {
    const newState = !isCollapsed;
    if (controlledCollapsed === undefined) {
      setInternalCollapsed(newState);
    }
    onCollapse?.(newState);
  }, [isCollapsed, controlledCollapsed, onCollapse]);

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    width: isCollapsed ? collapsedWidth : width,
    minWidth: isCollapsed ? collapsedWidth : width,
    maxWidth: isCollapsed ? collapsedWidth : width,
    alignSelf: 'stretch',
    background,
    borderRight: position === 'left' ? `1px solid ${borderColor}` : 'none',
    borderLeft: position === 'right' ? `1px solid ${borderColor}` : 'none',
    transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
    overflow: 'hidden',
    position: 'relative',
    flexShrink: 0,
    ...style,
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    overflow: 'auto',
    padding: isCollapsed ? '0.75rem' : '1rem',
    display: 'flex',
    flexDirection: 'column',
  };

  const toggleButtonStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: '1rem',
    right: isCollapsed ? '50%' : '1rem',
    transform: isCollapsed ? 'translateX(50%)' : 'none',
    width: '32px',
    height: '32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255, 255, 255, 0.05)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    cursor: 'pointer',
    borderRadius: '8px',
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: '16px',
    transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
  };

  return (
    <SidebarContext.Provider value={{ collapsed: isCollapsed }}>
      <style>{`
        .softn-sidebar-toggle:hover {
          background: rgba(255, 255, 255, 0.1) !important;
          color: rgba(255, 255, 255, 0.9) !important;
          border-color: rgba(255, 255, 255, 0.2) !important;
        }
        .softn-sidebar-toggle:active {
          transform: ${isCollapsed ? 'translateX(50%) scale(0.95)' : 'scale(0.95)'};
        }
      `}</style>
      <aside
        className={`softn-sidebar ${isCollapsed ? 'collapsed' : ''} ${className || ''}`}
        style={containerStyle}
      >
        <div style={contentStyle}>{children}</div>
        {collapsible && showToggle && (
          <button
            type="button"
            className="softn-sidebar-toggle"
            onClick={handleToggle}
            style={toggleButtonStyle}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                transform: isCollapsed
                  ? position === 'left'
                    ? 'rotate(0deg)'
                    : 'rotate(180deg)'
                  : position === 'left'
                    ? 'rotate(180deg)'
                    : 'rotate(0deg)',
                transition: 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
      </aside>
    </SidebarContext.Provider>
  );
}

export default Sidebar;
