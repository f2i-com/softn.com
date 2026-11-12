/**
 * Sidebar Component
 *
 * A collapsible sidebar layout component with dark theme support.
 *
 * On a phone or a portrait tablet (768 pixels wide and under) there is no
 * room for a column beside the page, and the sidebar used to be hidden there
 * with nothing in its place: an app whose navigation was its sidebar showed
 * its first page and no way to any other. It is now a menu button, in a slim
 * bar where the sidebar stood, that opens the sidebar over the page as a
 * drawer: focus goes into it and stays there, Escape or a press outside
 * closes it, and so does choosing a NavItem or a link in it.
 *
 * An app that draws its own phone navigation does not get a second one. That
 * is an element with the `softn-mobile-only` class, or a menu button of its
 * own (a control named "Menu" or "Open menu"); `mobileMenu={false}` says so
 * outright, and the sidebar is then hidden on a phone as it always was.
 */

import React, { useState, useCallback, createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { useAppScope } from '@softn/core';
import { useJudgedBackground } from '../utils/egress';
import { outlineIcon } from '../utils/icons';
import { PHONE_QUERY, useMediaQuery } from '../utils/media';
import { lockBodyScroll } from '../feedback/body-scroll-lock';
import { useModalLayer } from '../feedback/layer-stack';

// Context for sidebar collapsed state
export const SidebarContext = createContext<{ collapsed: boolean }>({ collapsed: false });

export function useSidebarCollapsed(): boolean {
  return useContext(SidebarContext).collapsed;
}

// Before paint in a browser, so a phone never shows a frame of the bar an
// app with its own navigation does not get; a plain effect on a server.
const useBeforePaint = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

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
  /**
   * On a phone (768 pixels wide and under) the sidebar is a menu button that
   * opens it as a drawer. `false` leaves it hidden there, for an app that
   * draws its own phone navigation; an app with a `softn-mobile-only`
   * element or a menu button of its own is taken to, without being told.
   */
  mobileMenu?: boolean;
  /** The name of the menu button, and of the drawer it opens, for a screen reader */
  menuLabel?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

/** What a control that opens an app's own navigation is called. */
const MENU_NAME = /^(?:open |show |toggle |close )?(?:the )?(?:main |app |site |side |nav |navigation )?(?:menu|navigation|nav)$/i;
/** The same control drawn as the three-line sign with no name. */
const MENU_SIGN = /^[☰≡]$/;

/** Whether an element is drawn at all: nothing it is inside is `display: none`. */
function isDrawn(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

/**
 * Whether the app this sidebar is in draws phone navigation of its own: an
 * element it shows only on a phone, or a menu button. Looked for in the app
 * and no further, since a host can have several apps on one page.
 */
function hasOwnPhoneNavigation(sidebar: Element): boolean {
  const app = sidebar.closest('[data-softn-app]') ?? sidebar.closest('.softn-app') ?? sidebar.ownerDocument.body;
  const ours = (element: Element) =>
    element.closest('.softn-sidebar, .softn-sidebar-bar') !== null;
  for (const element of Array.from(app.querySelectorAll('.softn-mobile-only'))) {
    if (!ours(element)) return true;
  }
  for (const control of Array.from(app.querySelectorAll('button, [role="button"], a[href]'))) {
    if (ours(control)) continue;
    const name = (control.getAttribute('aria-label') ?? control.getAttribute('title') ?? '').trim();
    const named = MENU_NAME.test(name) || (name === '' && MENU_SIGN.test((control.textContent ?? '').trim()));
    if (named && isDrawn(control)) return true;
  }
  return false;
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
  // The theme's surface: a fixed near-black default put the page's own dark
  // text on it in the light theme.
  background = 'var(--color-surface, #1c1917)',
  borderColor = 'var(--color-border, rgba(255, 255, 255, 0.05))',
  showToggle = true,
  mobileMenu = true,
  menuLabel = 'Menu',
  className,
  style,
}: SidebarProps): React.ReactElement {
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);
  const contentId = React.useId();

  const isCollapsed = controlledCollapsed !== undefined ? controlledCollapsed : internalCollapsed;

  const handleToggle = useCallback(() => {
    const newState = !isCollapsed;
    if (controlledCollapsed === undefined) {
      setInternalCollapsed(newState);
    }
    onCollapse?.(newState);
  }, [isCollapsed, controlledCollapsed, onCollapse]);

  // A `url()` in `background` is a fetch the renderer's scrub of `style`
  // never sees; the same policy decides it here.
  const safeBackground = useJudgedBackground(background);

  // On a phone: a menu button and a drawer, unless the app has its own.
  const sidebarRef = useRef<HTMLElement>(null);
  const phone = useMediaQuery(PHONE_QUERY);
  const wanted = phone && mobileMenu !== false;
  const [appHasOwn, setAppHasOwn] = useState(false);
  // After every draw: what the app shows on a phone can come and go with its
  // state, and the page is drawn again whenever that changes.
  useBeforePaint(() => {
    if (!wanted || !sidebarRef.current) return;
    const found = hasOwnPhoneNavigation(sidebarRef.current);
    if (found !== appHasOwn) setAppHasOwn(found);
  });
  const asMenu = wanted && !appHasOwn;
  const [menuOpen, setMenuOpen] = useState(false);
  const drawerOpen = asMenu && menuOpen;
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  // No longer a phone (the window was widened, the tablet turned): the
  // drawer is the sidebar again, and is not left open for the next time.
  useEffect(() => {
    if (!asMenu && menuOpen) setMenuOpen(false);
  }, [asMenu, menuOpen]);
  // The app went to another page, by whatever was pressed: the drawer is done.
  const { currentPage } = useAppScope();
  useEffect(() => {
    setMenuOpen(false);
  }, [currentPage]);
  // Focus in, Tab kept inside, Escape, focus back to the menu button: the
  // Drawer's own behaviour, by the hook the Drawer uses.
  useModalLayer(drawerOpen, sidebarRef, { onEscape: closeMenu });
  useEffect(() => {
    if (!drawerOpen) return;
    return lockBodyScroll(document.body);
  }, [drawerOpen]);

  // In a drawer the sidebar is drawn open, whatever it is beside the page.
  const drawnCollapsed = isCollapsed && !asMenu;
  const border = `1px solid ${borderColor}`;

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    width: drawnCollapsed ? collapsedWidth : width,
    minWidth: drawnCollapsed ? collapsedWidth : width,
    maxWidth: drawnCollapsed ? collapsedWidth : width,
    alignSelf: 'stretch',
    background: safeBackground,
    borderRight: position === 'left' ? border : 'none',
    borderLeft: position === 'right' ? border : 'none',
    transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
    overflow: 'hidden',
    position: 'relative',
    flexShrink: 0,
    ...style,
    ...(asMenu && {
      // Over the page, from the side the sidebar is on; never so wide that
      // no page is left to press to close it. Shut, it is not drawn.
      display: drawerOpen ? 'flex' : 'none',
      position: 'fixed',
      top: 0,
      bottom: 0,
      [position === 'right' ? 'right' : 'left']: 0,
      width: `min(85vw, ${width})`,
      minWidth: 0,
      maxWidth: '100vw',
      alignSelf: undefined,
      zIndex: 1001,
      transition: 'none',
      boxShadow: '0 0 24px rgba(0, 0, 0, 0.4)',
      outline: 'none',
      animation: `softn-sidebar-in-${position === 'right' ? 'right' : 'left'} 0.25s cubic-bezier(0.16, 1, 0.3, 1)`,
    }),
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    overflow: 'auto',
    padding: drawnCollapsed ? '0.75rem' : '1rem',
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
    background: 'var(--color-surface-hover, rgba(255, 255, 255, 0.05))',
    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.1))',
    cursor: 'pointer',
    borderRadius: '8px',
    color: 'var(--color-text-muted, rgba(255, 255, 255, 0.6))',
    fontSize: '16px',
    transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
  };

  // The bar that stands where the sidebar stood. It is a row across the top
  // in a Layout, which stacks on a phone, and a column down the side in a
  // row that does not: 48 pixels either way, for a 44-pixel button.
  const barStyle: React.CSSProperties = {
    display: 'flex',
    // The button at the top of a bar down the side, not half way down it.
    alignItems: 'flex-start',
    justifyContent: position === 'right' ? 'flex-end' : 'flex-start',
    flex: '0 0 auto',
    alignSelf: 'stretch',
    boxSizing: 'border-box',
    minWidth: '48px',
    minHeight: '48px',
    padding: '2px',
    background: safeBackground,
    borderBottom: border,
    // The line a bar down the side has against the page; a bar across the
    // top has none (the rule below), its ends being the screen's edges.
    borderRight: position === 'left' ? border : undefined,
    borderLeft: position === 'right' ? border : undefined,
  };

  const iconButtonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    width: '44px',
    height: '44px',
    padding: 0,
    border: 'none',
    borderRadius: '8px',
    background: 'transparent',
    color: 'var(--color-text-muted, inherit)',
    cursor: 'pointer',
  };

  return (
    <SidebarContext.Provider value={{ collapsed: drawnCollapsed }}>
      <style>{`
        .softn-sidebar-toggle:hover {
          background: var(--color-gray-100, rgba(255, 255, 255, 0.1)) !important;
          color: var(--color-text, rgba(255, 255, 255, 0.9)) !important;
          border-color: var(--color-border-hover, rgba(255, 255, 255, 0.2)) !important;
        }
        .softn-sidebar-toggle:active {
          transform: ${isCollapsed ? 'translateX(50%) scale(0.95)' : 'scale(0.95)'};
        }
        /* Under a finger (a tablet on its side) the collapse button is 44 pixels; it was 32. */
        @media (pointer: coarse) {
          .softn-sidebar-toggle { width: 44px !important; height: 44px !important; }
        }
        .softn-layout > .softn-sidebar-bar { order: -1; border-left: none !important; border-right: none !important; }
        .softn-sidebar-menu-button:hover,
        .softn-sidebar-close:hover {
          background: var(--color-surface-hover, rgba(127, 127, 127, 0.14)) !important;
          color: var(--color-text, inherit) !important;
        }
        @keyframes softn-sidebar-in-left {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
        @keyframes softn-sidebar-in-right {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .softn-sidebar-open { animation: none !important; }
        }
      `}</style>
      {asMenu && (
        <div className="softn-sidebar-bar" style={barStyle}>
          <button
            type="button"
            className="softn-sidebar-menu-button"
            style={iconButtonStyle}
            onClick={() => setMenuOpen(true)}
            aria-label={menuLabel}
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            aria-controls={contentId}
          >
            {outlineIcon('menu', 22)}
          </button>
        </div>
      )}
      {drawerOpen && (
        <div
          className="softn-sidebar-overlay"
          onClick={closeMenu}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--color-overlay, rgba(0, 0, 0, 0.5))' }}
        />
      )}
      <aside
        ref={sidebarRef}
        className={`softn-sidebar ${drawnCollapsed ? 'collapsed' : ''} ${drawerOpen ? 'softn-sidebar-open' : ''} ${className || ''}`}
        style={containerStyle}
        role={drawerOpen ? 'dialog' : undefined}
        aria-modal={drawerOpen ? true : undefined}
        aria-label={drawerOpen ? menuLabel : undefined}
        tabIndex={drawerOpen ? -1 : undefined}
      >
        {drawerOpen && (
          <div style={{ display: 'flex', justifyContent: position === 'right' ? 'flex-start' : 'flex-end', padding: '2px', flex: '0 0 auto' }}>
            <button type="button" className="softn-sidebar-close" style={iconButtonStyle} onClick={closeMenu} aria-label="Close menu">
              {outlineIcon('close', 22)}
            </button>
          </div>
        )}
        <div
          id={contentId}
          style={contentStyle}
          onClick={(event) => {
            // A place was chosen: the drawer has done what it was opened for.
            if (drawerOpen && (event.target as Element).closest?.('.softn-nav-item, a[href]')) closeMenu();
          }}
        >
          {children}
        </div>
        {collapsible && showToggle && !asMenu && (
          <button
            type="button"
            className="softn-sidebar-toggle"
            onClick={handleToggle}
            style={toggleButtonStyle}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!isCollapsed}
            aria-controls={contentId}
          >
            <svg
              aria-hidden="true"
              focusable="false"
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
