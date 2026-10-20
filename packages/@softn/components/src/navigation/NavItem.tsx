/**
 * NavItem Component
 *
 * Navigation item for sidebars and menus.
 *
 * `page="about"` shows that page of the app: the item sets the state the
 * app keeps its page in (`currentPage`, or `page` as Studio's projects keep
 * it), and is drawn as the current item while it is showing. `navigate`
 * goes to an address, as a link does: another page of the app
 * (`navigate="about.html"`) is shown in the app where the host can, and the
 * browser goes anywhere else. Both used to be attributes that nothing read.
 */

import React from 'react';
import { useAppScope } from '@softn/core';
import { textOf } from '../utils/text';
import { outlineIcon } from '../utils/icons';

export interface NavItemProps {
  /** Item label */
  label?: string;
  /** Children (alternative to label) */
  children?: React.ReactNode;
  /** Icon name or element */
  icon?: React.ReactNode | string;
  /** The page of the app to show, by the name its state holds it under */
  page?: string;
  /** An address to go to: another page of the app (`about.html`), a `#fragment`, or a web address */
  navigate?: string;
  /** Click handler */
  onClick?: () => void;
  /** Whether this item is active */
  active?: boolean;
  /** Collapsed mode - show only icon with tooltip */
  collapsed?: boolean;
  /** Variant style */
  variant?: 'default' | 'ghost' | 'primary';
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

export function NavItem({
  label,
  children,
  icon,
  page,
  navigate,
  onClick,
  active: activeProp,
  collapsed = false,
  variant = 'default',
  className,
  style,
}: NavItemProps): React.ReactElement {
  const scope = useAppScope();
  const href = safeHref(navigate);
  // Given no `active`, an item that shows a page is the current one while
  // that page shows.
  const active = activeProp ?? (page !== undefined && page !== '' && scope.currentPage === page);

  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    onClick?.();
    if (page !== undefined && page !== '') {
      // A page of the app's own, by name; or, in an app that keeps no page
      // state, the page of the bundle by that name, as a link names it. An
      // item that is a link as well is then not followed by the browser too.
      if (scope.showPage?.(page) || scope.followLink?.(page)) {
        event.preventDefault();
        return;
      }
    }
    if (href === undefined || event.defaultPrevented) return;
    // A new tab, another window, a download: the browser's, as for any link.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (href.startsWith('#') || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) return;
    if (scope.followLink?.(href)) event.preventDefault();
  };

  const resolvedIcon = typeof icon === 'string' ? outlineIcon(icon, 18) : icon;
  const displayLabel = label || children;
  // `data-label` and `title` are attributes: a label given as elements used
  // to reach them as "[object Object]". Its text is what they should say.
  const textLabel = textOf(displayLabel).replace(/\s+/g, ' ').trim();

  const baseStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: collapsed ? 'center' : 'flex-start',
    gap: collapsed ? '0' : '0.75rem',
    padding: collapsed ? '0.75rem' : '0.75rem 1rem',
    borderRadius: 'var(--radius-md, 0.5rem)',
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text-muted, #999)',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
    width: '100%',
    textAlign: 'left',
    position: 'relative',
  };

  // What the variant draws, current page or not. Default fills the current
  // page with the primary colour; ghost never fills, and marks the current
  // page with a light wash and full text colour; primary is filled either
  // way, an action in a list of places, and a shade deeper when current.
  const kind = variant === 'ghost' || variant === 'primary' ? variant : 'default';
  const primary = 'var(--color-primary, #6366f1)';
  const variantStyle: React.CSSProperties =
    kind === 'primary'
      ? {
          background: active ? `var(--color-primary-600, ${primary})` : primary,
          color: 'var(--color-primary-text, white)',
        }
      : !active
        ? {}
        : kind === 'ghost'
          ? {
              background: 'var(--color-surface-hover, rgba(255, 255, 255, 0.06))',
              color: 'var(--color-text, inherit)',
              fontWeight: 600,
            }
          : {
              background: primary,
              color: 'var(--color-primary-text, white)',
            };

  const buttonStyle: React.CSSProperties = {
    ...baseStyle,
    ...variantStyle,
    ...style,
  };

  const labelStyle: React.CSSProperties = {
    opacity: collapsed ? 0 : 1,
    width: collapsed ? 0 : 'auto',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    transition: 'opacity 200ms cubic-bezier(0.16, 1, 0.3, 1), width 200ms cubic-bezier(0.16, 1, 0.3, 1)',
  };

  const iconStyle: React.CSSProperties = {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <>
      <style>{`
        .softn-nav-item:hover:not(.active):not(.softn-nav-item--primary) {
          background: var(--nav-item-hover-bg, rgba(255, 255, 255, 0.06)) !important;
          color: var(--nav-item-hover-text, rgba(255, 255, 255, 0.95)) !important;
          transform: translateX(2px);
        }
        .softn-nav-item--primary:hover:not(.active) {
          filter: brightness(1.08);
        }
        .softn-nav-item:active {
          transform: scale(0.98) translateX(0);
        }
        .softn-nav-item.collapsed[data-label]:hover::after,
        .softn-nav-item.collapsed[data-label]:focus-visible::after {
          content: attr(data-label);
          position: absolute;
          left: 100%;
          top: 50%;
          transform: translateY(-50%);
          margin-left: 0.75rem;
          padding: 0.5rem 0.75rem;
          background: var(--nav-tooltip-bg, #1c1917);
          color: var(--nav-tooltip-text, white);
          font-size: 0.8125rem;
          font-weight: 500;
          border-radius: 0.375rem;
          white-space: nowrap;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
          z-index: 1000;
          border: 1px solid var(--nav-tooltip-border, rgba(255, 255, 255, 0.1));
          animation: softn-tooltip-in 200ms cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        @keyframes softn-tooltip-in {
          from { opacity: 0; transform: translateY(-50%) translateX(-4px); }
          to { opacity: 1; transform: translateY(-50%) translateX(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .softn-nav-item, .softn-nav-item::after { transition: none !important; animation: none !important; }
          .softn-nav-item:hover:not(.active), .softn-nav-item:active { transform: none !important; }
        }
      `}</style>
      {React.createElement(
        // An address is a link: it can be opened in a new tab, and says so.
        href !== undefined ? 'a' : 'button',
        {
          ...(href !== undefined ? { href } : { type: 'button' }),
          className: `softn-nav-item softn-nav-item--${kind} ${active ? 'active' : ''} ${collapsed ? 'collapsed' : ''} ${className || ''}`,
          style: href !== undefined ? { ...buttonStyle, textDecoration: 'none', boxSizing: 'border-box' } : buttonStyle,
          onClick: handleClick,
          'data-label': collapsed && textLabel ? textLabel : undefined,
          title: collapsed && textLabel ? textLabel : undefined,
          // Collapsed, only the icon shows; the name has to come from somewhere.
          'aria-label': collapsed && textLabel ? textLabel : undefined,
          'aria-current': active ? 'page' : undefined,
        },
        resolvedIcon && (
          <span className="nav-icon" style={iconStyle} aria-hidden={textLabel ? true : undefined}>
            {resolvedIcon}
          </span>
        ),
        !collapsed && (
          <span className="nav-label" style={labelStyle}>
            {displayLabel}
          </span>
        )
      )}
    </>
  );
}

export default NavItem;

/**
 * The address `navigate` may send the browser to: one of the app's own
 * pages, a fragment, or a web or mail address. A `javascript:` or `data:`
 * address is not one, and the item is then no link at all.
 */
function safeHref(navigate: string | undefined): string | undefined {
  if (typeof navigate !== 'string') return undefined;
  const href = navigate.trim();
  if (href === '') return undefined;
  // Judged as the browser reads it: it ignores control characters, tabs and
  // line breaks in an address, so "java\tscript:" is javascript:. The
  // characters are the point here, which the lint rule takes for a typo.
  // eslint-disable-next-line no-control-regex
  const read = href.replace(/[\u0000-\u0020\u007f\u00a0\u2000-\u200f\u2028\u2029\ufeff]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(read)?.[1]?.toLowerCase();
  if (scheme === undefined) return read.startsWith('\\') || read.startsWith('/\\') ? undefined : href;
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel' ? href : undefined;
}
